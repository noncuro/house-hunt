-- ------------------------------------------------------------------------------------------------
-- Eight facts that were already on the page and were never read.
--
-- WHY THIS EXISTS. The plan this replaces was eight agent-site adapters, on the premise that
-- Chestertons, Savills, Foxtons, Portico, Dexters and the rest market flats that never reach
-- Rightmove. Measured against five of those sites, they do not: 19/20, 24/24, 10/10, 13/13 and
-- 46/48 of their live lettings were already on Rightmove, and a separate pass over Foxtons and
-- TK International matched 29 of 29 in band, verified against Rightmove's own agent attribution.
-- Branch counts run the same way round — Chestertons' Islington page showed 76 lettings against
-- Rightmove's 79 for the same branch. These are feed-driven sites: the website and the portal
-- render one CRM record.
--
-- The fallback argument was that the agent sites carry richer fields. They do not carry anything
-- __PAGE_MODEL does not. Across the four saved fixtures Rightmove has the full postcode 4/4, floor
-- area 3/4, council tax band 3/4, EPC 4/4, available-from 4/4, deposit 2/4, let type 4/4 and the
-- marketing agent 4/4 — and `toListing` read none of the last five. So the columns below are what
-- the adapters were going to buy, taken from the page this project already decodes.
--
-- WHY THE AGENT IS THREE COLUMNS. `agent_branch_id` is the only stable one; a branch gets renamed
-- and its display name changes under it. `agent_branch` is what a person reads. `agent_company` is
-- what a tally groups on — Dexters has 72 branches, so counting by branch name reports one agent as
-- seventy-two, which is exactly the question "which agents should we support" was asking.
--
-- WHY `let_available_date` IS TEXT. The page says "Now" as often as it says "10/09/2026". Those are
-- both answers and only one is a date; parsing would either drop the useful half or invent a
-- move-in date the agent never gave.
-- ------------------------------------------------------------------------------------------------
-- A property row stops being a Rightmove row, and gains eight facts that were on the page already.
--
-- TWO CHANGES, ONE FUNCTION. `record_property` is a single upsert naming every column, so any
-- column added anywhere rewrites it. Splitting these into two migrations would have meant two
-- copies of the same ninety-line body landing minutes apart, so they are together.
--
-- ---------------------------------------------------------------------------------------------
-- PART ONE: the row knows which site it came from.
--
-- `rightmove_id` is the primary key of ten tables and eight functions and is not renamed here —
-- that buys a better word and no behaviour. What changes is what may go in it. Rightmove keeps its
-- bare numeric id, so every row already written stays readable and every `#card-12345` link
-- somebody bookmarked still resolves; every other site's key is `<site>_<its own id>`.
--
-- WHY `site` AND `external_id` ARE GENERATED. Both are derivable from `rightmove_id` by splitting
-- on the first underscore, and a view that wants "the Foxtons ones" should not be doing that split
-- itself. They were briefly ordinary columns with a check constraint holding the three in step, and
-- the harnesses found the flaw in that within the hour: `record_property` is not the only writer —
-- `check:rls` and `check:spend` insert into `property` with the service role directly — so every
-- writer that ever exists has to remember two columns and get them right.
--
-- Generated columns take that away. The key is the one source of truth, the other two are read off
-- it, and no writer can supply them at all: naming a generated column in an INSERT is an error, so
-- a row whose site disagrees with its key cannot be written by anybody, by any path, including a
-- hand-typed `psql` statement. It also means adding a tenth site needs no migration here — the
-- split is stated as an identity rather than as a list of the nine we have.
--
-- ---------------------------------------------------------------------------------------------
-- PART TWO: eight facts that were already on the page and were never read.
--
-- Measured before the site adapters were built: across seven of the eight agent sites, essentially
-- everything they market is already on Rightmove — 19/20, 24/24, 10/10, 13/13, 46/48, 29/29 in
-- band. Branch counts run the same way round; Chestertons' Islington page showed 76 lettings
-- against Rightmove's 79 for the same branch. These are feed-driven sites: the website and the
-- portal render one CRM record. `docs/multi-site.md` holds the measurement in full.
--
-- The second argument for the adapters was richer fields on the same flats. That one is answerable
-- here rather than by an adapter: across the four saved fixtures Rightmove has the full postcode
-- 4/4, floor area 3/4, council tax band 3/4, EPC 4/4, available-from 4/4, deposit 2/4, let type 4/4
-- and the marketing agent 4/4 — and `toListing` read none of the last five. The columns below are
-- what the adapters were going to buy, taken off the page this project already decodes.
--
-- WHY THE AGENT IS THREE COLUMNS. `agent_branch_id` is the only stable one; a branch gets renamed
-- and its display name changes under it. `agent_branch` is what a person reads. `agent_company` is
-- what a tally groups on — Dexters has 72 branches, so counting by branch name reports one agent as
-- seventy-two, which is exactly the question "which agents should we support" was asking.
--
-- WHY `let_available_date` IS TEXT. The page says "Now" as often as it says "10/09/2026". Those are
-- both answers and only one is a date; parsing would either drop the useful half or invent a
-- move-in date the agent never gave.
-- ------------------------------------------------------------------------------------------------

-- Part one. Dropped first so this migration is re-runnable over the ordinary-column version it
-- briefly was; `if exists` covers the first run, where neither is there.
alter table property drop constraint if exists property_key_matches_site;
alter table property drop column if exists site;
alter table property drop column if exists external_id;

-- An all-digit key is Rightmove's, which is what makes every row written before there were other
-- sites read back correctly without being rewritten. Anything else carries its site as a prefix.
alter table property add column site text
  generated always as (
    case when rightmove_id ~ '^[0-9]+$' then 'rightmove' else split_part(rightmove_id, '_', 1) end
  ) stored;

alter table property add column external_id text
  generated always as (
    case
      when rightmove_id ~ '^[0-9]+$' then rightmove_id
      else substring(rightmove_id from position('_' in rightmove_id) + 1)
    end
  ) stored;

comment on column property.site is
  'Which site this listing was read from — "rightmove", "foxtons", … Generated from rightmove_id, '
  'so it cannot disagree with the key and no writer has to remember it.';
comment on column property.external_id is
  'The site''s own id for the listing, unprefixed — what its own URLs use. Equal to rightmove_id '
  'for Rightmove rows, which is what keeps every pre-existing row and bookmarked link working. '
  'Generated, like site.';

-- Partial, because the question is always "the ones that are not Rightmove": Rightmove is most of
-- the table and an index over it would be read past rather than used.
create index if not exists property_site_idx on property (site) where site <> 'rightmove';

alter table property add column if not exists let_available_date text;
alter table property add column if not exists deposit int;
alter table property add column if not exists let_type text;
alter table property add column if not exists council_tax_band text;
alter table property add column if not exists agent_branch_id int;
alter table property add column if not exists agent_branch text;
alter table property add column if not exists agent_company text;
alter table property add column if not exists agent_phone text;

comment on column property.let_available_date is
  'When the flat is free, worded as the page words it — "Now", or dd/mm/yyyy. Text, not a date: '
  'those are two kinds of answer and parsing turns the first into a lie.';
comment on column property.deposit is
  'Deposit in whole pounds. Null on roughly half of listings, meaning the agent did not say — '
  'never "no deposit".';
comment on column property.agent_branch_id is
  'Rightmove''s own branch id. The stable half of the agent: a branch can be renamed, and this '
  'does not change with it.';
comment on column property.agent_company is
  'The trading name, falling back to the registered one. What to group by when counting agents — '
  'the branch name would split one agent across every office it has.';

-- Indexed because the question this was added to answer — who is marketing what we are looking at —
-- is a group-by over a project's flats, and it is the only new column anything filters on.
create index if not exists property_agent_company_idx on property (agent_company)
  where agent_company is not null;

-- Replaced wholesale rather than altered: the body is a dollar-quoted string, so the column list
-- inside it is invisible to `alter table` and a new column that is not named here is a column that
-- never gets written. Everything not to do with the eight new fields is carried across verbatim
-- from `20260830210000_refuse_stale_property.sql`, including the observed_at staleness gate and its
-- `v_wrote` handling.
--
-- Dropped first rather than `create or replace`d, which would be enough here — the signature and
-- return type are unchanged from that migration — because it is only enough when that migration has
-- already run. Against a database still on the `returns void` version, `create or replace` fails
-- with "cannot change return type of existing function" and the whole migration aborts. Dropping
-- costs the grants and the comment, restated below.
drop function if exists public.record_property(uuid, jsonb);

create function public.record_property(p_project_id uuid, p_property jsonb)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id text := nullif(trim(p_property ->> 'rightmove_id'), '');
  v_observed timestamptz;
  v_wrote boolean;
begin
  if v_id is null then
    raise exception 'record_property: rightmove_id is required';
  end if;
  if nullif(trim(p_property ->> 'url'), '') is null then
    raise exception 'record_property: url is required';
  end if;
  if nullif(trim(p_property ->> 'display_address'), '') is null then
    raise exception 'record_property: display_address is required';
  end if;
  -- The one gate that was ever load-bearing: you write as a project you are actually in.
  if not public.is_member(p_project_id) then
    raise exception 'record_property: not a member of project %', p_project_id;
  end if;

  -- A malformed timestamp raises rather than degrading to now(): a client sending nonsense here is
  -- a client whose readings we cannot order, and quietly treating it as the newest is the failure
  -- this whole function exists to stop.
  v_observed := least(coalesce((nullif(trim(p_property ->> 'observed_at'), ''))::timestamptz, now()), now());

  insert into public.property (
    rightmove_id, url, postcode, display_address, price, bedrooms, bathrooms,
    latitude, longitude, nearest_stations, image_urls, floorplan_urls,
    floor_area_sqft, floor_area_source, floorplan_url, furnish_type, listing_update,
    description,
    let_available_date, deposit, let_type, council_tax_band,
    agent_branch_id, agent_branch, agent_company, agent_phone,
    last_seen_at, written_by_project, written_at, observed_at
  )
  values (
    v_id,
    p_property ->> 'url',
    p_property ->> 'postcode',
    p_property ->> 'display_address',
    p_property ->> 'price',
    (p_property ->> 'bedrooms')::int,
    (p_property ->> 'bathrooms')::int,
    (p_property ->> 'latitude')::double precision,
    (p_property ->> 'longitude')::double precision,
    coalesce(p_property -> 'nearest_stations', '[]'::jsonb),
    coalesce(p_property -> 'image_urls', '[]'::jsonb),
    coalesce(p_property -> 'floorplan_urls', '[]'::jsonb),
    (p_property ->> 'floor_area_sqft')::int,
    p_property ->> 'floor_area_source',
    p_property ->> 'floorplan_url',
    p_property ->> 'furnish_type',
    p_property ->> 'listing_update',
    p_property ->> 'description',
    p_property ->> 'let_available_date',
    (p_property ->> 'deposit')::int,
    p_property ->> 'let_type',
    p_property ->> 'council_tax_band',
    (p_property ->> 'agent_branch_id')::int,
    p_property ->> 'agent_branch',
    p_property ->> 'agent_company',
    p_property ->> 'agent_phone',
    now(), p_project_id, now(), v_observed
  )
  on conflict (rightmove_id) do update set
    url = excluded.url,
    postcode = excluded.postcode,
    display_address = excluded.display_address,
    price = excluded.price,
    bedrooms = excluded.bedrooms,
    bathrooms = excluded.bathrooms,
    latitude = excluded.latitude,
    longitude = excluded.longitude,
    nearest_stations = excluded.nearest_stations,
    image_urls = excluded.image_urls,
    floorplan_urls = excluded.floorplan_urls,
    floor_area_sqft = excluded.floor_area_sqft,
    floor_area_source = excluded.floor_area_source,
    floorplan_url = excluded.floorplan_url,
    furnish_type = excluded.furnish_type,
    listing_update = excluded.listing_update,
    -- Only when the caller actually sent one, so a client that predates the column cannot blank it.
    description = coalesce(excluded.description, property.description),
    -- Same reason, and it is the live one here: every extension in somebody's Chrome today sends a
    -- payload with none of these eight keys, so an unguarded assignment would have the older copy
    -- wipe what a newer one wrote every time it re-read the flat.
    let_available_date = coalesce(excluded.let_available_date, property.let_available_date),
    deposit = coalesce(excluded.deposit, property.deposit),
    let_type = coalesce(excluded.let_type, property.let_type),
    council_tax_band = coalesce(excluded.council_tax_band, property.council_tax_band),
    agent_branch_id = coalesce(excluded.agent_branch_id, property.agent_branch_id),
    agent_branch = coalesce(excluded.agent_branch, property.agent_branch),
    agent_company = coalesce(excluded.agent_company, property.agent_company),
    agent_phone = coalesce(excluded.agent_phone, property.agent_phone),
    last_seen_at = now(),
    written_by_project = excluded.written_by_project,
    written_at = now(),
    observed_at = excluded.observed_at
  where property.observed_at is null or excluded.observed_at >= property.observed_at
  returning true into v_wrote;

  -- The row was seen, whether or not this reading of it was the newest. Kept true separately
  -- because the `where` above governs the whole update list and cannot spare one column.
  if v_wrote is null then
    update public.property set last_seen_at = now() where rightmove_id = v_id;
  end if;

  -- Same statement, same transaction: the property row and this project's claim on it either both
  -- exist or neither does. `first_seen_at` is deliberately not in the update list — it is the one
  -- column here that records something no later visit can tell you. Unconditional: a stale reading
  -- is still this project opening the flat, and refusing the link would take the flat off their
  -- shortlist to punish a tab.
  insert into public.project_property (project_id, rightmove_id, first_seen_at, last_seen_at)
  values (p_project_id, v_id, now(), now())
  on conflict (project_id, rightmove_id) do update set last_seen_at = now();

  return coalesce(v_wrote, false);
end;
$$;

revoke execute on function public.record_property(uuid, jsonb) from public, anon;
grant execute on function public.record_property(uuid, jsonb) to authenticated, service_role;

comment on function public.record_property(uuid, jsonb) is
  'Records what a listing page said, and links it to the calling member''s project, in one '
  'transaction. Both writes or neither: the foreign key from project_property onto property means '
  'a client cannot do these in two calls in either order. Clients do not insert project_property '
  'for a new listing themselves — this is the path. Returns false when the shared row already held '
  'a newer reading of the page and was left alone; the link is made either way.';
