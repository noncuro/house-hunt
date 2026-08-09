-- rightmove-extension: shared house-hunt state for two people.
--
-- Security model: there is no user auth. The extension ships the publishable (anon) key, and
-- that key is the shared secret between the two laptops. RLS is enabled with a policy granting
-- the anon role full access to these tables, so anyone holding the key holds the data. That is
-- an accepted tradeoff for two private, load-unpacked installs holding low-sensitivity data
-- (which flats we liked). Do not put anything else in this project.

create table if not exists place (
  id          uuid primary key default gen_random_uuid(),
  label       text not null,
  postcode    text not null,
  mode        text not null default 'transit' check (mode in ('transit', 'walking', 'cycling', 'driving')),
  sort_order  int  not null default 0,
  created_at  timestamptz not null default now()
);

create table if not exists property (
  rightmove_id     text primary key,
  url              text not null,
  postcode         text,
  display_address  text not null,
  price            text,
  bedrooms         int,
  bathrooms        int,
  latitude         double precision,
  longitude        double precision,
  nearest_stations jsonb not null default '[]'::jsonb,
  first_seen_at    timestamptz not null default now(),
  last_seen_at     timestamptz not null default now()
);

-- Per-person, not per-property: the interesting signal is where the two of you disagree, and a
-- single shared rating destroys that.
create table if not exists verdict (
  rightmove_id text not null references property(rightmove_id) on delete cascade,
  person       text not null,
  rating       text not null check (rating in ('no', 'maybe', 'love')),
  note         text not null default '',
  updated_at   timestamptz not null default now(),
  primary key (rightmove_id, person)
);

-- Shared read-through cache. Travel time from a postcode to a fixed place doesn't change, and
-- because both laptops share this table each property costs its API calls exactly once, ever.
create table if not exists travel_time (
  postcode    text not null,
  place_id    uuid not null references place(id) on delete cascade,
  mode        text not null,
  seconds     int not null,
  changes     int,
  computed_at timestamptz not null default now(),
  primary key (postcode, place_id, mode)
);

create index if not exists verdict_person_idx on verdict (person);
create index if not exists property_postcode_idx on property (postcode);

alter table place       enable row level security;
alter table property    enable row level security;
alter table verdict     enable row level security;
alter table travel_time enable row level security;

do $$
declare t text;
begin
  foreach t in array array['place', 'property', 'verdict', 'travel_time'] loop
    execute format('drop policy if exists shared_household on %I', t);
    execute format(
      'create policy shared_household on %I for all to anon using (true) with check (true)', t);
  end loop;
end $$;

-- Realtime, so a verdict on one laptop appears on the other without a refresh.
do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
end $$;

alter publication supabase_realtime add table verdict;
alter publication supabase_realtime add table place;
