-- Password sign-in, and the invite code that replaces the email as the thing you have to hold.
--
-- WHY THIS EXISTS. Sign-in was a six-digit code emailed by Supabase's built-in sender, which sends
-- about two emails an hour per project before it refuses. That is a limit the owner met in normal
-- use — invite somebody, resend once because it landed in spam, and the next person cannot sign in
-- for an hour. The alternatives were to run SMTP or to stop depending on email. This is the second.
--
-- WHAT REPLACES IT. An invite now carries a code: a short random string the owner reads out or
-- texts, out of band. A new person types their address, a password they choose, and that code; the
-- `password` Edge Function checks the code against a pending invite and creates the account with
-- the service role, already confirmed. Signing in afterwards is `signInWithPassword`.
--
-- WHAT DOES NOT CHANGE, AND MUST NOT. Invite-only. `enable_signup = false` on the project and on
-- its email provider is still the whole enforcement — `signInWithPassword` never creates an
-- account, so a stranger typing an address and a password gets "invalid login credentials" and
-- nothing is written. The only two ways an `auth.users` row comes into existence are the Admin API
-- called from an Edge Function that checked something first, and nothing else.
-- `consume_invites()` is untouched: it is still the only thing that turns an invite into
-- membership, still takes no arguments, and still runs immediately after a successful sign-in.

-- ------------------------------------------------------------------------------------------------
-- The code lives as a hash, not as itself.
--
-- The plaintext is returned once, to whoever created the invite, and is never stored. That is not
-- theatre about the database being breached: `read_invite` lets every member of a project read that
-- project's invite rows, so a plaintext column would put every outstanding code in front of every
-- member. It would not be a disaster — a member can invite whoever they like to their own project
-- anyway — but it means "the code is the thing that lets you in" stops being true of the code and
-- starts being true of the row.
--
-- Be honest about what the hash does NOT buy. A 12-character code over a 31-character alphabet is
-- about 59 bits, and SHA-256 is fast, so somebody holding this column and a GPU is doing years of
-- work rather than centuries — but they are doing work. It is a bare digest and not a KDF because
-- the code is machine-generated with full entropy, which is the one case where a KDF's stretching
-- buys almost nothing; the entropy is doing the job a KDF would otherwise have to.
-- ------------------------------------------------------------------------------------------------

alter table invite add column if not exists code_hash text;

create index if not exists invite_code_hash_idx on invite (code_hash) where status = 'pending';

comment on column invite.code_hash is
  'SHA-256 of the uppercased, punctuation-stripped invite code. The plaintext is generated in the '
  'invite Edge Function, returned to the inviter once and never stored — there is deliberately no '
  'way to read a code back, because every member of a project can read that project''s invite rows. '
  'Lost it? Resend, which revokes and mints a fresh one. Null means an invite that can never be '
  'redeemed: the redeem path matches on a hash it computed, so a null never matches anything.';

-- ------------------------------------------------------------------------------------------------
-- Somewhere durable to count wrong guesses.
--
-- The code is now the only thing between a stranger and an account, and the redeem endpoint is
-- unauthenticated by necessity — the person using it has no session yet, that is the point. So it
-- is the one door in this system anybody can knock on, and it needs a limiter.
--
-- It has to be a table. An Edge Function isolate is recycled without warning, which is exactly when
-- a counter held in memory stops existing; `resolve-location` counts rows in `api_usage` for the
-- same reason. This cannot reuse `api_usage`, because every row there needs a project and a user
-- and a redeem attempt has neither.
--
-- The address is stored hashed. Not anonymisation — an IPv4 space is small enough to enumerate
-- against a bare digest — but this table exists to be counted and never to be read, so there is no
-- reason for it to also be a list of the addresses people signed up from.
-- ------------------------------------------------------------------------------------------------

create table if not exists redeem_attempt (
  id       bigserial primary key,
  at       timestamptz not null default now(),
  -- Null when the platform gave us no forwarded address. A null is counted only by the global
  -- ceiling, which is the fail-closed backstop below.
  ip_hash  text,
  -- Lowercased, so per-address counting cannot be evaded by changing the case.
  email    text,
  ok       boolean not null
);

create index if not exists redeem_attempt_at_idx on redeem_attempt (at desc);
create index if not exists redeem_attempt_ip_idx on redeem_attempt (ip_hash, at desc) where not ok;
create index if not exists redeem_attempt_email_idx on redeem_attempt (email, at desc) where not ok;

alter table redeem_attempt enable row level security;
-- No policy and no grant for anybody but the service role. Nothing signed in has any business
-- reading who has been guessing, and the revoke makes a mistaken read an error rather than an
-- empty result that looks like "nobody has tried".
revoke all on table redeem_attempt from anon, authenticated;
revoke all on sequence redeem_attempt_id_seq from anon, authenticated;

comment on table redeem_attempt is
  'One row per invite-redemption attempt, successful or not, kept for a day and counted by '
  'redeem_code(). It is the rate limiter for the only unauthenticated endpoint in this system.';

-- ------------------------------------------------------------------------------------------------
-- create_invite, now minting a code as part of the same transaction that writes the row.
--
-- Dropped and recreated rather than overloaded: `create or replace` with an extra argument makes a
-- second function rather than replacing the first, and a caller passing three arguments would then
-- resolve to the old one and write an invite with no code — an invite nobody can redeem, which
-- looks exactly like a working invite until somebody tries. The new argument defaults to null so
-- the three-argument calls in `tools/check-rls.ts` still resolve here; those never redeem anything,
-- and a null hash cannot match a computed one.
--
-- The hash is computed in the Edge Function and passed in, rather than generated here, because the
-- *plaintext* has to reach the inviter and a value generated inside a database function has no way
-- out that is not also a way in for everyone reading the row.
-- ------------------------------------------------------------------------------------------------

drop function if exists public.create_invite(text, uuid, uuid);

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

  insert into invite (email, project_id, invited_by, code_hash)
  values (v_email, p_project_id, v_caller, p_code_hash)
  returning * into v_invite;

  return jsonb_build_object('status', 'invited', 'members', v_members,
                            'pending', v_pending + 1, 'max_members', v_max,
                            'invite', to_jsonb(v_invite));
end;
$$;

revoke execute on function public.create_invite(text, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.create_invite(text, uuid, uuid, text) to service_role;

-- Invites written before this migration have no code and cannot be redeemed. They are left pending
-- rather than expired, because an invite to somebody who already has an account still works — they
-- sign in with the password they already have and `consume_invites()` picks it up. Somebody with no
-- account needs a resend, which mints a code. Saying that here rather than silently expiring rows.

-- ------------------------------------------------------------------------------------------------
-- redeem_code — is this code, for this address, a live invite? And has this caller earned an answer?
--
-- Everything about redemption that the database can decide is decided here, in one transaction, so
-- the Edge Function's job is reduced to hashing, creating the account, and choosing the sentence.
--
-- THE MATCH IS ON THE PAIR. An attacker needs the code *and* the address it was sent to. That is
-- not defence in depth for its own sake: it means a stolen code is worth nothing without knowing
-- who it was for, and it means the refusal below can be one sentence for both halves — "no such
-- code" says nothing about whether the address is invited, so this endpoint cannot be used to
-- enumerate who has been asked in.
--
-- WHAT THE LIMITS COVER. Three ceilings on *failures* in the last hour: ten from one address, five
-- against one email, and two hundred across the whole system. The first stops the obvious script.
-- The second stops somebody who knows an invited address grinding at that one invite. The third is
-- the fail-closed backstop: past it, redemption stops for everybody for an hour, which is a real
-- outage and is the right trade for the only unauthenticated write in the system.
--
-- WHAT THEY DO NOT COVER. A distributed attacker rotating source addresses is bounded only by the
-- global ceiling and by the entropy of the code, which is where the real defence is: 200 guesses an
-- hour against 31^12 possibilities is 5e14 years for one code, and the invite expires in fourteen
-- days. The address itself comes from `x-forwarded-for`, which is a header — it is trustworthy only
-- because the function is unreachable except through Supabase's edge, and a change to how it is
-- fronted would quietly make per-address counting meaningless. Nothing here notices that.
-- Successful attempts are not limited at all, on purpose: somebody holding a real code is not the
-- threat, and rate-limiting them turns a typo into a lockout.
-- ------------------------------------------------------------------------------------------------

create or replace function public.redeem_code(
  p_email     text,
  p_code_hash text,
  p_ip_hash   text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_email    text := lower(trim(coalesce(p_email, '')));
  v_by_ip    int;
  v_by_email int;
  v_global   int;
  v_invite   invite%rowtype;
begin
  if v_email = '' or coalesce(p_code_hash, '') = '' then
    raise exception 'redeem_code: an address and a code are both required';
  end if;

  -- A day is long enough that every window below is inside it, and short enough that this table
  -- never becomes a log of who tried to sign up. Pruning here rather than on a schedule because
  -- this is the only thing that writes the table, so it is the only thing that can grow it.
  delete from public.redeem_attempt where at < now() - interval '1 day';

  select count(*)::int into v_by_ip from public.redeem_attempt
   where not ok and at > now() - interval '1 hour' and ip_hash is not null and ip_hash = p_ip_hash;
  select count(*)::int into v_by_email from public.redeem_attempt
   where not ok and at > now() - interval '1 hour' and email = v_email;
  select count(*)::int into v_global from public.redeem_attempt
   where not ok and at > now() - interval '1 hour';

  if v_by_ip >= 10 or v_by_email >= 5 or v_global >= 200 then
    -- Deliberately NOT recorded as an attempt. Counting a refusal you did not evaluate makes the
    -- window self-extending: every blocked knock would push the hour out by another knock, so a
    -- limit meant to last an hour would last as long as the attacker kept typing.
    return jsonb_build_object('status', 'rate-limited', 'retry_after_seconds', 3600);
  end if;

  select i.* into v_invite from public.invite i
   where lower(i.email) = v_email
     and i.code_hash = p_code_hash
     and i.status = 'pending'
     and i.expires_at > now()
   order by i.created_at desc
   limit 1;

  insert into public.redeem_attempt (ip_hash, email, ok)
  values (p_ip_hash, v_email, v_invite.id is not null);

  if v_invite.id is null then
    return jsonb_build_object('status', 'no-such-code');
  end if;

  -- The invite is NOT consumed here, and that is the invariant the whole invite system rests on:
  -- `consume_invites()` runs on first successful sign-in and is the only thing that turns an invite
  -- into membership. Marking it accepted here would hand out a place to somebody who has an account
  -- and has not yet signed into it.
  return jsonb_build_object('status', 'ok', 'invite_id', v_invite.id, 'project_id', v_invite.project_id);
end;
$$;

revoke execute on function public.redeem_code(text, text, text) from public, anon, authenticated;
grant execute on function public.redeem_code(text, text, text) to service_role;

comment on function public.redeem_code(text, text, text) is
  'Rate-limited lookup of a live invite by (address, code hash). Service role only — it is called '
  'by the `password` Edge Function, which is the only unauthenticated endpoint in this system. It '
  'does not consume the invite: consume_invites() still does that, on first sign-in.';
