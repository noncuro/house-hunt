-- ------------------------------------------------------------------------------------------------
-- The gap set carries where the flat is, so the backfill can stop asking how long it takes to walk
-- somewhere nothing can walk to inside an hour.
--
-- Over half the outstanding walking legs — 356 of 676 when this was written — are to a place more
-- than three miles off in a straight line, and every one of them costs a TfL call whose answer is
-- thrown away on arrival: `WALKING_LIMIT_SECONDS` has been the rule in every view since long before
-- this, so a walk over the hour is drawn as a dash whatever number comes back. The line the refusal
-- settled on is further out than three miles, so it refuses fewer than that count — see
-- `WALKING_LIMIT_MILES`, which explains why the bound has to be generous to be true.
--
-- The refusal itself is in the function, not here, because the distance it compares against is
-- `WALKING_LIMIT_MILES` — the display limit restated, derived from the same constant. Written out in
-- SQL it would be a second opinion about what is walkable, free to drift from the one the interface
-- enforces. All this migration does is hand over the point to measure from.
--
-- **A whole pair or nothing.** `postcode_lat`/`postcode_lon` where the property has both, else the
-- listing pin where it has both, and never one axis of each. The postcode point is what every
-- journey here is actually routed from (design D-postcode); Rightmove's map pin is deliberately
-- fuzzed, so a latitude from one and a longitude from the other is a point at neither end of the
-- journey, at a distance nobody can check — and near the boundary that is what turns a walkable leg
-- into a cached dead end. A flat with neither complete pair is not excluded: with nothing to
-- measure, the leg is asked as it always was.
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
           origin.lat        as origin_lat,
           origin.lon        as origin_lon,
           trim(pl.postcode) as dest_postcode,
           pl.lat            as dest_lat,
           pl.lon            as dest_lon,
           m.mode            as mode
      from project_property pp
      join property p  on p.rightmove_id = pp.rightmove_id
      join place    pl on pl.project_id  = pp.project_id
      -- Which point to measure from, chosen once: 1 is the postcode's own, 2 is Rightmove's pin,
      -- null is neither. A rank rather than a boolean because the ordering below needs it too, and
      -- one decision rather than two because the axes have to agree about which source they came
      -- from. `left join ... on true` so a property with no point at all still yields its rows.
      left join lateral (
        select case when p.postcode_lat is not null and p.postcode_lon is not null then 1
                    when p.latitude     is not null and p.longitude     is not null then 2
               end as rank
      ) as pick on true
      left join lateral (
        select case pick.rank when 1 then p.postcode_lat when 2 then p.latitude  end as lat,
               case pick.rank when 1 then p.postcode_lon when 2 then p.longitude end as lon
      ) as origin on true
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
     -- `distinct on` needs the ordering to start with its own expressions; everything after them
     -- decides which row wins. `pl.id` only picks *which* of two places at one postcode lends its
     -- coordinates, and they are the same point either way. The two after it matter more than they
     -- look: two different flats can share a postcode, and they are different rows here with
     -- different points, so without a rule the origin point is whichever one the planner reached
     -- first — a fuzzed pin from one flat standing in for the exact postcode point another flat
     -- already had. `pick.rank` prefers the exact point; `p.rightmove_id` makes the rest of the
     -- choice repeatable rather than merely arbitrary.
     order by trim(p.postcode), trim(pl.postcode), m.mode, pl.id, pick.rank nulls last, p.rightmove_id
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
