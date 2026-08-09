/** The session, and the one Supabase client in the extension.
 *
 *  Auth was originally left out of this project because of a real MV3 trap, written down in
 *  AGENTS.md: a service worker has no `localStorage` to persist a session in, and Chrome tears the
 *  worker down when it is idle. Both are still true. What makes them survivable is that this
 *  extension already put every network call in one place — the background worker — so there is
 *  exactly one context that ever needs a client, and therefore exactly one thing holding a refresh
 *  token. The three decisions that follow from that:
 *
 *  1. **Storage is `chrome.storage.local`.** supabase-js v2 accepts an async
 *     `getItem`/`setItem`/`removeItem`, which is precisely `chrome.storage.local`'s shape, so
 *     `persistSession: true` works in a worker that has no `localStorage` at all.
 *
 *  2. **Refreshing is explicit.** `autoRefreshToken: false`, because the built-in refresher hangs
 *     off `setInterval` and page visibility events — neither of which survives a worker Chrome has
 *     suspended. `ensureSession()` runs at the top of every handler that touches the database and
 *     refreshes when the access token is within five minutes of expiry. A `chrome.alarms`
 *     heartbeat does the same unprompted, so an install nobody opened for a week is refreshed
 *     before the *refresh* token ages out rather than after.
 *
 *  3. **Nothing else constructs a client.** Two contexts refreshing with the same refresh token is
 *     the classic way to invalidate a session, and Supabase rotates refresh tokens on use, so the
 *     loser of that race is signed out with nothing on screen explaining why. `tools/check-one-client.ts`
 *     enforces this rather than trusting it.
 *
 *  Not being signed in is a state, never an exception that escapes: handlers ask for a session,
 *  get null, and answer with an `unauthenticated` envelope the caller can render (design D2, D13).
 */
import { createClient, type Session, type SupabaseClient } from '@supabase/supabase-js';

const url = import.meta.env.WXT_SUPABASE_URL;
const key = import.meta.env.WXT_SUPABASE_PUBLISHABLE_KEY;

if (!url || !key) {
  throw new Error(
    'WXT_SUPABASE_URL / WXT_SUPABASE_PUBLISHABLE_KEY missing — set them in the hub root .env and rebuild',
  );
}

/** Where the session lives. Named rather than defaulted so it is greppable in
 *  `chrome://extensions` → Storage, which is the only debugger the other laptop has. */
export const SESSION_STORAGE_KEY = 'rm-supabase-session';

/** supabase-js writes JSON strings; chrome.storage.local stores them verbatim. A missing key must
 *  come back `null` rather than `undefined` — supabase-js treats `undefined` as a storage failure
 *  and falls back to an in-memory session, which is exactly the trap this adapter exists to avoid,
 *  and it does it silently. */
const chromeStorage = {
  async getItem(name: string): Promise<string | null> {
    const stored = await chrome.storage.local.get(name);
    const value = stored[name];
    return typeof value === 'string' ? value : null;
  },
  async setItem(name: string, value: string): Promise<void> {
    await chrome.storage.local.set({ [name]: value });
  },
  async removeItem(name: string): Promise<void> {
    await chrome.storage.local.remove(name);
  },
};

/** The only Supabase client in this extension. See the header, and `tools/check-one-client.ts`. */
export const supabase: SupabaseClient = createClient(url, key, {
  auth: {
    storage: chromeStorage,
    storageKey: SESSION_STORAGE_KEY,
    persistSession: true,
    autoRefreshToken: false,
    // There is no URL to detect a session in: sign-in is an address and a password typed into the
    // shortlist page, so nothing ever lands on a redirect (design D1).
    detectSessionInUrl: false,
    flowType: 'pkce',
  },
});

/** Refresh this far ahead of expiry. Long enough that a handler which takes a few seconds cannot
 *  have its token expire mid-flight; short enough that we are not refreshing on every message. */
export const REFRESH_MARGIN_SECONDS = 5 * 60;

/** How often the worker refreshes unprompted. The refresh token outlives this by weeks, so the
 *  only thing this protects against is an install left alone long enough for the refresh token
 *  itself to age out — which is a sign-in prompt appearing for no reason the user can see. */
export const HEARTBEAT_MINUTES = 30;

export const HEARTBEAT_ALARM = 'rm-session-heartbeat';

/** Thrown by `requireSession`, caught in `background.ts` and turned into a typed envelope. It is
 *  deliberately not a plain Error: "not signed in" is a state every surface renders differently
 *  from a failure, and telling them apart on a message string is how the difference gets lost. */
export class Unauthenticated extends Error {
  constructor(message = 'not signed in') {
    super(message);
    this.name = 'Unauthenticated';
  }
}

function secondsUntilExpiry(session: Session): number {
  // `expires_at` is seconds since the epoch. A session without one is a session we cannot reason
  // about, so treat it as due for a refresh rather than assuming it is fine.
  if (typeof session.expires_at !== 'number') return -1;
  return session.expires_at - Math.floor(Date.now() / 1000);
}

/** One refresh at a time, however many handlers ask at once.
 *
 *  Supabase rotates the refresh token on every use, so two concurrent refreshes with the same
 *  token mean one of them presents a token that has already been spent — and the session is gone.
 *  The panel, the shortlist and a paced sweep all wake the worker within the same second, so this
 *  is the normal case rather than an edge one. */
let refreshing: Promise<Session | null> | null = null;

async function refreshOnce(): Promise<Session | null> {
  refreshing ??= supabase.auth
    .refreshSession()
    .then(({ data, error }) => {
      if (error) throw error;
      return data.session;
    })
    .finally(() => {
      refreshing = null;
    });
  return refreshing;
}

/** The session, refreshed if it is about to expire. Null means signed out — never an exception.
 *
 *  A failed refresh is not automatically a sign-out. If the access token is still valid we keep
 *  using it and try again on the next message: the common cause of a refresh failing is the
 *  laptop being offline for a moment, and signing the user out for that would be a sign-in prompt
 *  in the middle of a working session. */
export async function ensureSession(): Promise<Session | null> {
  const { data, error } = await supabase.auth.getSession();
  if (error) {
    console.warn('could not read the stored session', error.message);
    return null;
  }
  const session = data.session;
  if (!session) return null;

  const remaining = secondsUntilExpiry(session);
  if (remaining > REFRESH_MARGIN_SECONDS) return session;

  try {
    return await refreshOnce();
  } catch (e) {
    if (remaining > 0) {
      console.warn('refresh failed; the current token is still valid', e);
      return session;
    }
    console.warn('refresh failed and the token has expired — signed out', e);
    return null;
  }
}

/** For handlers that cannot proceed without a user. Throws `Unauthenticated`, which
 *  `background.ts` turns into `{ ok: false, unauthenticated: true }` rather than a stack trace. */
export async function requireSession(): Promise<Session> {
  const session = await ensureSession();
  if (!session) throw new Unauthenticated();
  return session;
}

/** Register the heartbeat. Called once from `background.ts` at worker start; `chrome.alarms`
 *  survives the worker being torn down, which is the entire point of using it rather than a timer. */
export function startSessionHeartbeat(): void {
  chrome.alarms.create(HEARTBEAT_ALARM, { periodInMinutes: HEARTBEAT_MINUTES });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== HEARTBEAT_ALARM) return;
    void ensureSession();
  });
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
// Each refusal is still a named state, for the same reason as before: "something went wrong" gets
// the same button pressed again (design D1).
// ------------------------------------------------------------------------------------------------

export type SignInResult =
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
export async function signIn(email: string, password: string): Promise<SignInResult> {
  const address = email.trim().toLowerCase();
  if (!address) return { status: 'failed', message: 'enter an email address' };
  if (!password) return { status: 'failed', message: 'enter your password' };

  const { error } = await supabase.auth.signInWithPassword({ email: address, password });
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
  await supabase.auth.signOut();
}

/** The access token an Edge Function should be called with. The `analyse` function verifies its
 *  caller from this rather than from the publishable key, which authorises nothing now (design D10). */
export async function accessToken(): Promise<string | null> {
  const session = await ensureSession();
  return session?.access_token ?? null;
}
