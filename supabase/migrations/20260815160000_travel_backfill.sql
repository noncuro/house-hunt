-- ------------------------------------------------------------------------------------------------
-- The travel backlog: every journey the hunt needs and does not have.
--
-- Until now a travel time existed only where somebody had opened the listing that needed it. That is
-- fine for the flat you are looking at and wrong for every other one: add a sixth place and the
-- compare table grows a column of dashes that fills in only as each flat is opened by hand, one at a
-- time, forever. `cachedTravelTimes` is right to refuse to fetch on mount — a table that fires a
-- journey request per empty cell is a herd on TfL — but "do not fetch on mount" was silently also
-- "never fetch", because nothing else was going to.
--
-- The backlog is **derived, not enqueued**. There is no jobs table to insert into when a place is
-- added, because a queue you write to is a queue that can drift: a failed insert, a place added by a
-- surface that forgot to enqueue, or a row deleted by hand, and the gap is invisible forever. The
-- gap set is instead computed from the data that already states the requirement — the project's
-- properties, the project's places, the modes we route — minus the rows `travel_time` already holds.
-- Adding a place therefore enqueues nothing and needs to do nothing: the gaps exist the moment the
-- place does, and they stop existing when the answers land. Nothing can be lost because nothing is
-- stored.
-- ------------------------------------------------------------------------------------------------

-- Somewhere to remember that a pair keeps failing.
--
-- Without this, one origin TfL will never answer for is retried in every run forever, and because a
-- run has a fixed budget it eats the same slots every time — the backlog stops draining and the log
-- shows a healthy "60 attempted" while nothing at all is progressing. A settled no-route needs none
-- of this: it is cached in `travel_time` as `no_route` and leaves the gap set like any other answer.
-- This table is only ever about transient failure.
create table if not exists travel_backoff (
  origin_postcode text not null,
  dest_postcode   text not null,
  mode            text not null,
  attempts        int not null default 0,
  last_error      text,
  next_attempt_at timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  primary key (origin_postcode, dest_postcode, mode)
);

alter table travel_backoff enable row level security;

-- No policy, deliberately: `service_role` bypasses RLS and nothing else has any business here. The
-- revoke is belt and braces against Supabase's default grants on the public schema — RLS with no
-- policy already denies, and a table that is invisible to clients cannot become one they depend on.
revoke all on table travel_backoff from anon, authenticated;

comment on table travel_backoff is
  'Transient travel-lookup failures, so a pair that keeps failing stops consuming every backfill run. A settled no-route lives in travel_time instead.';

-- ------------------------------------------------------------------------------------------------
-- The gap set.
-- ------------------------------------------------------------------------------------------------

-- Every (origin, destination, mode) the hunt wants and `travel_time` does not have, oldest work
-- first, with the total outstanding carried on every row.
--
-- `remaining` is `count(*) over ()`, which Postgres computes over the whole matching set *before*
-- `limit` applies — so one call answers both "what should I work on" and "how much is left", and the
-- cron log shows a backlog draining rather than a number of attempts with no denominator.
--
-- The modes are the three we route (`TRAVEL_MODES` in packages/core/src/types.ts). Driving is
-- deliberately absent here as everywhere else: TfL cannot answer it, and asking would cache a
-- transit number under a driving label.
--
-- Archived flats are skipped. The funnel says they are done with — spending TfL's goodwill to learn
-- the commute to a flat somebody else took is the one clearly wasted call in the set. A flat with no
-- stage row at all is *not* archived and is included, which is the normal state of a new listing.
--
-- Two properties can share a postcode and two places can share one, so the set is distinct on the
-- postcode pair rather than on the rows behind it — the cache is keyed on postcodes (design D5) and
-- one lookup answers for every property and place at those two points.
create or replace function public.travel_gaps(p_limit int default 50)
returns table (
  origin_postcode text,
  dest_postcode   text,
  dest_lat        double precision,
  dest_lon        double precision,
  mode            text,
  remaining       bigint
)
language sql
security definer
set search_path = public, pg_temp
as $$
  with pairs as (
    select distinct on (p.postcode, pl.postcode, m.mode)
           p.postcode  as origin_postcode,
           pl.postcode as dest_postcode,
           pl.lat      as dest_lat,
           pl.lon      as dest_lon,
           m.mode      as mode
      from project_property pp
      join property p  on p.rightmove_id = pp.rightmove_id
      join place    pl on pl.project_id  = pp.project_id
      cross join unnest(array['walking', 'cycling', 'transit']) as m(mode)
      left join property_stage ps
        on ps.project_id   = pp.project_id
       and ps.rightmove_id = pp.rightmove_id
      left join travel_time tt
        on tt.origin_postcode = p.postcode
       and tt.dest_postcode   = pl.postcode
       and tt.mode            = m.mode
      left join travel_backoff tb
        on tb.origin_postcode = p.postcode
       and tb.dest_postcode   = pl.postcode
       and tb.mode            = m.mode
     where p.postcode  is not null
       -- A place with no postcode is not a destination: routing is postcode to postcode, and a
       -- neighbourhood the hunt searches around has no journey to ask about (`travelDestinations`).
       and pl.postcode is not null
       and tt.origin_postcode is null
       and (ps.stage is null or ps.stage <> 'archived')
       and (tb.next_attempt_at is null or tb.next_attempt_at <= now())
     -- `distinct on` needs the ordering to start with its own expressions; `pl.id` after them only
     -- decides *which* of two places at one postcode lends its coordinates, and they are the same
     -- point either way.
     order by p.postcode, pl.postcode, m.mode, pl.id
  )
  -- Qualified with the CTE name throughout: the `returns table` columns are parameters in scope
  -- here, and an unqualified `mode` would be ambiguous against them.
  select pairs.origin_postcode,
         pairs.dest_postcode,
         pairs.dest_lat,
         pairs.dest_lon,
         pairs.mode,
         count(*) over () as remaining
    from pairs
   order by pairs.origin_postcode, pairs.dest_postcode, pairs.mode
   limit greatest(p_limit, 0);
$$;

comment on function public.travel_gaps(int) is
  'Journeys the hunt needs and travel_time lacks, derived from project_property x place x mode. remaining carries the full outstanding count before the limit.';

revoke execute on function public.travel_gaps(int) from public, anon, authenticated;
grant execute on function public.travel_gaps(int) to service_role;

-- ------------------------------------------------------------------------------------------------
-- Backoff, written only by the function that made the call.
-- ------------------------------------------------------------------------------------------------

-- Five minutes, doubling, capped at a day. The cap matters more than the curve: TfL being down for
-- an afternoon should not push a leg's next attempt into next week, and a postcode that is genuinely
-- unroutable should still be re-asked occasionally in case it was us.
create or replace function public.record_travel_failure(
  p_origin_postcode text,
  p_dest_postcode   text,
  p_mode            text,
  p_error           text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_service_role() then
    raise exception 'record_travel_failure: the travel function records these, not clients';
  end if;

  insert into public.travel_backoff as tb (
    origin_postcode, dest_postcode, mode, attempts, last_error, next_attempt_at, updated_at)
  values (p_origin_postcode, p_dest_postcode, p_mode, 1, p_error, now() + interval '5 minutes', now())
  on conflict (origin_postcode, dest_postcode, mode) do update set
    attempts        = tb.attempts + 1,
    last_error      = excluded.last_error,
    -- Capped at 8 doublings before the `least` so the interval arithmetic stays small whatever the
    -- attempt count reaches.
    next_attempt_at = now() + least(interval '24 hours', interval '5 minutes' * power(2, least(tb.attempts, 8))),
    updated_at      = now();
end;
$$;

revoke execute on function public.record_travel_failure(text, text, text, text) from public, anon, authenticated;
grant execute on function public.record_travel_failure(text, text, text, text) to service_role;

-- Called when a leg finally answers — including a settled no-route, which is an answer. Leaving the
-- row instead would be harmless today, because a cached leg is no longer a gap, but it would quietly
-- delay the pair by hours the day a `travel_time` row is deleted or its basis moves on.
create or replace function public.clear_travel_failure(
  p_origin_postcode text,
  p_dest_postcode   text,
  p_mode            text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_service_role() then
    raise exception 'clear_travel_failure: the travel function clears these, not clients';
  end if;

  delete from public.travel_backoff
   where origin_postcode = p_origin_postcode
     and dest_postcode   = p_dest_postcode
     and mode            = p_mode;
end;
$$;

revoke execute on function public.clear_travel_failure(text, text, text) from public, anon, authenticated;
grant execute on function public.clear_travel_failure(text, text, text) to service_role;
