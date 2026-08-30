/** Who is calling, and what they are allowed to speak for — the Node half of
 *  `supabase/functions/_shared/caller.ts`, unchanged in substance.
 *
 *  The token is verified by asking GoTrue rather than by decoding it here. That costs one round trip
 *  and buys three things a local decode does not: an expired token is rejected by the authority on
 *  when it expired, a deleted or banned user stops being a caller immediately, and the check does
 *  not quietly depend on a platform setting still being switched on. The publishable key presented
 *  as a bearer fails it too, which is the case that matters most — that key is in every bundle.
 *
 *  On Vercel that last point is load-bearing in a way it was not on Supabase. There is no
 *  `verify_jwt` here: nothing in front of a route checks anything, so this file is the *only* gate.
 *  A route that forgets to call it is open to the internet.
 */
import { eq, HttpError, rest, serviceKey, supabaseUrl } from './supabase';

export interface Caller {
  userId: string;
  email: string;
  isAdmin: boolean;
  /** The project the caller is working in. Null only mid-invite-consumption (design D13). */
  activeProjectId: string | null;
}

export async function requireCaller(request: Request): Promise<Caller> {
  const token = /^Bearer\s+(\S+)$/i.exec(request.headers.get('Authorization') ?? '')?.[1];
  if (!token) throw new HttpError(401, 'unauthenticated', 'no bearer token');

  const response = await fetch(`${supabaseUrl()}/auth/v1/user`, {
    headers: { apikey: serviceKey(), Authorization: `Bearer ${token}` },
    cache: 'no-store',
  });
  if (!response.ok) {
    throw new HttpError(401, 'unauthenticated', `the access token was not accepted (${response.status})`);
  }
  const user = (await response.json()) as { id?: string; email?: string };
  if (!user.id) throw new HttpError(401, 'unauthenticated', 'the token names no user');

  // The profile is created by the `on auth.users insert` trigger, so its absence means something is
  // wrong with the account rather than with this request. Say which.
  const profiles = await rest<Array<{ is_admin: boolean; active_project_id: string | null; email: string }>>(
    `profile?id=eq.${eq(user.id)}&select=is_admin,active_project_id,email`,
  );
  const profile = profiles[0];
  if (!profile) throw new HttpError(403, 'no-profile', `user ${user.id} has no profile row`);

  return {
    userId: user.id,
    email: profile.email || (user.email ?? ''),
    isAdmin: profile.is_admin,
    activeProjectId: profile.active_project_id,
  };
}

/** The project a call is charged to and scoped by: the caller's active one, and they must be in it.
 *
 *  Membership is checked here rather than left to RLS because these routes hold the service role
 *  and RLS does not apply to them at all. Every gate on this path is one written out by hand. */
export async function requireActiveProject(caller: Caller): Promise<string> {
  if (!caller.activeProjectId) {
    throw new HttpError(403, 'no-active-project', 'this account is not in a project yet');
  }
  await requireMembership(caller, caller.activeProjectId);
  return caller.activeProjectId;
}

export async function requireMembership(caller: Caller, projectId: string): Promise<void> {
  const rows = await rest<Array<{ user_id: string }>>(
    `project_member?project_id=eq.${eq(projectId)}&user_id=eq.${eq(caller.userId)}&select=user_id`,
  );
  if (rows.length === 0) {
    throw new HttpError(403, 'not-a-member', `not a member of project ${projectId}`);
  }
}
