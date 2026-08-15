-- What a flat has cost, over time — because "the price" is a thing that moves, and until now every
-- move was overwritten.
--
-- `property.price` is one text column, rewritten on every sighting. A landlord dropping £3,100 to
-- £2,850 left no trace of it whatsoever: the card showed the new number, and nothing anywhere said
-- it was new. That is the wrong way round for a hunt. A reduction is one of the few signals a
-- listing gives off by itself — it means the place has been sitting, which is both a reason to look
-- again at something you passed on and a reason to think about what you offer.
--
-- A table rather than a `previous_price` column, following `verdict_history`. Two columns answer
-- "has it moved since last time" and nothing else, and a second reduction erases the first — so a
-- flat reduced twice in three weeks, which is the most interesting thing a listing can do, reads
-- identically to one reduced once. The history is small (one row per actual change, not per
-- sighting) and it is the only version of this that can be asked a question later.

create table if not exists property_price (
  rightmove_id text not null references property(rightmove_id) on delete cascade,
  price        text not null,
  seen_at      timestamptz not null default now(),
  primary key (rightmove_id, seen_at)
);

-- The common read is "this flat's prices, newest first" — every card asks it about itself.
create index if not exists property_price_by_listing on property_price (rightmove_id, seen_at desc);

alter table property_price enable row level security;

-- A shared fact table, exactly like `property` itself: what a flat costs is a fact about the flat,
-- not about a project, and two projects watching the same listing see the same history. So the same
-- shape as the other shared caches — everyone signed in may read it, nobody may write it directly,
-- and the only writer is the trigger below. A blanket write grant here would include DELETE, and
-- one buggy client could erase a history no sighting can reconstruct (design D4).
drop policy if exists readable on property_price;
create policy readable on property_price for select to authenticated using (true);

grant select on table property_price to authenticated;
revoke all on table property_price from anon;

-- Recording the change is the database's job, not each client's.
--
-- A trigger rather than another branch in `record_property` for two reasons. `record_property` is
-- already defined twice in `20260809310000_multi_tenant.sql` — the later definition wins — so a
-- third copy is a third place for this to be forgotten. And the property row is written from more
-- than one path; anything that moves the price should land here, whether or not it went through the
-- RPC. A trigger cannot be routed around.
--
-- Only actual changes are stored. Every fill-in run rewrites `price` with the same string it
-- already held, and a row per sighting would bury the three that matter under four hundred that say
-- nothing. `is distinct from` rather than `<>` so that a price appearing or disappearing counts as a
-- change too — `null <> '£2,850 pcm'` is null, which is not true, and the reduction would be lost.
--
-- The first price is recorded as well, on insert. Without it a flat's history starts at its first
-- *reduction*, so the card could say "reduced" but never from what.
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
  -- Two writers landing in the same microsecond would collide on the primary key, and a price
  -- change is not worth failing somebody's fill-in run over. The row is already there either way.
  insert into public.property_price (rightmove_id, price)
  values (new.rightmove_id, new.price)
  on conflict do nothing;
  return null;
end;
$$;

drop trigger if exists property_record_price on property;
create trigger property_record_price
  after insert or update of price on property
  for each row execute function public.record_price();

-- Every price we already hold, as each flat's opening figure. Without this the history begins the
-- next time each listing happens to be reopened, so for weeks the answer to "has this moved" would
-- be "we have no idea" for the entire shortlist — and a card with one price in its history reads as
-- a flat that has never changed, which is a claim rather than a shrug.
insert into property_price (rightmove_id, price, seen_at)
select p.rightmove_id, p.price, coalesce(p.last_seen_at, now())
  from property p
 where p.price is not null
on conflict do nothing;

-- Realtime, so a reduction found by one person's fill-in run shows up on the other's shortlist
-- without a reload — the same as a verdict or a stage.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (
      select 1 from pg_publication_tables
       where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'property_price'
    ) then
      alter publication supabase_realtime add table property_price;
    end if;
  end if;
end $$;
