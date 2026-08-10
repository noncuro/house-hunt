/** The extension's session: one client, in one context, kept alive across a worker Chrome tears
 *  down.
 *
 *  Auth was originally left out of this project because of a real MV3 trap: a service worker has no
 *  `localStorage` to persist a session in, and Chrome tears the worker down when it is idle. Both
 *  are still true. What makes them survivable is that this extension already put every network call
 *  in one place — the background worker — so there is exactly one context that ever needs a client,
 *  and therefore exactly one thing holding a refresh token. The three decisions that follow:
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
 *     loser of that race is signed out with nothing on screen explaining why.
 *     `tools/check-one-client.ts` enforces this rather than trusting it.
 *
 *  All of that is about *keeping a session alive here*. What signing in means, and everything that
 *  reads the database with the result, lives in `@house-hunt/core/db` and is shared with the
 *  website — which needs none of the machinery above, because a tab has `localStorage`, an event
 *  loop and visibility events (design D2, D8).
 *
 *  The website is now also the only place a sign-in form exists. This module still exposes
 *  `signIn`, because the bridge hands credentials over and the worker signs *itself* in with them:
 *  two independent sessions rather than two holders of one rotated refresh token (design D3).
 */
import { createClient, type Session, type SupabaseClient } from '@supabase/supabase-js';
import { configure } from '@house-hunt/core/db';
import { setLogSink } from '@house-hunt/core';
import { log } from './log';

const url = import.meta.env.WXT_SUPABASE_URL;
const key = import.meta.env.WXT_SUPABASE_PUBLISHABLE_KEY;

if (!url || !key) {
  throw new Error(
    'WXT_SUPABASE_URL / WXT_SUPABASE_PUBLISHABLE_KEY missing — set them in the repo root .env and rebuild',
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
    // website, handed here, and nothing ever lands on a redirect (design D1, D3).
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
 *  The panel, the search badges and a paced sweep all wake the worker within the same second, so
 *  this is the normal case rather than an edge one. */
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

/** Hand core the client and the refresh policy, and give it somewhere to log.
 *
 *  Called once from `background.ts` before anything touches the database. Core throws rather than
 *  constructing a default if this is forgotten, because a default would persist a session where it
 *  will not be found again and that looks exactly like being signed out. */
export function configureCore(): void {
  configure(supabase, { ensureSession });
  setLogSink(log);
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
