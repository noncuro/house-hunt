-- ------------------------------------------------------------------------------------------------
-- The gap set carries where the flat is, so the backfill can stop asking how long it takes to walk
-- somewhere nothing can walk to inside an hour.
--
-- Over half the outstanding walking legs — 356 of 676 when this was written — are to a place further
-- off in a straight line than an hour on foot could cover. Every one of them costs a TfL call, and
-- every answer is thrown away on arrival: `WALKING_LIMIT_SECONDS` has been the rule in every view
-- since long before this, so a walk over the hour is drawn as a dash whatever number comes back.
--
-- The refusal itself is in the function, not here, because the distance it compares against is
-- `WALKING_LIMIT_MILES` — the display limit restated, derived from the same constant. Written out in
-- SQL it would be a second opinion about what is walkable, free to drift from the one the interface
-- enforces. All this migration does is hand over the point to measure from.
--
-- `postcode_lat`/`postcode_lon` first, falling back to the pin. The postcode point is what every
-- journey here is actually routed from (design D-postcode), and Rightmove's map pin is deliberately
-- fuzzed — which does not matter at all at this range, but preferring the exact one costs nothing
-- and keeps the two answers measured from the same place. A flat with neither is not excluded: with
-- nothing to measure, the leg is asked as it always was.
-- ------------------------------------------------------------------------------------------------

drop function if exists public.travel_gaps(int);

create function public.travel_gaps(p_limit int default 50)
returns table (
  origin_postcode text,
  origin_lat      double precision,
  origin_lon      double precision,
  dest_postcode   text,
  dest_lat        double precision,
  dest_lon        double precision,
  mode            text,
  remaining       bigint
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_service_role() then
    raise exception 'travel_gaps: the travel function reads the backlog, not clients';
  end if;

  return query
  with pairs as (
    select distinct on (trim(p.postcode), trim(pl.postcode), m.mode)
           trim(p.postcode)  as origin_postcode,
           coalesce(p.postcode_lat, p.latitude)  as origin_lat,
           coalesce(p.postcode_lon, p.longitude) as origin_lon,
           trim(pl.postcode) as dest_postcode,
           pl.lat            as dest_lat,
           pl.lon            as dest_lon,
           m.mode            as mode
      from project_property pp
      join property p  on p.rightmove_id = pp.rightmove_id
      join place    pl on pl.project_id  = pp.project_id
      cross join unnest(array['walking', 'cycling', 'transit']) as m(mode)
      left join property_stage ps
        on ps.project_id   = pp.project_id
       and ps.rightmove_id = pp.rightmove_id
      left join travel_time tt
        on tt.origin_postcode = trim(p.postcode)
       and tt.dest_postcode   = trim(pl.postcode)
       and tt.mode            = m.mode
      left join travel_backoff tb
        on tb.origin_postcode = trim(p.postcode)
       and tb.dest_postcode   = trim(pl.postcode)
       and tb.mode            = m.mode
     where nullif(trim(p.postcode), '') is not null
       -- A place with no postcode is not a destination: routing is postcode to postcode, and a
       -- neighbourhood the hunt searches around has no journey to ask about (`travelDestinations`).
       and nullif(trim(pl.postcode), '') is not null
       and tt.origin_postcode is null
       and (ps.stage is null or ps.stage <> 'archived')
       and (tb.next_attempt_at is null or tb.next_attempt_at <= now())
     -- `distinct on` needs the ordering to start with its own expressions; `pl.id` after them only
     -- decides *which* of two places at one postcode lends its coordinates, and they are the same
     -- point either way.
     order by trim(p.postcode), trim(pl.postcode), m.mode, pl.id
  )
  -- Qualified with the CTE name throughout: the `returns table` columns are parameters in scope
  -- here, and an unqualified `mode` would be ambiguous against them.
  select pairs.origin_postcode,
         pairs.origin_lat,
         pairs.origin_lon,
         pairs.dest_postcode,
         pairs.dest_lat,
         pairs.dest_lon,
         pairs.mode,
         count(*) over () as remaining
    from pairs
   order by pairs.origin_postcode, pairs.dest_postcode, pairs.mode
   limit greatest(p_limit, 0);
end;
$$;

comment on function public.travel_gaps(int) is
  'Journeys the hunt needs and travel_time lacks, derived from project_property x place x mode. Carries both endpoints so the caller can refuse a leg too far to walk. remaining is the full outstanding count before the limit.';

revoke execute on function public.travel_gaps(int) from public, anon, authenticated;
grant execute on function public.travel_gaps(int) to service_role;
