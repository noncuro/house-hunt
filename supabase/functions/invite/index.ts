/** Invites, and the account that comes into existence because of one.
 *
 *  Public signup is disabled at the Supabase project — that is the whole enforcement, and this
 *  function is where the exception is granted. It runs with the service role, so nothing here is
 *  protected by RLS and every gate is written out by hand (design D7):
 *
 *    - an **admin** may invite any address, to any project, or to the platform with no project at
 *      all (`projectId: null`), which on first sign-in becomes a project of their own;
 *    - a **member** may invite only to their own active project, and nothing else;
 *    - a project refuses at `max_members` (6, admin-raisable), counting members **plus pending,
 *      non-expired invites** — otherwise six outstanding invites all land and the project holds
 *      twelve people.
 *
 *  **The ceiling is the database's invariant, not this function's.** `create_invite` counts and
 *  inserts in one transaction under an advisory lock on the project, so two members inviting at the
 *  same moment cannot both read five and both write a sixth. This function used to insert and then
 *  re-count and withdraw, which never over-admitted but was a compensation where the specification
 *  asked for an invariant. What stays here is the one rule the database cannot know: that a
 *  non-admin may only name their **active** project. `create_invite` re-checks the weaker form of
 *  it — admin, or a member of the named project — where it cannot be skipped.
 *
 *  Being at capacity is a stated result, not an error. A generic failure at this point gets the
 *  same address typed in again; "this project is at its limit of 6 people" does not.
 *
 *  **What the invite hands over is a code, and this is the only moment it exists in the clear.**
 *  This function used to create the `auth.users` row here and leave it passwordless, because
 *  sign-in was a code emailed on demand and the account only had to exist for that email to be
 *  sendable. Sign-in is a password now and nothing sends email, so the account is created at the
 *  moment the invitee chooses a password — in the `password` function, against the code minted
 *  here. Only the hash is stored (see the migration), so the plaintext returned below is the one
 *  copy there will ever be: the inviter texts it, or resends to mint another.
 *
 *  Membership is still not created here. The invite is consumed on first successful sign-in, so a
 *  pending invite that is never used leaves nothing behind.
 *
 *  Deploy:
 *    supabase functions deploy invite --project-ref <ref>
 */
import { requireCaller, requireMembership, type Caller } from '../_shared/caller.ts';
import { formatCode, generateCode, hashCode } from '../_shared/code.ts';
import { body, eq, HttpError, requireEnv, rest, rpc, SERVICE_KEY, serve, SUPABASE_URL } from '../_shared/http.ts';

interface Request_ {
  email?: string;
  /** Absent means the caller's active project. `null` means a platform invite, admins only. */
  projectId?: string | null;
}

interface Invite {
  id: string;
  email: string;
  project_id: string | null;
  status: string;
  expires_at: string;
  created_at: string;
}

/** What `create_invite` answers. The four statuses are the four sentences the interface has to be
 *  able to say, which is why they come back as data and not as four different exceptions. */
interface Created {
  status: 'invited' | 'at-capacity' | 'already-a-member' | 'already-invited';
  members: number | null;
  pending: number | null;
  max_members: number | null;
  invite: Invite | null;
}

serve(async (request) => {
  requireEnv({ SUPABASE_URL, SERVICE_KEY });

  const caller = await requireCaller(request);
  const input = await body<Request_>(request);
  const email = normalise(input.email);
  const projectId = await target(caller, input);

  // Minted before the row is written so the two land together — an invite row with a null
  // `code_hash` is one nobody can ever redeem, and it looks exactly like a working invite until
  // somebody tries. `create_invite` may still refuse, in which case this code is simply discarded.
  const code = generateCode();

  const created = await rpc<Created>('create_invite', {
    p_email: email,
    p_project_id: projectId,
    p_invited_by: caller.userId,
    p_code_hash: await hashCode(code),
  });

  const outcome = {
    status: created.status,
    email,
    projectId,
    members: created.members,
    pending: created.pending,
    maxMembers: created.max_members,
    invite: created.invite,
  };
  if (created.status !== 'invited' || !created.invite) return outcome;

  const userExisted = await hasAccount(email);

  // The address and the project, never the code. A function log is readable by anyone with
  // dashboard access, and a code in a log is a code somewhere it was not handed to.
  console.log(
    `invited ${email} to ${projectId ?? 'the platform'} by ${caller.email}` +
      `${userExisted ? ' (account already existed)' : ''}`,
  );
  // `userExisted` decides which of two different things the inviter has to do next: send the code,
  // or tell them to sign in with the password they already have. The code goes back either way,
  // because an account can exist without its owner remembering how to get into it, and an unused
  // code costs nothing.
  return { ...outcome, userExisted, code: formatCode(code) };
});

/** Which project this invite is for, and whether the caller has any standing to say so. */
async function target(caller: Caller, input: Request_): Promise<string | null> {
  // `projectId: null`, written explicitly, is the platform invite. Absent is not the same thing —
  // that is "my project", and the two must not be confused, because one of them creates a project.
  if ('projectId' in input && input.projectId === null) {
    if (!caller.isAdmin) {
      throw new HttpError(403, 'not-allowed', 'only an admin can invite somebody to the platform');
    }
    return null;
  }

  const requested = input.projectId ?? caller.activeProjectId;
  if (!requested) {
    throw new HttpError(403, 'no-active-project', 'this account is not in a project yet');
  }
  if (caller.isAdmin) return requested;

  // The rule `create_invite` cannot enforce, because the active project is this side's knowledge.
  if (requested !== caller.activeProjectId) {
    throw new HttpError(403, 'not-allowed', 'a member may invite only to their own active project');
  }
  await requireMembership(caller, requested);
  return requested;
}

/** `create_invite` checks the address too, and raises if it is not one. This is the same check
 *  written where it can be a 400 with a sentence in it rather than a 500 with a stack behind it —
 *  a typed-in blank is the caller's mistake, not a failure of the system. */
function normalise(email: string | undefined): string {
  const trimmed = (email ?? '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
    throw new HttpError(400, 'bad-request', 'a valid email address is required');
  }
  return trimmed;
}

/** Does this address already have an account?
 *
 *  Asked of `profile` rather than of the Admin API's user list: the `on auth.users insert` trigger
 *  writes a profile row for every account, so the two agree, and this is one indexed read against a
 *  table this function already talks to instead of a paged search over every user in the project.
 *
 *  Nothing branches on it except the sentence the inviter reads. An address that already has an
 *  account is the ordinary way somebody joins a second house hunt: they sign in with the password
 *  they have, and `consume_invites()` picks the new invite up. */
async function hasAccount(email: string): Promise<boolean> {
  const rows = await rest<Array<{ id: string }>>(`profile?email=eq.${eq(email)}&select=id&limit=1`);
  return rows.length > 0;
}
