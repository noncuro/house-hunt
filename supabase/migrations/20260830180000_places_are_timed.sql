-- ------------------------------------------------------------------------------------------------
-- Somewhere to look *in* is not somewhere to travel *to*, and until now every place with a postcode
-- was both.
--
-- A neighbourhood is saved so the sweep has a centre and a radius. Having saved it, the hunt starts
-- answering a question nobody asked: how long it takes to walk from a flat in Borough to the middle
-- of Borough. That is a row on the panel, a row in the detail pane, three more columns on a compare
-- table that already scrolls sideways — and, invisibly, three legs per flat per neighbourhood in the
-- derived backlog the fifteen-minute backfill works through. The backlog stood at ~2,100 legs when
-- this was written, and 79% of them were to a place that also carries a sweep radius.
--
-- So: one column saying whether journeys are timed to this place, and the same clause added to the
-- SQL that derives the backlog. `travelDestinations` in packages/core is the other half; the two are
-- separate implementations of one question and have to be read together.
--
-- **`true` for every existing row, including the ones with no postcode.** Nothing changes for
-- anybody on the day this ships: the predicate is `postcode is not null AND travel_timed`, two
-- clauses, so a postcode-less place is still not a destination for exactly the reason it always was.
-- Setting those rows `false` would look tidier and would be the bug — it writes "not worth routing
-- to" onto rows that mean "cannot be routed to", and a postcode arriving later would then leave the
-- place silently untimed with nothing on screen to explain it.
--
-- The consequence, stated plainly: the backlog does not shrink until somebody turns a place off.
-- The alternative is guessing at somebody's set-up, which is the silent default this project keeps
-- refusing.
--
-- Nothing here deletes a `travel_time` row, and nothing can: that table is keyed on
-- `(origin_postcode, dest_postcode, mode)` and has never carried a `place_id`. The journeys already
-- paid for stay paid for, and turning a place back on shows them again immediately.
-- ------------------------------------------------------------------------------------------------

alter table place add column if not exists travel_timed boolean not null default true;

comment on column place.travel_timed is
  'Whether journeys are timed to this place. False for somewhere the hunt searches around but does '
  'not commute to. Read with the postcode, never instead of it: no postcode means the place cannot '
  'be routed to, this means it is not worth routing to, and the two are different states on screen. '
  'Presentation plus enqueueing only — it never deletes a travel_time row.';

-- ------------------------------------------------------------------------------------------------
-- And the same question asked again in SQL. Drop and recreate, as `travel_gaps_origin_point` did:
-- everything below is that migration's function with one clause and one sentence added.
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
       -- And one it has been told not to time is not a destination either — the same predicate
       -- `travelDestinations` applies, restated here because this is where the spend is. Without
       -- it the backfill goes on fetching journeys to every neighbourhood forever, at three legs
       -- per flat, and nothing on any screen looks wrong.
       and pl.travel_timed
       and tt.origin_postcode is null
       and (ps.stage is null or ps.stage <> 'archived')
       and (tb.next_attempt_at is null or tb.next_attempt_at <= now())
     -- `distinct on` needs the ordering to start with its own expressions; everything after them
     -- decides which row wins, and the order of *those* is the whole guarantee.
     --
     -- `pick.rank` comes first because a group is not one flat's rows. `place` is joined on
     -- `project_id`, so two projects each holding a flat at the same postcode and a place at the
     -- same postcode land in one group with different `pl.id`s and different properties. Sorting on
     -- `pl.id` before the rank hands the group to whichever project happens to hold the lower place
     -- id — which is exactly how one flat's fuzzed pin comes to stand in for the exact postcode
     -- point another flat already had, the case that migration exists to prevent.
     --
     -- `p.rightmove_id` then makes the choice between equally-ranked properties repeatable rather
     -- than merely arbitrary. `pl.id` is last and decides only *which* of two places at one postcode
     -- lends its coordinates, which is the one tie here that does not matter: they are the same
     -- point either way.
     order by trim(p.postcode), trim(pl.postcode), m.mode, pick.rank nulls last, p.rightmove_id, pl.id
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
  'Journeys the hunt needs and travel_time lacks, derived from project_property x place x mode, for places with a postcode that are timed. Carries both endpoints so the caller can refuse a leg too far to walk. remaining is the full outstanding count before the limit.';

revoke execute on function public.travel_gaps(int) from public, anon, authenticated;
grant execute on function public.travel_gaps(int) to service_role;
