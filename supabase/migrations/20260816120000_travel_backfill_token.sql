-- ------------------------------------------------------------------------------------------------
-- The schedule stops carrying the master key to prove it is the schedule.
--
-- `run_travel_backfill` sent the service-role key as both `Authorization: Bearer` and `apikey`, and
-- the travel function recognised the schedule by comparing that bearer token against its own copy of
-- the same key. It worked, and it was the wrong credential twice over.
--
-- Too much authority: that key opens every table in this database, and the only thing the schedule
-- is allowed to do with it is ask for `kind: 'backfill'`. One secret, two jobs, so neither could be
-- rotated without the other.
--
-- And too tied to the platform. Supabase now issues two kinds of service key — the legacy JWT and
-- the newer `sb_secret_` — and it injects whichever is current as `SUPABASE_SERVICE_ROLE_KEY`. The
-- vault held one and the function had been given the other, so `run_travel_backfill` returned 401
-- on every run while a hand-rolled curl with the other key came back 200 on the same deployment.
-- Nothing was misconfigured in any way either side could see; the two copies of "the service role
-- key" were simply not the same string, and there was no reason they should have been.
--
-- So the schedule now proves who it is with a secret that exists for nothing else. Three vault
-- entries instead of two, and each says one thing:
--
--   travel_functions_url    where the functions are (unchanged)
--   travel_publishable_key  a key the gateway accepts, which on its own grants nothing
--   travel_backfill_token   random, ours, and worth exactly one capability
--
-- Why the token is not simply in `Authorization`: that header and `apikey` belong to the gateway,
-- which validates them as project keys and rejects a random string before this reaches any of our
-- code. So the publishable key satisfies Kong — safe to hand over, since every table here is
-- `to authenticated` and `anon` holds nothing — and the token travels in `X-Backfill-Token`, which
-- the gateway passes through and the function decides on.
--
-- SETUP.md has the three `vault.create_secret` calls. Missing, this still raises rather than
-- returning quietly, for the reason the original migration gives at length.
-- ------------------------------------------------------------------------------------------------

create or replace function run_travel_backfill(p_budget int default 60)
returns bigint
language plpgsql
security definer
set search_path = public, extensions, net, vault
as $$
declare
  v_url      text;
  v_key      text;
  v_token    text;
  v_missing  text[];
  v_previous travel_backfill_run%rowtype;
  v_request  bigint;
begin
  if p_budget is null or p_budget < 1 then
    raise exception 'run_travel_backfill: budget must be at least one TfL call, not %', p_budget;
  end if;

  select decrypted_secret into v_url   from vault.decrypted_secrets where name = 'travel_functions_url';
  select decrypted_secret into v_key   from vault.decrypted_secrets where name = 'travel_publishable_key';
  select decrypted_secret into v_token from vault.decrypted_secrets where name = 'travel_backfill_token';

  -- Named individually rather than as "the vault is not set up": which one is missing is the whole
  -- of what the person reading this needs, and the three-way `case` the earlier version used to say
  -- it did not survive a third secret.
  v_missing := array_remove(array[
    case when v_url   is null then 'travel_functions_url'   end,
    case when v_key   is null then 'travel_publishable_key' end,
    case when v_token is null then 'travel_backfill_token'  end
  ], null);
  if array_length(v_missing, 1) > 0 then
    raise exception 'run_travel_backfill: the vault has no % — see SETUP.md', array_to_string(v_missing, ' or ');
  end if;

  -- Serialised against another caller before the row is read, not just against the row.
  -- `travel_backfill_run` is the record of what was asked for, and the check below is a read of it
  -- followed by a decision — two runs entering together both see nothing outstanding, both post, and
  -- both draw the same gaps, because nothing is missing any less until the first has written its
  -- answers. The upsert afterwards makes the *table* consistent and the duplicate TfL spend has
  -- already happened. pg_cron will not overlap a job with itself, but a hand-run
  -- `select run_travel_backfill(...)` beside a scheduled one is exactly the case that costs money.
  -- Transaction-scoped, so it is released whether this returns or raises.
  perform pg_advisory_xact_lock(hashtext('travel-backfill'));

  select * into v_previous from travel_backfill_run where id = 1;
  if v_previous.request_id is not null
     and v_previous.requested_at > now() - travel_backfill_stalled_after()
     and not exists (select 1 from net._http_response where id = v_previous.request_id)
  then
    raise notice 'run_travel_backfill: request % is still outstanding, skipping this slot', v_previous.request_id;
    return null;
  end if;

  select net.http_post(
    url := v_url || '/travel',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      -- The gateway's two headers, holding the key that gets past the gateway and nothing more.
      'Authorization', 'Bearer ' || v_key,
      'apikey', v_key,
      -- And the one the function decides on.
      'X-Backfill-Token', v_token
    ),
    body := jsonb_build_object('kind', 'backfill', 'budget', p_budget),
    timeout_milliseconds := 300000
  ) into v_request;

  insert into travel_backfill_run (id, request_id, requested_at) values (1, v_request, now())
    on conflict (id) do update set request_id = excluded.request_id, requested_at = excluded.requested_at;

  return v_request;
end;
$$;

revoke all on function run_travel_backfill(int) from public;
revoke all on function run_travel_backfill(int) from anon, authenticated;

-- The old entry is not dropped here. It is deployment data rather than schema — the same reason it
-- was never created by a migration — and a migration that deletes a secret it did not write is one
-- that destroys a working deployment if this is ever re-run against a project mid-rollout. SETUP.md
-- says to remove it once the schedule is seen to work.
