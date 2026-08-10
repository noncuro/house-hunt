-- Travel lookups become attributable, because the key making them is now ours.
--
-- The TfL app key used to ship in the extension bundle, which meant the key was public and every
-- call made with it was anonymous. Moving journey and station resolution into the `travel` Edge
-- Function takes the key out of the bundle and puts it in one place — and the moment we are the
-- ones spending it, "who is calling and how often" stops being a curiosity and starts being the
-- thing that keeps a loop somewhere from getting the key rate-limited for everybody.
--
-- `api_usage` already answers that question for the OpenAI spend, already carries a `kind`, and is
-- already what the admin console reads. So this adds no table and no function: it prices TfL at
-- zero so `record_api_usage` will accept it.
--
-- Zero is the honest number, not a placeholder. A TfL journey costs nothing in money; what it costs
-- is goodwill against a rate limit, and the row exists to count calls rather than to charge for
-- them. `price_at` returning null is what `record_api_usage` treats as "refuse rather than record a
-- call as free", and that rule is right for a model whose price nobody has looked up — it would be
-- wrong here, where free is the actual price.
insert into model_price (model, effective_from, input_usd_per_mtok, cached_input_usd_per_mtok, output_usd_per_mtok)
values ('tfl', 'epoch', 0, 0, 0)
on conflict (model, effective_from) do nothing;

-- Counting a user's lookups in the last hour, without handing the client a way to read everyone
-- else's. `api_usage` is admin-readable only, and the function needs a count for one user, so this
-- is the narrowest thing that answers it. Service role alone: the caller is the Edge Function.
create or replace function public.travel_calls_since(p_user_id uuid, p_since timestamptz)
returns int
language sql
security definer
set search_path = public, pg_temp
as $$
  select coalesce(sum(coalesce(input_tokens, 0)), 0)::int
  from public.api_usage
  where user_id = p_user_id
    and kind = 'travel'
    and occurred_at >= p_since;
$$;

-- `input_tokens` carries the call count. Reusing the column rather than adding one keeps this to a
-- single migration with no schema change, and the meaning is stated here and in the function that
-- writes it: for a `kind = 'travel'` row, input_tokens is "TfL requests made", cost is zero, and
-- there are no tokens involved at all.
comment on function public.travel_calls_since(uuid, timestamptz) is
  'TfL requests made by one user since a moment. Reads api_usage rows with kind = ''travel'', where input_tokens holds the request count.';

revoke execute on function public.travel_calls_since(uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.travel_calls_since(uuid, timestamptz) to service_role;
