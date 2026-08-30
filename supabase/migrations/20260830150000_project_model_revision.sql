-- A retrain carries the revision of the verdicts it was fitted on, and the write refuses if that
-- revision has moved.
--
-- Two retrains overlapping meant the one that started earlier — fitted on the older verdicts — could
-- land last and overwrite the newer model, silently: the person who pressed the button last was told
-- it succeeded, and it had, their model was just not the one in the row. The Edge Function had the
-- same unguarded write; what changed with the move to a Vercel route (#64) is the size of the
-- window, from a fit cut off at two seconds of CPU to a 300-second maxDuration. Issue #88.
--
-- Not an advisory lock. A lock inside set_project_model serialises the *write* while leaving the
-- read-fit-write cycle interleaved, so the stale model still wins and the code looks fixed. The fit
-- has to carry what it was built from, and the write has to compare.
--
-- The revision is recomputed here, on the same connection as the write, rather than trusted from
-- the caller: the caller reads it *before* reading the training rows, so a verdict that changes
-- between those two reads is caught too — the write sees the newer revision and refuses, and the
-- route refits. Over-refusal in that sliver is the right error; the alternative is a model fitted
-- on rows the revision does not describe.

-- md5 over everything the fit reads that is project data: each verdict's flat, rating and last
-- change, and the set of excluded flats. Places and preferences are deliberately not in it — they
-- shape the features, not the labels, and a retrain after a place is added is what somebody
-- asked for, not a stale one. Ordered so the hash is a function of the set and not of plan choice.
create or replace function public.project_training_revision(p_project_id uuid)
returns text
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select md5(
    coalesce((
      select string_agg(rightmove_id || ':' || rating || ':' || updated_at::text, ',' order by rightmove_id)
      from public.verdict where project_id = p_project_id
    ), '')
    || '|' ||
    coalesce((
      select string_agg(rightmove_id, ',' order by rightmove_id)
      from public.training_exclusion where project_id = p_project_id
    ), '')
  );
$$;

revoke execute on function public.project_training_revision(uuid) from public;
grant  execute on function public.project_training_revision(uuid) to service_role;

-- Both writers gain a trailing `p_revision`. Dropped and recreated rather than replaced: a new
-- parameter is a new signature, and `create or replace` would have left the old one standing
-- beside it as an overload nobody meant. The return changes from void to whether the write
-- happened — a superseded fit is an outcome to report, not an error to throw.
drop function if exists public.set_project_model(uuid, jsonb, int, text, int, uuid);
drop function if exists public.clear_project_model(uuid);

create function public.set_project_model(
  p_project_id uuid,
  p_model      jsonb,
  p_version    int,
  p_label_mode text,
  p_n_examples int,
  p_trained_by uuid default null,
  -- Null means "do not check" and exists for the Edge Function this route replaced, which still
  -- calls the old shape until it is retired; the route always passes one.
  p_revision   text default null
)
returns boolean
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
  if p_revision is not null and p_revision <> public.project_training_revision(p_project_id) then
    return false;
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
  return true;
end;
$$;

revoke execute on function public.set_project_model(uuid, jsonb, int, text, int, uuid, text) from public;
grant  execute on function public.set_project_model(uuid, jsonb, int, text, int, uuid, text) to service_role;

-- The same guard on the clear. A stale "insufficient" deleting a model that newer verdicts do
-- support is the same overwrite with nothing in the row afterwards.
create function public.clear_project_model(p_project_id uuid, p_revision text default null)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_service_role() then
    raise exception 'clear_project_model: the model is written by the predict function, not by clients';
  end if;
  if p_revision is not null and p_revision <> public.project_training_revision(p_project_id) then
    return false;
  end if;

  delete from public.project_model where project_id = p_project_id;
  return true;
end;
$$;

revoke execute on function public.clear_project_model(uuid, text) from public;
grant  execute on function public.clear_project_model(uuid, text) to service_role;
