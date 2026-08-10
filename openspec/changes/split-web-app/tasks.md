# Tasks

Ordered so that the extension keeps working at every step and nothing is deleted
until its replacement is running. Phases 1, 2 and 3 each end with a build that
can be loaded and used; only phase 5 is a cutover.

The install is load-unpacked on a handful of laptops, so "deploy" means rebuild
and reload. There is no staged rollout, which is why the destructive step —
deleting `entrypoints/shortlist/` and revoking the cache grants — is last and
separate.

## 1. The workspace, with no behaviour change

- [x] 1.1 `pnpm-workspace.yaml` and a root `package.json` that owns the shared
      dev dependencies (typescript, oxlint, tsx) and forwards `check`, `build`
      and `check:all` to the packages.
- [x] 1.2 `packages/core`: move `lib/{types,supabase,analysis,png,facts,hubs,shortlist,cards,sweep,decode,postcode,tfl}.ts`.
      Split `lib/messages.ts` — every interface and result type moves here, the
      `Envelope`/`Request`/`ResponseMap`/`send()` transport stays behind.
- [x] 1.3 `packages/core/src/client.ts`: `configure(client)` / `db()` per D2.
      `supabase.ts` reads `db()` instead of importing a constructed client.
- [x] 1.4 `packages/ui`: move `components/` except `Panel.tsx`, with their CSS.
      Assert it imports no `supabase.ts` and core imports no React.
- [x] 1.5 `apps/extension`: everything that is left, still building the same
      manifest and the same shortlist page. `lib/auth.ts` keeps the
      `chrome.storage` adapter and the heartbeat and now calls `configure()`.
- [x] 1.6 Rewrite `tools/check-one-client.ts` for the new shape (D8) and move
      the rest of `tools/` to whichever package they check.
- [x] 1.7 `pnpm check:all` passes, `pnpm build` produces a working unpacked
      extension, and the smoke harnesses run. **No user-visible change.**

## 2. Travel, stations and postcodes move server-side

- [x] 2.1 `supabase/functions/travel/`: resolve journeys, nearby stations and
      postcode points; answer from cache first; write what it learned with the
      service role. Reuses `_shared/http.ts` and `_shared/caller.ts`.
- [x] 2.2 Extend `pnpm sync:function` to copy `tfl.ts` and `postcode.ts`, and
      `deploy:function` to refuse a stale copy. Keep both Deno-clean: no `node:`
      imports, no `import.meta.env`.
- [x] 2.3 Per-user rate limiting on the function, on the same footing as
      `analyse`. TfL is now called with our key on a user's behalf.
- [x] 2.4 Enforce the pinned weekday-09:00 basis inside the function, so two
      flats measured on different evenings stay comparable by construction
      rather than by client convention.
- [x] 2.5 Point the background worker's `travel:get`, `stations:walk` and
      `postcode:point` handlers at the function. Drop `WXT_TFL_APP_KEY` and the
      `api.tfl.gov.uk` / `api.postcodes.io` host permissions from the manifest.
- [x] 2.6 Verify a cache miss resolves and a cache hit does not call TfL, on a
      real listing, before touching the grants.

## 3. The website

- [x] 3.1 `apps/web`: Next.js App Router, `configure()` with supabase-js
      defaults, TanStack Query with the settings `queries.ts` already uses.
      The client is built in an effect rather than at module scope — building it
      touches `localStorage`, and Next renders the page on the server first.
- [x] 3.2 Port `queries.ts`: `ask({type})` becomes a direct core call. Keep the
      keys, the stale times, the optimistic `useRate` and its per-property
      rollback, and the `onError` that re-reads the auth state.
- [x] 3.3 Port the screens: shortlist, Compare, Map, Detail, Settings, Project,
      Admin, SignIn. Deep-link a flat by rightmove id — the thing the
      `chrome-extension://` address could never do. Three pieces that were
      worker-only turned out to be shared and moved into core rather than being
      copied: `cachedTravelTimes`, `readAuthState`, and the sign-in that also
      consumes invites (`apps/web/src/lib/session.ts`, until the extension's own
      sign-in goes in phase 5). Settings loses its Diagnostics section — a tab
      has devtools, and core's log sink points at the console.
- [x] 3.4 Content-Security-Policy permitting `'self'` and the Supabase origin
      and nothing else, plus a written rule that no third-party script is added.
      D3 depends on this and it is the only thing holding it up.
- [ ] 3.5 Deploy to Vercel behind the project's own domain; environment from the
      hub `.env`, publishable key only. **Daniel's step** — it needs his Vercel
      account and the domain.
- [ ] 3.6 Use it for a full session — sign in, rate a flat, add a place, invite
      someone — while the extension is still doing all of the above too.

## 4. The bridge

- [x] 4.1 A content script on the website's origin only, carrying `hello`,
      `sign-in` and `sign-out` and nothing else (D3). Addressed by origin, never
      by extension id. The origin cannot be read on the `matches` line — WXT
      evaluates that file to write the manifest in a pass where
      `import.meta.env` is undefined, and the obvious spelling silently ships
      `matches: ['undefined/*']`. A placeholder plus a `build:manifestGenerated`
      hook that throws if it is missing; negative-tested.
- [x] 4.2 Website: hand the credentials across on a successful sign-in; sign the
      extension out when you sign out; show "install the extension" or "connect
      the extension" from what `hello` answers.
- [x] 4.3 Extension: signed-out surfaces link to the website instead of showing
      a sign-in form. `chrome.action.onClicked` opens `WXT_WEB_APP_URL`.
- [ ] 4.4 Verify the two sessions are independent: sign in on both, force a
      refresh on each, confirm neither signs the other out. This is the failure
      D3 exists to prevent and it is invisible until days later, so provoke it
      deliberately. **Daniel's step** — it needs two real sessions, so it needs
      a password. `pnpm check:bridge` covers the envelope guards, which is the
      part that can be checked without a browser.

## 5. Cutover

- [ ] 5.1 Delete `entrypoints/shortlist/`, the shortlist HTML entry point,
      `SignIn.tsx`, and every `background.ts` handler that only it called (D6).
- [x] 5.2 **Done early, in phase 2** — it turned out to be required rather than
      optional. The RPCs guarded on `auth.uid() is not null`, which is false for
      the service role, so the function could not write the caches at all until
      the guard became `is_service_role()`. Revoking `authenticated` in the same
      migration was then free, since nothing on either client still called them.
      `tools/check-rls.ts` asserts both halves.
- [ ] 5.3 Update `AGENTS.md`, `README.md`, `SETUP.md` and the store listing: the
      extension is the Rightmove overlay, the website is the app, and installing
      the extension is optional for a reader.
- [ ] 5.4 Cut a release and reload both laptops.
