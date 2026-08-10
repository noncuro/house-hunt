-- The shared travel caches become server-written, and stop being client-writable.
--
-- `travel_time`, `station_point` and `station_walk` are global by design: one project's lookup
-- saves every other project's. Their write RPCs were granted to `authenticated`, and what those
-- RPCs validate is plausibility, not truth — a known mode, a duration between 0 and 86400 seconds,
-- a coordinate on Earth. Truth was never checkable there, because whether the journey really takes
-- 41 minutes was known only to whoever asked TfL, and that was the client. So one member of one
-- project could write a wrong journey time, or move a station, and every other project would read
-- it as fact: permanently, with nothing detecting it and nothing expiring it.
--
-- The `travel` Edge Function now makes every TfL call and is the only thing that should write these
-- rows. Two changes follow.
--
-- **The guard changes from "is anybody signed in" to "is this the server".** `auth.uid()` is null
-- for the service role — it is not a person and has no profile — which is stated on
-- `is_service_role()` where it was introduced. That means the existing `auth.uid() is null` check
-- refused the one caller that should be allowed. It did so silently, because the function caught
-- the failure so that a cache write could never turn a good answer into a bad one, so the visible
-- symptom was only that nothing was ever cached and every lookup cost a fresh TfL call.
--
-- **`authenticated` loses execute.** Nothing on either client calls these any more.
create or replace function public.cache_travel(
  p_origin_postcode text,
  p_dest_postcode   text,
  p_mode            text,
  p_seconds         int default null,
  p_changes         int default null,
  p_no_route        boolean default false,
  p_journeys        jsonb default null,
  p_basis           text default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_origin text := nullif(trim(p_origin_postcode), '');
  v_dest   text := nullif(trim(p_dest_postcode), '');
begin
  if not public.is_service_role() then
    raise exception 'cache_travel: travel times are written by the travel function, not by clients';
  end if;
  if v_origin is null or v_dest is null then
    raise exception 'cache_travel: both postcodes are required';
  end if;
  if p_mode not in ('transit', 'walking', 'cycling', 'driving') then
    raise exception 'cache_travel: % is not a travel mode', p_mode;
  end if;
  -- A no-route answer has no duration; a route with one has to be a plausible one. 24 hours is not
  -- a journey anyone is taking, and a negative one is a bug being cached forever.
  if p_no_route and p_seconds is not null then
    raise exception 'cache_travel: a journey that does not exist cannot take % seconds', p_seconds;
  end if;
  if not p_no_route and (p_seconds is null or p_seconds < 0 or p_seconds > 86400) then
    raise exception 'cache_travel: % is not a plausible journey duration in seconds', p_seconds;
  end if;

  insert into public.travel_time (
    origin_postcode, dest_postcode, mode, seconds, changes, no_route, journeys, basis, computed_at)
  values (v_origin, v_dest, p_mode, p_seconds, p_changes, p_no_route, p_journeys, p_basis, now())
  on conflict (origin_postcode, dest_postcode, mode) do update set
    seconds = excluded.seconds,
    changes = excluded.changes,
    no_route = excluded.no_route,
    journeys = excluded.journeys,
    basis = excluded.basis,
    computed_at = now();
end;
$$;

-- A station's coordinates, cached even when TfL cannot resolve it — a null point is a real answer
-- and stops us asking again about a station TfL has never heard of.
create or replace function public.cache_station_point(
  p_name text,
  p_lat  double precision default null,
  p_lon  double precision default null,
  p_lines jsonb default '[]'::jsonb
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_name text := nullif(trim(p_name), '');
begin
  if not public.is_service_role() then
    raise exception 'cache_station_point: stations are resolved by the travel function, not by clients';
  end if;
  if v_name is null then
    raise exception 'cache_station_point: a station needs a name';
  end if;
  if (p_lat is null) <> (p_lon is null) then
    raise exception 'cache_station_point: half a coordinate is not a location';
  end if;
  if p_lat is not null and (p_lat < -90 or p_lat > 90 or p_lon < -180 or p_lon > 180) then
    raise exception 'cache_station_point: %,% is not a point on Earth', p_lat, p_lon;
  end if;

  insert into public.station_point (name, lat, lon, lines, resolved_at)
  values (v_name, p_lat, p_lon, coalesce(p_lines, '[]'::jsonb), now())
  on conflict (name) do update set
    lat = excluded.lat, lon = excluded.lon, lines = excluded.lines, resolved_at = now();
end;
$$;

create or replace function public.cache_station_walk(
  p_postcode text, p_station_name text, p_seconds int)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_postcode text := nullif(trim(p_postcode), '');
  v_station  text := nullif(trim(p_station_name), '');
begin
  if not public.is_service_role() then
    raise exception 'cache_station_walk: walks are measured by the travel function, not by clients';
  end if;
  if v_postcode is null or v_station is null then
    raise exception 'cache_station_walk: both a postcode and a station are required';
  end if;
  -- Nobody walks to a nearby station for four hours. A number outside this is a unit error.
  if p_seconds is null or p_seconds < 0 or p_seconds > 14400 then
    raise exception 'cache_station_walk: % is not a plausible walk in seconds', p_seconds;
  end if;

  insert into public.station_walk (postcode, station_name, seconds, computed_at)
  values (v_postcode, v_station, p_seconds, now())
  on conflict (postcode, station_name) do update set
    seconds = excluded.seconds, computed_at = now();
end;
$$;

-- The grants, narrowed. `revoke ... from public` does not remove the explicit grant Supabase's
-- default privileges hand every new function in this schema, which is why each role is named.
do $$
declare f text;
begin
  foreach f in array array[
    'public.cache_travel(text, text, text, int, int, boolean, jsonb, text)',
    'public.cache_station_point(text, double precision, double precision, jsonb)',
    'public.cache_station_walk(text, text, int)'
  ] loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;
