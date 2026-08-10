import { createClient } from '@supabase/supabase-js';
import { configure } from '@house-hunt/core/db';
import { setLogSink } from '@house-hunt/core';

/** The website's one Supabase client, and what it deliberately does *not* carry.
 *
 *  The extension's client is built around an MV3 service worker: a `chrome.storage.local` adapter
 *  because a worker has no `localStorage`, `autoRefreshToken: false` because the built-in refresher
 *  hangs off `setInterval` and page-visibility events that do not survive being suspended, an
 *  explicit `ensureSession()` before every call, and a `chrome.alarms` heartbeat so an install
 *  nobody opened for a week is refreshed before its refresh token ages out.
 *
 *  A browser tab needs none of that and is worse off with it. It has `localStorage`, a real event
 *  loop and visibility events, which is exactly what supabase-js's own refresher is written
 *  against. So this is the plain defaults, and `configure()` is called without an `ensureSession`
 *  override — core falls back to reading the stored session, which is all a tab needs.
 *
 *  **This is a second, independent session, on purpose.** Signing in here does not hand the
 *  extension a copy of it: Supabase rotates the refresh token on use and revokes the family when a
 *  spent one is presented, so two holders of one token sign the user out unpredictably and days
 *  later. The extension signs *itself* in from credentials passed across the bridge, and ends up
 *  with its own refresh-token family (design D3).
 */
function build() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

  if (!url || !key) {
    throw new Error(
      'NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY are missing — set them in ' +
        'the repo root .env for local development, and in the Vercel project for a deploy',
    );
  }

  return createClient(url, key, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      // Nothing ever lands on a redirect: sign-in is an address and a password, there is no magic
      // link and no OAuth. Leaving this on would only mean parsing every URL the app is opened with.
      detectSessionInUrl: false,
      flowType: 'pkce',
      // Distinct from the extension's key. They are different origins so they could not collide
      // anyway, but naming it makes "which session is this" answerable from devtools.
      storageKey: 'house-hunt-session',
    },
  });
}

let done = false;

/** Called once, from the root provider, in an effect — which is to say in the browser.
 *
 *  Built here rather than at module scope, and that is not tidiness. `persistSession` reaches for
 *  `localStorage` as the client is constructed, so a module-scope client throws `window is not
 *  defined` the moment Next renders this page on the server, which it does at build time to
 *  prerender it. There is nothing to prerender — every screen here is behind a session — so the
 *  server sends an empty shell and this runs on hydration. */
export function configureOnce(): void {
  if (done) return;
  done = true;
  configure(build());
  // Core emits diagnostics through a sink each host registers. The extension keeps a ring buffer in
  // chrome.storage that Settings can copy out, because the other laptop has no debugger. A tab has
  // devtools, so the console is the right place and there is nothing to store.
  setLogSink((level, scope, message, detail) => {
    const line = `[${scope}] ${message}`;
    if (level === 'error') console.error(line, detail ?? '');
    else if (level === 'warn') console.warn(line, detail ?? '');
    else console.info(line, detail ?? '');
  });
}
