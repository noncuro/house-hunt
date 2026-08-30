-- Inviting an address that already has an account adds them to the project, there and then.
--
-- WHAT WENT WRONG. An invite was always a pending row, and the only thing that turned a pending row
-- into a membership was `consume_invites()`, which the website called at exactly one moment: right
-- after a password was accepted. That was the right moment for somebody new — they have to sign in
-- to exist — and the wrong one for everybody else. Somebody who already has an account is already
-- signed in, on a phone that keeps its session for months, and so never reaches that moment. The
-- owner watched the screen mint a code for a person who needed no code, and the invited person
-- watched nothing at all: the project never appeared, and no screen on either side said why.
--
-- WHAT CHANGES. `create_invite` now asks whether the address has a profile. If it does, the
-- membership is written in the same transaction, under the same lock, and the answer is `added`
-- rather than `invited` — no code is minted, because there is nobody to redeem it. The invite row
-- is still written, as `accepted`, so the project's list of who was asked in reads the same either
-- way. A pending invite that was already waiting for an existing account — the rows this bug left
-- behind — is consumed on the spot by the next attempt to invite them, which is what the owner will
-- do when the first one visibly did nothing.
--
-- WHAT DOES NOT CHANGE. Only a *profile* is adding somebody, and a profile exists only because an
-- `auth.users` row does, which only the two Edge Functions holding the service role create. A
-- stranger's address has no profile and gets a pending invite with a code, exactly as before. The
-- ceiling is counted in the same statement as the write, as it was.
--
-- The actual joining moves into `accept_invite()` so the direct path and the sign-in path cannot
-- come to disagree about what it means to take a place: `consume_invites()` loops over it now.

-- ------------------------------------------------------------------------------------------------
-- accept_invite — one live invite becomes one membership, or does not because the hunt is full.
--
-- Returns the project joined, or null when there was no room. Not callable by clients: it takes the
-- user as an argument, which is exactly the back door `consume_invites()` refuses to have, and it is
-- safe here only because both callers are `security definer` functions that have already decided
-- whose invite this is.
-- ------------------------------------------------------------------------------------------------
create or replace function public.accept_invite(p_invite invite, p_user uuid, p_email text)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_project uuid;
  v_members int;
  v_max     int;
begin
  if p_invite.project_id is null then
    -- A platform invite promises a house hunt of their own. Named for them rather than left
    -- blank: an unnamed project in the switcher is indistinguishable from a broken one.
    insert into project (name)
    values (coalesce(nullif(split_part(p_email, '@', 1), ''), 'My') || '''s house hunt')
    returning id into v_project;
  else
    v_project := p_invite.project_id;

    -- Same lock and same order as create_invite and claim_analysis, so the ceiling cannot be
    -- crossed by an invite being created and another being consumed at the same moment. Re-entrant
    -- within a transaction, which is what lets create_invite hold it and then call this.
    perform pg_advisory_xact_lock(hashtextextended('rm:project:' || v_project::text, 0));

    select count(*)::int into v_members from project_member where project_id = v_project;
    select max_members into v_max from project where id = v_project;

    -- Consuming is net zero against the ceiling — this invite was already counted as pending
    -- when it was created — so the honest test is on members alone. It can still fail, because
    -- an invite issued when there was room can be consumed after somebody else took the place.
    -- Leaving it pending is deliberate: revoking a member's place because they were slow is
    -- worse than telling them the hunt is full and letting somebody make room.
    if v_members >= coalesce(v_max, 6) then
      return null;
    end if;
  end if;

  insert into project_member (project_id, user_id)
  values (v_project, p_user)
  on conflict do nothing;

  update invite
     set status = 'accepted', accepted_at = now()
   where id = p_invite.id;

  -- Land them somewhere, but only somebody with nowhere already: a returning member taking up a
  -- second invite must not be yanked out of the hunt they were working in.
  update profile set active_project_id = v_project
   where id = p_user and active_project_id is null;

  return v_project;
end;
$$;

revoke execute on function public.accept_invite(invite, uuid, text) from public, anon, authenticated;

-- ------------------------------------------------------------------------------------------------
-- consume_invites — unchanged in what it promises; the joining itself now lives in accept_invite.
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
    v_project := public.accept_invite(v_invite, v_user, v_email);
    if v_project is null then
      v_full := v_full || v_invite.project_id;
    else
      v_joined := v_joined || v_project;
    end if;
  end loop;

  -- Somebody with memberships and no active project — after leaving the hunt they were in, say —
  -- is landed in the earliest of them. accept_invite lands the ones it joins; this covers the rest.
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

comment on function public.consume_invites() is
  'Turns every live invite for the CALLER''S OWN address into membership. Argument-free '
  'deliberately: it reads auth.uid() and the JWT email, so there is no parameter that could point '
  'it at somebody else''s invite. Called every time the app reads who is signed in, not only on '
  'sign-in — a session on a phone lasts months, and an invite that waits for the next sign-in waits '
  'for good. An address that already has an account is added by create_invite() directly and '
  'never needs this; it remains the path for a platform invite and for rows written before that.';

-- ------------------------------------------------------------------------------------------------
-- create_invite — the same function, with the branch for an address that already has an account.
--
-- The signature is restated in full, default included: `create or replace` cannot drop a default,
-- and the three-argument calls in `tools/check-rls.ts` have to keep resolving here.
-- ------------------------------------------------------------------------------------------------
create or replace function public.create_invite(
  p_email      text,
  p_project_id uuid,
  p_invited_by uuid,
  p_code_hash  text default null
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
  -- The account behind the address, if there is one. A profile exists only because an auth.users
  -- row does, so this is "do they have an account", read from the table this function already
  -- joins to rather than from the Admin API.
  v_user     uuid;
  v_members  int;
  v_pending  int;
  v_max      int;
  v_existing invite;
  v_invite   invite;
  v_joined   uuid;
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

  select pr.id into v_user from profile pr where lower(pr.email) = v_email limit 1;

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
    -- An invite already waiting for somebody who already has an account is the state this bug left
    -- behind. Reporting it as "already invited" would be true and useless — the row has been
    -- waiting for a sign-in that is never going to happen. Take it up now instead. A place was
    -- reserved for it when it was written, so this cannot cross the ceiling.
    if v_user is not null then
      v_joined := public.accept_invite(v_existing, v_user, v_email);
      if v_joined is null then
        return jsonb_build_object('status', 'at-capacity', 'members', v_members,
                                  'pending', v_pending, 'max_members', v_max, 'invite', null);
      end if;
      select i.* into v_invite from invite i where i.id = v_existing.id;
      -- greatest(): a platform invite's pending count is over `project_id = null`, which counts
      -- nothing, and 0 - 1 would claim negative invites outstanding.
      return jsonb_build_object('status', 'added', 'members', v_members + 1,
                                'pending', greatest(v_pending - 1, 0), 'max_members', v_max,
                                'invite', to_jsonb(v_invite));
    end if;
    -- The blocking row comes back so the interface can name it, and its `code_hash` comes back with
    -- it — which is useless to anybody, and is the point: the code that row was created with is
    -- gone, so "resend" is the only way to get a working one. See the column comment.
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

  -- No code for an account that exists: the row is accepted in the next statement and a hash on it
  -- would be a code somebody could be told to type in, for a door that is already open.
  insert into invite (email, project_id, invited_by, code_hash)
  values (v_email, p_project_id, v_caller, case when v_user is null then p_code_hash end)
  returning * into v_invite;

  if v_user is null then
    return jsonb_build_object('status', 'invited', 'members', v_members,
                              'pending', v_pending + 1, 'max_members', v_max,
                              'invite', to_jsonb(v_invite));
  end if;

  v_joined := public.accept_invite(v_invite, v_user, v_email);
  if v_joined is null then
    -- The ceiling was checked four statements ago under the lock this still holds.
    raise exception 'create_invite: project % refused a member it had room for', p_project_id;
  end if;
  select i.* into v_invite from invite i where i.id = v_invite.id;
  return jsonb_build_object('status', 'added', 'members', v_members + 1,
                            'pending', v_pending, 'max_members', v_max,
                            'invite', to_jsonb(v_invite));
end;
$$;

revoke execute on function public.create_invite(text, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.create_invite(text, uuid, uuid, text) to service_role;
