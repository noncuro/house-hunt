-- Multi-tenant: accounts, projects, invites, spend caps, and the RLS that makes them real.
--
-- Squashed from the ten migrations the multi-tenant change was developed as. They were only ever
-- applied to a local database, so there is nothing in the wild that ran them separately and
-- nothing to preserve by keeping them apart. Timestamped after `amenities` and `natural_light`,
-- which were already applied to the live database and must therefore keep running first — this
-- file's `record_property` knows about the `description` column those added.
--
-- Read in order; each section is the file it came from, unedited except where noted.

-- ===========================================================================
-- 20260809210000_accounts
-- ===========================================================================

-- Accounts, projects and the two helper functions every policy in this database calls.
--
-- This is the first migration written on the assumption that more than two people will hold the
-- bundle. Everything before it took the opposite view: 20260809000000_init.sql says so in its
-- header, and grants the `anon` role full access to every table on the strength of it. That model
-- is dismantled in 20260809270000_rls.sql; this file builds what replaces it.
--
-- Three tables and two functions:
--   profile         one row per auth.users row, created by trigger. Holds admin-ness, the active
--                   project, and a personal spend cap.
--   project         one house hunt.
--   project_member  who is in it.
--
-- Nothing here is destructive and nothing here changes an existing table.

create table if not exists project (
  id              uuid primary key default gen_random_uuid(),
  name            text not null,
  -- Nullable because the first project is seeded by migration, before any auth.users row exists.
  created_by      uuid references auth.users(id) on delete set null,
  monthly_cap_usd numeric(10, 2) not null default 20,
  -- Bounds the invite graph: any member may invite, so without a ceiling the user count grows
  -- without an admin doing anything and every user is a claim on the owner's OpenAI key.
  -- Admin-raisable.
  max_members     int not null default 6,
  created_at      timestamptz not null default now()
);

create table if not exists profile (
  id                uuid primary key references auth.users(id) on delete cascade,
  email             text not null,
  display_name      text,
  is_admin          boolean not null default false,
  -- A user may be in several projects and has exactly one active. Set null rather than cascade so
  -- leaving a project does not delete the person.
  active_project_id uuid references project(id) on delete set null,
  monthly_cap_usd   numeric(10, 2) not null default 20,
  created_at        timestamptz not null default now(),
  last_seen_at      timestamptz
);

create index if not exists profile_email_idx on profile (lower(email));

create table if not exists project_member (
  project_id uuid not null references project(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  role       text not null default 'member' check (role in ('member', 'owner')),
  joined_at  timestamptz not null default now(),
  primary key (project_id, user_id)
);

create index if not exists project_member_user_idx on project_member (user_id);

-- Who is an admin, as data rather than as a literal inside a function.
--
-- A profile cannot be seeded by migration — there is no auth.users row to hang it off until
-- somebody actually signs in — so admin-ness is decided at sign-up time by looking the address up
-- here. Adding an admin is an insert, not a deploy.
create table if not exists admin_email (
  email text primary key
);

-- The table is created empty on purpose. Who the admin is belongs to a deployment rather than to
-- the schema, so it is supplied by `supabase/seed.sql` — untracked, one address, copied from
-- `supabase/seed.example.sql`. Getting it wrong locks the only admin out of the admin view, which
-- is exactly the kind of value that should not be baked into a migration everybody shares. Keep it
-- to one row: every extra row here is a second way to become admin, and the reason to add one is a
-- person, not a hedge.

-- ---------------------------------------------------------------------------------------------
-- The two helpers every policy calls, and the trap they exist to avoid.
--
-- `is_admin()` reads `profile`. A policy ON `profile` that calls it would, if this were an
-- ordinary function, re-enter that policy to answer the question and the query would fail with
-- "infinite recursion detected in policy for relation profile" — an error that names the relation
-- and nothing about the cause. SECURITY DEFINER with a pinned search_path is the fix: the body
-- runs as the owner (postgres, which holds BYPASSRLS), so the read inside never consults a policy.
--
-- The pinned `search_path` is not decoration. A SECURITY DEFINER function with a mutable path is
-- how a caller with CREATE on some schema makes the definer run their table instead of ours.
--
-- `is_member()` has the same shape for the same reason: it is called from policies on tables that
-- join to project_member, and project_member's own policy calls it.
-- ---------------------------------------------------------------------------------------------

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce((select p.is_admin from public.profile p where p.id = auth.uid()), false);
$$;

create or replace function public.is_member(p_project_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.project_member m
     where m.project_id = p_project_id
       and m.user_id = auth.uid()
  );
$$;

-- "Do I share any project with this person?" — what lets one member see another's display name so
-- a verdict can say who set it. Same SECURITY DEFINER reasoning: it is called from the policy on
-- `profile` and reads `profile`'s neighbour table.
create or replace function public.shares_project(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
      from public.project_member mine
      join public.project_member theirs on theirs.project_id = mine.project_id
     where mine.user_id = auth.uid()
       and theirs.user_id = p_user_id
  );
$$;

revoke execute on function public.is_admin() from public;
revoke execute on function public.is_member(uuid) from public;
revoke execute on function public.shares_project(uuid) from public;
grant execute on function public.is_admin() to authenticated, service_role;
grant execute on function public.is_member(uuid) to authenticated, service_role;
grant execute on function public.shares_project(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- A profile exists because an auth.users row does.
--
-- Membership is deliberately NOT created here. An invite is consumed on first successful sign-in
-- by the invite Edge Function, so a pending invite that is never used leaves no membership behind.
-- ---------------------------------------------------------------------------------------------

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.profile (id, email, is_admin)
  values (
    new.id,
    new.email,
    exists (select 1 from public.admin_email a where lower(a.email) = lower(new.email))
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Backfill: any auth.users row that predates the trigger still needs a profile. There are none
-- today, but running this migration twice, or against a project where somebody signed in between
-- steps, must not leave a user without a profile.
insert into public.profile (id, email, is_admin)
select u.id,
       coalesce(u.email, ''),
       exists (select 1 from public.admin_email a where lower(a.email) = lower(u.email))
  from auth.users u
 where not exists (select 1 from public.profile p where p.id = u.id)
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------------------------
-- The project every existing row in this database belongs to.
--
-- A fixed uuid, not a generated one: later migrations in this same change backfill against it, the
-- seed must be idempotent, and a re-run must not create a second project holding half the data.
-- ---------------------------------------------------------------------------------------------

-- The name is a placeholder and is meant to be replaced: `supabase/seed.sql` (untracked, copied
-- from `supabase/seed.example.sql`) renames it to whatever the deployment calls its house hunt,
-- and the Project view can rename it afterwards. The row itself has to be created here rather than
-- in the seed, because the statements below in this same migration attach real data to this id.
insert into project (id, name)
values ('00000000-0000-4000-a000-000000000001', 'House hunt')
on conflict (id) do nothing;

comment on table project is
  'One house hunt. 00000000-0000-4000-a000-000000000001 is the seeded project holding everything '
  'that existed before this database had accounts.';

-- ===========================================================================
-- 20260809220000_project_scope
-- ===========================================================================

-- Give every opinion an owner.
--
-- The split this change turns on: a fact about a listing is global and an opinion about it belongs
-- to a project. This file moves the opinions. `place`, `search_sighting`, `hub_sweep` and the new
-- `project_property` and `project_hub` all gain a project, and every row that exists today is
-- assigned to the seeded project so nothing is orphaned and nothing is deleted.
--
-- The seeded project id is repeated as a literal rather than looked up by name, because a project
-- someone renames must not change what this migration means on a re-run.

-- ---------------------------------------------------------------------------------------------
-- project_property — which listings a project has actually opened.
--
-- Two jobs. It is the shortlist's membership list, replacing "every row in `property`" now that
-- `property` is shared across projects. And it is the gate on `record_property`: a client may only
-- write a shared fact about a listing one of its own projects has linked, so a project cannot
-- rewrite a listing it has never opened (design D4).
-- ---------------------------------------------------------------------------------------------

create table if not exists project_property (
  project_id    uuid not null references project(id) on delete cascade,
  rightmove_id  text not null references property(rightmove_id) on delete cascade,
  first_seen_at timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  primary key (project_id, rightmove_id)
);

create index if not exists project_property_rightmove_idx on project_property (rightmove_id);

-- Every property that exists belongs to the one project that existed. Dates carried across rather
-- than defaulted, so "we first saw this in June" survives.
insert into project_property (project_id, rightmove_id, first_seen_at, last_seen_at)
select '00000000-0000-4000-a000-000000000001', p.rightmove_id, p.first_seen_at, p.last_seen_at
  from property p
on conflict (project_id, rightmove_id) do nothing;

-- ---------------------------------------------------------------------------------------------
-- project_hub — the neighbourhoods a project searches around.
--
-- These were compile-time constants in src/lib/hubs.ts, which was right when the hubs *were* the
-- search. They stop being constants because a second project searching Manchester cannot be shown
-- Hampstead.
--
-- One table serves both questions AGENTS.md is careful to keep apart. `rightmove_location_id` null
-- means "this hub can answer what a listing is near, but there is nothing to sweep" — which is the
-- honest state for a hub added from a postcode before its identifier is resolved.
-- ---------------------------------------------------------------------------------------------

-- `lat`/`lon` are nullable, which is not laziness. A hub whose coordinates are unknown cannot
-- answer "what is this listing near" — every bearing computed from a guessed coordinate would be
-- silently wrong and nothing on screen would look it — but it can still carry a project's sweep
-- history. That is exactly the state of Highbury & Islington and King's Cross, which were hubs
-- briefly and were dropped: their hub_sweep rows exist and the coordinates left with hubs.ts. Null
-- says so honestly. Readers must skip a hub with no point rather than default one, the same way
-- `hubsWithPlaces` already skips a place whose postcode was never resolved.
create table if not exists project_hub (
  id                   uuid primary key default gen_random_uuid(),
  project_id           uuid not null references project(id) on delete cascade,
  name                 text not null,
  lat                  double precision,
  lon                  double precision,
  -- `<locationType>^<id>`, e.g. STATION^4187. Null => not searchable, only nameable.
  rightmove_location_id text,
  -- The SEO path segment the identifier was read out of, kept so a wrong identifier is traceable
  -- to the page that produced it.
  display_location_id  text,
  max_days_since_added int,
  last_swept_at        timestamptz,
  sort_order           int not null default 0,
  created_at           timestamptz not null default now(),
  unique (project_id, name)
);

-- Lets hub_sweep carry both a project and a hub and be unable to disagree about which project the
-- hub is in — see the composite foreign key below.
create unique index if not exists project_hub_project_id_idx on project_hub (project_id, id);

-- The original five, verbatim from src/lib/hubs.ts.
--
-- Coordinates came from TfL's StopPoint API and were reverse-geocoded through postcodes.io to
-- confirm the ward each one landed in; Primrose Hill is anchored on NW1 8XD because its station
-- closed in 1992. Re-deriving any of them would silently rotate every bearing computed from it,
-- with nothing on screen looking wrong, so they are copied rather than recomputed.
insert into project_hub (project_id, name, lat, lon, rightmove_location_id, display_location_id, sort_order)
values
  ('00000000-0000-4000-a000-000000000001', 'Hampstead',     51.556239, -0.177464, 'STATION^4187', 'Hampstead-Station.html',    0),
  ('00000000-0000-4000-a000-000000000001', 'Primrose Hill', 51.54086,  -0.15772,  'REGION^87390', 'Primrose-Hill.html',        1),
  ('00000000-0000-4000-a000-000000000001', 'Belsize Park',  51.550311, -0.164648, 'STATION^824',  'Belsize-Park-Station.html', 2),
  ('00000000-0000-4000-a000-000000000001', 'Angel',         51.531788, -0.105919, 'STATION^245',  'Angel-Station.html',        3),
  ('00000000-0000-4000-a000-000000000001', 'Old Street',    51.526065, -0.088193, 'STATION^6881', 'Old-Street-Station.html',   4)
on conflict (project_id, name) do nothing;

-- ---------------------------------------------------------------------------------------------
-- place gains a project.
-- ---------------------------------------------------------------------------------------------

alter table place add column if not exists project_id uuid references project(id) on delete cascade;

update place set project_id = '00000000-0000-4000-a000-000000000001' where project_id is null;

alter table place alter column project_id set not null;

create index if not exists place_project_idx on place (project_id, sort_order);

-- ---------------------------------------------------------------------------------------------
-- search_sighting gains a project, and its key grows to include it.
--
-- (rightmove_id, hub) was unique when there was one project. Two projects can both sweep a hub
-- named "Angel" and both see the same flat, and collapsing those into one row would let one
-- project's sweep report a listing the other project had never looked at.
--
-- `hub` stays a name rather than becoming project_hub.id: a sighting is a record of what a search
-- page showed under a name, and it must survive that hub being renamed or deleted. hub_sweep is
-- the opposite case and is re-keyed below.
-- ---------------------------------------------------------------------------------------------

alter table search_sighting add column if not exists project_id uuid references project(id) on delete cascade;

update search_sighting set project_id = '00000000-0000-4000-a000-000000000001' where project_id is null;

alter table search_sighting alter column project_id set not null;

do $$
begin
  if exists (
    select 1 from pg_constraint
     where conname = 'search_sighting_pkey'
       and conrelid = 'search_sighting'::regclass
       and array_length(conkey, 1) = 2
  ) then
    alter table search_sighting drop constraint search_sighting_pkey;
    alter table search_sighting add primary key (project_id, rightmove_id, hub);
  end if;
end $$;

drop index if exists search_sighting_hub_idx;
create index if not exists search_sighting_hub_idx on search_sighting (project_id, hub, last_seen_at desc);

-- ---------------------------------------------------------------------------------------------
-- hub_sweep re-keys onto project_hub.
--
-- A sweep record is about one project's hub, and its whole purpose is to decide how far back that
-- project's next sweep looks. Keyed on a bare name it would be shared, and one project finishing a
-- sweep would narrow another project's window past everything nobody looked at — the failure
-- AGENTS.md calls the only one here that looks exactly like success.
--
-- `project_id` is carried alongside `hub_id` so the RLS policy is a direct membership test rather
-- than a join, and the composite foreign key onto project_hub(project_id, id) makes it impossible
-- for the two columns to name different projects.
-- ---------------------------------------------------------------------------------------------

alter table hub_sweep add column if not exists hub_id uuid references project_hub(id) on delete cascade;
alter table hub_sweep add column if not exists project_id uuid references project(id) on delete cascade;

do $$
begin
  -- Only while the old text key still exists: match each sweep row to the seeded project's hub of
  -- the same name. A sweep for a hub no longer in the list keeps its row and gets no hub_id; the
  -- delete below removes it, because a sweep record that names nothing cannot date anything.
  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'hub_sweep' and column_name = 'hub'
  ) then
    -- A sweep for a hub that is no longer in the list keeps its row and gets a hub of its own,
    -- with no coordinates and no location identifier: history without a place on the map. Deleting
    -- it instead would throw away the record of a neighbourhood having been worked to the end,
    -- which is the one thing hub_sweep exists to remember.
    insert into project_hub (project_id, name, sort_order)
    select distinct '00000000-0000-4000-a000-000000000001'::uuid, s.hub, 100
      from hub_sweep s
     where not exists (
       select 1 from project_hub h
        where h.project_id = '00000000-0000-4000-a000-000000000001' and h.name = s.hub)
    on conflict (project_id, name) do nothing;

    update hub_sweep s
       set hub_id = h.id,
           project_id = h.project_id
      from project_hub h
     where h.project_id = '00000000-0000-4000-a000-000000000001'
       and h.name = s.hub
       and s.hub_id is null;

    alter table hub_sweep drop constraint hub_sweep_pkey;
    alter table hub_sweep drop column hub;
    alter table hub_sweep alter column hub_id set not null;
    alter table hub_sweep alter column project_id set not null;
    alter table hub_sweep add primary key (hub_id);
    alter table hub_sweep add constraint hub_sweep_project_hub_fkey
      foreign key (project_id, hub_id) references project_hub (project_id, id) on delete cascade;
  end if;
end $$;

comment on column hub_sweep.project_id is
  'Denormalised from project_hub so the RLS policy is a direct membership test. The composite '
  'foreign key onto project_hub(project_id, id) is what stops the two from disagreeing.';

-- ===========================================================================
-- 20260809230000_verdict_project
-- ===========================================================================

-- A verdict becomes project state.
--
-- 20260809000000_init.sql made verdicts per-person on purpose: "the interesting signal is where
-- the two of you disagree, and a single shared rating destroys that." That is deliberately
-- reversed — two people on one project now share one rating per property. The original concern
-- is real, so two things blunt it rather than pretending it away:
--
--   * verdict_history keeps every prior row, including the per-person rows that exist today, so
--     the disagreement signal is recoverable and reverting this decision is a query rather than an
--     archaeology exercise.
--   * the current rating names who set it and when, so a shared rating cannot be silently
--     overwritten — "no — Alex, 2h ago" is what keeps last-write-wins honest.
--
-- `set_by` is a user id and `set_by_name` is the name typed into Settings under the old identity
-- model. Both exist because the auth.users rows do not exist while this migration runs: the names
-- are preserved now and mapped to user ids in a one-shot follow-up once both accounts exist.

create table if not exists verdict_history (
  id           bigint generated always as identity primary key,
  project_id   uuid not null references project(id) on delete cascade,
  rightmove_id text not null,
  rating       text not null,
  note         text not null default '',
  set_by       uuid references auth.users(id) on delete set null,
  set_by_name  text,
  -- When the rating it records was set, not when it was archived.
  updated_at   timestamptz not null,
  recorded_at  timestamptz not null default now()
);

-- Deliberately NOT a foreign key onto property: history outlives the row it is about, and the
-- whole point of keeping it is that a decision survives the listing being deleted.
create index if not exists verdict_history_idx
  on verdict_history (project_id, rightmove_id, updated_at desc);

do $$
begin
  -- Everything below runs only while `person` still exists, which is what makes the whole file
  -- idempotent: a second run finds the re-keyed table and does nothing.
  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'verdict' and column_name = 'person'
  ) then
    -- Every existing row, verbatim, before anything is collapsed.
    insert into verdict_history (project_id, rightmove_id, rating, note, set_by_name, updated_at)
    select '00000000-0000-4000-a000-000000000001', v.rightmove_id, v.rating, v.note, v.person, v.updated_at
      from verdict v;

    alter table verdict add column if not exists project_id uuid references project(id) on delete cascade;
    alter table verdict add column if not exists set_by uuid references auth.users(id) on delete set null;
    alter table verdict add column if not exists set_by_name text;

    update verdict
       set project_id = '00000000-0000-4000-a000-000000000001',
           set_by_name = coalesce(set_by_name, person);

    -- Collapse to one row per property: the most recently updated wins. `person` breaks a tie on
    -- identical timestamps so the result is deterministic rather than whichever row the planner
    -- happened to visit first.
    delete from verdict v
     using verdict w
     where v.project_id = w.project_id
       and v.rightmove_id = w.rightmove_id
       and (w.updated_at, w.person) > (v.updated_at, v.person);

    alter table verdict drop constraint verdict_pkey;
    alter table verdict drop column person;
    alter table verdict alter column project_id set not null;
    alter table verdict add primary key (project_id, rightmove_id);
  end if;
end $$;

-- Every change to a verdict is archived, by the database rather than by whichever client made it.
-- A client-side history write is one a client can forget, and the row it forgets is exactly the
-- one somebody later wants: the rating that was overwritten.
--
-- SECURITY DEFINER because `authenticated` holds no insert on verdict_history — history is written
-- by this trigger and by nothing else.
create or replace function public.archive_verdict()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  -- A verdict also disappears when its project is deleted, and archiving it then would insert a
  -- history row pointing at a project mid-cascade. Deleting a project is meant to remove a house
  -- hunt entirely, so there is nothing to keep.
  if tg_op = 'DELETE' and not exists (select 1 from public.project p where p.id = old.project_id) then
    return null;
  end if;

  insert into public.verdict_history (project_id, rightmove_id, rating, note, set_by, set_by_name, updated_at)
  values (old.project_id, old.rightmove_id, old.rating, old.note, old.set_by, old.set_by_name, old.updated_at);
  return null;
end;
$$;

drop trigger if exists verdict_archive on verdict;
create trigger verdict_archive
  after update or delete on verdict
  for each row execute function public.archive_verdict();

comment on column verdict.set_by_name is
  'The name typed into Settings under the pre-auth identity model. Kept so authorship of the '
  'existing 18 verdicts survives until both accounts exist and a one-shot migration maps it to '
  'set_by. New rows written by the extension set set_by and leave this null.';

-- ===========================================================================
-- 20260809240000_travel_rekey
-- ===========================================================================

-- The travel cache stops being keyed on a place.
--
-- (postcode, place_id, mode) tied a journey to a `place` row, and a place belongs to a project. So
-- the cache was inescapably per-project: two projects with an office on the same street would pay
-- TfL twice and, worse, hold two rows free to disagree. A journey between two postcodes is a fact
-- about London, which puts it on the global side of the split this change is built on.
--
-- After: (origin_postcode, dest_postcode, mode). `place` keeps its postcode and the lookup
-- resolves through it.
--
-- THE POINT OF DOING THIS IN PLACE. There are 351 real cached legs, and every one of them carries
-- a `basis` recording whether it was measured against a weekday 09:00 departure or at whatever
-- moment somebody happened to open a listing. `staleTravel` reads that column to decide whether a
-- row still answers the question we now ask. Rebuilding this table by insert-select is how that
-- column quietly arrives full of nulls, every row reads as "measured at an unknown time of day",
-- and the whole cache is refetched — a schema change turning into a bill, now that there are caps
-- to count it against. Altering the table in place carries `basis`, `journeys`, `no_route`,
-- `changes` and `computed_at` across because they are never touched.

alter table travel_time add column if not exists origin_postcode text;
alter table travel_time add column if not exists dest_postcode text;

do $$
begin
  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'travel_time' and column_name = 'place_id'
  ) then
    update travel_time t
       set origin_postcode = t.postcode,
           dest_postcode = p.postcode
      from place p
     where p.id = t.place_id;

    -- A row whose place has no postcode cannot be re-keyed and cannot be looked up again either.
    -- There should be none — place.postcode is NOT NULL — but a null key would silently become a
    -- row nothing ever matches, which is worse than an absent one.
    delete from travel_time where origin_postcode is null or dest_postcode is null;

    -- Two places at the same postcode collapse into one journey. Keep the most recently computed,
    -- with the origin as the tie-break so the outcome does not depend on the planner.
    delete from travel_time t
     using travel_time u
     where t.origin_postcode = u.origin_postcode
       and t.dest_postcode = u.dest_postcode
       and t.mode = u.mode
       and (u.computed_at, u.place_id) > (t.computed_at, t.place_id);

    alter table travel_time drop constraint travel_time_pkey;
    alter table travel_time drop column place_id;
    alter table travel_time drop column postcode;
    alter table travel_time alter column origin_postcode set not null;
    alter table travel_time alter column dest_postcode set not null;
    alter table travel_time add primary key (origin_postcode, dest_postcode, mode);
  end if;
end $$;

create index if not exists travel_time_origin_idx on travel_time (origin_postcode);

comment on table travel_time is
  'Shared read-through cache of journeys between two postcodes. Global, not project-scoped: a '
  'journey between two postcodes is a fact, and keying it on a project''s place row made every '
  'project pay again for the same trip. `basis` says what a number means — see TRAVEL_BASIS in '
  'src/lib/tfl.ts.';

-- ===========================================================================
-- 20260809250000_invite
-- ===========================================================================

-- Invites.
--
-- Public signup is disabled at the Supabase project, which is the whole enforcement; this table is
-- the bookkeeping. One table serves both kinds of invite:
--
--   project_id set   -> "join this project"
--   project_id null  -> an admin inviting somebody to the platform. Consuming it creates a fresh
--                       project for them, which they can name.
--
-- Consumption happens on first successful sign-in, not at invite time, so a pending invite that is
-- never used leaves no membership behind.

create table if not exists invite (
  id          uuid primary key default gen_random_uuid(),
  email       text not null,
  project_id  uuid references project(id) on delete cascade,
  invited_by  uuid references auth.users(id) on delete set null,
  status      text not null default 'pending' check (status in ('pending', 'accepted', 'revoked')),
  expires_at  timestamptz not null default now() + interval '14 days',
  created_at  timestamptz not null default now(),
  accepted_at timestamptz
);

-- One outstanding invite per address per project. `nulls not distinct` so two platform invites to
-- the same address collide too — without it the null project_id makes every row distinct and the
-- same person can be invited to the platform indefinitely.
create unique index if not exists invite_pending_idx
  on invite (lower(email), project_id) nulls not distinct
  where status = 'pending';

create index if not exists invite_email_idx on invite (lower(email));
create index if not exists invite_project_idx on invite (project_id, status);

-- ---------------------------------------------------------------------------------------------
-- The member ceiling, counted the way it has to be counted.
--
-- Pending invites count toward it. Otherwise six outstanding invites all land and the project
-- holds twelve people. Expired ones do not, because an invite past its date confers nothing.
--
-- This is a function rather than a check constraint because it has to be read *before* the invite
-- row is written, so the interface can say "this project is at its limit of 6 people" before the
-- field is submitted, rather than turning a stated state into a failed insert.
-- ---------------------------------------------------------------------------------------------
create or replace function public.project_headcount(p_project_id uuid)
returns table (members int, pending int, max_members int)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    (select count(*)::int from public.project_member m where m.project_id = p_project_id),
    (select count(*)::int from public.invite i
      where i.project_id = p_project_id and i.status = 'pending' and i.expires_at > now()),
    (select p.max_members from public.project p where p.id = p_project_id);
$$;

revoke execute on function public.project_headcount(uuid) from public;
grant execute on function public.project_headcount(uuid) to authenticated, service_role;

-- ===========================================================================
-- 20260809260000_spend
-- ===========================================================================

-- What each call costs, and the ceiling on it.
--
-- Until now the only record of what OpenAI cost was a number computed in the Edge Function and
-- written to a log line. That was fine while the only key holder was the person paying. It is not
-- fine once the bundle is on other people's machines: the ceiling on cost was "however many
-- listings anyone inserts", and nothing measured it.

-- ---------------------------------------------------------------------------------------------
-- Prices are data.
--
-- The hardcoded rates in the function charged cached input tokens at the full input rate, which
-- overstates spend by about an order of magnitude on a prompt that reuses a system block. Cached
-- input therefore gets its own column rather than being folded in.
-- ---------------------------------------------------------------------------------------------

create table if not exists model_price (
  model                     text not null,
  effective_from            timestamptz not null default now(),
  input_usd_per_mtok        numeric(12, 4) not null,
  cached_input_usd_per_mtok numeric(12, 4) not null,
  output_usd_per_mtok       numeric(12, 4) not null,
  primary key (model, effective_from)
);

-- gpt-5.6-terra list price, matching the `cost()` the Edge Function used, plus the cached-input
-- rate it did not have. `effective_from` is epoch so this row prices everything already recorded.
insert into model_price (model, effective_from, input_usd_per_mtok, cached_input_usd_per_mtok, output_usd_per_mtok)
values ('gpt-5.6-terra', 'epoch', 2.0000, 0.2000, 12.0000)
on conflict (model, effective_from) do nothing;

-- The price in force for a model at a moment. Null for a model nobody has priced — the caller
-- must treat that as a reason to refuse, not as free.
create or replace function public.price_at(p_model text, p_at timestamptz default now())
returns model_price
language sql
stable
set search_path = public, pg_temp
as $$
  select p.* from public.model_price p
   where p.model = p_model and p.effective_from <= p_at
   order by p.effective_from desc
   limit 1;
$$;

-- ---------------------------------------------------------------------------------------------
-- One row per paid call.
--
-- `cost_usd` is stored, never recomputed. A repricing must not retroactively change what last
-- month's cap counted.
-- ---------------------------------------------------------------------------------------------

create table if not exists api_usage (
  id                  bigint generated always as identity primary key,
  occurred_at         timestamptz not null default now(),
  -- Set null rather than cascade: a deleted project must not erase the record of money spent.
  project_id          uuid references project(id) on delete set null,
  user_id             uuid references auth.users(id) on delete set null,
  kind                text not null default 'analysis',
  model               text,
  input_tokens        int not null default 0,
  cached_input_tokens int not null default 0,
  output_tokens       int not null default 0,
  cost_usd            numeric(10, 6) not null,
  rightmove_id        text
);

create index if not exists api_usage_project_idx on api_usage (project_id, occurred_at desc);
create index if not exists api_usage_user_idx on api_usage (user_id, occurred_at desc);

-- ---------------------------------------------------------------------------------------------
-- A running claim is an attributable reservation.
--
-- The cost of a call is not knowable before it is made, so the cap check reserves an estimate and
-- reconciles to the real cost when the usage row lands. A reservation is not a new table: it is a
-- property_analysis row in status 'running', which already exists and already drains through the
-- stale-claim path. These two columns are what make it attributable to a budget.
-- ---------------------------------------------------------------------------------------------

alter table property_analysis
  add column if not exists claimed_by_project uuid references project(id) on delete set null,
  add column if not exists claimed_by_user uuid references auth.users(id) on delete set null;

create index if not exists property_analysis_running_idx
  on property_analysis (status, claimed_at) where status = 'running';

-- ---------------------------------------------------------------------------------------------
-- The month, in Europe/London.
--
-- Every other date in this project is London local — the sweep windows, the "added yesterday"
-- wording — and a cap that reset at midnight UTC would reset an hour early for half the year and
-- be a different month's budget for anything done between 23:00 and 00:00 in summer.
-- ---------------------------------------------------------------------------------------------

create or replace function public.month_start_london(p_at timestamptz default now())
returns timestamptz
language sql
stable
set search_path = public, pg_temp
as $$
  select date_trunc('month', p_at at time zone 'Europe/London') at time zone 'Europe/London';
$$;

-- ---------------------------------------------------------------------------------------------
-- Claim a listing, but only if the budget allows it.
--
-- The old claim_analysis serialised on the *listing*: two requests for the same rightmove_id could
-- not both win. That is exactly the wrong lock for a spend cap. Requests for *different* listings
-- never contend at all, so a paced sweep opening five unanalysed flats near the cap would have
-- five transactions each read the same under-cap total and all proceed. The budget is shared state
-- and the claim never touched it.
--
-- So this locks the budget. pg_advisory_xact_lock on the project, then on the user — ALWAYS in
-- that order, so two callers can never hold one lock each and wait on the other. The locks release
-- with the transaction, so the next caller sees this one's reservation.
--
-- Returns jsonb rather than boolean because "you cannot have this" now has three different reasons
-- and the panel renders each of them differently:
--   { status: 'claimed' }
--   { status: 'busy' }      another caller holds a live claim on this listing
--   { status: 'capped', scope, spent, reserved, cap, resets_at }
--
-- Granted to service_role alone. The extension must not be able to claim directly: a claim is a
-- reservation against real money, and one made outside the Edge Function's flow would consume
-- budget with no call behind it to release it.
-- ---------------------------------------------------------------------------------------------

drop function if exists public.claim_analysis(text, interval);

create or replace function public.claim_analysis(
  p_rightmove_id  text,
  p_project_id    uuid,
  p_user_id       uuid,
  p_estimate_usd  numeric default 0.10,
  p_stale_after   interval default '10 minutes'
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_month_start   timestamptz := public.month_start_london();
  v_resets_at     timestamptz := public.month_start_london() + interval '1 month';
  v_project_cap   numeric;
  v_user_cap      numeric;
  v_project_spent numeric;
  v_user_spent    numeric;
  v_project_held  numeric;
  v_user_held     numeric;
  v_claimed       int;
begin
  if p_project_id is null or p_user_id is null then
    raise exception 'claim_analysis: a claim must name the project and the user it is charged to';
  end if;

  -- Project first, then user. The fixed order is the whole deadlock argument.
  perform pg_advisory_xact_lock(hashtextextended('rm:project:' || p_project_id::text, 0));
  perform pg_advisory_xact_lock(hashtextextended('rm:user:' || p_user_id::text, 0));

  select p.monthly_cap_usd into v_project_cap from project p where p.id = p_project_id;
  select p.monthly_cap_usd into v_user_cap from profile p where p.id = p_user_id;
  if v_project_cap is null or v_user_cap is null then
    raise exception 'claim_analysis: no cap for project % / user % — refusing rather than treating an unknown budget as unlimited', p_project_id, p_user_id;
  end if;

  select coalesce(sum(u.cost_usd), 0) into v_project_spent
    from api_usage u where u.project_id = p_project_id and u.occurred_at >= v_month_start;
  select coalesce(sum(u.cost_usd), 0) into v_user_spent
    from api_usage u where u.user_id = p_user_id and u.occurred_at >= v_month_start;

  -- In flight: live claims only. A stale one has already been given up on and its reservation has
  -- drained, which is what stops a crash from permanently consuming budget.
  select count(*) * p_estimate_usd into v_project_held
    from property_analysis a
   where a.status = 'running'
     and a.claimed_by_project = p_project_id
     and a.claimed_at >= now() - p_stale_after
     and a.rightmove_id <> p_rightmove_id;
  select count(*) * p_estimate_usd into v_user_held
    from property_analysis a
   where a.status = 'running'
     and a.claimed_by_user = p_user_id
     and a.claimed_at >= now() - p_stale_after
     and a.rightmove_id <> p_rightmove_id;

  if v_project_spent + v_project_held + p_estimate_usd > v_project_cap then
    return jsonb_build_object(
      'status', 'capped', 'scope', 'project',
      'spent', round(v_project_spent, 6), 'reserved', round(v_project_held, 6),
      'cap', v_project_cap, 'resets_at', v_resets_at);
  end if;

  if v_user_spent + v_user_held + p_estimate_usd > v_user_cap then
    return jsonb_build_object(
      'status', 'capped', 'scope', 'user',
      'spent', round(v_user_spent, 6), 'reserved', round(v_user_held, 6),
      'cap', v_user_cap, 'resets_at', v_resets_at);
  end if;

  -- The claim itself, unchanged in meaning from 20260809030000_analysis_claim.sql: the primary key
  -- makes exactly one caller win, and a run that died mid-flight can be taken over once it goes
  -- stale, so one crash does not block a listing forever.
  insert into property_analysis (rightmove_id, status, claimed_at, claimed_by_project, claimed_by_user)
  values (p_rightmove_id, 'running', now(), p_project_id, p_user_id)
  on conflict (rightmove_id) do update
    set status = 'running',
        claimed_at = now(),
        error = null,
        claimed_by_project = excluded.claimed_by_project,
        claimed_by_user = excluded.claimed_by_user
    where property_analysis.status = 'failed'
       or (property_analysis.status = 'running'
           and property_analysis.claimed_at < now() - p_stale_after);

  get diagnostics v_claimed = row_count;

  return jsonb_build_object('status', case when v_claimed > 0 then 'claimed' else 'busy' end);
end;
$$;

-- Revoked from `anon` and `authenticated` by name, not only from PUBLIC. Supabase's default
-- privileges hand every new function in this schema an explicit EXECUTE grant to both roles, and
-- revoking from PUBLIC leaves those grants standing — which is how a client ends up able to claim
-- against its own budget with no call behind it. Verified by tools/check-rls.ts, which caught
-- exactly this.
revoke execute on function public.claim_analysis(text, uuid, uuid, numeric, interval)
  from public, anon, authenticated;
grant execute on function public.claim_analysis(text, uuid, uuid, numeric, interval) to service_role;

-- ---------------------------------------------------------------------------------------------
-- Record what a call cost, priced from the table.
--
-- Pricing lives here rather than in the Edge Function so a repricing needs an insert and not a
-- deploy. Called on success and on failure-with-usage alike: tokens OpenAI billed have to be
-- billed against a cap whether or not we got an answer out of them.
-- ---------------------------------------------------------------------------------------------

create or replace function public.record_api_usage(
  p_project_id          uuid,
  p_user_id             uuid,
  p_model               text,
  p_input_tokens        int,
  p_cached_input_tokens int,
  p_output_tokens       int,
  p_rightmove_id        text default null,
  p_kind                text default 'analysis'
)
returns numeric
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_price model_price;
  v_cost  numeric;
begin
  v_price := public.price_at(p_model);
  if v_price is null then
    raise exception 'record_api_usage: no price for model % — add a model_price row rather than recording a call as free', p_model;
  end if;

  v_cost := round(
      coalesce(p_input_tokens, 0)::numeric / 1e6 * v_price.input_usd_per_mtok
    + coalesce(p_cached_input_tokens, 0)::numeric / 1e6 * v_price.cached_input_usd_per_mtok
    + coalesce(p_output_tokens, 0)::numeric / 1e6 * v_price.output_usd_per_mtok,
    6);

  insert into api_usage (project_id, user_id, kind, model, input_tokens, cached_input_tokens,
                         output_tokens, cost_usd, rightmove_id)
  values (p_project_id, p_user_id, p_kind, p_model, coalesce(p_input_tokens, 0),
          coalesce(p_cached_input_tokens, 0), coalesce(p_output_tokens, 0), v_cost, p_rightmove_id);

  return v_cost;
end;
$$;

revoke execute on function public.record_api_usage(uuid, uuid, text, int, int, int, text, text)
  from public, anon, authenticated;
grant execute on function public.record_api_usage(uuid, uuid, text, int, int, int, text, text) to service_role;

-- Month-to-date spend for a project and a user, which is what the 80% warning and the admin view
-- both read. Readable by anyone who could read the underlying api_usage rows anyway.
create or replace function public.spend_summary(p_project_id uuid, p_user_id uuid default auth.uid())
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case
    when not (public.is_member(p_project_id) or public.is_admin()) then
      jsonb_build_object('error', 'not a member of this project')
    else jsonb_build_object(
      'month_start', public.month_start_london(),
      'resets_at', public.month_start_london() + interval '1 month',
      'project_spent', (select coalesce(sum(u.cost_usd), 0) from public.api_usage u
                         where u.project_id = p_project_id and u.occurred_at >= public.month_start_london()),
      'project_cap', (select p.monthly_cap_usd from public.project p where p.id = p_project_id),
      'user_spent', (select coalesce(sum(u.cost_usd), 0) from public.api_usage u
                      where u.user_id = p_user_id and u.occurred_at >= public.month_start_london()),
      'user_cap', (select p.monthly_cap_usd from public.profile p where p.id = p_user_id))
  end;
$$;

revoke execute on function public.spend_summary(uuid, uuid) from public;
grant execute on function public.spend_summary(uuid, uuid) to authenticated, service_role;

-- ===========================================================================
-- 20260809270000_rls
-- ===========================================================================

-- The boundary.
--
-- Everything before this migration was written on one premise, stated plainly in
-- 20260809000000_init.sql: "there is no user auth. The extension ships the publishable (anon) key,
-- and that key is the shared secret between the two laptops." Every table therefore carried one
-- policy, `shared_household`, granting the `anon` role full access. Anyone holding the bundle held
-- the database.
--
-- This file replaces all of it. Afterwards:
--
--   * `anon` holds nothing, anywhere. The publishable key identifies the project and authorises
--     nothing, which is the change that makes distributing this beyond two trusted laptops
--     defensible at all.
--   * Every policy is `to authenticated` and predicated on project membership.
--   * The five global fact tables grant `authenticated` SELECT and nothing else. No INSERT policy,
--     no UPDATE policy, and DELETE for `service_role` alone. Writes go through the validating
--     SECURITY DEFINER functions at the bottom of this file.
--
-- The last point is the one worth being explicit about, because an earlier draft of this design
-- got it wrong. It granted every authenticated user blanket write access to the shared caches on
-- the grounds that they are derived from a page the user is looking at. A blanket `for all` policy
-- includes DELETE: any invited client — or any bug in one — could have emptied the 351-leg travel
-- cache for every project at once. A cache that can only be added to and corrected cannot be
-- emptied by a client bug.

-- ---------------------------------------------------------------------------------------------
-- Out with the old.
-- ---------------------------------------------------------------------------------------------

do $$
declare t text;
begin
  foreach t in array array[
    'place', 'property', 'verdict', 'travel_time', 'property_analysis',
    'station_point', 'station_walk', 'search_sighting', 'hub_sweep'
  ] loop
    execute format('drop policy if exists shared_household on %I', t);
  end loop;
end $$;

-- RLS on everything this change introduced, and on everything it did not.
do $$
declare t text;
begin
  foreach t in array array[
    'place', 'property', 'verdict', 'verdict_history', 'travel_time', 'property_analysis',
    'station_point', 'station_walk', 'search_sighting', 'hub_sweep',
    'profile', 'project', 'project_member', 'project_property', 'project_hub',
    'invite', 'api_usage', 'model_price', 'admin_email'
  ] loop
    execute format('alter table %I enable row level security', t);
    -- The `anon` role is granted table privileges by Supabase's default privileges on the public
    -- schema, and a grant with no policy is only silently useless. Revoking makes it loud.
    execute format('revoke all on table %I from anon', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------------------------
-- The five global fact tables: SELECT and nothing else.
--
-- Read by any signed-in user, so a listing is analysed once across all projects and two projects
-- looking at the same flat pay OpenAI once. That leaves a residual: a signed-in member of any
-- project can enumerate every listing anyone has analysed. The data is public Rightmove content
-- with no opinion attached, the leak is "which flats have been looked at, by someone", and closing
-- it is written up as design D14 and deferred deliberately.
-- ---------------------------------------------------------------------------------------------

do $$
declare t text;
begin
  foreach t in array array['property', 'property_analysis', 'station_point', 'station_walk', 'travel_time'] loop
    execute format('drop policy if exists read_shared_facts on %I', t);
    execute format('create policy read_shared_facts on %I for select to authenticated using (true)', t);
    -- No policy would already deny these. Revoking the grant as well means the refusal is an error
    -- the caller can see rather than a write that silently affects nothing.
    execute format('revoke insert, update, delete on table %I from authenticated', t);
    execute format('grant select on table %I to authenticated', t);
  end loop;
end $$;

-- `model_price` is readable so a client can explain a charge; nobody but the service role writes.
drop policy if exists read_model_price on model_price;
create policy read_model_price on model_price for select to authenticated using (true);
revoke insert, update, delete on table model_price from authenticated;

-- ---------------------------------------------------------------------------------------------
-- Accounts.
--
-- Note what RLS cannot do here: it gates rows, not columns. A policy letting a user update their
-- own profile would let them set their own `is_admin` and raise their own `monthly_cap_usd`, which
-- is the entire point of having a cap. Column-level grants are the right tool, so `authenticated`
-- may update exactly three columns and an admin changes a cap through admin_set_user_cap below.
-- ---------------------------------------------------------------------------------------------

drop policy if exists read_profile on profile;
create policy read_profile on profile for select to authenticated
  using (id = auth.uid() or public.shares_project(id) or public.is_admin());

drop policy if exists update_own_profile on profile;
create policy update_own_profile on profile for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

revoke all on table profile from authenticated;
grant select on table profile to authenticated;
grant update (display_name, active_project_id, last_seen_at) on table profile to authenticated;

-- `active_project_id` is one of the three columns a user may write, and a column grant cannot say
-- "a project you are actually in". Every query is membership-gated anyway, so the worst this
-- prevents is an extension pointed at a project it can see nothing of — which renders as an empty
-- shortlist, and an empty shortlist is indistinguishable from a broken one. Refuse it outright.
create or replace function public.check_active_project()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.active_project_id is not null
     and not exists (
       select 1 from public.project_member m
        where m.project_id = new.active_project_id and m.user_id = new.id
     ) then
    raise exception 'active_project_id: % is not a project this user is a member of', new.active_project_id;
  end if;
  return new;
end;
$$;

drop trigger if exists profile_active_project on profile;
create trigger profile_active_project
  before insert or update of active_project_id on profile
  for each row execute function public.check_active_project();

drop policy if exists read_project on project;
create policy read_project on project for select to authenticated
  using (public.is_member(id) or public.is_admin());

drop policy if exists update_project on project;
create policy update_project on project for update to authenticated
  using (public.is_member(id)) with check (public.is_member(id));

revoke all on table project from authenticated;
grant select on table project to authenticated;
grant update (name) on table project to authenticated;

drop policy if exists read_project_member on project_member;
create policy read_project_member on project_member for select to authenticated
  using (public.is_member(project_id) or public.is_admin());

-- Leaving a project is the one membership change a client makes. Joining is the invite Edge
-- Function's business, with the service role, because a client that could insert its own
-- membership row could join any project it could name.
drop policy if exists leave_project on project_member;
create policy leave_project on project_member for delete to authenticated
  using (user_id = auth.uid() or public.is_admin());

revoke all on table project_member from authenticated;
grant select, delete on table project_member to authenticated;

-- Who the admins are is admin-only knowledge; it is a list of people's email addresses.
drop policy if exists read_admin_email on admin_email;
create policy read_admin_email on admin_email for select to authenticated using (public.is_admin());
revoke all on table admin_email from authenticated;
grant select on table admin_email to authenticated;

-- ---------------------------------------------------------------------------------------------
-- Project-scoped data. One shape, repeated: you may do anything to a row whose project you are in,
-- and nothing at all to any other row.
-- ---------------------------------------------------------------------------------------------

do $$
declare t text;
begin
  foreach t in array array['place', 'search_sighting', 'hub_sweep', 'project_hub', 'project_property'] loop
    execute format('drop policy if exists project_scoped on %I', t);
    execute format(
      'create policy project_scoped on %I for all to authenticated '
      'using (public.is_member(project_id)) with check (public.is_member(project_id))', t);
    execute format('grant select, insert, update, delete on table %I to authenticated', t);
  end loop;
end $$;

-- A verdict carries an author, and the author is the person writing it. Without the `set_by` check
-- a member could attribute a rating to somebody else, which is precisely what showing the author
-- is meant to prevent.
drop policy if exists project_scoped on verdict;
create policy project_scoped on verdict for all to authenticated
  using (public.is_member(project_id))
  with check (public.is_member(project_id) and (set_by is null or set_by = auth.uid()));
grant select, insert, update, delete on table verdict to authenticated;

-- History is written by the trigger in 20260809230000_verdict_project.sql and read by anyone in
-- the project. A client that could insert here could fabricate a disagreement that never happened.
drop policy if exists read_verdict_history on verdict_history;
create policy read_verdict_history on verdict_history for select to authenticated
  using (public.is_member(project_id));
revoke all on table verdict_history from authenticated;
grant select on table verdict_history to authenticated;

-- An invite is visible to the project it names, to the address it was sent to, and to admins.
-- Writing one is the Edge Function's job — it is what validates the caller's standing and counts
-- the project against max_members — but revoking is a status change a member may make directly.
drop policy if exists read_invite on invite;
create policy read_invite on invite for select to authenticated
  using (
    public.is_admin()
    or (project_id is not null and public.is_member(project_id))
    or lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  );

drop policy if exists revoke_invite on invite;
create policy revoke_invite on invite for update to authenticated
  using (public.is_admin() or (project_id is not null and public.is_member(project_id)))
  with check (public.is_admin() or (project_id is not null and public.is_member(project_id)));

revoke all on table invite from authenticated;
grant select on table invite to authenticated;
grant update (status) on table invite to authenticated;

-- Spend is readable by the project it was charged to, by the person who spent it, and by an admin.
-- Nobody writes it but the service role: a client that could insert here could hide its own spend
-- or exhaust somebody else's cap.
drop policy if exists read_api_usage on api_usage;
create policy read_api_usage on api_usage for select to authenticated
  using (
    public.is_admin()
    or user_id = auth.uid()
    or (project_id is not null and public.is_member(project_id))
  );
revoke all on table api_usage from authenticated;
grant select on table api_usage to authenticated;

-- ---------------------------------------------------------------------------------------------
-- The write RPCs.
--
-- src/lib/supabase.ts already funnels every write to a shared fact through a handful of named
-- functions, so this changes what those functions call and nothing about the shape of the calling
-- code. Each one validates its arguments, because "the client read it off a page" is not
-- validation and a NOT NULL constraint is not either.
-- ---------------------------------------------------------------------------------------------

-- Record what a listing page said.
--
-- Refused unless the caller's project already holds a project_property link for this listing. The
-- link is the client's own assertion that this project opened this listing, made through the
-- project_property policy above, and it is what stops one project rewriting a listing it has never
-- opened. A jsonb argument rather than eighteen positional ones: the extraction on this table
-- grows every time Rightmove's blob does, and the explicit column list below is the whitelist.
create or replace function public.record_property(p_project_id uuid, p_property jsonb)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id text := nullif(trim(p_property ->> 'rightmove_id'), '');
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
  if not public.is_member(p_project_id) then
    raise exception 'record_property: not a member of project %', p_project_id;
  end if;
  if not exists (
    select 1 from public.project_property pp
     where pp.project_id = p_project_id and pp.rightmove_id = v_id
  ) then
    raise exception
      'record_property: listing % is not linked to project % — a project may only write facts about listings it opened',
      v_id, p_project_id;
  end if;

  insert into public.property (
    rightmove_id, url, postcode, display_address, price, bedrooms, bathrooms,
    latitude, longitude, nearest_stations, image_urls, floorplan_urls,
    floor_area_sqft, floor_area_source, floorplan_url, furnish_type, listing_update, last_seen_at
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
    now()
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
    last_seen_at = now();

  update public.project_property
     set last_seen_at = now()
   where project_id = p_project_id and rightmove_id = v_id;
end;
$$;

-- The postcode-derived coordinates `locateProperties` fills in. Same gate as record_property: this
-- is a write to a global row, so the caller has to have opened the listing.
create or replace function public.set_property_point(
  p_project_id uuid, p_rightmove_id text, p_lat double precision, p_lon double precision)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_lat is null or p_lon is null then
    raise exception 'set_property_point: a point needs both a latitude and a longitude';
  end if;
  if p_lat < -90 or p_lat > 90 or p_lon < -180 or p_lon > 180 then
    raise exception 'set_property_point: %,% is not a point on Earth', p_lat, p_lon;
  end if;
  if not public.is_member(p_project_id) then
    raise exception 'set_property_point: not a member of project %', p_project_id;
  end if;
  if not exists (
    select 1 from public.project_property pp
     where pp.project_id = p_project_id and pp.rightmove_id = p_rightmove_id
  ) then
    raise exception 'set_property_point: listing % is not linked to project %', p_rightmove_id, p_project_id;
  end if;

  update public.property
     set postcode_lat = p_lat, postcode_lon = p_lon
   where rightmove_id = p_rightmove_id;
end;
$$;

-- A journey between two postcodes. Not gated on a listing: an origin is a listing's postcode and a
-- destination is a saved place's, and requiring a link for both would refuse the compare table's
-- bulk lookups for no gain. Signed in is the gate, and the validation below is the substance —
-- a mode nobody planned for, or a duration that is not a duration, is refused rather than cached.
create or replace function public.cache_travel(
  p_origin_postcode text,
  p_dest_postcode   text,
  p_mode            text,
  p_seconds         int default null,
  p_changes         int default null,
  p_no_route        boolean default false,
  p_journeys        jsonb default null,
  p_basis           text default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_origin text := nullif(trim(p_origin_postcode), '');
  v_dest   text := nullif(trim(p_dest_postcode), '');
begin
  if auth.uid() is null then
    raise exception 'cache_travel: sign in first';
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

  insert into public.travel_time (
    origin_postcode, dest_postcode, mode, seconds, changes, no_route, journeys, basis, computed_at)
  values (v_origin, v_dest, p_mode, p_seconds, p_changes, p_no_route, p_journeys, p_basis, now())
  on conflict (origin_postcode, dest_postcode, mode) do update set
    seconds = excluded.seconds,
    changes = excluded.changes,
    no_route = excluded.no_route,
    journeys = excluded.journeys,
    basis = excluded.basis,
    computed_at = now();
end;
$$;

-- A station's coordinates, cached even when TfL cannot resolve it — a null point is a real answer
-- and stops us asking again about a station TfL has never heard of.
create or replace function public.cache_station_point(
  p_name text,
  p_lat  double precision default null,
  p_lon  double precision default null,
  p_lines jsonb default '[]'::jsonb
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_name text := nullif(trim(p_name), '');
begin
  if auth.uid() is null then
    raise exception 'cache_station_point: sign in first';
  end if;
  if v_name is null then
    raise exception 'cache_station_point: a station needs a name';
  end if;
  if (p_lat is null) <> (p_lon is null) then
    raise exception 'cache_station_point: half a coordinate is not a location';
  end if;
  if p_lat is not null and (p_lat < -90 or p_lat > 90 or p_lon < -180 or p_lon > 180) then
    raise exception 'cache_station_point: %,% is not a point on Earth', p_lat, p_lon;
  end if;

  insert into public.station_point (name, lat, lon, lines, resolved_at)
  values (v_name, p_lat, p_lon, coalesce(p_lines, '[]'::jsonb), now())
  on conflict (name) do update set
    lat = excluded.lat, lon = excluded.lon, lines = excluded.lines, resolved_at = now();
end;
$$;

create or replace function public.cache_station_walk(
  p_postcode text, p_station_name text, p_seconds int)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_postcode text := nullif(trim(p_postcode), '');
  v_station  text := nullif(trim(p_station_name), '');
begin
  if auth.uid() is null then
    raise exception 'cache_station_walk: sign in first';
  end if;
  if v_postcode is null or v_station is null then
    raise exception 'cache_station_walk: both a postcode and a station are required';
  end if;
  -- Nobody walks to a nearby station for four hours. A number outside this is a unit error.
  if p_seconds is null or p_seconds < 0 or p_seconds > 14400 then
    raise exception 'cache_station_walk: % is not a plausible walk in seconds', p_seconds;
  end if;

  insert into public.station_walk (postcode, station_name, seconds, computed_at)
  values (v_postcode, v_station, p_seconds, now())
  on conflict (postcode, station_name) do update set
    seconds = excluded.seconds, computed_at = now();
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Caps are admin-only, and a cap you can raise yourself is not a cap. Column grants keep the
-- columns unwritable; these two functions are the only way they move.
-- ---------------------------------------------------------------------------------------------

-- The service role is not a person and so has no profile to be an admin in — `auth.uid()` is null
-- for it and `is_admin()` is therefore false. The invite and admin Edge Functions run as it, and
-- so does anything operational, so it counts as standing here. The `role` claim is part of the
-- signed JWT: presenting it requires the service key, which is the same thing as being trusted.
create or replace function public.is_service_role()
returns boolean
language sql
stable
set search_path = public, pg_temp
as $$
  select coalesce(auth.jwt() ->> 'role', '') = 'service_role';
$$;

create or replace function public.admin_set_user_cap(p_user_id uuid, p_cap numeric)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not (public.is_admin() or public.is_service_role()) then
    raise exception 'admin_set_user_cap: admins only';
  end if;
  if p_cap is null or p_cap < 0 then
    raise exception 'admin_set_user_cap: % is not a cap', p_cap;
  end if;
  update public.profile set monthly_cap_usd = p_cap where id = p_user_id;
end;
$$;

create or replace function public.admin_set_project_cap(p_project_id uuid, p_cap numeric)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not (public.is_admin() or public.is_service_role()) then
    raise exception 'admin_set_project_cap: admins only';
  end if;
  if p_cap is null or p_cap < 0 then
    raise exception 'admin_set_project_cap: % is not a cap', p_cap;
  end if;
  update public.project set monthly_cap_usd = p_cap where id = p_project_id;
end;
$$;

create or replace function public.admin_set_max_members(p_project_id uuid, p_max int)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not (public.is_admin() or public.is_service_role()) then
    raise exception 'admin_set_max_members: admins only';
  end if;
  if p_max is null or p_max < 1 then
    raise exception 'admin_set_max_members: a project holds at least one person';
  end if;
  update public.project set max_members = p_max where id = p_project_id;
end;
$$;

do $$
declare f text;
begin
  foreach f in array array[
    'public.record_property(uuid, jsonb)',
    'public.set_property_point(uuid, text, double precision, double precision)',
    'public.cache_travel(text, text, text, int, int, boolean, jsonb, text)',
    'public.cache_station_point(text, double precision, double precision, jsonb)',
    'public.cache_station_walk(text, text, int)',
    'public.admin_set_user_cap(uuid, numeric)',
    'public.admin_set_project_cap(uuid, numeric)',
    'public.admin_set_max_members(uuid, int)'
  ] loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated, service_role', f);
  end loop;
end $$;

-- ---------------------------------------------------------------------------------------------
-- And the sweep that catches whatever the lists above missed.
--
-- `revoke execute ... from public` does NOT revoke the explicit grant Supabase's default
-- privileges hand every new function in this schema to `anon` and `authenticated`. tools/check-rls
-- found the consequence: `anon` — the role the key in the bundle carries — could call
-- `claim_analysis` and reserve budget against somebody else's cap without signing in at all. Every
-- function above is individually revoked now, and this is the backstop, because the failure mode
-- of forgetting one is invisible.
--
-- It runs last on purpose: it has to see every function this change created.
revoke execute on all functions in schema public from anon;

-- ===========================================================================
-- 20260809280000_invite_rpc
-- ===========================================================================

-- The member ceiling becomes an invariant, and an expired invite stops pretending to be pending.
--
-- Two things the invite Edge Function found, both of them mine.
--
-- THE CEILING. D7 says the count is "checked in the same statement that writes the invite row". An
-- Edge Function cannot do that: `project_headcount()` is one round trip and the insert is another,
-- with no transaction spanning them, so two members inviting at the same moment can both read five
-- and both write a sixth. The function worked around it honestly — insert, then re-count only the
-- live pending invites written before its own and withdraw if too many stand in front — which never
-- over-admits, but is a retry-and-withdraw where the specification asked for an invariant, and
-- about twenty-five lines of compensation that exist only because the check and the write were in
-- different transactions.
--
-- `create_invite` puts them in the same one, under the same `pg_advisory_xact_lock` on the project
-- that `claim_analysis` takes. That composes: both take the project lock first and neither takes a
-- second lock that the other might already hold, so the two cannot deadlock against each other.
-- The ceiling is then a real invariant rather than a race that is cleaned up afterwards.
--
-- EXPIRY. Nothing aged a pending invite out. `invite_pending_idx` is unique on `status = 'pending'`
-- with no regard for `expires_at`, so an invite that lapsed a month ago still blocked a fresh one
-- to the same address with a bare 409 and nothing to explain it. The accounts spec also says an
-- expired invite "appears in the admin view as expired rather than pending", which was not true of
-- anything in the database: `status` still read `pending` and the admin view would have had to
-- derive the truth from `expires_at`. So `expired` becomes a real status, `create_invite` ages the
-- relevant rows out before it counts anything, and `expire_invites()` exists for the admin view to
-- call so the state is correct even when nobody is inviting.

-- ---------------------------------------------------------------------------------------------
-- `expired` is a status, not something a reader has to work out.
-- ---------------------------------------------------------------------------------------------

alter table invite drop constraint if exists invite_status_check;
alter table invite add constraint invite_status_check
  check (status in ('pending', 'accepted', 'revoked', 'expired'));

comment on column invite.status is
  'pending | accepted | revoked | expired. `expired` is written by expire_invites() and by '
  'create_invite(), not by the passage of time — a row past its expires_at that nobody has swept '
  'yet still reads `pending`. Anything that must not honour a lapsed invite checks the date as '
  'well as the status; the admin view can rely on the status alone as long as it calls '
  'expire_invites() first. An expired invite confers nothing: it is not consumed on sign-in and it '
  'does not count against max_members.';

-- Stand down anything already past its date, so the column is true the moment this migration ends
-- rather than the next time somebody invites.
update invite set status = 'expired' where status = 'pending' and expires_at <= now();

-- Called by the admin view before it lists invites, and by create_invite below. Idempotent, and it
-- can only move a row whose own `expires_at` has genuinely passed, which is why it is safe to let
-- any signed-in caller run it: there is no argument that makes it do something unwanted.
create or replace function public.expire_invites(p_project_id uuid default null)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_expired int;
begin
  update public.invite
     set status = 'expired'
   where status = 'pending'
     and expires_at <= now()
     and (p_project_id is null or project_id = p_project_id);
  get diagnostics v_expired = row_count;
  return v_expired;
end;
$$;

revoke execute on function public.expire_invites(uuid) from public, anon;
grant execute on function public.expire_invites(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- Check and insert, in one transaction, under one lock.
--
-- Returns a stated outcome rather than raising for the ordinary refusals, because every one of
-- them is something the interface has to render as its own sentence: "this project is at its limit
-- of 6 people", "they are already here", "they already have an invite outstanding". A generic
-- failure at this point gets the same address typed in again.
--
--   { status: 'invited' | 'at-capacity' | 'already-a-member' | 'already-invited',
--     members, pending, max_members,   -- null for a platform invite; no project, no ceiling
--     invite }                         -- the row, or the blocking row, or null
--
-- Standing is checked here too, and not because the Edge Function's check is inadequate — it knows
-- things this does not, like whether the named project is the caller's *active* one. This is the
-- weaker invariant restated where it cannot be skipped: a project invite comes from an admin or
-- from somebody actually in that project, and a platform invite comes from an admin.
--
-- `service_role` only. The account behind an invite is created through the Admin API, which is the
-- Edge Function's business; an invite row written from the extension directly would point at an
-- address with no account, and sign-in asks for a code with `shouldCreateUser: false` and would get
-- nothing, with nothing anywhere to say why. Write the row first and create the user second: this
-- is the cheap half and the one that can be undone by setting the row to `revoked`.
-- ---------------------------------------------------------------------------------------------

create or replace function public.create_invite(
  p_email      text,
  p_project_id uuid,
  p_invited_by uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_email    text := lower(trim(coalesce(p_email, '')));
  -- The Edge Function resolves the caller from the JWT and passes it; `auth.uid()` is null under
  -- the service role, so the argument is the caller of record. It is trusted exactly as far as the
  -- service key is, which is the same trust that lets this function exist.
  v_caller   uuid := coalesce(auth.uid(), p_invited_by);
  v_is_admin boolean;
  v_members  int;
  v_pending  int;
  v_max      int;
  v_existing invite;
  v_invite   invite;
begin
  -- Deliberately loose: a sanity check against a blank or a stray name, not an attempt to decide
  -- what an address may look like. An address that does not exist simply never signs in.
  if v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
    raise exception 'create_invite: "%" is not an email address', p_email;
  end if;
  if v_caller is null then
    raise exception 'create_invite: an invite has to come from somebody';
  end if;

  select coalesce(p.is_admin, false) into v_is_admin from profile p where p.id = v_caller;
  v_is_admin := coalesce(v_is_admin, false);

  if p_project_id is null then
    if not v_is_admin then
      raise exception 'create_invite: only an admin can invite somebody to the platform';
    end if;
    -- No project means no ceiling, so the only thing worth serialising is two invites racing to the
    -- same address. The unique index would catch it; the lock lets this report it as a state.
    perform pg_advisory_xact_lock(hashtextextended('rm:invite-email:' || v_email, 0));
  else
    if not v_is_admin and not exists (
      select 1 from project_member m where m.project_id = p_project_id and m.user_id = v_caller
    ) then
      raise exception 'create_invite: % is not a member of project %', v_caller, p_project_id;
    end if;
    -- The same key claim_analysis takes, and taken first there too, so the two cannot deadlock.
    perform pg_advisory_xact_lock(hashtextextended('rm:project:' || p_project_id::text, 0));
  end if;

  -- Inside the lock, so nothing can lapse or be swept between the ageing and the count.
  perform public.expire_invites(p_project_id);
  if p_project_id is null then
    update invite set status = 'expired'
     where status = 'pending' and expires_at <= now() and lower(email) = v_email;
  end if;

  if p_project_id is not null then
    select p.max_members into v_max from project p where p.id = p_project_id;
    if v_max is null then
      raise exception 'create_invite: project % does not exist', p_project_id;
    end if;

    if exists (
      select 1 from project_member m
        join profile pr on pr.id = m.user_id
       where m.project_id = p_project_id and lower(pr.email) = v_email
    ) then
      select count(*)::int into v_members from project_member m where m.project_id = p_project_id;
      select count(*)::int into v_pending from invite i
       where i.project_id = p_project_id and i.status = 'pending' and i.expires_at > now();
      return jsonb_build_object('status', 'already-a-member', 'members', v_members,
                                'pending', v_pending, 'max_members', v_max, 'invite', null);
    end if;
  end if;

  select i.* into v_existing from invite i
   where lower(i.email) = v_email
     and i.status = 'pending'
     and i.expires_at > now()
     and (i.project_id = p_project_id or (i.project_id is null and p_project_id is null))
   limit 1;

  select count(*)::int into v_members from project_member m where m.project_id = p_project_id;
  select count(*)::int into v_pending from invite i
   where i.project_id = p_project_id and i.status = 'pending' and i.expires_at > now();

  if v_existing.id is not null then
    return jsonb_build_object('status', 'already-invited', 'members', v_members,
                              'pending', v_pending, 'max_members', v_max,
                              'invite', to_jsonb(v_existing));
  end if;

  -- Pending invites count toward the ceiling. Without that, six outstanding invites all land and
  -- the project holds twelve people.
  if p_project_id is not null and v_members + v_pending >= v_max then
    return jsonb_build_object('status', 'at-capacity', 'members', v_members,
                              'pending', v_pending, 'max_members', v_max, 'invite', null);
  end if;

  insert into invite (email, project_id, invited_by)
  values (v_email, p_project_id, v_caller)
  returning * into v_invite;

  return jsonb_build_object('status', 'invited', 'members', v_members,
                            'pending', v_pending + 1, 'max_members', v_max,
                            'invite', to_jsonb(v_invite));
end;
$$;

revoke execute on function public.create_invite(text, uuid, uuid) from public, anon, authenticated;
grant execute on function public.create_invite(text, uuid, uuid) to service_role;

-- ---------------------------------------------------------------------------------------------
-- A note the next caller of record_api_usage needs, written where they will be standing.
-- ---------------------------------------------------------------------------------------------

comment on function public.record_api_usage(uuid, uuid, text, int, int, int, text, text) is
  'Records one paid call and returns what it cost. IMPORTANT: p_input_tokens and '
  'p_cached_input_tokens are priced as DISJOINT sets — the cost is input*rate + cached*cached_rate. '
  'OpenAI reports cached tokens as a SUBSET of input_tokens, so a caller passing the raw usage '
  'block straight through bills the cached portion twice, once at the full input rate. Subtract '
  'first: input = usage.input_tokens - usage.cached_tokens. The analyse function does this today. '
  'The columns are stored the same way they are priced, so api_usage.input_tokens means '
  '"uncached input tokens".';

comment on function public.expire_invites(uuid) is
  'Moves pending invites past their expires_at to status `expired`. Idempotent, safe for any '
  'signed-in caller, and worth calling before any view that shows invite status.';

-- ===========================================================================
-- 20260809290000_record_property_link
-- ===========================================================================

-- `record_property` writes the listing and the link together, because the two-step could not work.
--
-- THE CYCLE. `project_property.rightmove_id` references `property(rightmove_id)`, and
-- `record_property` refused unless a `project_property` row already existed. For a listing nobody
-- had opened before — which is the entire purpose of this extension — both orders fail:
--
--   insert the link first    -> foreign key violation, the property row does not exist yet
--   call record_property     -> refused, the link does not exist yet
--
-- Nothing in the client can break that. It worked only for the 55 listings the migration
-- backfilled, which is precisely why tools/check-rls.ts did not catch it: every fixture listing
-- already existed. There is now a case for a genuinely new id, which is the case that matters.
--
-- The fault is mine and it is a specification error before it is a coding one. D4 says the link
-- "is created on the same path, from the listing the user is on" — one path, not two calls. The
-- separate-link step was my reconciliation of D4 against the spec scenario "a member calls
-- record_property for a rightmove_id that no project of theirs has a link to -> the call is
-- refused", and that scenario is now unsatisfiable: creating the link IS opening the listing, so
-- there is no way to call this function for a listing your project has not, by that act, opened.
-- The scenario needs rewriting rather than the code needing to satisfy it.
--
-- WHAT THE GATE WAS BUYING, HONESTLY. It was meant to stop a project rewriting a listing it never
-- opened. But opening a listing is something anyone may do, so a client determined to write about
-- one could always have linked it first and then written. The gate never prevented a determined
-- write; it prevented a blind one, and it did that at the cost of making the ordinary case
-- impossible. What actually protects these tables is unchanged and is the substance of D4: every
-- write goes through a validating SECURITY DEFINER function that checks membership, there is no
-- client DELETE path anywhere, and `property_analysis` remains service-role only end to end.
--
-- Doing both writes here also keeps the foreign key meaning something. Dropping it so that
-- link-first would work would allow `project_property` rows pointing at listings that do not
-- exist, and would quietly make its `on delete cascade` a no-op.
--
-- WHAT REPLACES THE GATE. Attribution. `property.written_by_project` records which project last
-- wrote a shared row. D4 accepts as irreducible that a member can write a wrong price about a
-- listing their project opened and every other project will read it — no server can verify a number
-- read off a page. That risk does not go away, but it stops being anonymous: a wrong fact now names
-- the project that wrote it, so the admin view can answer "who did this" rather than shrugging.

alter table property
  add column if not exists written_by_project uuid references project(id) on delete set null,
  add column if not exists written_at timestamptz;

comment on column property.written_by_project is
  'The project whose member last wrote this shared row through record_property. Null for the rows '
  'that predate accounts. D4 accepts that a member can record a wrong fact about a listing their '
  'project opened; this is what makes that traceable rather than anonymous.';

create or replace function public.record_property(p_project_id uuid, p_property jsonb)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id text := nullif(trim(p_property ->> 'rightmove_id'), '');
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

  insert into public.property (
    rightmove_id, url, postcode, display_address, price, bedrooms, bathrooms,
    latitude, longitude, nearest_stations, image_urls, floorplan_urls,
    floor_area_sqft, floor_area_source, floorplan_url, furnish_type, listing_update,
    -- Added when this was squashed: `description` is a column the already-applied `amenities`
    -- migration introduced, and the analyser reads it for the two amenities only ever stated in
    -- prose. Left out of the insert list it would stay null on every listing.
    description,
    last_seen_at, written_by_project, written_at
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
    now(), p_project_id, now()
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
    written_at = now();

  -- Same statement, same transaction: the property row and this project's claim on it either both
  -- exist or neither does. `first_seen_at` is deliberately not in the update list — it is the one
  -- column here that records something no later visit can tell you.
  insert into public.project_property (project_id, rightmove_id, first_seen_at, last_seen_at)
  values (p_project_id, v_id, now(), now())
  on conflict (project_id, rightmove_id) do update set last_seen_at = now();
end;
$$;

revoke execute on function public.record_property(uuid, jsonb) from public, anon;
grant execute on function public.record_property(uuid, jsonb) to authenticated, service_role;

comment on function public.record_property(uuid, jsonb) is
  'Records what a listing page said, and links it to the calling member''s project, in one '
  'transaction. Both writes or neither: the foreign key from project_property onto property means '
  'a client cannot do these in two calls in either order. Clients do not insert project_property '
  'for a new listing themselves — this is the path.';

-- ---------------------------------------------------------------------------------------------
-- One fact, one place: `last_swept_at` lives on hub_sweep.
--
-- It was on both tables. `project_hub.last_swept_at` came from the D11 sketch; `hub_sweep` has held
-- it since 20260809120000 and is where its meaning is written down and where the rest of the sweep
-- record lives — the window used, the result count, which pages have been read, and the rule in
-- 20260809200000 that only a complete pass may set it. Writing both on completion keeps them equal
-- exactly until something writes one and not the other, which is how two copies of one fact always
-- end. The copy with no history attached is the one to drop.
--
-- `project_hub.max_days_since_added` stays, and is not a duplicate of `hub_sweep.last_window_days`:
-- one is a setting for this hub, the other is a record of what a particular sweep actually covered.
-- ---------------------------------------------------------------------------------------------

alter table project_hub drop column if exists last_swept_at;

-- ===========================================================================
-- 20260809300000_consume_invite
-- ===========================================================================

-- Nothing consumed an invite, and three separate places said it did.
--
-- `invite.accepted_at` existed. The comment at the top of the invite migration said "consumption
-- happens on first successful sign-in". The `auth:verify` handler in background.ts said the same
-- thing in a comment and then called `readAuthState()`. No code anywhere inserted a
-- `project_member` row, marked an invite accepted, set `active_project_id`, or created the project
-- a platform invite promises.
--
-- So an invited person requested a code, received it, verified it, signed in successfully — and
-- landed in no project, permanently, with the picker offering nothing to pick. The whole invite
-- flow terminated one step before the thing it exists to do. It read as finished because every
-- piece around it was: the ceiling, the expiry, the Admin API user creation, the UI for all four
-- outcomes. The comments describing the missing step are the reason nobody noticed.
--
-- This file adds the step, and closes two ways the invite table could be used against itself.

-- ------------------------------------------------------------------------------------------------
-- consume_invites — turn every live invite for the caller's own address into membership.
--
-- Takes no arguments on purpose. It reads the caller from `auth.uid()` and the address from the
-- JWT, so there is no parameter to point at somebody else's invite. An email-carrying argument
-- would make this function the invite system's back door: anyone could name any invited address
-- and join the project it was for.
-- ------------------------------------------------------------------------------------------------
create or replace function public.consume_invites()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user     uuid := auth.uid();
  v_email    text := lower(nullif(trim(coalesce(auth.jwt() ->> 'email', '')), ''));
  v_invite   invite%rowtype;
  v_project  uuid;
  v_members  int;
  v_max      int;
  v_joined   uuid[] := '{}';
  v_full     uuid[] := '{}';
  v_active   uuid;
begin
  if v_user is null or v_email is null then
    raise exception 'consume_invites: no authenticated caller';
  end if;

  -- The profile row is made by the auth.users trigger, but sign-in and this call can land in the
  -- same instant. Make sure it exists rather than failing on a foreign key at the last step.
  insert into profile (id, email)
  values (v_user, v_email)
  on conflict (id) do nothing;

  perform public.expire_invites(null);

  for v_invite in
    select * from invite
     where lower(email) = v_email
       and status = 'pending'
       and expires_at > now()
     order by created_at
  loop
    if v_invite.project_id is null then
      -- A platform invite promises a house hunt of their own. Named for them rather than left
      -- blank: an unnamed project in the switcher is indistinguishable from a broken one.
      insert into project (name)
      values (coalesce(nullif(split_part(v_email, '@', 1), ''), 'My') || '''s house hunt')
      returning id into v_project;
    else
      v_project := v_invite.project_id;

      -- Same lock and same order as create_invite and claim_analysis, so the ceiling cannot be
      -- crossed by an invite being created and another being consumed at the same moment.
      perform pg_advisory_xact_lock(hashtextextended('rm:project:' || v_project::text, 0));

      select count(*)::int into v_members from project_member where project_id = v_project;
      select max_members into v_max from project where id = v_project;

      -- Consuming is net zero against the ceiling — this invite was already counted as pending
      -- when it was created — so the honest test is on members alone. It can still fail, because
      -- an invite issued when there was room can be consumed after somebody else took the place.
      -- Leaving it pending is deliberate: revoking a member's place because they were slow is
      -- worse than telling them the hunt is full and letting somebody make room.
      if v_members >= coalesce(v_max, 6) then
        v_full := v_full || v_project;
        continue;
      end if;
    end if;

    insert into project_member (project_id, user_id)
    values (v_project, v_user)
    on conflict do nothing;

    update invite
       set status = 'accepted', accepted_at = now()
     where id = v_invite.id;

    v_joined := v_joined || v_project;
  end loop;

  -- Land them somewhere. Only when they have nowhere already: a returning member consuming a
  -- second invite must not be yanked out of the hunt they were working in.
  select active_project_id into v_active from profile where id = v_user;
  if v_active is null then
    select project_id into v_active from project_member
     where user_id = v_user order by joined_at limit 1;
    if v_active is not null then
      update profile set active_project_id = v_active where id = v_user;
    end if;
  end if;

  return jsonb_build_object(
    'joined', to_jsonb(v_joined),
    'at_capacity', to_jsonb(v_full),
    'active_project', v_active);
end;
$$;

revoke execute on function public.consume_invites() from public, anon;
grant execute on function public.consume_invites() to authenticated, service_role;

comment on function public.consume_invites() is
  'Turns every live invite for the CALLER''S OWN address into membership, and is the only thing '
  'that does. Argument-free deliberately: it reads auth.uid() and the JWT email, so there is no '
  'parameter that could point it at somebody else''s invite. Call it immediately after a '
  'successful sign-in — before this runs, a newly invited user is in no project at all.';

-- ------------------------------------------------------------------------------------------------
-- Members could rewrite any invite's status, which made the ceiling advisory.
--
-- `grant update (status) on invite to authenticated` plus a policy checking only membership meant
-- a member could set any of the project's invites to any value. Flipping pending to accepted frees
-- a place against the ceiling without anyone joining, and it can be done repeatedly; flipping
-- expired or revoked back to pending resurrects rows that create_invite would have refused to
-- write. Either way `members + pending` stops meaning what create_invite's advisory lock is
-- carefully serialising, so the ceiling holds only against callers who use the front door.
--
-- The fix is that no client writes this table. Revoking is the one transition a member legitimately
-- makes, so it gets a function that can express what create_invite's grant could not: pending to
-- revoked, and nothing else.
-- ------------------------------------------------------------------------------------------------
drop policy if exists revoke_invite on invite;
revoke update on table invite from authenticated;

create or replace function public.revoke_invite(p_invite_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_invite invite%rowtype;
begin
  select * into v_invite from invite where id = p_invite_id;
  if v_invite.id is null then
    return jsonb_build_object('status', 'not-found');
  end if;

  if not (public.is_admin() or (v_invite.project_id is not null and public.is_member(v_invite.project_id))) then
    raise exception 'revoke_invite: not yours to revoke';
  end if;

  -- Only this transition. An accepted invite is a membership and revoking it here would leave the
  -- member in place with the paperwork saying otherwise; removing somebody is a different act with
  -- a different confirmation. An expired one is already spent.
  if v_invite.status <> 'pending' then
    return jsonb_build_object('status', 'not-pending', 'was', v_invite.status);
  end if;

  update invite set status = 'revoked' where id = p_invite_id;
  return jsonb_build_object('status', 'revoked', 'invite_id', p_invite_id);
end;
$$;

revoke execute on function public.revoke_invite(uuid) from public, anon;
grant execute on function public.revoke_invite(uuid) to authenticated, service_role;

-- ------------------------------------------------------------------------------------------------
-- spend_summary answered for anybody whose id you could name.
--
-- It checked that the caller belonged to `p_project_id` and then took `p_user_id` on trust,
-- returning that person's spend across EVERY project plus their personal cap. Co-members' ids are
-- readable from project_member, so any member could read how much another member had spent
-- elsewhere — in projects the caller has nothing to do with. The default of `auth.uid()` described
-- how the client calls it, which is not the same as a constraint.
-- ------------------------------------------------------------------------------------------------
create or replace function public.spend_summary(p_project_id uuid, p_user_id uuid default auth.uid())
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with scope as (
    -- An admin may ask about anyone; everybody else asks about themselves, whatever they passed.
    select case when public.is_admin() then coalesce(p_user_id, auth.uid()) else auth.uid() end as uid
  )
  select case
    when not (public.is_member(p_project_id) or public.is_admin()) then
      jsonb_build_object('error', 'not a member of this project')
    else jsonb_build_object(
      'month_start', public.month_start_london(),
      'resets_at', public.month_start_london() + interval '1 month',
      'project_spent', (select coalesce(sum(u.cost_usd), 0) from public.api_usage u
                         where u.project_id = p_project_id and u.occurred_at >= public.month_start_london()),
      'project_cap', (select p.monthly_cap_usd from public.project p where p.id = p_project_id),
      'user_spent', (select coalesce(sum(u.cost_usd), 0) from public.api_usage u
                      where u.user_id = (select uid from scope)
                        and u.occurred_at >= public.month_start_london()),
      'user_cap', (select p.monthly_cap_usd from public.profile p where p.id = (select uid from scope)))
  end;
$$;

revoke execute on function public.spend_summary(uuid, uuid) from public, anon;
grant execute on function public.spend_summary(uuid, uuid) to authenticated, service_role;
