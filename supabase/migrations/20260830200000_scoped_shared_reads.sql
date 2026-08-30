-- ------------------------------------------------------------------------------------------------
-- The shared fact tables stop being a directory of everybody's hunt.
--
-- `property`, `property_analysis`, `station_point`, `station_walk` and `travel_time` were readable
-- by any signed-in user — `for select to authenticated using (true)`. That is what makes a listing
-- analysed once across every project instead of once each, and it is also why a member of any hunt
-- could `select * from property` and read every address every other household has opened. Not their
-- opinions: those are all predicated on membership already. Just the list of flats, which between
-- two people hunting together is the point and between separate households is a disclosure.
--
-- Deferred deliberately as design D14, on the stated condition "before the first release with users
-- other than the original pair on it". That condition has fired.
--
-- WHAT CHANGES, AND WHAT DELIBERATELY DOES NOT. The cache stays one shared cache: a listing another
-- project paid to analyse is still read for free the moment this project opens it, and
-- `claim_analysis` still finds the existing row and charges nobody. What goes away is *listing the
-- table*. A row is readable when some project you are in has opened the listing it is about — which
-- is exactly the predicate every client read already carried in its own query, so nothing on either
-- surface changes shape.
--
-- WHY POLICIES RATHER THAN A READER FUNCTION. The issue proposed revoking SELECT outright and
-- adding a `SECURITY DEFINER` reader taking an explicit array of ids. That would work, and it would
-- mean rewriting the shortlist — one PostgREST query that embeds the verdict, the funnel row and
-- the analysis — as an RPC returning JSON, on a path no check in this repo can exercise without a
-- browser. The predicate is the same either way; putting it in the policy puts it in the one place
-- that cannot be forgotten by a future read path, which a reader function cannot promise.
-- ------------------------------------------------------------------------------------------------

-- The two questions the policies below ask, as functions, for the same reason `is_member` is one:
-- a policy on `property` that reads `project_member` needs to get past `project_member`'s own
-- policy, and a plain function called from inside a policy recurses. SECURITY DEFINER with a
-- pinned `search_path` is what the rest of this schema uses and what `check:rls` already asserts
-- does not recurse.

create or replace function public.listing_is_mine(p_rightmove_id text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
      from public.project_property pp
      join public.project_member m on m.project_id = pp.project_id
     where pp.rightmove_id = p_rightmove_id
       and m.user_id = auth.uid()
  );
$$;

-- A postcode is mine if it is the postcode of a listing of mine. `travel_time` and `station_walk`
-- are keyed on the origin postcode rather than on the listing, so this is the same question asked
-- one join further out.
create or replace function public.postcode_is_mine(p_postcode text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
      from public.property p
      join public.project_property pp on pp.rightmove_id = p.rightmove_id
      join public.project_member m on m.project_id = pp.project_id
     where p.postcode = p_postcode
       and m.user_id = auth.uid()
  );
$$;

-- `from public` alone would leave Supabase's default grant to `authenticated` in place, which is
-- fine here — both are *called by* `authenticated`, from inside the policies below — but `anon`
-- holds nothing anywhere and these are no exception.
revoke execute on function public.listing_is_mine(text) from public, anon;
revoke execute on function public.postcode_is_mine(text) from public, anon;
grant execute on function public.listing_is_mine(text) to authenticated, service_role;
grant execute on function public.postcode_is_mine(text) to authenticated, service_role;

comment on function public.listing_is_mine(text) is
  'Has any project I am in opened this listing? The read half of design D4, and what replaced the '
  'blanket SELECT on the shared fact tables.';
comment on function public.postcode_is_mine(text) is
  'Is this the postcode of a listing a project of mine has opened? The travel and station caches '
  'are keyed on the postcode rather than the listing, so they ask this instead.';

-- ------------------------------------------------------------------------------------------------
-- The policies.
-- ------------------------------------------------------------------------------------------------

drop policy if exists read_shared_facts on property;
create policy read_shared_facts on property for select to authenticated
  using (public.listing_is_mine(rightmove_id));

drop policy if exists read_shared_facts on property_analysis;
create policy read_shared_facts on property_analysis for select to authenticated
  using (public.listing_is_mine(rightmove_id));

-- Origin only. Every client read filters on `origin_postcode` and maps the destinations back to the
-- project's own places, so scoping the destination as well would narrow nothing anybody reads — and
-- it would be the kind of predicate that silently empties the compare table's travel column the
-- first time a place's postcode is stored in a shape the join does not match. The residue it leaves
-- is a destination postcode, with no label and no project on it, visible to another hunt that has
-- opened the same flat.
drop policy if exists read_shared_facts on travel_time;
create policy read_shared_facts on travel_time for select to authenticated
  using (public.postcode_is_mine(origin_postcode));

drop policy if exists read_shared_facts on station_walk;
create policy read_shared_facts on station_walk for select to authenticated
  using (public.postcode_is_mine(postcode));

-- `station_point` holds TfL's own coordinates for a station and nothing about anybody's hunt, so
-- what leaks here is only which stations have been looked up — which is a weak reading of where
-- people are searching rather than a list of flats. Scoped anyway, through the walks that are the
-- only reason a station is ever resolved, because "weak" is not "none" and the index below is the
-- whole cost.
create index if not exists station_walk_station_idx on station_walk (station_name);

drop policy if exists read_shared_facts on station_point;
create policy read_shared_facts on station_point for select to authenticated
  using (
    exists (
      select 1
        from public.station_walk w
       where w.station_name = station_point.name
         and public.postcode_is_mine(w.postcode)
    )
  );

-- `property_price` is the sixth table and was not on the issue's list because it did not exist when
-- the list was written. It is keyed on `rightmove_id` and was `using (true)`, so it answered the
-- same enumeration question in cheaper words: not the addresses, but the id of every flat anybody
-- has ever opened, and its price history. Same predicate, same reason.
drop policy if exists readable on property_price;
create policy readable on property_price for select to authenticated
  using (public.listing_is_mine(rightmove_id));
