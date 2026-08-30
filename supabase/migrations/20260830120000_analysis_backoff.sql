-- A charged analysis failure stops being re-paid on every sweep.
--
-- `claim_analysis` re-claimed any row sitting at `failed`, unconditionally and forever. That is the
-- right answer for a transient failure and the wrong one for a deterministic failure — output
-- truncated at MAX_OUTPUT_TOKENS, or output that will not validate — because the same forty photos
-- fail the same way next time. And the failure path in the `analyse` function records the usage
-- *before* it releases the claim, correctly: OpenAI billed for those tokens whether or not an
-- answer came back. So each re-claim was a full vision call, charged, for nothing.
--
-- The loop closed through the sweep. `getSweepKnowledge` counts a listing complete only on a `done`
-- analysis, so a failed one leaves the flat `partial`, `pendingSightings` keeps it, and the
-- unattended sweep's fill-in pass opens every pending sighting — which requests the analysis again.
-- One broken listing therefore cost roughly $0.10-0.17 of a $20 monthly cap on every run, and
-- nothing on any screen said so.
--
-- This is the shape `travel_backoff` has had since 20260815160000, applied to the path that spends
-- real money rather than a free API quota. The columns live on `property_analysis` rather than in a
-- table of their own because, unlike a travel leg, there is already exactly one row per listing to
-- hang them on.

alter table property_analysis
  add column if not exists attempts        int not null default 0,
  add column if not exists next_attempt_at timestamptz;

comment on column property_analysis.attempts is
  'Charged attempts that ended in failure. Reset to 0 by a successful analysis; a row that reaches the ceiling in claim_analysis is not claimed again.';
comment on column property_analysis.next_attempt_at is
  'When a failed row may be claimed again. Null on a row that has never failed, which reads as "now".';

-- Rows that failed before this migration have no history, so they get one more go rather than
-- being written off on a count nobody kept. `attempts = 0` is what the default already gives them;
-- this is here to say that it is deliberate and not an oversight.
--
-- The ceiling and the doubling are stated once, in `claim_analysis` and `record_analysis_failure`
-- below. Five attempts spread over five minutes, ten, twenty, forty and eighty is a little over two
-- hours of trying, which is long enough to ride out an OpenAI outage and short enough that nobody
-- waits a day for a listing that was only briefly unlucky.

-- ------------------------------------------------------------------------------------------------
-- Recording a failure: one statement, so the count cannot be lost to a race.
-- ------------------------------------------------------------------------------------------------

-- Read-modify-write from the function would drop increments whenever two runs failed the same
-- listing at once — which is exactly when a listing is failing hard — and an undercounted row is one
-- that never reaches the ceiling. `attempts + 1` in SQL cannot do that.
-- The failure is recorded against the claim that produced it, not merely against the listing. A run
-- that overshot the stale timeout has already had its claim taken over by somebody else, and a
-- write keyed on `rightmove_id` alone would land on the *new* run's row: releasing a claim that is
-- still spending — which frees its reservation and lets a third run start on the same listing — and
-- charging its `attempts` for a failure that was not its. `claimed_at` is that identifier already,
-- since a takeover is what moves it, so nothing new has to be stored to have one.
create or replace function public.record_analysis_failure(
  p_rightmove_id text,
  p_claimed_at   timestamptz,
  p_error        text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_service_role() then
    raise exception 'record_analysis_failure: the analyse function records these, not clients';
  end if;
  if p_rightmove_id is null or p_claimed_at is null then
    raise exception 'record_analysis_failure: a listing id and the claim it was recorded under are both required';
  end if;

  update public.property_analysis
     set status          = 'failed',
         error           = p_error,
         attempts        = attempts + 1,
         -- Capped at 8 doublings before the `least` so the interval arithmetic stays small whatever
         -- the count reaches, matching `record_travel_failure`. The ceiling in `claim_analysis`
         -- bites long before that here; the cap is what stops a future raise of the ceiling turning
         -- into an overflow.
         next_attempt_at = now() + least(
           interval '24 hours',
           interval '5 minutes' * power(2, least(attempts, 8)))
   where rightmove_id = p_rightmove_id
     and claimed_at   = p_claimed_at;

  -- Nothing matched. Either the row has been deleted underneath a running analysis, or this run's
  -- claim was taken over while it was working and the row now belongs to somebody else. Both are
  -- worth a line: the usage has already been recorded, so the charge is on the books either way,
  -- and this is the only trace of what it bought.
  if not found then
    raise notice 'record_analysis_failure: no analysis row for % still claimed at %; the charge is recorded but the failure is not', p_rightmove_id, p_claimed_at;
  end if;
end;
$$;

revoke execute on function public.record_analysis_failure(text, timestamptz, text) from public, anon, authenticated;
grant execute on function public.record_analysis_failure(text, timestamptz, text) to service_role;

-- ------------------------------------------------------------------------------------------------
-- Claiming: a failed row is claimable again only while it has attempts left and its wait is up.
-- ------------------------------------------------------------------------------------------------

-- Replaced whole rather than patched, because the body is the spend cap and splitting it across two
-- migrations would leave the caps described in one file and enforced in another. Everything above
-- the insert is unchanged from 20260809310000_multi_tenant.sql.
-- The two defaults are repeated from 20260809310000 because they have to be: `create or replace`
-- cannot drop a parameter default that the existing function has, and Postgres refuses the whole
-- statement with 42P13 rather than quietly accepting the narrower signature. Omitting them here
-- failed at `supabase start` — which is the only place it *can* fail, since nothing in `check:all`
-- applies a migration.
create or replace function public.claim_analysis(
  p_rightmove_id text,
  p_project_id   uuid,
  p_user_id      uuid,
  p_estimate_usd numeric  default 0.10,
  p_stale_after  interval default '10 minutes'
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_month_start   timestamptz := public.month_start_london();
  v_resets_at     timestamptz := public.month_start_london() + interval '1 month';
  v_project_cap   numeric;
  v_user_cap      numeric;
  v_project_spent numeric;
  v_user_spent    numeric;
  v_project_held  numeric;
  v_user_held     numeric;
  v_claimed       int;
  -- The claim's identifier, handed back to the caller so that the failure it may later record can
  -- be matched to it. `now()` is transaction time, so this is the same instant the row is stamped
  -- with, and a takeover — the only other thing that writes `claimed_at` — necessarily moves it.
  v_claimed_at    timestamptz := now();
  -- A literal rather than a parameter. Making it an argument would change this function's
  -- signature, and the revoke/grant pair below names the signature exactly — an overload would
  -- leave the old one in place, still callable, still re-claiming forever. Nothing needs to vary
  -- it: the only caller is the analyse function.
  c_max_attempts  constant int := 5;
begin
  if p_project_id is null or p_user_id is null then
    raise exception 'claim_analysis: a claim must name the project and the user it is charged to';
  end if;

  -- Project first, then user. The fixed order is the whole deadlock argument.
  perform pg_advisory_xact_lock(hashtextextended('rm:project:' || p_project_id::text, 0));
  perform pg_advisory_xact_lock(hashtextextended('rm:user:' || p_user_id::text, 0));

  select p.monthly_cap_usd into v_project_cap from project p where p.id = p_project_id;
  select p.monthly_cap_usd into v_user_cap from profile p where p.id = p_user_id;
  if v_project_cap is null or v_user_cap is null then
    raise exception 'claim_analysis: no cap for project % / user % — refusing rather than treating an unknown budget as unlimited', p_project_id, p_user_id;
  end if;

  select coalesce(sum(u.cost_usd), 0) into v_project_spent
    from api_usage u where u.project_id = p_project_id and u.occurred_at >= v_month_start;
  select coalesce(sum(u.cost_usd), 0) into v_user_spent
    from api_usage u where u.user_id = p_user_id and u.occurred_at >= v_month_start;

  -- In flight: live claims only. A stale one has already been given up on and its reservation has
  -- drained, which is what stops a crash from permanently consuming budget.
  select count(*) * p_estimate_usd into v_project_held
    from property_analysis a
   where a.status = 'running'
     and a.claimed_by_project = p_project_id
     and a.claimed_at >= now() - p_stale_after
     and a.rightmove_id <> p_rightmove_id;
  select count(*) * p_estimate_usd into v_user_held
    from property_analysis a
   where a.status = 'running'
     and a.claimed_by_user = p_user_id
     and a.claimed_at >= now() - p_stale_after
     and a.rightmove_id <> p_rightmove_id;

  if v_project_spent + v_project_held + p_estimate_usd > v_project_cap then
    return jsonb_build_object(
      'status', 'capped', 'scope', 'project',
      'spent', round(v_project_spent, 6), 'reserved', round(v_project_held, 6),
      'cap', v_project_cap, 'resets_at', v_resets_at);
  end if;

  if v_user_spent + v_user_held + p_estimate_usd > v_user_cap then
    return jsonb_build_object(
      'status', 'capped', 'scope', 'user',
      'spent', round(v_user_spent, 6), 'reserved', round(v_user_held, 6),
      'cap', v_user_cap, 'resets_at', v_resets_at);
  end if;

  -- The claim itself. The primary key makes exactly one caller win, and a run that died mid-flight
  -- can be taken over once it goes stale, so one crash does not block a listing forever.
  --
  -- What is new is the two conditions on the `failed` branch. A failure is retried while it still
  -- has attempts left *and* its wait is up; past either, the row stays as it is and the caller is
  -- told `busy`, which the analyse function already reports as `cached`. The count is deliberately
  -- not cleared here — a claim is an attempt beginning, not one succeeding, and zeroing it on claim
  -- would mean the ceiling could never be reached. The trigger at the foot of this file clears it
  -- when an analysis actually lands.
  insert into property_analysis (rightmove_id, status, claimed_at, claimed_by_project, claimed_by_user)
  values (p_rightmove_id, 'running', v_claimed_at, p_project_id, p_user_id)
  on conflict (rightmove_id) do update
    set status = 'running',
        claimed_at = v_claimed_at,
        error = null,
        claimed_by_project = excluded.claimed_by_project,
        claimed_by_user = excluded.claimed_by_user
    where (property_analysis.status = 'failed'
           and property_analysis.attempts < c_max_attempts
           and coalesce(property_analysis.next_attempt_at, now()) <= now())
       or (property_analysis.status = 'running'
           and property_analysis.claimed_at < now() - p_stale_after);

  get diagnostics v_claimed = row_count;

  if v_claimed = 0 then
    return jsonb_build_object('status', 'busy');
  end if;
  return jsonb_build_object('status', 'claimed', 'claimed_at', v_claimed_at);
end;
$$;

revoke execute on function public.claim_analysis(text, uuid, uuid, numeric, interval)
  from public, anon, authenticated;
grant execute on function public.claim_analysis(text, uuid, uuid, numeric, interval) to service_role;

-- ------------------------------------------------------------------------------------------------
-- A successful analysis clears the history.
-- ------------------------------------------------------------------------------------------------

-- The `analyse` function writes its result with a PostgREST patch, which cannot express "and reset
-- these two". A trigger can, and it belongs here rather than in the function for the same reason
-- `enter_funnel` lives in the database: it is a rule about the row, not about one writer of it.
create or replace function public.clear_analysis_backoff()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.status = 'done' then
    new.attempts := 0;
    new.next_attempt_at := null;
  end if;
  return new;
end;
$$;

drop trigger if exists clear_analysis_backoff on property_analysis;
create trigger clear_analysis_backoff
  before update on property_analysis
  for each row
  when (new.status = 'done' and (old.attempts > 0 or old.next_attempt_at is not null))
  execute function public.clear_analysis_backoff();
