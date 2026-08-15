-- One list of places, instead of two lists of the same thing.
--
-- A project kept `place` (somewhere you measure the commute to) and `project_hub` (somewhere you
-- search around). Both are "a spot on the map this hunt cares about, with a name you can picture
-- standing in", and both already answered the compass question — `hubsWithPlaces` merged them at
-- read time on every card, with a tie-break rule to decide which name won. Two tables, one concept,
-- and a setup flow that made you type Angel twice to have it both searched and measured.
--
-- So `place` absorbs the hub. A row that carries a Rightmove location identifier and a radius is a
-- place this hunt sweeps around; a row without one is a place it only measures against; and the
-- compass reads every row either way. What used to be "add a neighbourhood" is now a toggle on a
-- place you already saved.
--
-- What deliberately does not change:
--
--   * `search_sighting.hub` stays a text name. It is a record of what a search was filed under at
--     the time, not a foreign key — see the note on it in the multi-tenant migration. Renaming a
--     place must not rewrite history.
--   * `hub_sweep` keeps its own row per place with the pages recorded, and re-keys onto `place.id`
--     the same way it re-keyed onto `project_hub.id`. The composite foreign key that stops a sweep
--     and its place from disagreeing about the project is carried over intact.
--   * A place with no coordinate is still skipped, never defaulted. A guessed point silently
--     rotates every bearing computed from it and nothing on screen looks wrong.
-- ---------------------------------------------------------------------------------------------

-- The two halves of "Rightmove can search this", exactly as `project_hub` held them. Null means
-- this place is not swept — which is the honest state for the office and for Heathrow, and the
-- starting state for a place whose postcode has not been resolved to an identifier yet.
alter table place add column if not exists rightmove_location_id text;
alter table place add column if not exists display_location_id   text;

-- How far around the place to search, in miles. Rightmove's own `radius` parameter takes exactly
-- these steps, so this is stored as the number that goes into the URL rather than as anything that
-- has to be converted on the way out. Null means "not a sweep centre", which is the same sentence
-- the identifier above tells; both are required before a search URL can be built, and the code
-- refuses rather than picking a radius nobody chose.
-- Two decimal places, not one. Rightmove's own radius control offers a quarter mile, and
-- `numeric(3,1)` rounds 0.25 to 0.3 on the way in — which is not one of the values Rightmove
-- accepts, so the select would have no matching option and the search URL would carry a radius
-- nobody chose. Exactly the class of silent default this project keeps refusing.
alter table place add column if not exists sweep_radius_miles numeric(4, 2);
-- And widen it where an earlier run of this file created it as `numeric(3,1)`. `add column if not
-- exists` does nothing to a column that is already there, so without this a database part-way
-- through a `psql -f` that failed keeps the precision that rounds 0.25 to 0.3 — and re-running the
-- migration, which is how this project fixes a partial apply, would report success and change
-- nothing.
alter table place alter column sweep_radius_miles type numeric(4, 2);
alter table place add column if not exists max_days_since_added int;

-- A hub never had a postcode — it was a name resolved to a coordinate and an identifier — so the
-- column that was mandatory for a travel destination cannot stay mandatory for every place.
-- Travel reads it and skips a place without one, which is the existing rule for a place whose
-- postcode never resolved, so nothing downstream needs to learn a new state.
alter table place alter column postcode drop not null;

comment on column place.sweep_radius_miles is
  'Miles to search around this place, or null for a place we only measure travel time to. Paired '
  'with rightmove_location_id: both are needed to build a search URL, and neither is defaulted.';

-- One place per name per hunt. Case-insensitive, because "Work" and "work" are the same place to
-- everybody except a database, and the sweep is recorded by name.
--
-- Existing duplicates are renamed rather than merged or deleted: two places with one name are two
-- rows somebody made on purpose, and which is "the" Work is not ours to decide. The suffix makes
-- them distinguishable and visible, which is what gets them fixed.
-- The suffix is searched for rather than computed from the row's position among its duplicates. A
-- hunt holding `Work`, `Work` and `Work (2)` would otherwise rename the second `Work` to `Work (2)`
-- and collide with the row already called that, and the unique index below would fail on a
-- migration whose whole job here is to make it succeed.
do $$
declare dup record;
declare n int;
declare candidate text;
begin
  for dup in
    select id, project_id, label,
           row_number() over (partition by project_id, lower(label) order by created_at, id) as rank
      from place
  loop
    continue when dup.rank = 1;
    n := 1;
    loop
      n := n + 1;
      candidate := dup.label || ' (' || n || ')';
      exit when not exists (
        select 1 from place p
         where p.project_id = dup.project_id and lower(p.label) = lower(candidate)
      );
    end loop;
    update place set label = candidate where id = dup.id;
  end loop;
end $$;

create unique index if not exists place_project_label_key on place (project_id, lower(label));

-- ---------------------------------------------------------------------------------------------
-- Fold the neighbourhoods in.
--
-- Matched on (project_id, lower(name)) against existing places so a hunt that saved "Angel" as
-- both a neighbourhood and a place ends up with one row carrying both jobs, rather than two rows
-- with the same name and half the answer each.
--
-- Which is only well defined if the name picks out one row. Nothing enforced that before — `place`
-- had no uniqueness at all, while `project_hub` had `unique (project_id, name)` — so two places
-- called "Work" would both collect the hub's identifier and radius, show two identical sweep links,
-- and record progress under neither: `placeIdFor` asks for one row by name and gets two. The
-- constraint goes on below, after the fold, and the fold is written to leave nothing that violates
-- it.
-- ---------------------------------------------------------------------------------------------
do $$
begin
  if to_regclass('public.project_hub') is null then
    return;
  end if;

  -- Where a place of the same name already exists, it gains the search half. Coordinates are only
  -- filled in where the place had none: a postcode resolved through postcodes.io is at least as
  -- good as a hub's anchor, and overwriting it would move a point that other rows have been
  -- measured against.
  update place p
     set rightmove_location_id = coalesce(p.rightmove_location_id, h.rightmove_location_id),
         display_location_id   = coalesce(p.display_location_id, h.display_location_id),
         max_days_since_added  = coalesce(p.max_days_since_added, h.max_days_since_added),
         lat                   = coalesce(p.lat, h.lat),
         lon                   = coalesce(p.lon, h.lon),
         sweep_radius_miles    = coalesce(p.sweep_radius_miles,
                                          case when h.rightmove_location_id is not null then 1.0 end)
    from project_hub h
   where h.project_id = p.project_id
     and lower(h.name) = lower(p.label);

  -- The rest arrive as places in their own right. 1.0 miles is what every sweep URL this project
  -- has ever built used, so it is the radius already in force rather than a new default — see
  -- `RENTAL_SEARCH` and the sweep URL builder.
  insert into place (project_id, label, postcode, lat, lon, sort_order,
                     rightmove_location_id, display_location_id, max_days_since_added,
                     sweep_radius_miles)
  select h.project_id,
         h.name,
         null,
         h.lat,
         h.lon,
         1000 + h.sort_order,  -- after the saved places, in the order the hubs were in
         h.rightmove_location_id,
         h.display_location_id,
         h.max_days_since_added,
         case when h.rightmove_location_id is not null then 1.0 end
    from project_hub h
   where not exists (
           select 1 from place p
            where p.project_id = h.project_id and lower(p.label) = lower(h.name)
         );
end $$;

-- ---------------------------------------------------------------------------------------------
-- hub_sweep follows its hub into place.
-- ---------------------------------------------------------------------------------------------
create unique index if not exists place_project_id_idx on place (project_id, id);

alter table hub_sweep add column if not exists place_id uuid references place(id) on delete cascade;

-- The name this search was filed under, back again. It was `hub_sweep`'s primary key originally and
-- the multi-tenant migration dropped it in favour of `hub_id`, on the reasoning that the hub row
-- carries the name — which holds right up until there is no row. `place_id` is nullable because the
-- backfill below cannot always find one: a sweep recorded against a hub that was deleted before this
-- migration ran has nothing to point at. Such a row keeps its pages and its name instead of saying
-- which pages were recorded and refusing to say of what. (Deleting a place from here on is the other
-- case, and it cascades — see the note above the foreign key.) `search_sighting.hub` has always been
-- a text name for the same reason.
alter table hub_sweep add column if not exists hub text;

-- Only the backfill is guarded on `project_hub` still being here. The schema changes below it are
-- not: they used to sit inside the same block, so a database where the table was already gone —
-- one restored from a dump taken after this ran, a re-run against a partly-migrated copy — got the
-- early return and kept `hub_sweep.hub_id` with no composite key onto `place`. The client stopped
-- writing `hub_id` in the same commit, so a surviving `not null` on it fails every sweep write, and
-- the header above would be claiming a foreign key that was never created.
do $$
begin
  if to_regclass('public.project_hub') is null then
    return;
  end if;

  update hub_sweep s
     set place_id = p.id,
         hub      = coalesce(s.hub, h.name)
    from project_hub h
    join place p on p.project_id = h.project_id and lower(p.label) = lower(h.name)
   where s.hub_id = h.id
     and s.place_id is null;

  -- A sweep whose hub row is still there but whose name never matched a place — a hub renamed after
  -- its sweep was recorded. It keeps the name rather than being left anonymous.
  update hub_sweep s
     set hub = coalesce(s.hub, h.name)
    from project_hub h
   where s.hub_id = h.id
     and s.hub is null;

end $$;

-- A sweep whose hub was dropped before this migration ran has no place to point at, which is why
-- `place_id` is nullable. It keeps its name and its pages and loses only the link.
--
-- That is not the same as deleting a place from here on: both foreign keys cascade, so removing a
-- sweep centre removes its sweep, and the button that does it says as much. Keeping a sweep against
-- a place nobody has any more would date the next window of a search nobody is running — the one
-- failure in the sweep that looks exactly like success.
--
-- Unconditional, and *before* the table goes: `hub_id` references `project_hub`, so dropping the
-- table first fails outright with "other objects depend on it". Being outside the guard is what
-- makes the whole thing re-runnable — inside it, a database that had already lost `project_hub`
-- kept `hub_id` and never gained the composite key below, and the client stopped writing `hub_id`
-- in this same commit.
alter table hub_sweep drop constraint if exists hub_sweep_project_hub_fkey;
alter table hub_sweep drop column if exists hub_id;

drop table if exists project_hub;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'hub_sweep'::regclass and conname = 'hub_sweep_place_fkey'
  ) then
    alter table hub_sweep add constraint hub_sweep_place_fkey
      foreign key (project_id, place_id) references place (project_id, id) on delete cascade;
  end if;
end $$;

-- `recordSweepPage` upserts on this, so it has to be unique — as `hub_id` was.
create unique index if not exists hub_sweep_place_id_key on hub_sweep (place_id);

comment on column hub_sweep.place_id is
  'The place this sweep is of. Denormalised project_id beside it, with the composite foreign key '
  'onto place(project_id, id) stopping the two from disagreeing — as it did for project_hub.';

-- The privileges are the table's, and the table already had them; the new columns inherit. Stated
-- anyway because the project''s default privileges hand `anon` DML on anything new, and a column
-- added to an existing table is the one case where that is not in play but the habit still is.
revoke all on table place from anon;
revoke all on table hub_sweep from anon;
