-- One list of places, instead of two lists of the same thing.
--
-- A project kept `place` (somewhere you measure the commute to) and `project_hub` (somewhere you
-- search around). Both are "a spot on the map this hunt cares about, with a name you can picture
-- standing in", and both already answered the compass question — `hubsWithPlaces` merged them at
-- read time on every card, with a tie-break rule to decide which name won. Two tables, one concept,
-- and a setup flow that made you type Angel twice to have it both searched and measured.
--
-- So `place` absorbs the hub. A row that carries a Rightmove location identifier and a radius is a
-- place this hunt sweeps around; a row without one is a place it only measures against; and the
-- compass reads every row either way. What used to be "add a neighbourhood" is now a toggle on a
-- place you already saved.
--
-- What deliberately does not change:
--
--   * `search_sighting.hub` stays a text name. It is a record of what a search was filed under at
--     the time, not a foreign key — see the note on it in the multi-tenant migration. Renaming a
--     place must not rewrite history.
--   * `hub_sweep` keeps its own row per place with the pages recorded, and re-keys onto `place.id`
--     the same way it re-keyed onto `project_hub.id`. The composite foreign key that stops a sweep
--     and its place from disagreeing about the project is carried over intact.
--   * A place with no coordinate is still skipped, never defaulted. A guessed point silently
--     rotates every bearing computed from it and nothing on screen looks wrong.
-- ---------------------------------------------------------------------------------------------

-- The two halves of "Rightmove can search this", exactly as `project_hub` held them. Null means
-- this place is not swept — which is the honest state for the office and for Heathrow, and the
-- starting state for a place whose postcode has not been resolved to an identifier yet.
alter table place add column if not exists rightmove_location_id text;
alter table place add column if not exists display_location_id   text;

-- How far around the place to search, in miles. Rightmove's own `radius` parameter takes exactly
-- these steps, so this is stored as the number that goes into the URL rather than as anything that
-- has to be converted on the way out. Null means "not a sweep centre", which is the same sentence
-- the identifier above tells; both are required before a search URL can be built, and the code
-- refuses rather than picking a radius nobody chose.
alter table place add column if not exists sweep_radius_miles numeric(3, 1);
alter table place add column if not exists max_days_since_added int;

-- A hub never had a postcode — it was a name resolved to a coordinate and an identifier — so the
-- column that was mandatory for a travel destination cannot stay mandatory for every place.
-- Travel reads it and skips a place without one, which is the existing rule for a place whose
-- postcode never resolved, so nothing downstream needs to learn a new state.
alter table place alter column postcode drop not null;

comment on column place.sweep_radius_miles is
  'Miles to search around this place, or null for a place we only measure travel time to. Paired '
  'with rightmove_location_id: both are needed to build a search URL, and neither is defaulted.';

-- ---------------------------------------------------------------------------------------------
-- Fold the neighbourhoods in.
--
-- Matched on (project_id, lower(name)) against existing places so a hunt that saved "Angel" as
-- both a neighbourhood and a place ends up with one row carrying both jobs, rather than two rows
-- with the same name and half the answer each.
-- ---------------------------------------------------------------------------------------------
do $$
begin
  if to_regclass('public.project_hub') is null then
    return;
  end if;

  -- Where a place of the same name already exists, it gains the search half. Coordinates are only
  -- filled in where the place had none: a postcode resolved through postcodes.io is at least as
  -- good as a hub's anchor, and overwriting it would move a point that other rows have been
  -- measured against.
  update place p
     set rightmove_location_id = coalesce(p.rightmove_location_id, h.rightmove_location_id),
         display_location_id   = coalesce(p.display_location_id, h.display_location_id),
         max_days_since_added  = coalesce(p.max_days_since_added, h.max_days_since_added),
         lat                   = coalesce(p.lat, h.lat),
         lon                   = coalesce(p.lon, h.lon),
         sweep_radius_miles    = coalesce(p.sweep_radius_miles,
                                          case when h.rightmove_location_id is not null then 1.0 end)
    from project_hub h
   where h.project_id = p.project_id
     and lower(h.name) = lower(p.label);

  -- The rest arrive as places in their own right. 1.0 miles is what every sweep URL this project
  -- has ever built used, so it is the radius already in force rather than a new default — see
  -- `RENTAL_SEARCH` and the sweep URL builder.
  insert into place (project_id, label, postcode, lat, lon, sort_order,
                     rightmove_location_id, display_location_id, max_days_since_added,
                     sweep_radius_miles)
  select h.project_id,
         h.name,
         null,
         h.lat,
         h.lon,
         1000 + h.sort_order,  -- after the saved places, in the order the hubs were in
         h.rightmove_location_id,
         h.display_location_id,
         h.max_days_since_added,
         case when h.rightmove_location_id is not null then 1.0 end
    from project_hub h
   where not exists (
           select 1 from place p
            where p.project_id = h.project_id and lower(p.label) = lower(h.name)
         );
end $$;

-- ---------------------------------------------------------------------------------------------
-- hub_sweep follows its hub into place.
-- ---------------------------------------------------------------------------------------------
create unique index if not exists place_project_id_idx on place (project_id, id);

alter table hub_sweep add column if not exists place_id uuid references place(id) on delete cascade;

do $$
begin
  if to_regclass('public.project_hub') is null then
    return;
  end if;

  update hub_sweep s
     set place_id = p.id
    from project_hub h
    join place p on p.project_id = h.project_id and lower(p.label) = lower(h.name)
   where s.hub_id = h.id
     and s.place_id is null;

  -- A sweep whose hub was dropped before this migration ran has no place to point at. It keeps its
  -- name and its pages and loses only the link, which is the same state it was in when the hub was
  -- deleted — the alternative is throwing away the history that dates the next window.
  alter table hub_sweep drop constraint if exists hub_sweep_project_hub_fkey;
  alter table hub_sweep drop column if exists hub_id;

  alter table hub_sweep add constraint hub_sweep_place_fkey
    foreign key (project_id, place_id) references place (project_id, id) on delete cascade;

  drop table project_hub;
end $$;

-- `recordSweepPage` upserts on this, so it has to be unique — as `hub_id` was.
create unique index if not exists hub_sweep_place_id_key on hub_sweep (place_id);

comment on column hub_sweep.place_id is
  'The place this sweep is of. Denormalised project_id beside it, with the composite foreign key '
  'onto place(project_id, id) stopping the two from disagreeing — as it did for project_hub.';

-- The privileges are the table's, and the table already had them; the new columns inherit. Stated
-- anyway because the project''s default privileges hand `anon` DML on anything new, and a column
-- added to an existing table is the one case where that is not in play but the habit still is.
revoke all on table place from anon;
revoke all on table hub_sweep from anon;
