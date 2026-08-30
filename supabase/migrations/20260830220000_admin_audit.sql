-- An admin raising a cap leaves a record of having done it.
--
-- Being an admin is a row in `admin_email`, and the three RPCs that move a budget or a member
-- ceiling check `is_admin()` — or the service role — and nothing further. That was accepted while
-- there was one admin who was
-- also the person paying the OpenAI bill: there was nobody to audit against. It stops being true the
-- moment there is a second admin, or an admin who is not the bill-payer, and at that point "who
-- raised this cap, and from what" is a question somebody actually needs answered — asked, always,
-- after the fact, about a change nobody remembers making.
--
-- This is the record and only the record. The other half of the original entry — a second factor on
-- the privileged RPCs — is a separate decision about how an admin authenticates, and bolting a
-- half-considered one onto a log would make both worse.
--
-- WHAT IT COSTS TO GET WRONG: a log that records changes which did not happen is worse than no log,
-- because it is believed. So each function now checks that its UPDATE actually found the row it
-- named and raises if it did not. `update ... where id = $1` against a mistyped id has always
-- reported success and changed nothing; the audit row would have made that failure look like a
-- change, permanently.

create table if not exists admin_action (
  id           bigint generated always as identity primary key,
  occurred_at  timestamptz not null default now(),
  -- Null means the service role did it: it is not a person, has no profile, and `auth.uid()` is
  -- null for it. Operational changes run that way and are a different thing from an admin at a
  -- keyboard, which is why the null is left to say so rather than filled in with a stand-in.
  actor_id     uuid references auth.users(id) on delete set null,
  action       text not null check (action in ('set_user_cap', 'set_project_cap', 'set_max_members')),
  -- One of the two is set, depending on what was changed. Set null rather than cascade for the same
  -- reason `api_usage` does: deleting a project must not erase the record of what was done to it —
  -- which is also why the constraint is `<= 1` and not `= 1`. The `on delete set null` fires as an
  -- UPDATE, the check is re-evaluated, and a row whose subject has been deleted would then fail it
  -- and block the delete. So what is enforced is "never both"; "at least one at insert time" is the
  -- writing functions' job, and a row with neither means the subject is gone.
  subject_user_id    uuid references auth.users(id) on delete set null,
  subject_project_id uuid references project(id) on delete set null,
  check (num_nonnulls(subject_user_id, subject_project_id) <= 1),
  -- Both figures, because "raised to 200" is only half an answer — from 150 is a decision and from
  -- 5 is an incident. Numeric covers both a dollar cap and a member count.
  previous_value numeric,
  new_value      numeric not null
);

alter table admin_action enable row level security;

-- Admins, and nobody else. Unlike `api_usage`, the subject of the row is not entitled to read it:
-- what the log answers is "which admin did this", and handing that to the person whose cap moved
-- would make the log a notification.
drop policy if exists read_admin_action on admin_action;
create policy read_admin_action on admin_action for select to authenticated
  using (public.is_admin());

-- No insert, update or delete policy exists, so RLS refuses all three for `authenticated` however
-- the grants land. The grants are narrowed anyway: two doors, and the failure mode of relying on
-- one of them is invisible.
revoke all on table admin_action from anon, authenticated;
grant select on table admin_action to authenticated;

comment on table admin_action is
  'Who raised whose cap, and from what. Written only by the admin_set_* functions that perform the change; readable by admins.';

-- ---------------------------------------------------------------------------------------------
-- The three functions, which now write the row in the same statement-block as the change.
--
-- Definer functions run as the table owner, so the insert goes in without any policy allowing it —
-- which is the point: the only path that writes this table is the path that performs the action.
-- No signature changes, so `create or replace` is enough and no parameter default is being moved.
-- ---------------------------------------------------------------------------------------------

create or replace function public.admin_set_user_cap(p_user_id uuid, p_cap numeric)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_previous numeric;
  v_rows int;
begin
  if not (public.is_admin() or public.is_service_role()) then
    raise exception 'admin_set_user_cap: admins only';
  end if;
  if p_cap is null or p_cap < 0 then
    raise exception 'admin_set_user_cap: % is not a cap', p_cap;
  end if;

  -- Read before the write, not `returning`: RETURNING hands back the row as it now is, so the log
  -- would have recorded the new figure in both columns and said nothing about what changed.
  select p.monthly_cap_usd into v_previous from public.profile p where p.id = p_user_id;
  update public.profile set monthly_cap_usd = p_cap where id = p_user_id;
  get diagnostics v_rows = row_count;
  if v_rows = 0 then
    raise exception 'admin_set_user_cap: no such user %', p_user_id;
  end if;

  insert into public.admin_action (actor_id, action, subject_user_id, previous_value, new_value)
  values (auth.uid(), 'set_user_cap', p_user_id, v_previous, p_cap);
end;
$$;

create or replace function public.admin_set_project_cap(p_project_id uuid, p_cap numeric)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_previous numeric;
  v_rows int;
begin
  if not (public.is_admin() or public.is_service_role()) then
    raise exception 'admin_set_project_cap: admins only';
  end if;
  if p_cap is null or p_cap < 0 then
    raise exception 'admin_set_project_cap: % is not a cap', p_cap;
  end if;

  select p.monthly_cap_usd into v_previous from public.project p where p.id = p_project_id;
  update public.project set monthly_cap_usd = p_cap where id = p_project_id;
  get diagnostics v_rows = row_count;
  if v_rows = 0 then
    raise exception 'admin_set_project_cap: no such project %', p_project_id;
  end if;

  insert into public.admin_action (actor_id, action, subject_project_id, previous_value, new_value)
  values (auth.uid(), 'set_project_cap', p_project_id, v_previous, p_cap);
end;
$$;

create or replace function public.admin_set_max_members(p_project_id uuid, p_max int)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_previous numeric;
  v_rows int;
begin
  if not (public.is_admin() or public.is_service_role()) then
    raise exception 'admin_set_max_members: admins only';
  end if;
  if p_max is null or p_max < 1 then
    raise exception 'admin_set_max_members: a project holds at least one person';
  end if;

  select p.max_members into v_previous from public.project p where p.id = p_project_id;
  update public.project set max_members = p_max where id = p_project_id;
  get diagnostics v_rows = row_count;
  if v_rows = 0 then
    raise exception 'admin_set_max_members: no such project %', p_project_id;
  end if;

  insert into public.admin_action (actor_id, action, subject_project_id, previous_value, new_value)
  values (auth.uid(), 'set_max_members', p_project_id, v_previous, p_max);
end;
$$;

-- `create or replace` keeps the grants a function already had, but stating them again is what makes
-- this file readable on its own — and `revoke ... from public` alone would leave standing the
-- explicit grant Supabase's default privileges hand every new function in this schema.
do $$
declare f text;
begin
  foreach f in array array[
    'public.admin_set_user_cap(uuid, numeric)',
    'public.admin_set_project_cap(uuid, numeric)',
    'public.admin_set_max_members(uuid, int)'
  ] loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated, service_role', f);
  end loop;
end $$;
