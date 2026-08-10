# Split the app out of the extension: a website on Vercel, a thin extension beside it

## Why

Everything this project does lives inside a Chrome extension, including the
parts that have nothing to do with Chrome. The shortlist — cards, the compare
table, the map, a listing's detail, settings, the admin console, sign-in — is
roughly 3,500 lines of React that reads a database and draws pictures. It is an
app. It is hosted in an extension for no reason other than that the extension
was built first.

That has four costs, and they are getting worse now that other people are being
invited in.

1. **You cannot send anyone a link.** The shortlist's address is
   `chrome-extension://jkcidomcogoaociobhbjankcpjgnhlji/shortlist.html`. That
   string is a hash of the manifest key, it differs between the unpacked and
   store builds of the same code, and it means nothing to anybody who has not
   already installed the extension. There is no way to show someone the house
   hunt before they install anything, and no way to link to one flat.

2. **Every reader must install an extension.** Inviting a sixth person to a
   project currently means asking them to load an unpacked build, or to find us
   in a store listing that is not published yet. Most of what they want — look
   at the shortlist, rate a flat, read the analysis — needs no browser
   extension at all. Only the Rightmove overlay does.

3. **The shared caches trust the client.** `cache_travel`,
   `cache_station_point` and `cache_station_walk` are `security definer` RPCs
   granted to `authenticated`. They check that a value is *plausible* — a known
   mode, a duration between 0 and 86400 seconds, a coordinate on Earth — and
   cannot check that it is *true*, because the truth is whatever TfL said and
   only the client spoke to TfL. `travel_time` and `station_point` are global
   tables by design, so one member of one project can write a wrong journey
   time and every other project reads it. Nothing detects this and nothing
   expires it. The same reasoning applies to `WXT_TFL_APP_KEY`, which ships in
   the bundle: the key is public and the calls made with it are unattributable.

4. **The MV3 session trap constrains a UI that does not need to live there.**
   `lib/auth.ts` exists in the shape it does — a `chrome.storage` adapter,
   `autoRefreshToken: false`, a `chrome.alarms` heartbeat, an explicit
   `ensureSession()` before every handler — because a service worker has no
   `localStorage` and Chrome tears it down. That is the correct answer for a
   background worker. It is unnecessary complexity for a browser tab, which has
   `localStorage`, a real event loop and visibility events.

The seam is already there. `src/lib/supabase.ts` — all 1,635 lines of data
access — touches no Chrome API. Neither does anything in `src/components/`.
`src/entrypoints/shortlist/` reaches the world through exactly one function,
`ask()` in `queries.ts`, and every message it sends maps one-to-one onto a
function in `supabase.ts`. Splitting is mostly a matter of moving files and
replacing one transport with a direct call.

## What Changes

- **A website, at a real domain, on Vercel.** Next.js App Router with
  `supabase-js` running in the browser against the anon key and RLS — the same
  trust model the extension uses today, so `supabase.ts` ports without a
  security rethink. It carries the shortlist, compare, map, detail, settings,
  projects, invites, admin and sign-in.
- **The repo becomes a pnpm workspace.** `packages/core` (types, data layer,
  domain logic), `packages/ui` (the React components both surfaces render),
  `apps/web`, `apps/extension`. `supabase/` stays where it is and serves both.
- **The extension keeps only what needs a browser extension**: the four content
  scripts on Rightmove, the background worker that serves them, the session, the
  diagnostics log, and a new bridge content script on the website's own origin.
  `src/entrypoints/shortlist/` is deleted. Clicking the extension icon opens the
  website.
- **One sign-in, on the website.** The extension has no sign-in form. When you
  sign in on the website it hands your credentials, once and in memory, across
  the bridge, and the background worker signs *itself* in with the code it
  already has — so the two surfaces hold two independent Supabase sessions and
  never race on a rotated refresh token. A signed-out extension says "open House
  hunt to sign in" and links there. See design D3, and the constraint it puts on
  what the website is allowed to load.
- **Travel times and geocoding move to an Edge Function.** A new `travel`
  function resolves journeys, nearby stations and postcodes, and is the only
  thing that writes the caches. `cache_travel`, `cache_station_point` and
  `cache_station_walk` are revoked from `authenticated`. `WXT_TFL_APP_KEY`
  leaves the bundle. Both surfaces call the same function, so there is one
  implementation rather than one per surface.

## What does not change

- The database, its RLS, projects, invites and the spend cap. This change moves
  code between processes; it does not move a trust boundary except to tighten
  the three cache RPCs.
- The panel on a Rightmove listing, the search-result badges and the sweep. They
  are the reason the extension exists and they stay in it.
- The analysis Edge Function, and the rule that `lib/analysis.ts` and
  `lib/png.ts` are the source of truth copied into it by `pnpm sync:function`.
  `lib/tfl.ts` and `lib/postcode.ts` join them under that rule.

## Impact

- **Affected specs:** new `surfaces`; `travel` gains server-side resolution;
  `accounts` amended where sign-in moves off the extension.
- **Affected code:** every file moves. `src/entrypoints/shortlist/` is deleted
  (~3,500 lines) and reappears in `apps/web`. `src/lib/messages.ts` splits: the
  DTOs go to `packages/core`, the envelope and `chrome.runtime` transport stay
  in the extension and shed roughly two-thirds of their message types.
- **Migration:** one migration, revoking three grants. No data moves.
- **Distribution:** the store listing changes from "the app" to "the Rightmove
  overlay for House hunt", and the README's install instructions become optional
  rather than the only way in.
