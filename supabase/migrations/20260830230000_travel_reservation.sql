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

  -- A claim whose request died is given up on rather than left holding capacity for ever. This
  -- person's only: the delete runs under this person's lock, and sweeping the whole table from
  -- under it would have two callers taking row locks on each other's rows in an order neither
  -- controls. A crashed row for somebody who never comes back therefore sits there until their
  -- account goes, which costs a row and no capacity.
  delete from public.travel_claim c
   where c.user_id = p_user_id
     and c.claimed_at < now() - p_stale_after;

  v_used := public.travel_calls_since(p_user_id, now() - p_window);
  select coalesce(sum(c.calls), 0) into v_held
    from public.travel_claim c where c.user_id = p_user_id;

  -- Bigger than the whole allowance, which is not a wait. An ask of 400 against a limit of 300
  -- is refused at an empty minute exactly as it is at a full one, so answering 'rate-limited'
  -- would put "try again in a minute" on a screen where a minute changes nothing. Said apart,
  -- and checked before the usage test so the two cannot be confused by a busy minute.
  if p_calls > p_limit then
    return jsonb_build_object(
      'status', 'too-large',
      'asked', p_calls, 'limit', p_limit);
  end if;

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
-- Give the reservation back, and record what was spent.
--
-- `p_made` is the calls that left for TfL. Anything reserved and not spent is released by the
-- delete, which is what stops a cache-heavy page load from being billed for the calls it saved.
--
-- THE LEDGER IS WRITTEN FIRST, AND FROM THE ARGUMENTS. Whose the calls were is a fact the caller
-- holds; it does not depend on the reservation row still being there. A batch that outran
-- `p_stale_after` has had its claim swept, and reading the attribution back off the row would then
-- leave real TfL calls out of `api_usage` — which is what `travel_calls_since` counts, so the next
-- minute's cap would be computed off a short number and the admin console would under-report. The
-- swept claim is reported through the return value rather than raised on: the calls are already
-- made and the answer is already correct.
-- ---------------------------------------------------------------------------------------------

create or replace function public.release_travel_calls(
  p_reservation bigint,
  p_user_id     uuid,
  p_project_id  uuid,
  p_made        int
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_released int;
begin
  if not public.is_service_role() then
    raise exception 'release_travel_calls: reservations are released by the travel function, not by clients';
  end if;
  if p_user_id is null then
    raise exception 'release_travel_calls: a release must name the person the calls are charged to';
  end if;
  if p_made is null or p_made < 0 then
    raise exception 'release_travel_calls: % is not a number of calls made', p_made;
  end if;

  if p_made > 0 then
    perform public.record_api_usage(p_project_id, p_user_id, 'tfl', p_made, 0, 0, null, 'travel');
  end if;

  -- Both, not the id alone. A claim belongs to a person, and this function is handed the two
  -- separately — so a caller whose pair is out of step would otherwise release capacity that
  -- was never theirs and be told it worked. `service_role` bounds who can make that mistake,
  -- not what it costs when they do.
  delete from public.travel_claim c where c.id = p_reservation and c.user_id = p_user_id;
  get diagnostics v_released = row_count;
  return v_released > 0;
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
    'public.release_travel_calls(bigint, uuid, uuid, int)'
  ] loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;
