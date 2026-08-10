import type { Session } from '@supabase/supabase-js';
import { db, ensureSession } from './client';

/** Signing in, signing out, and getting hold of a valid session.
 *
 *  All of this used to live in the extension's `lib/auth.ts` next to the `chrome.storage` adapter
 *  and the `chrome.alarms` heartbeat, because the extension was the only thing that had a session.
 *  Splitting it out separates two questions that were tangled: *how do I keep a session alive*,
 *  which is genuinely different in a service worker and a browser tab and stays with each host,
 *  and *what does signing in mean*, which is the same everywhere and belongs here. */

/** Thrown when something that needs a user does not have one.
 *
 *  Deliberately not a plain Error. "Not signed in" is a state every surface renders differently
 *  from a failure — the panel invites sign-in, the website shows the sign-in view, a search page
 *  shows nothing at all, because a dimmed card asserts a verdict and a verdict implies a project —
 *  and telling them apart on a message string is how that difference gets lost. */
export class Unauthenticated extends Error {
  constructor(message = 'not signed in') {
    super(message);
    this.name = 'Unauthenticated';
  }
}

/** For callers that cannot proceed without a user. */
export async function requireSession(): Promise<Session> {
  const session = await ensureSession();
  if (!session) throw new Unauthenticated();
  return session;
}

/** The access token an Edge Function should be called with. The functions verify their caller from
 *  this rather than from the publishable key, which authorises nothing (design D10). */
export async function accessToken(): Promise<string | null> {
  const session = await ensureSession();
  return session?.access_token ?? null;
}

// ------------------------------------------------------------------------------------------------
// Sign-in.
//
// It used to be a six-digit code emailed on request. Supabase's built-in sender stops at roughly
// two messages an hour per project, which is a limit the owner met doing ordinary things — invite
// somebody, resend once because it went to spam, and nobody can sign in for an hour. The only ways
// out were to run SMTP or to stop depending on email, and this is the second one: a password, and
// an invite code handed over by text.
//
// Each refusal is a named state, for the same reason as before: "something went wrong" gets the
// same button pressed again (design D1).
// ------------------------------------------------------------------------------------------------

/** What a password sign-in did, before anything is known about projects.
 *
 *  Distinct from `SignInResult` in `contracts.ts`, which is what a *surface* is told and carries
 *  the resulting `AuthState` with it. The two are separate because the invite is consumed between
 *  them, and a second round trip there is a window in which somebody who has just joined a house
 *  hunt is shown "you are in no house hunt". */
export type SignInOutcome =
  | { status: 'signed-in' }
  /** Supabase answers "invalid login credentials" to a wrong password and to an address with no
   *  account alike, and it is right to: telling them apart would make this endpoint an oracle for
   *  who has an account. So this one state carries both, and the copy says both — the alternative
   *  is a confident sentence that is wrong half the time. */
  | { status: 'wrong-credentials' }
  /** Its own state rather than folded into the one above, because it is not the user's mistake and
   *  no amount of retyping fixes it: it means "Confirm email" is on in the hosted project, and
   *  nothing in this system sends a confirmation. Silently reading as "wrong password" is exactly
   *  how that misconfiguration would survive a week of somebody insisting they typed it right. */
  | { status: 'not-confirmed' }
  | { status: 'rate-limited'; message: string }
  | { status: 'failed'; message: string };

interface AuthFailure {
  code?: string;
  status?: number;
  message: string;
}

function isRateLimit(error: AuthFailure): boolean {
  return (
    error.status === 429 ||
    error.code === 'over_request_rate_limit' ||
    /rate limit|too many requests|only request this after/i.test(error.message)
  );
}

/** Sign in. This is the whole of it, and it creates nothing.
 *
 *  `signInWithPassword` has no `shouldCreateUser` and no equivalent — it cannot bring an account
 *  into existence, whatever it is sent. That is worth saying out loud because the old OTP path
 *  *could*, and had to be told not to. Invite-only now rests on the two switches it always really
 *  rested on (`enable_signup = false` on the project and on its email provider) and on the fact
 *  that the only two routes to an `auth.users` row both run in an Edge Function holding the service
 *  role, behind an invite code or an admin. */
export async function signIn(email: string, password: string): Promise<SignInOutcome> {
  const address = email.trim().toLowerCase();
  if (!address) return { status: 'failed', message: 'enter an email address' };
  if (!password) return { status: 'failed', message: 'enter your password' };

  const { error } = await db().auth.signInWithPassword({ email: address, password });
  if (!error) return { status: 'signed-in' };

  const failure: AuthFailure = { code: error.code, status: error.status, message: error.message };
  if (isRateLimit(failure)) return { status: 'rate-limited', message: error.message };
  if (failure.code === 'email_not_confirmed' || /not confirmed/i.test(error.message)) {
    return { status: 'not-confirmed' };
  }
  if (
    failure.code === 'invalid_credentials' ||
    failure.status === 400 ||
    /invalid login credentials/i.test(error.message)
  ) {
    return { status: 'wrong-credentials' };
  }
  return { status: 'failed', message: error.message };
}

export async function signOut(): Promise<void> {
  await db().auth.signOut();
}
