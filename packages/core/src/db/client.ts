import type { Session, SupabaseClient } from '@supabase/supabase-js';

/** The one Supabase client, handed in by whoever is hosting this code.
 *
 *  Core cannot construct its own, because the right client depends on where it is running and
 *  core has no way to find out. The extension's background worker needs the `chrome.storage.local`
 *  adapter, `autoRefreshToken: false` and an explicit `ensureSession()` before every call, because
 *  an MV3 service worker has no `localStorage` and Chrome tears it down when idle. A browser tab
 *  needs none of that and is worse off with it. A default constructed here would be wrong in one
 *  of the two places, and wrong quietly — a session persisted somewhere it will not be found again
 *  looks exactly like being signed out.
 *
 *  The invariant this preserves is the one the whole session design rests on: **one client per
 *  process**. Supabase rotates the refresh token on every use, so two clients in one process
 *  eventually refresh with a token the other has already spent, and the loser is signed out with
 *  nothing on screen explaining why. `tools/check-one-client.ts` enforces it rather than trusting
 *  it (design D2, D8).
 */
let client: SupabaseClient | null = null;

/** How the host gets hold of a session it is willing to make a request with.
 *
 *  This is the other half of what differs between the two, and the half that is easy to miss.
 *  A browser tab lets supabase-js refresh on its own timers, so reading the stored session is the
 *  whole of it. A service worker cannot: the built-in refresher hangs off `setInterval` and page
 *  visibility events, neither of which survives being suspended, so the extension turns it off and
 *  refreshes explicitly before every call. Both answer "give me a usable session"; only one of
 *  them can be written here. */
export interface Host {
  ensureSession?: () => Promise<Session | null>;
  /** Where the website is, for the surfaces that are not it.
   *
   *  The third thing that differs between the two hosts, and it arrived with the move off Supabase's
   *  Edge runtime (`docs/vercel-migration.md`). A route is reached at `/api/<name>`, relative, so it
   *  follows whichever origin the page is served from — production, a preview, or localhost — and
   *  never becomes a second copy of an origin to keep in step. The extension's background worker has
   *  no such origin: a relative fetch there resolves against `chrome-extension://` and 404s with a
   *  body that parses as nothing, so it says where the website is and the extension is the only
   *  thing that sets this. The website leaves it unset, deliberately — a website that named its own
   *  origin would be the copy that goes stale. */
  apiOrigin?: string;
}

let ensure: () => Promise<Session | null> = async () => {
  const { data, error } = await db().auth.getSession();
  if (error) {
    console.warn('could not read the stored session', error.message);
    return null;
  }
  return data.session;
};

/** Called once, at start-up, by each application. */
export function configure(next: SupabaseClient, host: Host = {}): void {
  if (client && client !== next) {
    throw new Error(
      'configure() called twice with different clients — one process holds one client, or two of ' +
        'them race on a rotated refresh token and the loser is silently signed out (design D2)',
    );
  }
  client = next;
  if (host.ensureSession) ensure = host.ensureSession;
  if (host.apiOrigin !== undefined) apiOrigin = host.apiOrigin;
}

/** Set by the extension, unset on the website. Read by `callRoute`. */
let apiOrigin: string | null = null;

export function configuredApiOrigin(): string | null {
  return apiOrigin;
}

/** A session that is usable now, or null for signed out — never an exception. */
export function ensureSession(): Promise<Session | null> {
  return ensure();
}

/** The client, or a refusal that names what was forgotten.
 *
 *  Throwing beats falling back to a default. A default would work in development, where a session
 *  is a minute old, and fail on the other laptop a week later. */
export function db(): SupabaseClient {
  if (!client) {
    throw new Error(
      'the Supabase client has not been configured — call configure() from the application entry ' +
        'point before touching the data layer',
    );
  }
  return client;
}

/** True once `configure()` has run. For code that must not construct a client but may reasonably
 *  ask whether one exists yet — a smoke harness, or a guard around start-up ordering. */
export function isConfigured(): boolean {
  return client !== null;
}
