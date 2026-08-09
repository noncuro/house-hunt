-- Walking time to nearby stations. Rightmove gives straight-line miles, which is not the walk.
--
-- Two caches because there are two lookups: a station name resolves to coordinates once ever
-- (TfL's journey planner rejects station names and Naptan ids alike, but takes "lat,lon"), and
-- the walk from a given postcode to those coordinates never changes either.
create table if not exists station_point (
  name text primary key,
  lat  double precision,
  lon  double precision,
  -- Cached even when unresolvable, so we don't re-ask TfL about a station it doesn't know.
  resolved_at timestamptz not null default now()
);

create table if not exists station_walk (
  postcode     text not null,
  station_name text not null,
  seconds      int not null,
  computed_at  timestamptz not null default now(),
  primary key (postcode, station_name)
);

alter table station_point enable row level security;
alter table station_walk  enable row level security;

do $$
declare t text;
begin
  foreach t in array array['station_point', 'station_walk'] loop
    execute format('drop policy if exists shared_household on %I', t);
    execute format('create policy shared_household on %I for all to anon using (true) with check (true)', t);
  end loop;
end $$;
