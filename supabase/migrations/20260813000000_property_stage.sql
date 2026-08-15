-- The funnel: how far a place has got, which is a different question from how much we like it.
--
-- A verdict is taste — "not our place", "like it", "love it" — and it is the label the verdict-score
-- model learns from. A stage is progress: reached out, viewing booked, viewed, offer in, archived.
-- Keeping them in one column would destroy the first the moment the second moved: a flat you loved
-- and then lost to a higher offer would end up recorded as "rejected", and the model would learn
-- that you dislike exactly the flat you liked most. So a stage never touches a verdict, and the only
-- direction the two are coupled is the one below — liking something is what puts it in the funnel.
--
-- One row per property per project, member-owned, low stakes: the same shape as `verdict` and
-- `project_setting`, and therefore the same member-scoped RLS rather than a SECURITY DEFINER writer.

create table if not exists property_stage (
  project_id     uuid not null references project(id) on delete cascade,
  rightmove_id   text not null references property(rightmove_id) on delete cascade,
  stage          text not null check (stage in
                   ('shortlisted', 'enquired', 'viewing_booked', 'viewed', 'offer_made', 'archived')),
  -- Why it was archived, which is the whole content of an archive. "Archived" alone answers
  -- nothing a month later — whether a flat went because somebody outbid you or because you walked
  -- away is the difference between a near miss and a taste you have learned something about.
  archive_reason text check (archive_reason in ('offer_rejected', 'gone', 'passed', 'other')),
  note           text not null default '',
  set_by         uuid references auth.users(id) on delete set null,
  updated_at     timestamptz not null default now(),
  primary key (project_id, rightmove_id),
  -- A reason belongs to an archive and to nothing else, in both directions. Without the second half
  -- a flat moved on from `archived` back to `viewed` would keep the reason it was archived for, and
  -- every renderer would then have to decide which of the two to believe.
  constraint property_stage_reason check (
    (stage = 'archived') = (archive_reason is not null)
  )
);

alter table property_stage enable row level security;

-- Project data: members read and write their own project's rows, exactly like `verdict`. `set_by`
-- must be the caller — required rather than "null or the caller", so a member cannot write a row
-- that erases who moved it. The trigger below is the one writer that does not go through this
-- policy, and it is SECURITY DEFINER for that reason.
drop policy if exists project_scoped on property_stage;
create policy project_scoped on property_stage for all to authenticated
  using (public.is_member(project_id))
  with check (public.is_member(project_id) and set_by = auth.uid());

-- Entering the funnel is something liking a place does, and this is the half of that sentence the
-- database can hold. Without it the policy above lets any member insert a row saying `viewed` for a
-- property nobody has rated — which is not a security hole (it is their own project's data) but it
-- does quietly falsify the one thing every reader here assumes: that a flat outside the funnel is a
-- flat nobody has liked. The funnel bar counts on it, and so does the triage pile.
--
-- `as restrictive`, because permissive policies are OR-ed together: a second permissive policy would
-- widen what is allowed rather than narrow it. Restrictive ones are AND-ed, so this is a condition
-- on top of `project_scoped` rather than an alternative to it.
--
-- The second half of the test — "or it is already in the funnel" — is what makes this survivable,
-- and it is here because `check:rls` refused the first version of it. Every stage write from either
-- client is an upsert, and an `insert … on conflict do update` is judged by the INSERT policy even
-- when it takes the update path. Without the disjunct, a flat you viewed and have since decided
-- against could never be archived: its verdict is no longer a like, so the write that records how
-- it ended was refused. That is a rule this feature exists to keep — progress survives a change of
-- mind — and it would have gone out broken.
--
-- `in_funnel` rather than a subquery on this table, because a policy on `property_stage` that reads
-- `property_stage` recurses ("infinite recursion detected in policy"). Same shape, and same reason,
-- as `is_member` — and gated on membership itself, so it cannot answer questions about anybody
-- else's hunt.
--
-- The trigger below is unaffected either way: it is SECURITY DEFINER, so it runs as the table's
-- owner and RLS does not apply to it at all.
create or replace function public.in_funnel(p_project_id uuid, p_rightmove_id text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public.is_member(p_project_id) and exists (
    select 1 from public.property_stage s
     where s.project_id = p_project_id and s.rightmove_id = p_rightmove_id
  );
$$;

drop policy if exists stage_needs_a_like on property_stage;
create policy stage_needs_a_like on property_stage as restrictive for insert to authenticated
  with check (
    exists (
      select 1 from public.verdict v
       where v.project_id = property_stage.project_id
         and v.rightmove_id = property_stage.rightmove_id
         and v.rating in ('maybe', 'love')
    )
    or public.in_funnel(property_stage.project_id, property_stage.rightmove_id)
  );

grant select, insert, update, delete on table property_stage to authenticated;

-- `anon` holds nothing, and saying so has to be explicit: the project's default privileges hand the
-- anon role full DML on every new public table, so the grant above is an addition to that rather
-- than the whole of it. Left alone, this is the one table where an unauthenticated request is
-- answered — with `[]` rather than a refusal, because the policies above are `to authenticated` and
-- RLS returns no rows. Nothing leaks either way; what differs is the distance to a leak, which
-- becomes one mistyped policy rather than two.
revoke all on table property_stage from anon;

-- Liking a place is what enters it into the funnel, and the database does it rather than each
-- client, for the same reason `archive_verdict` is a trigger: a client-side follow-up write is one
-- a client can forget, and the two surfaces that rate flats (the panel on Rightmove, and triage in
-- bulk on the website) would then disagree about whether a rated flat is in the funnel at all.
--
-- Two rules, and the second is the one worth stating out loud:
--
--   * an existing stage is never overwritten. Re-rating a flat you have already viewed must not
--     send it back to the start of the funnel.
--   * a rating of "not our place" removes the stage only while it is still `shortlisted` — that is
--     the stage the like itself created, so withdrawing the like withdraws it. Anything further on
--     stays: you really did reach out, or view it, and deciding against it afterwards is what
--     archiving is for. It is also the honest record for a flat rejected after a viewing.
--
-- SECURITY DEFINER so it holds regardless of who wrote the verdict — the service role and a
-- migration both write verdicts with no `auth.uid()`, and under the policy above those inserts
-- would be refused, silently leaving the flat out of the funnel.
create or replace function public.enter_funnel()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.rating in ('maybe', 'love') then
    insert into public.property_stage (project_id, rightmove_id, stage, set_by)
    values (new.project_id, new.rightmove_id, 'shortlisted', new.set_by)
    on conflict (project_id, rightmove_id) do nothing;
  else
    delete from public.property_stage
     where project_id = new.project_id
       and rightmove_id = new.rightmove_id
       and stage = 'shortlisted';
  end if;
  return null;
end;
$$;

drop trigger if exists verdict_enter_funnel on verdict;
create trigger verdict_enter_funnel
  after insert or update of rating on verdict
  for each row execute function public.enter_funnel();

-- Every flat already rated positively is in the funnel already, as far as anyone using this is
-- concerned — they are the shortlist. Without this they would sit outside it until somebody
-- re-rated them, and the funnel would open empty on a hunt with thirty places in it.
insert into property_stage (project_id, rightmove_id, stage, set_by, updated_at)
select v.project_id, v.rightmove_id, 'shortlisted', v.set_by, v.updated_at
  from verdict v
 where v.rating in ('maybe', 'love')
on conflict (project_id, rightmove_id) do nothing;

-- Realtime, so a viewing booked on one laptop moves the flat on the other, the same way a verdict
-- or a preference does.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (
      select 1 from pg_publication_tables
       where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'property_stage'
    ) then
      alter publication supabase_realtime add table property_stage;
    end if;
  end if;
end $$;
