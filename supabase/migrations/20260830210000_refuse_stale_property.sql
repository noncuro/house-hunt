-- ------------------------------------------------------------------------------------------------
-- A page read yesterday stops overwriting a page read this morning.
--
-- Two hunts open the same flat and share one `property` row — which is the point, and is what makes
-- a listing analysed once rather than once per project. `record_property` upserts the whole row, so
-- whoever writes last wins, and one of the writers can be a tab that has been open since yesterday
-- or a session the browser restored: its numbers are older and they land on top. `written_at` made
-- that diagnosable after the fact and nothing refused it.
--
-- WHAT "NEWER" MEANS HERE. Not when the write arrived — every write arrives now, including the
-- stale one, which is exactly why `written_at` could never adjudicate this. It is **when the page
-- was read**: `toListing` stamps `observedAt` where `__PAGE_MODEL` is decoded, which for a tab
-- opened yesterday is yesterday, and for the `listing` function's server-side fetch is the moment
-- of the fetch. That timestamp rides through the payload and is stored on the row, so the next
-- write has something to be older *than*.
--
-- A client clock is not trustworthy and this does not pretend otherwise. It is capped at `now()` on
-- arrival, so a tab whose clock is a year fast cannot stamp the row unwritable; and a clock that is
-- slow refuses that client's own writes, which is loud and is the safe direction. A payload with no
-- `observed_at` — an older extension in somebody's Chrome — reads as `now()` and keeps today's
-- behaviour exactly.
--
-- WHAT REFUSING DOES NOT MEAN. It refuses the *shared row* and nothing else. The project still gets
-- its `project_property` link, `last_seen_at` still moves on both rows, and the caller is told:
-- the function returns a boolean now, false meaning "a newer reading was already there and was
-- kept". Silence would have been the third wrong answer after overwriting and raising.
-- ------------------------------------------------------------------------------------------------

alter table property add column if not exists observed_at timestamptz;

comment on column property.observed_at is
  'When the page these numbers were read off was read — stamped by the decoder, not by the write, '
  'so a tab open since yesterday carries yesterday. Capped at now() on arrival. Null on rows '
  'written before this existed, which read as "no claim", so the first write with a timestamp wins.';

-- Replaced rather than altered: the return type changes from void, which `create or replace` cannot
-- do. Nothing holds a reference to it — clients call it by name over PostgREST.
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
