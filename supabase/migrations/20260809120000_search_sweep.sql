-- Sweeping the search pages: what we have seen listed, and when we last looked.
--
-- Until now the database only knew about properties someone had opened. That makes "have we
-- already considered this one?" unanswerable while you are still looking at the results page,
-- which is exactly where the question gets asked — and it makes a second pass over a
-- neighbourhood start from nothing every time.
--
-- Security model is unchanged from 20260809000000_init.sql: no user auth, the anon key is the
-- shared secret, RLS on with one policy granting anon full access. The policy below is a
-- deliberate copy of that one rather than a variation on it.

-- One row per (property, hub) seen on a search results page.
--
-- Deliberately NOT a foreign key onto property(rightmove_id): the whole point of a sighting is
-- that it may be a flat nobody has opened yet, so most rows here have no property row, and the
-- interesting query is precisely the anti-join. The columns are what a search card gives away for
-- free — no page has to be opened to fill any of them in.
--
-- Keyed by (rightmove_id, hub) rather than by rightmove_id alone because the hub radii overlap on
-- purpose: a flat between Belsize Park and Primrose Hill genuinely is a result for both sweeps,
-- and collapsing that would make one hub's sweep look complete because the other had run.
create table if not exists search_sighting (
  rightmove_id     text not null,
  hub              text not null,
  url              text not null,
  display_address  text,
  price            text,
  bedrooms         int,
  bathrooms        int,
  -- Rightmove's fuzzed search pin, good enough to place a card on a map and nothing finer. The
  -- accurate point is postcode-derived and only exists once the listing itself has been opened.
  latitude         double precision,
  longitude        double precision,
  -- When Rightmove first showed it.
  first_visible_at timestamptz,
  -- When it last changed, and how. Both are stored because **`maxDaysSinceAdded` filters on this
  -- date and not on `first_visible_at`**, which a saved Hampstead page proved: 24 of its 25 cards
  -- were first visible inside the 14-day window, and the 25th had been listed 27 days earlier and
  -- had its price cut 5 days before the search. The filter is really "added or changed since",
  -- so this is the column that says whether a sighting was inside the window we asked for.
  listing_update_at     timestamptz,
  -- "new" or "price_reduced" on the page we checked.
  listing_update_reason text,
  -- Their exact wording, e.g. "Added yesterday" / "Reduced on 04/08/2026". Kept verbatim because
  -- "added" and "reduced" are different events and keeping only the date loses which one it was.
  added_or_reduced text,
  first_seen_at    timestamptz not null default now(),
  last_seen_at     timestamptz not null default now(),
  primary key (rightmove_id, hub)
);

-- When each hub was last swept, which is what decides how many days back the next sweep looks.
-- One row per hub, written only when a human says the sweep is finished — see the note in
-- src/lib/sweep.ts about why a too-narrow window is the failure that looks like success.
create table if not exists hub_sweep (
  hub                 text primary key,
  last_swept_at       timestamptz not null default now(),
  -- What the search reported it had in total the moment the sweep was marked done. Not a count of
  -- our rows: it is Rightmove's number, kept so a later sweep returning far fewer results is
  -- visible as the anomaly it would be.
  last_result_count   int,
  -- The maxDaysSinceAdded actually used, so the record says what was covered and not merely when.
  last_window_days    int,
  -- The identifier the page resolved to, recorded rather than assumed: if a hub's identifier is
  -- ever edited in hubs.ts, the old sweeps still say which area they actually covered.
  location_identifier text
);

-- The sweep panel's main question is "which of these ids do we already know about", asked with a
-- list of two dozen ids. That is served by the primary key on property. This index serves the
-- other direction — everything ever sighted for one hub, newest first.
create index if not exists search_sighting_hub_idx on search_sighting (hub, last_seen_at desc);
create index if not exists search_sighting_updated_idx on search_sighting (listing_update_at desc);

alter table search_sighting enable row level security;
alter table hub_sweep       enable row level security;

do $$
declare t text;
begin
  foreach t in array array['search_sighting', 'hub_sweep'] loop
    execute format('drop policy if exists shared_household on %I', t);
    execute format(
      'create policy shared_household on %I for all to anon using (true) with check (true)', t);
  end loop;
end $$;
