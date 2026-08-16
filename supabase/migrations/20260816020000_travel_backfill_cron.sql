-- ------------------------------------------------------------------------------------------------
-- The travel backlog gets worked by the database that knows about it.
--
-- The schedule used to be a GitHub Actions workflow, which was a reasonable place for it and turned
-- out to be the wrong one for a simple reason: the thing it needed was two repository secrets, and
-- nobody knew they were missing. It ran every fifteen minutes for a day and failed every single time
-- at its own guard, 40 runs out of 40, while the app showed a column of dashes that looked exactly
-- like a slow backlog rather than like a job that had never once started (#41). A schedule that
-- lives beside the data it works on has one fewer place to be misconfigured — the credentials it
-- needs are in the project's own vault rather than in another product's settings page — and it is
-- visible from `cron.job_run_details`, which is the same connection everything else here is debugged
-- from.
--
-- What this does *not* change is the design the backlog rests on: the gap set is still derived
-- (`travel_gaps`), still stores nothing, and still cannot lose work it never enqueued. This is only
-- the alarm clock.
--
-- Two secrets have to be in the vault before it can do anything, and they are deployment identity
-- rather than schema, so they are not here and never will be — see SETUP.md, which has the two
-- `vault.create_secret` calls. Missing, this raises rather than returning quietly: a backfill that
-- silently does nothing is the failure this whole migration exists to end.
-- ------------------------------------------------------------------------------------------------

create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;

-- What the last run asked for, so the next one can tell whether it came back.
--
-- pg_net is asynchronous: `http_post` returns a request id and the answer lands in
-- `net._http_response` later, so the scheduled statement finishes in milliseconds whether the
-- backfill takes two seconds or four minutes. That means pg_cron's own "one run of a job at a time"
-- guarantee protects nothing here — it is already over — and two overlapping runs would draw the
-- same gaps, because nothing is missing any less until the first run has written its answers. They
-- would spend twice the calls on one set of legs. One row, holding what is outstanding.
create table if not exists travel_backfill_run (
  -- Exactly one row, ever. The check is the constraint that says so out loud.
  id           int primary key default 1 check (id = 1),
  request_id   bigint not null,
  requested_at timestamptz not null default now()
);

alter table travel_backfill_run enable row level security;
-- No policy, deliberately. Nothing in either app reads this; `SECURITY DEFINER` below is what
-- touches it, and RLS with no policy is the honest way to say "not for callers".

comment on table travel_backfill_run is
  'The most recent backfill request pg_net was handed, so an overlapping run can be skipped.';

-- How long a request may be outstanding before the next run stops waiting for it.
--
-- Longer than the gap between runs, and that is the whole of the arithmetic. It was six minutes
-- first — comfortably above the call's own 300s timeout, which sounded like the right bound and
-- made the guard above unreachable: the next slot does not arrive for fifteen minutes, by which
-- point every request is already older than six, so nothing was ever seen as outstanding. At
-- sixteen an unanswered request skips exactly one slot and a genuinely stuck one resumes on the
-- next, which is what a stall window is for.
create or replace function travel_backfill_stalled_after() returns interval
language sql immutable as $$ select interval '16 minutes' $$;

/** Ask the travel function to work the backlog down by one run's budget.
 *
 *  Returns the pg_net request id, or null when the run was skipped because the previous one has not
 *  answered yet. Raises when the vault is not set up: the whole point of moving this here was that a
 *  misconfigured schedule should be loud, and the one thing that made the old one quiet was that a
 *  failure looked identical to an empty backlog from the app. */
create or replace function run_travel_backfill(p_budget int default 60)
returns bigint
language plpgsql
security definer
-- `net` and `vault` named explicitly: a `SECURITY DEFINER` function that resolves anything through
-- the caller's `search_path` is the standard way one of these becomes somebody else's code.
set search_path = public, extensions, net, vault
as $$
declare
  v_url      text;
  v_key      text;
  v_previous travel_backfill_run%rowtype;
  v_request  bigint;
begin
  if p_budget is null or p_budget < 1 then
    raise exception 'run_travel_backfill: budget must be at least one TfL call, not %', p_budget;
  end if;

  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'travel_functions_url';
  select decrypted_secret into v_key from vault.decrypted_secrets where name = 'travel_service_role_key';
  if v_url is null or v_key is null then
    raise exception
      'run_travel_backfill: the vault has no % — see SETUP.md',
      case when v_url is null and v_key is null then 'travel_functions_url or travel_service_role_key'
           when v_url is null then 'travel_functions_url'
           else 'travel_service_role_key' end;
  end if;

  select * into v_previous from travel_backfill_run where id = 1;
  if v_previous.request_id is not null
     and v_previous.requested_at > now() - travel_backfill_stalled_after()
     and not exists (select 1 from net._http_response where id = v_previous.request_id)
  then
    raise notice 'run_travel_backfill: request % is still outstanding, skipping this slot', v_previous.request_id;
    return null;
  end if;

  -- Long enough for a full budget of legs, since the function works them inside the one request and
  -- a timeout here abandons the answer rather than the work — the legs would be routed, the cache
  -- written, and the run recorded as a failure.
  select net.http_post(
    url := v_url || '/travel',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      -- Both, because the gateway wants an apikey and the function wants a bearer token; they are
      -- the same secret and it is the service role's, which is what tells `isServiceRole` that this
      -- is the schedule rather than a person.
      'Authorization', 'Bearer ' || v_key,
      'apikey', v_key
    ),
    body := jsonb_build_object('kind', 'backfill', 'budget', p_budget),
    timeout_milliseconds := 300000
  ) into v_request;

  insert into travel_backfill_run (id, request_id, requested_at) values (1, v_request, now())
    on conflict (id) do update set request_id = excluded.request_id, requested_at = excluded.requested_at;

  return v_request;
end;
$$;

-- Nobody's to call. The schedule runs as the owner; a signed-in person has no business spending the
-- project's TfL budget by hand, and `anon` holds nothing anywhere in this schema.
revoke all on function run_travel_backfill(int) from public;
revoke all on function run_travel_backfill(int) from anon, authenticated;

-- Every fifteen minutes, which is the cadence the workflow ran at and the one the budget was chosen
-- against: 60 legs a run is ~240 an hour. `cron.schedule` is keyed on the name, so re-running this
-- migration re-points the same job rather than stacking a second one beside it.
select cron.schedule('travel-backfill', '*/15 * * * *', $$select public.run_travel_backfill(60)$$);
