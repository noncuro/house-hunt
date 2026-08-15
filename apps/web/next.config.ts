import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PHASE_DEVELOPMENT_SERVER } from 'next/constants.js';
import type { NextConfig } from 'next';

/** The workspace root's `.env`, which is where both surfaces' configuration lives.
 *
 *  Next only looks for `.env` beside the app it is building, and the extension already reads the
 *  root one through Vite's `envDir` — see `apps/extension/wxt.config.ts`. One file rather than one
 *  per app, because both read the same Supabase project with the same publishable key and two
 *  copies of that is two things to keep in step.
 *
 *  Absent is fine and silent: on Vercel there is no file and the same names come from the project's
 *  environment. Anything already set wins, so a real environment variable is never overwritten by a
 *  stale line in a file. */
function loadRootEnv(): void {
  const path = fileURLToPath(new URL('../../.env', import.meta.url));
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return;
  }
  for (const line of text.split('\n')) {
    const match = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const [, name, raw] = match;
    if (process.env[name] !== undefined) continue;
    process.env[name] = raw!.trim().replace(/^(['"])(.*)\1$/, '$2');
  }
}

loadRootEnv();

/** The Content-Security-Policy is load-bearing here, not hygiene.
 *
 *  Sign-in happens on this origin, and when it succeeds the credentials are handed to the extension
 *  across a `window.postMessage` on this origin (design D3). Any script running here can read that
 *  message. Today the only scripts here are ours, and this header is what keeps it that way — no
 *  analytics, no embedded widget, no CDN-hosted library, ever, or the handoff has to be replaced
 *  first with a server-minted second session that carries no password.
 *
 *  This is a constraint the extension never had, because a `chrome-extension://` origin cannot be
 *  reached from the web at all. It is the real cost of moving the app onto the internet.
 *
 *  `'unsafe-inline'` for styles is Next's requirement for its own critical CSS. Scripts get
 *  `'unsafe-inline'` too, which Next needs for hydration bootstrapping and which is worth being
 *  honest about: it does not weaken the property above, since the threat is a *third-party* script
 *  reading a same-origin message, and `script-src 'self'` is what excludes those.
 */
const SUPABASE_ORIGIN = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';

/** React's development build calls `eval()` — for callstack reconstruction, nothing that ships —
 *  and the production CSP has no `'unsafe-eval'`, so under `next dev` the console fills with a
 *  refusal and the devtools overlay opens over the page. Granted for the dev server and nowhere
 *  else: the header a built app serves is the one below, unchanged, which is what `smoke:web`
 *  asserts against because it serves a production build for exactly this reason.
 *
 *  Keyed on the build phase rather than on `NODE_ENV`. Next preserves a `NODE_ENV` that was set
 *  explicitly — `next build` with `NODE_ENV=development` in the environment warns and carries on —
 *  so a host that exports it for any other reason would have put `'unsafe-eval'` into a production
 *  artifact, and the header would have said so with nothing else looking wrong.
 *  `PHASE_DEVELOPMENT_SERVER` is only ever `next dev`. */
function cspFor(phase: string): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline'${phase === PHASE_DEVELOPMENT_SERVER ? " 'unsafe-eval'" : ''}`,
    "style-src 'self' 'unsafe-inline'",
    // Rightmove's own photo URLs. We link to them and never re-host them (their terms, 13.4), which
    // means the images load from their origin and this has to say so.
    //
    // And the map's tiles, which `screens/Map.tsx` loads from OpenStreetMap. Missing here until
    // `smoke:web` was written, and the symptom was as quiet as this sort of thing gets: the map view
    // laid out correctly, drew its markers and its controls, and rendered every tile as blank grey.
    // Nothing errored on screen — the refusals go to the console — so it read as a map of somewhere
    // with no streets rather than as a policy blocking the images.
    "img-src 'self' data: blob: https://media.rightmove.co.uk https://*.rightmove.co.uk https://tile.openstreetmap.org",
    "font-src 'self' data:",
    `connect-src 'self' ${SUPABASE_ORIGIN}`.trim(),
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ].join('; ');
}

const nextConfig = (phase: string): NextConfig => ({
  // The packages are TypeScript source rather than a build, so Next compiles them like app code.
  transpilePackages: ['@house-hunt/core', '@house-hunt/ui'],
  // Said outright because Next guesses by walking up for a lockfile, and ~/GitHub happens to have
  // one — which made it treat every repo on the machine as this app's workspace.
  outputFileTracingRoot: fileURLToPath(new URL('../../', import.meta.url)),
  reactStrictMode: true,
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'Content-Security-Policy', value: cspFor(phase) },
          { key: 'Referrer-Policy', value: 'same-origin' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          // A private house hunt has no business in a search index.
          { key: 'X-Robots-Tag', value: 'noindex, nofollow' },
        ],
      },
    ];
  },
});

export default nextConfig;
