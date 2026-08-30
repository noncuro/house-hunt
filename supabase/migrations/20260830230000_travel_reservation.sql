-- The travel rate limit becomes a reservation, because a check is not a limit.
--
-- `checkRate` read the last minute's usage and returned; `recordCalls` wrote afterwards, once every
-- TfL request had already gone out. Two holes follow, and neither is visible from the outside:
--
--   * Two requests arriving between a read and its matching write both see the pre-write count, so
--     the effective ceiling is 300 times however many requests are in flight. A grid opening twenty
--     flats at once is exactly that shape, and it is the ordinary case rather than an attack.
--   * The check ran once, before the body was even parsed, and nothing downstream bounded how many
--     legs the body asked for. One journey ask naming 301 destinations is 301 possible calls; one
--     station ask with 151 names is up to 302. A single request could spend the whole allowance and
--     then some, having passed a check that said it was inside it.
--
-- So capacity is claimed before dispatch instead of counted after it. This is `claim_analysis`'s
-- argument on a different resource: the budget is shared state, so the claim has to touch it, and
-- an advisory lock held for the transaction is what makes the read and the write one step. What is
-- being rationed here is TfL's goodwill rather than money, but the failure is identical — a limit
-- that reads correctly and binds nothing looks exactly like a limit that works.
--
-- WHY A CLAIM TABLE AND NOT A COUNTER. A reservation has to be released, because the batch is sized
-- on what the cache could not answer and some of those legs turn out not to need a call at all (a
-- walk refused on distance never asks). Releasing a counter is an increment away from being wrong in
-- the direction that matters. A row that is deleted on release, and ignored once stale, cannot
-- over-count: the worst a crashed function does is hold its own capacity for two minutes.
--
-- And it keeps `api_usage` honest. That table's `input_tokens` means "TfL requests made" — it is
-- what the admin console reads and what `travel_calls_since` counts — so a reservation written there
-- would make the ledger record calls nobody made. The claim is held beside it and only the calls
-- that actually happened are recorded, which is the same separation `property_analysis` keeps
-- between a running claim and the `api_usage` row that settles it.

create table if not exists travel_claim (
  id         bigint generated always as identity primary key,
  user_id    uuid not null references auth.users(id) on delete cascade,
  -- Which budget the calls will be recorded against when the claim is released. Null is possible
  -- mid-invite-consumption, the same as everywhere else the active project is read.
  project_id uuid references project(id) on delete set null,
  calls      int not null check (calls > 0),
  claimed_at timestamptz not null default now()
);

create index if not exists travel_claim_user_idx on travel_claim (user_id, claimed_at desc);

-- No policy of any kind, so RLS refuses every client outright; the service role bypasses it and the
-- definer functions below run as the owner. Nobody but the travel function has any business here.
alter table travel_claim enable row level security;
revoke all on table travel_claim from anon, authenticated;

comment on table travel_claim is
  'TfL capacity reserved by an in-flight travel request. Deleted on release; ignored once stale.';

-- ---------------------------------------------------------------------------------------------
-- Claim capacity, or refuse.
--
-- The window and the limit are the caller's, as they were for `travel_calls_since`: the travel
-- function owns what the cap is, and changing its shape must not need a migration. `p_stale_after`
-- is how long a claim from a function that died still holds its capacity — long enough to cover a
-- slow batch of TfL calls, short enough that a crash is forgotten within the window it was
-- competing for.
-- ---------------------------------------------------------------------------------------------

create or replace function public.claim_travel_calls(
  p_user_id     uuid,
  p_project_id  uuid,
  p_calls       int,
  p_limit       int,
  p_window      interval,
  p_stale_after interval default '2 minutes'
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_used int;
  v_held int;
  v_id   bigint;
begin
  if not public.is_service_role() then
    raise exception 'claim_travel_calls: TfL capacity is claimed by the travel function, not by clients';
  end if;
  if p_user_id is null then
    raise exception 'claim_travel_calls: a claim must name the person it is charged to';
  end if;
  if p_calls is null or p_calls < 1 then
    raise exception 'claim_travel_calls: % is not a number of calls to claim', p_calls;
  end if;
  if p_limit is null or p_window is null then
    raise exception 'claim_travel_calls: refusing to claim against an unstated limit — an absent cap is not an unlimited one';
  end if;

  -- The whole point of the function. Everything below reads the allowance and then adds to it, and
  -- without this the two halves are a race that no amount of care in the query prevents. Keyed on
  -- the person, because that is what the cap is per; released with the transaction.
  perform pg_advisory_xact_lock(hashtextextended('rm:travel:' || p_user_id::text, 0));

  -- A claim whose request died is given up on rather than left holding capacity for ever. Deleted
  -- rather than merely ignored so the table does not grow a row per crash.
  delete from public.travel_claim c
   where c.user_id = p_user_id
     and c.claimed_at < now() - p_stale_after;

  v_used := public.travel_calls_since(p_user_id, now() - p_window);
  select coalesce(sum(c.calls), 0) into v_held
    from public.travel_claim c where c.user_id = p_user_id;

  if v_used + v_held + p_calls > p_limit then
    return jsonb_build_object(
      'status', 'rate-limited',
      'used', v_used, 'held', v_held, 'asked', p_calls, 'limit', p_limit);
  end if;

  insert into public.travel_claim (user_id, project_id, calls)
  values (p_user_id, p_project_id, p_calls)
  returning id into v_id;

  return jsonb_build_object('status', 'claimed', 'reservation', v_id);
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Give the reservation back, and record what was actually spent.
--
-- Takes an array because a station ask claims one call at a time — a walk can only be asked for
-- once the station has been placed, so its capacity cannot be claimed before the placing call has
-- returned — and settling them one round trip each would put a database call between every pair of
-- TfL calls.
--
-- `p_made` is the honest number: the calls that left for TfL. Anything reserved and not spent is
-- released by the delete, which is what stops a cache-heavy page load from being billed for the
-- calls it saved.
-- ---------------------------------------------------------------------------------------------

create or replace function public.release_travel_calls(p_reservations bigint[], p_made int)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user    uuid;
  v_project uuid;
begin
  if not public.is_service_role() then
    raise exception 'release_travel_calls: reservations are released by the travel function, not by clients';
  end if;
  if p_reservations is null or array_length(p_reservations, 1) is null then
    raise exception 'release_travel_calls: nothing to release';
  end if;
  if p_made is null or p_made < 0 then
    raise exception 'release_travel_calls: % is not a number of calls made', p_made;
  end if;

  with gone as (
    delete from public.travel_claim c where c.id = any(p_reservations)
    returning c.user_id, c.project_id
  )
  select g.user_id, g.project_id into v_user, v_project from gone g limit 1;

  if p_made = 0 then
    return;
  end if;
  -- The calls happened and there is nothing left saying whose they were, which means the claim went
  -- stale mid-flight: the request outran `p_stale_after`. Said out loud rather than recorded against
  -- a guess, because an unattributed call is exactly the thing the ledger exists to not have.
  if v_user is null then
    raise exception 'release_travel_calls: reservation is gone — % TfL calls cannot be attributed', p_made;
  end if;

  perform public.record_api_usage(
    v_project, v_user, 'tfl', p_made, 0, 0, null, 'travel');
end;
$$;

-- `revoke ... from public` does not touch the explicit grant Supabase's default privileges hand
-- every new function in this schema to `anon` and `authenticated`, so both are named. A client that
-- could call either of these could reserve somebody else's whole minute, or record calls nobody
-- made against their allowance.
do $$
declare f text;
begin
  foreach f in array array[
    'public.claim_travel_calls(uuid, uuid, int, int, interval, interval)',
    'public.release_travel_calls(bigint[], int)'
  ] loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;
