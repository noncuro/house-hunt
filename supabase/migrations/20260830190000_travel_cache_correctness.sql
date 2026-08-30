-- ------------------------------------------------------------------------------------------------
-- The travel cache stops lying, in three parts.
--
-- 1. The journey key is locked while it is written to, in `cache_travel` as well as in
--    `record_travel_failure`. #76 accepted the race between them because nothing in the application
--    deleted a `travel_time` row, so a backoff row left standing beside a cached answer suppressed
--    nothing. Part 3 of this migration deletes `travel_time` rows, and #47 wants them re-asked; the
--    day the entry named has come, and a leftover backoff row now delays a re-ask by up to a day.
--    A transaction-scoped advisory lock on the key, taken by both writers, is what the entry said
--    closing it takes. It is a lock per cached journey, most of them on the interactive path, and it
--    is held for one insert — cheaper than the sentence describing it.
--
-- 2. Nothing changes in the schema for a 300: `tfl.ts` now classifies it as transient, so it is
--    never written here. What was already written is part 3.
--
-- 3. The rows that were demonstrably poisoned are deleted, so `travel_gaps` derives them again and
--    the backfill re-asks — which is the property the derived backlog was chosen for. The set is
--    the conservative one from the design pass on #47, and the shape of the data decides it:
--
--      - Walking has a hard cliff at two miles: 1,597 walks beyond it were asked and TfL planned
--        none of them. Those negatives are honest, and re-asking them spends ~1,600 calls to be told
--        the same thing. Walking rows are deleted only under a mile — where 347 succeeded and 11 did
--        not, which is the signature of a fault rather than of distance.
--      - Cycling and transit show no distance signal at all: 2–5% no-route in every band, including
--        the one where nearly everything else succeeded. Those are random failures written down as
--        verdicts, and all of them go.
--      - Any row whose reason is the old 300 sentence goes whatever its mode: that sentence was the
--        misclassification itself.
--      - Rows carrying one of our own refusals (`tooFarToWalk`) are untouched. A constant settled
--        them, not TfL, and re-deriving changes nothing.
--
--    ~250 legs at the backfill's pace is about an hour of work, and only the legs a hunt still wants
--    come back at all: `travel_gaps` derives from live properties and places, so a deleted row for
--    an archived flat is simply gone.
--
--    The backoff rows for the same keys go with them. They are the very thing part 1 exists to stop
--    surviving a deletion, and the ones that already exist would each hold a re-ask back until their
--    `next_attempt_at`.
-- ------------------------------------------------------------------------------------------------

-- The lock, as one function, so the two writers cannot hash two different strings for one key and
-- lock against nobody. Service role only: the writers below run as their owner and reach it, and a
-- client that could take arbitrary advisory locks could hold the cache still.
create or replace function public.lock_travel_journey(
  p_origin_postcode text,
  p_dest_postcode   text,
  p_mode            text
)
returns void
language sql
as $$
  select pg_advisory_xact_lock(
    hashtextextended('travel:' || p_origin_postcode || '|' || p_dest_postcode || '|' || p_mode, 0));
$$;

revoke execute on function public.lock_travel_journey(text, text, text) from public, anon, authenticated;
grant execute on function public.lock_travel_journey(text, text, text) to service_role;

create or replace function public.cache_travel(
  p_origin_postcode text,
  p_dest_postcode   text,
  p_mode            text,
  p_seconds         int default null,
  p_changes         int default null,
  p_no_route        boolean default false,
  p_journeys        jsonb default null,
  p_basis           text default null,
  p_reason          text default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_origin text := nullif(trim(p_origin_postcode), '');
  v_dest   text := nullif(trim(p_dest_postcode), '');
  v_reason text := nullif(trim(p_reason), '');
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
  -- A reason on a row that has a number is a contradiction rather than extra colour: it would be
  -- drawn nowhere, and it means the caller thinks it wrote a refusal and did not.
  if v_reason is not null and not p_no_route then
    raise exception 'cache_travel: a journey of % seconds does not need a reason for having none', p_seconds;
  end if;
  -- And the other way round, which is the whole point of the column. Refused in the body rather
  -- than by the signature because eight positional arguments still resolve here with the ninth
  -- defaulted (see `20260816150000_travel_time_reason.sql`).
  if p_no_route and v_reason is null then
    raise exception 'cache_travel: a cached "there is no journey" has to say what settled it';
  end if;

  -- Held until this transaction ends, and taken by `record_travel_failure` on the same key, so a
  -- failure report for this journey either sees this row committed or is written before it and
  -- cleared by the caller's `clear_travel_failure` afterwards. Neither order leaves a backoff row
  -- standing over an answer.
  perform public.lock_travel_journey(v_origin, v_dest, p_mode);

  insert into public.travel_time (
    origin_postcode, dest_postcode, mode, seconds, changes, no_route, journeys, basis, reason, computed_at)
  values (v_origin, v_dest, p_mode, p_seconds, p_changes, p_no_route, p_journeys, p_basis, v_reason, now())
  on conflict (origin_postcode, dest_postcode, mode) do update set
    seconds = excluded.seconds,
    changes = excluded.changes,
    no_route = excluded.no_route,
    journeys = excluded.journeys,
    basis = excluded.basis,
    -- Cleared on a row that has just become a real answer, rather than left standing over it.
    reason = excluded.reason,
    computed_at = now();
end;
$$;

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
-- Keyed exactly as `cache_travel` keys the answer — trimmed — because a backoff is only ever about
-- a pair the cache might hold, and a key nothing will ever match is outstanding forever. See the
-- original in `20260815160000_travel_backfill.sql`.
declare
  v_origin text := nullif(trim(p_origin_postcode), '');
  v_dest   text := nullif(trim(p_dest_postcode), '');
begin
  if not public.is_service_role() then
    raise exception 'record_travel_failure: the travel function records these, not clients';
  end if;
  if v_origin is null or v_dest is null then
    raise exception 'record_travel_failure: both postcodes are required';
  end if;

  -- A failure that arrives after the answer did is not a failure to back off on. Under read
  -- committed the `not exists` below cannot see a `cache_travel` insert that has not committed, so
  -- on its own it let a losing run whose snapshot predated the winner's commit record a backoff the
  -- winner's `clear_travel_failure` had already been and gone for. The lock closes that: the winner
  -- holds the key until its insert commits, so this statement's snapshot is taken after it.
  perform public.lock_travel_journey(v_origin, v_dest, p_mode);

  insert into public.travel_backoff as tb (
    origin_postcode, dest_postcode, mode, attempts, last_error, next_attempt_at, updated_at)
  select v_origin, v_dest, p_mode, 1, p_error, now() + interval '5 minutes', now()
   where not exists (
     select 1 from public.travel_time tt
      where tt.origin_postcode = v_origin
        and tt.dest_postcode   = v_dest
        and tt.mode            = p_mode)
  on conflict (origin_postcode, dest_postcode, mode) do update set
    attempts        = tb.attempts + 1,
    last_error      = excluded.last_error,
    -- Capped at 8 doublings before the `least` so the interval arithmetic stays small whatever the
    -- attempt count reaches.
    next_attempt_at = now() + least(interval '24 hours', interval '5 minutes' * power(2, least(tb.attempts, 8))),
    updated_at      = now();

  -- Said out loud rather than returned silently: declining to record is the right answer to a race
  -- and the wrong answer to anything else, and the two are told apart only by how often this
  -- appears in the log.
  if not found then
    raise notice 'record_travel_failure: % -> % (%) is already answered; not backing off a failure the cache overtook',
      v_origin, v_dest, p_mode;
  end if;
end;
$$;

-- ------------------------------------------------------------------------------------------------
-- Part 3: the cleanup.
-- ------------------------------------------------------------------------------------------------

do $$
declare
  v_rows     int;
  v_backoffs int;
begin
  create temp table doomed on commit drop as
  select tt.origin_postcode, tt.dest_postcode, tt.mode
    from public.travel_time tt
   where tt.no_route
     and (
       tt.mode in ('cycling', 'transit')
       or tt.reason like 'TfL could not resolve %'
       or (
         tt.mode = 'walking'
         and tt.reason is null
         -- Under a mile in a straight line, measured from any property at that postcode with a
         -- whole pair of coordinates — the postcode's own point first, Rightmove's pin otherwise,
         -- as `travel_gaps` picks — to a place at the destination postcode. A pair nothing can
         -- place is left alone: a refusal to delete needs a measurement as much as a refusal to
         -- ask does.
         and exists (
           select 1
             from public.property p
             cross join lateral (
               select case when p.postcode_lat is not null and p.postcode_lon is not null then p.postcode_lat
                           when p.latitude     is not null and p.longitude     is not null then p.latitude end as lat,
                      case when p.postcode_lat is not null and p.postcode_lon is not null then p.postcode_lon
                           when p.latitude     is not null and p.longitude     is not null then p.longitude end as lon
             ) as o
             join public.place pl on trim(pl.postcode) = tt.dest_postcode
            where trim(p.postcode) = tt.origin_postcode
              and o.lat is not null and pl.lat is not null and pl.lon is not null
              -- Haversine, in miles, as `distanceMiles` in `hubs.ts` computes it.
              and 2 * 3958.7613 * asin(least(1::double precision, sqrt(
                    power(sin(radians(pl.lat - o.lat) / 2), 2)
                    + cos(radians(o.lat)) * cos(radians(pl.lat)) * power(sin(radians(pl.lon - o.lon) / 2), 2)
                  ))) < 1
         )
       )
     );

  delete from public.travel_time tt
   using doomed d
   where tt.origin_postcode = d.origin_postcode
     and tt.dest_postcode   = d.dest_postcode
     and tt.mode            = d.mode;
  get diagnostics v_rows = row_count;

  delete from public.travel_backoff tb
   using doomed d
   where tb.origin_postcode = d.origin_postcode
     and tb.dest_postcode   = d.dest_postcode
     and tb.mode            = d.mode;
  get diagnostics v_backoffs = row_count;

  raise notice 'travel cache cleanup: % poisoned no-route rows deleted, % backoff rows with them; travel_gaps re-derives the legs a hunt still wants',
    v_rows, v_backoffs;
end;
$$;
