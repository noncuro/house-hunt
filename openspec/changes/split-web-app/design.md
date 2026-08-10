# Design

The decisions behind the split, in the order they constrain each other. D3 is
the one that took the most getting to and is the one most likely to be
re-litigated later, so it is written up at length.

## D1 — One repo, a pnpm workspace, four packages

```
house-hunt/
  packages/core/       @house-hunt/core   types, the Supabase data layer, domain logic
  packages/ui/         @house-hunt/ui     React components both surfaces render
  apps/web/            @house-hunt/web    Next.js, deployed to Vercel
  apps/extension/      @house-hunt/ext    WXT, load-unpacked and Chrome Web Store
  supabase/                               migrations and Edge Functions, shared
```

Two repos was the alternative and it is the wrong one: the two surfaces share
`supabase.ts`, every type, and most components, and the whole point of the
change is that there is one implementation of each. A workspace keeps the shared
code importable without publishing it anywhere, and Vercel builds a subdirectory
happily given a root directory setting.

What goes where is decided by one question: **does this need a browser
extension?**

| Module | Destination | Because |
|---|---|---|
| `lib/supabase.ts` | core | No Chrome API in 1,635 lines. |
| `lib/types.ts`, the DTOs out of `lib/messages.ts` | core | The vocabulary both surfaces speak. |
| `lib/analysis.ts`, `png.ts`, `facts.ts`, `hubs.ts`, `shortlist.ts`, `cards.ts`, `sweep.ts`, `decode.ts`, `postcode.ts`, `tfl.ts` | core | Pure. Several already run under Deno. |
| `lib/extract.ts`, `search-page.ts` | extension | Reads a Rightmove DOM. |
| `lib/auth.ts` | split — see D2 | Half contract, half `chrome.storage`. |
| `lib/log.ts` | extension | Diagnostics for a surface with no debugger. |
| The envelope and transport in `lib/messages.ts` | extension | `chrome.runtime.sendMessage`. |
| `components/` except `Panel.tsx` | ui | No Chrome API anywhere in them. |
| `components/Panel.tsx` | extension | It *is* the Rightmove overlay. |
| `entrypoints/shortlist/` | web | Deleted from the extension. |
| `entrypoints/*.content/`, `background.ts` | extension | The reason the extension exists. |

`packages/core` must not import React and `packages/ui` must not import
`supabase.ts` — a component takes data as props. This is what stops the
extension bundle from pulling the whole data layer in behind a stray import,
and it is checked, not trusted (see D8).

## D2 — One Supabase client per process, constructed by the app, not the library

`packages/core` cannot call `createClient` at import time: it has no way to know
whether it is in a service worker that needs a `chrome.storage` adapter and no
auto-refresh, or in a tab where the defaults are right. So core exports a
constructor and a setter, and each app calls it exactly once at start-up:

```ts
// packages/core/src/client.ts
export function configure(client: SupabaseClient): void   // called once per process
export function db(): SupabaseClient                      // throws if configure() has not run
```

The extension passes what `lib/auth.ts` builds today — the `chrome.storage.local`
adapter, `storageKey: 'rm-supabase-session'`, `persistSession: true`,
`autoRefreshToken: false`, `detectSessionInUrl: false` — and keeps
`ensureSession()` and the `chrome.alarms` heartbeat, because the MV3 trap those
exist for is still real. The web app passes a client with supabase-js's own
defaults: `localStorage`, `autoRefreshToken: true`, no heartbeat, no
`ensureSession()` before every call. A tab has an event loop and visibility
events; the machinery the worker needs is dead weight in it.

`detectSessionInUrl` stays `false` in the web app too. Sign-in is an address and
a password; nothing lands on a redirect and there is no magic-link flow to
detect. Turning it on would only mean parsing every URL the app is ever opened
with.

## D3 — Sign-in happens once, on the website, and the extension signs *itself* in

The requirement is one sign-in. The trap is that "one sign-in" reads as "one
session, shared", and a shared Supabase session is a session that dies.

Supabase rotates the refresh token on every use and revokes the whole family if
a spent one is presented outside a short reuse window. Two holders of the same
refresh token therefore diverge the first time either refreshes: the other is
left holding a revoked token, and the next thing it does is sign the user out
with nothing on screen explaining why. Intermittently, and days later. This is
the same failure `tools/check-one-client.ts` was written to prevent inside the
extension, and copying a session across the bridge would reintroduce it across
processes instead — where the check cannot see it.

Two independent sessions for one user, on the other hand, are entirely normal:
it is what being signed in on a phone and a laptop is. So the extension needs
its **own** session, not a copy of the website's.

Three ways to give it one were considered.

- **Hand over the tokens.** Rejected: that is the shared-refresh-token failure
  above.
- **Mint a second session server-side.** An Edge Function running as the service
  role verifies the caller's JWT and issues a fresh, independent session for
  that user — in practice `admin.generateLink` followed by `verifyOtp`. It
  works, it needs no password, and it is the right answer if the handoff below
  ever becomes annoying. Deferred because it is a new server-side capability and
  a new way to obtain a session, and neither is needed yet.
- **Hand over the credentials, once, and let the extension sign in.** Chosen.

At the moment the website's sign-in form succeeds it holds an email address and
a password in a local variable. It posts both across the bridge to the
background worker, which calls the `signIn()` it already has. The extension
performs a completely ordinary password sign-in and ends up with its own session
and its own refresh-token family. The website keeps the credentials in memory
for the duration of that one call and never stores them.

Two things follow, and they are requirements rather than notes.

**The website may not load third-party scripts.** The handoff is a
`window.postMessage` on the website's own origin, and any script running on that
origin can read it. Today that is only our code. It must stay that way: no
analytics, no widgets, no CDN-hosted anything, enforced by a Content-Security
-Policy on the deployed app that permits `'self'` and the Supabase origin and
nothing else. This is a constraint the extension never had, because a page in a
`chrome-extension://` origin cannot be reached from the web at all, and it is
the real cost of moving the app onto the internet.

**The later-install path needs a second door.** Someone who signs in on the
website today and installs the extension next week has no password in memory.
The extension detects that it is signed out, and the website — told by the
bridge that an extension is present but unauthenticated — shows a "connect the
extension" prompt that asks for the password once. It is a re-prompt for a
credential they have already typed on that same origin, which is a familiar
thing to be asked and not a new kind of secret to hand over.

The bridge itself is a content script the extension injects on the website's
origin only. It carries three messages, and deliberately no more:

| Message | Direction | Purpose |
|---|---|---|
| `hello` | page → extension → page | "Is an extension installed, and is it signed in?" Lets the site say *install it* or *connect it* or nothing. |
| `sign-in` | page → extension | Email and password, once, in memory. Answers with the same `SignInResult` the shortlist used to render. |
| `sign-out` | page → extension | Signing out on the website signs the extension out too, because otherwise the overlay keeps working after you thought you had left. |

Nothing about a flat, a verdict or a project crosses the bridge. Both surfaces
read the database directly; the bridge exists solely to keep two sessions in
step.

It is addressed by origin rather than by extension id. The unpacked build and
the store build have different ids — the id is a hash of the manifest key and
the store build omits the key deliberately — so a website that knew an id would
work with one of the two installs and silently not the other.

## D4 — Travel, stations and postcodes resolve server-side, and the client stops writing the cache

`cache_travel`, `cache_station_point` and `cache_station_walk` are granted to
`authenticated` and are `security definer`. Their validation is about
plausibility, which is all it can be: whether a journey really takes 41 minutes
is knowable only to whoever asked TfL, and today that is the client. Since
`travel_time` and `station_point` are deliberately global — the whole point is
that one project's lookup saves another's — a single member writing a wrong
number pollutes every project at once, permanently and undetectably.

A new `travel` Edge Function becomes the only writer. It takes a question ("how
long from this postcode to these places, by these modes", "what stations are
near this postcode", "where is this postcode"), answers from the cache where it
can, calls TfL and postcodes.io for the misses, writes what it learned with the
service role, and returns the answers. The three RPCs are revoked from
`authenticated` and granted to `service_role` alone.

Three things fall out of this that are worth having anyway:

- `WXT_TFL_APP_KEY` leaves the extension bundle, where it is currently public.
- Calls to TfL become attributable and rate-limitable per user, which the
  existing `analyse` function already needed and this one now shares.
- The pinned weekday-09:00 basis is enforced in one place. It is currently a
  client-side convention, and a client that forgot it would write a rush-hour
  journey into a cache everyone reads as comparable.

`lib/tfl.ts` and `lib/postcode.ts` join `analysis.ts` and `png.ts` under the
existing rule: they are the source of truth in `packages/core`, they are copied
into the function by `pnpm sync:function`, `pnpm deploy:function` refuses a
stale copy, and they must stay free of `node:` imports and `import.meta.env`
reads so they run unchanged under Deno.

## D5 — The extension icon opens the website; the extension has no pages left

`chrome.action.onClicked` opens the configured web app URL in a tab. There is no
popup (there never was, deliberately) and after this change no extension page at
all, so `web_accessible_resources` and the shortlist HTML entry point go with
it. The URL is build configuration — `WXT_WEB_APP_URL` — so a development build
points at localhost and a store build points at production.

This also settles a question that has no good answer while the app lives in the
extension: what to send someone. It is a domain now.

## D6 — The message surface shrinks to what a content script needs

`background.ts` handles about fifty message types today. Roughly two-thirds
exist only because the shortlist page could not reach the database itself: every
`admin:*`, `invite:*`, `project:*`, `hubs:*` mutation, `places:add`,
`places:remove`, `profile:set-name`, `spend:summary`, `shortlist:get`,
`properties:locate`. Those callers move into the web app and call
`packages/core` directly, so the handlers are deleted rather than ported.

What remains is what a script running in a Rightmove page needs: the auth state,
recording a listing, reading and requesting an analysis, reading and setting a
verdict, reading places and hubs, travel and stations, the sweep, and
`tab:open`. `Request`/`ResponseMap` stay exactly as they are for those — the
end-to-end typing over `chrome.runtime.sendMessage` is worth keeping and there
is no reason to change a transport that works.

## D7 — The web app is client-rendered, and Vercel mostly serves static files

Next.js App Router, but with data read by `supabase-js` in the browser under the
anon key and RLS, exactly as the extension reads it. Server components reading
Supabase would be a second trust model to reason about, would need
`@supabase/ssr` and cookie-based sessions, and would mean reworking the
TanStack Query cache and the optimistic verdict write — for loading behaviour on
a six-person tool and SEO nobody wants on a private house hunt.

`queries.ts` therefore ports nearly unchanged. `ask({ type: 'shortlist:get' })`
becomes `getShortlist()`; the query keys, the stale times, the optimistic
`useRate` and its rollback, and the `onError` that re-reads the auth state all
stay as they are. `BackgroundError` loses its name and its `unauthenticated` /
`noProject` flags come from the errors `packages/core` already throws.

API routes are for things that need a secret, and at the time of writing there
are none — the secrets live in Edge Functions. The route handler surface starts
empty, which is the correct size for it.

## D8 — The guards move with the code

`tools/check-one-client.ts` currently asserts that `createClient` is called in
exactly one file and that `lib/supabase.ts` is imported for its values by
`background.ts` alone. Both facts stop being true and the invariant they protect
does not, so the check is rewritten to assert the new shape:

- `createClient` is called in exactly one file **per app**, and never in
  `packages/core` or `packages/ui`.
- `configure()` is called once per app entry point.
- `packages/core` imports no React, and `packages/ui` imports no `supabase.ts`.
- No file under `apps/extension` imports from `apps/web` or vice versa.

A check that has been rewritten is a check nobody has confidence in, so it gets
the same treatment the original had: it fails loudly, names the design decision
it is protecting, and is run by `pnpm check:all`.
