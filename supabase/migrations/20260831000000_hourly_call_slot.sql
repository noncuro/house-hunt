-- One hourly slot, claimed rather than checked. Closes #117.
--
-- Both routes that fetch Rightmove hold a per-user hourly limit, and both checked it in two
-- statements: count the last hour's rows out of `api_usage`, decide, then insert one. So N requests
-- arriving together all read the same count and all proceed, and the overshoot is bounded by
-- concurrency rather than by the limit.
--
-- Neither shape was new — both predate the move to Vercel routes and were ported unchanged — and a
-- handful of extra requests in a burst does not breach anything. A caller stuck in a retry loop
-- does, and the no-crawl rule those limits enforce (`resolve-location/route.ts`) is the thing that
-- is worth defending against exactly that.
--
-- This is `claim_analysis`'s argument on a cheaper resource: an advisory lock held for the
-- transaction is what makes the read and the write one step. It is deliberately *not* the same
-- function. `claim_analysis` guards money — it counts spend plus live reservations, takes two locks
-- in a fixed order, and hands back a reservation somebody has to release — because an overshoot
-- there is a bill. Here the call is free and the row is the whole record, so a claim either takes a
-- slot or does not, and there is nothing to give back.
--
-- The row it writes is the row the routes write today: `cost_usd = 0`, no model, no tokens, so it
-- stays out of every sum the spend caps and the admin view take. It must not route through
-- `record_api_usage`, which raises when there is no `model_price` row for the model it is handed —
-- that would turn the limiter into an outage on the path it exists to protect.

create or replace function claim_hourly_call(
  p_user_id uuid,
  p_project_id uuid,
  p_kind text,
  p_limit int,
  p_rightmove_id text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_used int;
begin
  if p_limit is null or p_limit < 1 then
    raise exception 'claim_hourly_call needs a limit of at least 1, got %', p_limit;
  end if;

  -- On the user and the kind together, so a person hitting their listing limit is not also waiting
  -- behind their own location lookups. Every caller of this takes exactly one lock and holds it to
  -- the end of the transaction, so there is no order to get wrong and nothing to deadlock against.
  perform pg_advisory_xact_lock(hashtextextended('rm:hourly:' || p_kind || ':' || p_user_id::text, 0));

  select count(*)
    into v_used
    from api_usage
   where user_id = p_user_id
     and kind = p_kind
     and occurred_at > now() - interval '1 hour';

  if v_used >= p_limit then
    return jsonb_build_object('status', 'rate-limited', 'used', v_used, 'limit', p_limit);
  end if;

  insert into api_usage (project_id, user_id, kind, cost_usd, rightmove_id,
                         input_tokens, cached_input_tokens, output_tokens)
  values (p_project_id, p_user_id, p_kind, 0, p_rightmove_id, 0, 0, 0);

  -- The count *including* this claim, which is what the caller reports and what the next request
  -- will read. Returning the pre-insert number would have the last permitted call say it had used
  -- one fewer than it had.
  return jsonb_build_object('status', 'claimed', 'used', v_used + 1, 'limit', p_limit);
end;
$$;

-- A client must not be able to spend its own allowance without making the call, nor to skip it.
revoke execute on function claim_hourly_call(uuid, uuid, text, int, text) from public, anon, authenticated;
grant execute on function claim_hourly_call(uuid, uuid, text, int, text) to service_role;
