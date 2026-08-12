-- Hunt preferences: what a project is looking for, set on the "Your Hunt" page and read wherever a
-- flat is judged. One row per project, member-owned, low stakes — the same shape as a verdict or a
-- training exclusion, so it takes the same member-scoped RLS rather than a SECURITY DEFINER writer.
--
-- The preferences are a jsonb blob, not typed columns, for the same reason `project_model.model` is:
-- their shape is owned by `packages/core/src/facts.ts` (a great-room size bar, and a must-have /
-- nice-to-have per amenity) and will grow, and a blob means adding a preference is a code change
-- rather than a migration. Nothing in SQL ever reads inside it; it is read whole and handed to the
-- flag logic.

create table if not exists project_setting (
  project_id  uuid primary key references project(id) on delete cascade,
  preferences jsonb not null default '{}'::jsonb,
  updated_by  uuid references auth.users(id) on delete set null,
  updated_at  timestamptz not null default now()
);

alter table project_setting enable row level security;

-- Project data: members read and write their own project's row, exactly like `verdict` and
-- `training_exclusion`. `updated_by` is pinned to the caller so a change records who made it.
drop policy if exists project_scoped on project_setting;
create policy project_scoped on project_setting for all to authenticated
  using (public.is_member(project_id))
  with check (public.is_member(project_id) and (updated_by is null or updated_by = auth.uid()));

-- Realtime, so a preference changed on one laptop re-flags the flats on another the same way a
-- verdict or a retrain does.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (
      select 1 from pg_publication_tables
       where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'project_setting'
    ) then
      alter publication supabase_realtime add table project_setting;
    end if;
  end if;
end $$;
