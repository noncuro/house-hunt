-- ------------------------------------------------------------------------------------------------
-- A cached "there is no journey" gets to say why.
--
-- `travel_time.no_route` is one bit, and every view turns it into the same sentence: *TfL says there
-- is no such journey between these two points*. That was true while TfL was the only thing that
-- could settle the question. It stopped being true the moment we started settling some of them
-- ourselves — a walk further off in a straight line than an hour on foot can cover is refused before
-- any call is made — and a hover that credits TfL for a verdict TfL never gave is the kind of
-- confident wrong answer the fail-loudly rule is about. Worse, it is unfalsifiable from the outside:
-- the row looks exactly like a real refusal.
--
-- So the reason travels with the row. Null on every row written before this, which reads as "no
-- more than the bit says" and leaves the existing sentence as the fallback — the honest reading of a
-- row that genuinely does not know any more than that.
--
-- This is also what #47 needs. A TfL 300 — the planner could not resolve an endpoint — is currently
-- cached as a permanent verdict on the destination, and the first thing anybody debugging it wants
-- is the message TfL actually returned.
-- ------------------------------------------------------------------------------------------------

alter table public.travel_time add column if not exists reason text;

comment on column public.travel_time.reason is
  'Why there is no number, in words, for a row that has none. Null means no more than no_route says.';

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

revoke execute on function public.cache_travel(text, text, text, int, int, boolean, jsonb, text, text)
  from public, anon, authenticated;
grant execute on function public.cache_travel(text, text, text, int, int, boolean, jsonb, text, text)
  to service_role;

-- The eight-argument form is dropped so a caller that has not been updated fails at the door rather
-- than quietly writing rows with no reason on them, which is the state this migration exists to end.
drop function if exists public.cache_travel(text, text, text, int, int, boolean, jsonb, text);
