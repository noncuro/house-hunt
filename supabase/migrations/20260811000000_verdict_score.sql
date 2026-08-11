-- The verdict score: a per-project classifier that learns from the project's own verdicts and
-- predicts P(yes) for any flat. Two tables and one writer.
--
-- `project_model` holds the fitted model — one row per project. The model itself is a small jsonb
-- blob (weights, the feature spec that standardised them, the cross-validated hyperparameters, and
-- the honest metrics) rather than a wide set of typed columns, because its shape is owned by
-- `packages/core/src/predict.ts` and will grow features over time; a blob means adding one is a
-- code change, not a migration. Only the `predict` Edge Function writes it, exactly like the travel
-- caches: the fit needs the whole project's verdicts and holds no secret, but making the server the
-- sole writer keeps a client from stuffing a hand-made model into the table every surface then
-- trusts. Members read it (it is theirs); nobody else sees it.
--
-- `training_exclusion` is how a flat leaves the training set without losing its verdict. A place you
-- loved that is no longer on the market is still a place you loved — deleting the verdict would lose
-- that, but leaving it in trains the model on a listing you can't act on. So the exclusion is a
-- separate mark, project-scoped and member-set (rating is member-set too, and this is the same
-- low-stakes project data), and the fit left-joins it out. The verdict stays; only its vote in the
-- model is withdrawn.

create table if not exists project_model (
  project_id  uuid primary key references project(id) on delete cascade,
  -- The serialised `Model` from predict.ts: { version, labelMode, columns, weights, bias,
  -- hyperparams, metrics }. Read whole and handed to `score()`; never picked apart in SQL.
  model       jsonb not null,
  -- Denormalised out of the blob so a surface can spot a stale model, and a human can read the
  -- table, without parsing jsonb. `version` is predict.ts's MODEL_VERSION at training time.
  version     int not null,
  label_mode  text not null check (label_mode in ('love-vs-no', 'lovemaybe-vs-no')),
  -- How many labelled flats the fit saw (after exclusions). A model trained on eight verdicts and
  -- one trained on eighty are both "a model"; this is how the UI says which.
  n_examples  int not null default 0,
  trained_by  uuid references auth.users(id) on delete set null,
  trained_at  timestamptz not null default now()
);

-- A flat withheld from one project's training set. The verdict is untouched; this only says "don't
-- learn from this one" — typically because it is off the market and can no longer be acted on.
create table if not exists training_exclusion (
  project_id   uuid not null references project(id) on delete cascade,
  rightmove_id text not null references property(rightmove_id) on delete cascade,
  reason       text not null default '',
  set_by       uuid references auth.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  primary key (project_id, rightmove_id)
);

alter table project_model      enable row level security;
alter table training_exclusion enable row level security;

-- project_model: members read their project's model. No client write policy exists — the only
-- writer is the SECURITY DEFINER function below, running as the service role.
drop policy if exists read_project_model on project_model;
create policy read_project_model on project_model for select to authenticated
  using (public.is_member(project_id) or public.is_admin());

-- training_exclusion: project data, so members read and write it for their own project, the same
-- shape as the `verdict` policy. `set_by` is pinned to the caller so a mark records who made it.
drop policy if exists project_scoped on training_exclusion;
create policy project_scoped on training_exclusion for all to authenticated
  using (public.is_member(project_id))
  with check (public.is_member(project_id) and (set_by is null or set_by = auth.uid()));

-- The one writer of project_model. Guarded by `is_service_role()` for the same reason the travel
-- caches are: the row is written by the `predict` function and by nothing else, and `auth.uid()`
-- is null for the service role, so the guard is an explicit "is this the server", not an accident.
create or replace function public.set_project_model(
  p_project_id uuid,
  p_model      jsonb,
  p_version    int,
  p_label_mode text,
  p_n_examples int,
  p_trained_by uuid default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_service_role() then
    raise exception 'set_project_model: the model is written by the predict function, not by clients';
  end if;
  if p_label_mode not in ('love-vs-no', 'lovemaybe-vs-no') then
    raise exception 'set_project_model: % is not a label mode', p_label_mode;
  end if;

  insert into public.project_model (project_id, model, version, label_mode, n_examples, trained_by, trained_at)
  values (p_project_id, p_model, p_version, p_label_mode, p_n_examples, p_trained_by, now())
  on conflict (project_id) do update set
    model       = excluded.model,
    version     = excluded.version,
    label_mode  = excluded.label_mode,
    n_examples  = excluded.n_examples,
    trained_by  = excluded.trained_by,
    trained_at  = now();
end;
$$;

revoke execute on function public.set_project_model(uuid, jsonb, int, text, int, uuid) from public;
grant  execute on function public.set_project_model(uuid, jsonb, int, text, int, uuid) to service_role;

-- The other half of the writer. A retrain that can no longer fit a model — the project excluded its
-- way below MIN_PER_CLASS, or re-rated enough flats that one class emptied — must not leave the old
-- row standing. "Insufficient" and a table still holding last week's weights means every surface
-- goes on scoring flats against a model the project's own data no longer supports, and the retrain
-- that was supposed to correct it is the thing that reports success at doing nothing. Deleting is
-- right rather than flagging stale: the model is derived data, cheap to refit the moment the
-- verdicts support one again.
create or replace function public.clear_project_model(p_project_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_service_role() then
    raise exception 'clear_project_model: the model is written by the predict function, not by clients';
  end if;

  delete from public.project_model where project_id = p_project_id;
end;
$$;

revoke execute on function public.clear_project_model(uuid) from public;
grant  execute on function public.clear_project_model(uuid) to service_role;

-- Realtime, so a retrain on one laptop refreshes the scores on another, the same way a verdict does.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    -- `add table` errors if the table is already a member; guard so the migration is re-runnable.
    if not exists (
      select 1 from pg_publication_tables
       where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'project_model'
    ) then
      alter publication supabase_realtime add table project_model;
    end if;
    if not exists (
      select 1 from pg_publication_tables
       where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'training_exclusion'
    ) then
      alter publication supabase_realtime add table training_exclusion;
    end if;
  end if;
end $$;
