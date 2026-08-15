-- Keep every price observation, including two in one transaction.
--
-- `property_price` was keyed on `(rightmove_id, seen_at)` with `seen_at default now()`, and `now()`
-- is the *transaction* start time rather than the wall clock. A transaction that changed a
-- property's price twice — a fill-in run touching the same listing twice, a backfill overlapping a
-- live write — produced two rows with an identical key, and the `on conflict do nothing` on the
-- trigger's insert threw the second away. The observation that was lost is the later one, which is
-- the one that is true.
--
-- A surrogate key and `clock_timestamp()`. Neither alone is enough: `clock_timestamp()` still does
-- not promise two distinct microsecond readings, and a surrogate key with `now()` would store the
-- two changes as though they happened at the same instant. Ordering stays on `seen_at`, which is
-- what every reader already sorts by.
-- ---------------------------------------------------------------------------------------------

alter table property_price add column if not exists id bigint generated always as identity;

do $$
begin
  if exists (
    select 1 from pg_constraint
     where conrelid = 'property_price'::regclass and contype = 'p' and conname = 'property_price_pkey'
  ) then
    alter table property_price drop constraint property_price_pkey;
  end if;
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'property_price'::regclass and contype = 'p'
  ) then
    alter table property_price add constraint property_price_pkey_id primary key (id);
  end if;
end $$;

alter table property_price alter column seen_at set default clock_timestamp();

-- The read path is unchanged and still wants this: everything ever seen for one listing, newest
-- first. It was riding on the old primary key.
create index if not exists property_price_listing_idx on property_price (rightmove_id, seen_at desc);

-- The trigger loses its conflict target along with the key it named. Nothing replaces it: the
-- trigger only fires when the price actually changed (`is distinct from` on the old row), so there
-- is no duplicate for it to swallow — and swallowing one was the bug.
create or replace function public.record_price()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.price is null then
    return null;
  end if;
  if tg_op = 'UPDATE' and new.price is not distinct from old.price then
    return null;
  end if;
  insert into public.property_price (rightmove_id, price)
  values (new.rightmove_id, new.price);
  return null;
end;
$$;
