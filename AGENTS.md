# house-hunt — shared house-hunting for Rightmove: a website plus a thin extension

A shared shortlist for people hunting a flat together: travel times to saved places,
one shared verdict per flat per project, a funnel from shortlisted to archived, and a vision pass
over the photos for what the listing won't say. Multi-tenant, invite-only, password sign-in — nothing here sends email; a **project** is one hunt (up to six
people). In use on real listings.

Two apps in one pnpm workspace: `apps/web` (Next.js — shortlist, compare, map, settings, sign-in,
project/admin, and **the whole product**: it is installable, works offline, and adds flats from a
pasted or shared address) and `apps/extension` (thin Chrome MV3 — the listing panel, search badges,
sweep panel, all only on Rightmove pages, and **one of two ways in** rather than the way in: no
browser on a phone loads it, so nothing may be reachable only through it). Shared logic in `packages/core` and `packages/ui`. Config is
the workspace-root `.env` (see `.env.example`). This file is *how it's built and how to check you
haven't broken it*; `product.md` is *how we decide what to build*.

## Running it

```bash
pnpm install
pnpm dev            # extension: Chrome with it loaded, hot-reloads
pnpm dev:web        # website: next dev on http://localhost:3100
pnpm build          # extension -> apps/extension/.output/chrome-mv3 ("Load unpacked")
pnpm build:web      # website: next build
pnpm compile        # typecheck both apps
pnpm icons          # redraw the website's app icons (only when the mark itself changes)
```

**`pnpm sweep` runs a whole sweep with nobody watching** — a real Chrome, the real extension, and
the button on the Triage tab, clicked. It is the one thing in `tools/` that is *meant* to reach
Rightmove, which is why its header restates what keeps it inside the standing rule: it presses the
button, and it does not have its own idea of the pace. `pnpm sweep:sign-in` does the one-time
sign-in that leaves a profile behind. **`docs/sweep-runner.md`** is the mini-PC recipe — systemd,
Xvfb, and why updating the extension is an `ExecStartPre` rather than its own timer.

The extension bundles only `WXT_*` vars, the website only `NEXT_PUBLIC_*`; both point at the same
Supabase project. `WXT_WEB_APP_URL` is where the extension sends sign-ins and the origin its
bridge trusts. It is also where the extension's API calls go: four of them are routes on the
website now, so `host_permissions` covers that origin as well as Supabase's. Nothing runs locally in
production: analysis, invites, passwords, location lookups and travel are all routes in
`apps/web/src/app/api/`. **Deploying the website is now the whole deployment** — there is one
artefact and one place to look when something server-side is wrong, which is what the move off
Supabase's Edge runtime bought. `apps/web/vercel.json` pins the region to `lhr1`, beside the
database: the default is Washington, and every server-side query would cross the Atlantic while
looking like success. **`docs/server-side.md`** is what a route here is: the reply convention, the
hand-written gate, the region and the environment. Second machine: `SETUP.md`.

## Standing rules

- **No PII in the repo.** No real names, personal email addresses, or anything identifying the
  people using it — in code, docs, examples, or commit messages. Deployment-specific identity
  (admin email, project name) lives in the untracked `supabase/seed.sql`.
- **Never `git add -A` or `git add .`. Stage explicit paths.** The working tree carries untracked
  secrets and whole second checkouts — `.env` (a real database password), `supabase/seed.sql`, and
  git worktrees under `.claude/`. A blanket add vendors one of those the moment a `.gitignore` rule
  is missing; `.claude/` was untracked-but-not-ignored until a Codex review caught a worktree `.env`
  about to be committed. Add the files you changed, by name, and read `git status` before every
  commit.
- **Distribution is private until the Chrome Web Store listing is approved** — load-unpacked
  only for now. Access is an invite, not a download.
- **Select on `data-testid`, never CSS-module class names** — Rightmove's hashed classes churn.
- **Fail loudly.** If extraction breaks, the panel must say so; blanks look like real data.
- **One fact, one renderer.** Anything both apps show lives in `packages/ui/src/` or
  `packages/core/src/facts.ts`. Never re-implement a fact in a view.
- **Only `background.ts` constructs a Supabase client** (extension side). One session holder is
  what keeps an MV3 session alive; `pnpm check:one-client` enforces it.
- **A migration's `YYYYMMDDHHMMSS` must be a minute no other migration uses — on main *or on any
  branch in flight*.** Supabase keys `supabase_migrations.schema_migrations` on that prefix, not on
  the file, so when two share one the first to run records the version and `supabase db push` reads
  the second as already applied and skips it. There is no error and no log line: the column,
  function or policy is absent, in production only, because CI starts from an empty database
  and applies both files happily. It nearly landed twice in one day, both times between two branches
  open at once — each author checked `origin/main`, correctly found the minute free, and could not
  see the other branch. `pnpm check:migrations` is what catches it, run against the merge result:
  red on the second pull request when that branch is current with main, and otherwise red on the
  `main` push right after it lands. A `pull_request` tick is not recomputed when the base moves,
  so rebase before merging when another migration is in flight.
- **Change anything that ends up inside the built extension — `apps/extension/`, and the
  `packages/core` and `packages/ui` source bundled into it — and bump
  `apps/extension/package.json`'s `version`, and `EXPECTED_EXTENSION_VERSION` in
  `apps/web/src/lib/extension-version.ts` to match.** A shared-package fix ships in somebody's
  browser exactly as an `apps/extension/` one does, so without a bump their stale copy reports
  itself current; `pnpm check:zip` counts those files as "source file(s) changed since it was
  packaged" and `package.yml` rebuilds on "extension or shared-package source" for the same
  reason. The two
  are compared over the bridge on `hello`, and that comparison is the only thing that can tell
  somebody the copy in their Chrome is older than the code. Nothing enforces it: Vercel builds
  only `apps/web`, so a forgotten bump ships as a confident "up to date" on a browser running
  last week's extension — which is how eleven withdrawn listings stayed on a worklist that had
  already been taught to drop them. A stale unpacked copy is the most common bug in this project
  and it never looks like one.

  The zip is the third copy of that number and the one people actually run, and it is **not** yours
  to refresh — `.github/workflows/package.yml` rebuilds and commits it when a change reaches main.
  It used to be a hand copy, which is a step that does not get done: it sat at 0.1.0 through three
  bumps while the site said 0.3.1 and told everybody who downloaded it that they were out of date,
  which is the message they had just acted on. `pnpm package` still works and is what to run if you
  want the zip now; `pnpm check:zip` says when it is behind — a failure on your own machine, where
  running `pnpm package` is the answer, and a note in CI, where `package.yml` is already doing it.
  Its other three assertions are fatal everywhere: the three version strings agree, the archive
  holds every file its own manifest names, the stamp is of this archive. A forgotten bump is still
  nothing a repackage fixes. Why the stale half is a note in CI is on the code (`tools/check-zip.ts`).
- **Rightmove's own mark may be used on the buttons that go to Rightmove**, and nowhere else. It
  labels an outbound link with the thing it opens, which is what a trademark is for, and it is the
  owner's decision on the owner's product. What stays forbidden is unchanged and is a different
  question: **listing photos and floorplans are never re-hosted.** Those are shown from Rightmove's
  own CDN URLs, which is why `.fixtures/` is gitignored and why every harness answers image
  requests from memory rather than saving them.

  The service worker's photo cache is not an exception to that and must not become one. It is the
  reader's own browser holding a copy of a file it already fetched, on the reader's own device,
  which is what an HTTP cache is — nothing is copied to our origin and nothing is served to anybody
  else. The line is *whose server the bytes come off*, and it has not moved.

## Rightmove's terms, in four lines

Their [Terms of Use](https://www.rightmove.co.uk/c/terms-of-use/) forbid automated access (5.2,
5.5), and forbid embedding their images in an extension (13.4). There is no carve-out for a content
script in your own browser. So:

- **Never fetch a search or listing page in the background.** Only read pages somebody opened. This
  is the line between a notes app and a crawler.
- **Never re-host their images or floorplans.** Store the URL or nothing.
- **Store only what the hunt needs, and do not redistribute it.**

## Architecture map

| Piece | Job |
|---|---|
| ext `entrypoints/page-model.content.ts` (MAIN world) | Decodes `window.__PAGE_MODEL`, posts the listing out |
| ext `entrypoints/{panel,search,sweep}.content/` | Listing panel (Shadow DOM), search-card badges, sweep panel |
| ext `entrypoints/bridge.content.ts` | On the website's origin only; relays four messages so the two sessions stay in step, and carries the version `hello` compares |
| ext `entrypoints/background.ts` | All network + the only Supabase client in the extension |
| web `components/Shell.tsx` | The one header row, the hunt switcher, the account menu, the phone's tab bar |
| web `screens/Places.tsx` | Everything the hunt has looked at, drawn four ways — Cards, Table (`Compare.tsx`), Board, Map — under one filter (`lib/lens.ts`) |
| web `screens/*.tsx` | Triage, HeadToHead, FirstRun, Settings, Sweep, SignIn, Project, Install, Admin, AddFlat |
| web `screens/AddFlat.tsx` | A flat from a pasted or shared address — the phone's only way in, and the extension's counterpart |
| web `components/Flat*.tsx` | One flat: the card in a grid, the whole of it (`FlatDetail`), and the panel it opens in over any screen |
| web `lib/platform.ts` | Whether an extension can exist here at all, and whether this is an installed app. Hooks, not calls, in a render — see the note in the file |
| web `lib/persist.ts` + `public/sw.js` | The offline half: the hunt in IndexedDB, the shell/build/photographs in the Cache API |
| web `public/manifest.webmanifest` | What makes it installable, and the share target Rightmove shares into. Icons are drawn by `pnpm icons` |
| `packages/core/` | Facts, hubs, listing extraction, stage (the funnel), sweep, travel, analysis, db, bridge contract |
| web `app/api/` | Everything that runs server-side, and the only thing holding the service role: `predict` (fit the verdict-score model), `listing` (one listing page, read server-side), `analyse` (vision, holds the OpenAI key), `travel` (TfL + postcodes, sole writer of the travel cache, and the scheduled `backfill` that drains the gap set), `invite`, `resolve-location`, `password`. Every one is `authedRoute` or a stated `publicRoute`, and `pnpm check:routes` is what holds that — its `PUBLIC_ROUTES` is the whole record of what this deployment answers without a session. `server/cors.ts` is what lets the extension and a Rightmove content script call the ones they need |

## Decisions an agent might otherwise "fix"

- **Invite-only until there's billing** — every analysis spends an OpenAI API key, so going
  public means charging users first. Enforced as `enable_signup = false` on the Supabase
  project, not a client argument. RLS is `to authenticated` everywhere; `anon` holds nothing.
  Shared fact tables are written only through `SECURITY DEFINER` functions; `DELETE` is
  `service_role` only.
- **A shared fact is shared, but the list of them is not.** `property`, `property_analysis`,
  `station_point`, `station_walk`, `travel_time` and `property_price` hold facts about a listing
  rather than about a hunt, which is what makes a flat analysed once across the platform instead of
  once per project. They were also `select ... using (true)`, so any member of any hunt could list
  the whole `property` table and read every address every other household had opened. The policies
  ask `listing_is_mine` / `postcode_is_mine` now (`20260830190000`): a row is readable once a project
  you are in has opened the listing it is about, which is the predicate every read here already
  carried in its own query. Two consequences worth knowing before "fixing" something: a new read
  path that forgets to join `project_property` comes back **empty rather than wrong**, and the
  cache is still one cache — opening a flat another hunt found still costs nobody a second
  analysis. `pnpm check:rls` asserts both directions, including that a scoped-to-nothing policy
  fails rather than passes.
- **The MV3 session lives only in `background.ts`** (chrome.storage adapter, explicit
  `ensureSession()`, alarms heartbeat) — a second client holder silently kills the session.
- **`SEED_HUBS` is for dev tools/checks only** — hubs are project data (`project_hub`), and a
  surface reading the constant puts one project's neighbourhoods on another's flats. A hub with
  no coordinates is skipped, never defaulted.
- **The sweep window snaps up, never down** — a too-narrow window drops listings and looks like
  success. Details in `packages/core/src/sweep.ts`.
- **A filter never drops a flat for a number we do not have.** Triage's filters (rent, beds, size,
  main room, must-have amenities) exclude only what is *known* not to qualify — most of those
  figures are read off photographs, and "we could not tell" is common. Dropping unknowns would hide
  precisely the least-known listings, which is the pile triage exists to work through, and it would
  do it invisibly. `applyFilter` counts them and the bar says how many are kept on that basis.
- **A verdict and a stage are two facts, and neither writes the other.** "Like it" / "love it" /
  "not our place" is taste and is what the verdict-score model is fitted on; the funnel
  (shortlisted → reached out → viewing booked → viewed → offer in → archived, with a reason) is
  progress. A flat you loved and lost is archived and *still loved* — collapsing the two would
  teach the model the opposite of what happened. The one coupling is the `enter_funnel` trigger:
  liking a place enters it at `shortlisted`, un-liking removes it only while it is still there, and
  a stage further along survives any change of mind. `packages/core/src/stage.ts` owns the funnel;
  `20260813000000_property_stage.sql` owns the coupling.
- **Off the market is a third fact, and it hides rather than writes.** The mark lives in
  `training_exclusion` — it is what withholds a flat from the verdict-score model — and it is also
  the only thing anybody records to mean "this one is gone". So a flat that is off the market is
  drawn under **Archived** and nowhere else (`lensMatches` in `apps/web/src/lib/lens.ts`), and it is
  kept out of the triage pile, which is a list of work still to do. That is all it does: the verdict
  and the stage are untouched, which is what makes a flat you loved and lost still readable as
  loved. Making the toggle archive would have it *write* over somebody's account of what happened,
  which is the same objection `background.ts` makes to a background tab doing it — the point is that
  gone flats stop appearing among the live ones, not that the funnel gets edited.

  This replaced a separate "hide off-market" switch with a line under the tally offering them back.
  Two controls narrowed one list, and the flats they hid had to go somewhere the eye could find them
  again; Archived is where somebody already looks for a flat that is no longer in play, so the
  question "where did it go" stopped needing an answer.
- **A phone is a first surface, not a narrow window, and nothing may be reachable only through the
  extension.** No browser on a phone loads a Chrome extension — Chrome for Android loads none, and
  iOS loads no Chrome extension at all — so every sentence offering the install is, there, an
  instruction that cannot be followed. `lib/platform.ts` answers that question once and the notice,
  the menu item, the first-run step and the Install screen all ask it; `useExtension` and the
  sign-out bridge skip their deadlines rather than waiting out a reply that cannot come. The rule
  that follows is the one to keep: a new capability that only the panel can reach has cut the phone
  out of the product, and adding a flat was exactly that until the `listing` route existed.

- **Adding a flat by address is a server-side read of one page, and the no-crawl rule is not
  relaxed for it.** `app/api/listing` fetches a single listing, for the person who has just pasted
  or shared that exact address, rate-limited per user, and rebuilds the URL from an id so nothing a
  caller sends can steer it elsewhere. It decodes with `packages/core/src/listing.ts` — the same
  module the content script uses, which is why that module moved out of the extension: one page
  shape read two ways is a fork, and the day Rightmove renames a field the copy that did not learn
  about it returns a flat with no postcode rather than an error. Read the block at the top of
  `app/api/resolve-location/route.ts`; the argument there is the whole permission this has. What is
  forbidden, still, is turning a *list* into fetches — a sweep's sightings are opened in front of
  the reader by the paced opener, and must never be handed to this.

- **The offline copy is restored stale, and says so.** `lib/persist.ts` puts the last snapshot back
  before any query mounts (React Query takes starting data on the first render and never again), and
  always with the timestamp it was written at — so it refetches the moment there is a network, and
  `components/Offline.tsx` can say how old what you are looking at is. That sentence is the point
  rather than a nicety: a verdict is *shared*, so a cached one drawn as current is this app being
  confidently wrong about the one thing it exists to get right. Spend, the admin tables and the
  invite list are deliberately not kept — anything that is money or permission is read fresh or not
  shown.

- **Driving times deliberately throw** (TfL can't do them) rather than mislabel a transit number.
- **The travel backlog is derived, not enqueued.** Nothing inserts a job when a place is added:
  `travel_gaps` computes what is missing from a project's properties, its places and the modes we
  route, minus what `travel_time` already holds, and a pg_cron job
  (`20260816020000_travel_backfill_cron.sql`) has the `travel` function work a budget of them every
  fifteen minutes. A queue written to on place-add is a queue that drifts — one failed insert and the
  gap is invisible for good — while a derived set cannot lose work it never stored. Lazy lookup alone
  never fetched anything for a flat nobody opened, which is how adding a place left a column of
  dashes that filled in only by hand.

  **Which places count as destinations is written twice — `travelDestinations` in
  `packages/core/src/hubs.ts` and the `where` clause of `travel_gaps` — and both have to say the
  same thing.** A postcode and `place.travel_timed`, two clauses, because "cannot be routed to" and
  "not worth routing to" are different facts and the screen says different things about them. The
  SQL copy is the one that gets forgotten and the one the money runs through: a clause missing there
  is the backfill fetching journeys nobody wants forever, three legs per flat, with every screen
  looking right. `pnpm check:travel` reads the clause out of the live migration for that reason.
  Switching a place off never deletes a `travel_time` row — that table is keyed on a pair of
  postcodes and has never known what a place is — so switching it back on is the whole undo.

  **The schedule lives in the database, and the credentials it uses live in the project's vault.** It
  was a GitHub Actions workflow first, which is a reasonable place for a cron and was the wrong one
  here: it needed two repository secrets nobody knew were missing, so it failed at its own guard 40
  runs out of 40 while the app showed a column of dashes that looked exactly like a slow backlog. Two
  `vault.create_secret` calls stand it up — `SETUP.md` has them — and `cron.job_run_details` is where
  a failure is read, on the same connection everything else here is debugged from.

**Every other decision is documented as a comment on the code that owns it** (`TRAVEL_BASIS` in
`tfl.ts`, `SWEEP_MARGIN_HOURS` in `sweep.ts`, `duplicateIds` in `shortlist.ts`, `Lens` in
`apps/web/src/lib/lens.ts`, `claim_analysis` in the migrations) — including new
ones. This file holds only cross-cutting rules and the decisions an agent working elsewhere
could silently violate. Accepted gaps are GitHub issues labelled `accepted-gap` — see below.

## Issues are the backlog — all of it

**Everything not-yet-done is a GitHub issue.** No second list, no new TODO file. Labels:
`accepted-gap` (known, deliberately unfixed — each must state a trigger somebody can check,
not a feeling: for most of them it is membership beyond the six-member cap or a second admin;
when a trigger fires, re-read them all), `bug`,
`enhancement`.

- **Close what you fix, in the PR that fixes it** (`Closes #N`). A pass over 17 open issues found 10
  wrong: 6 already fixed, 4 half-landed. A stale issue argues for work already done.
- **Half-fixed something? Rewrite the issue and its title.** The title is the only part most people
  read.
- **A working file is fine inside a PR and must not survive it.** Write the plan, the checklist, the
  phase notes a big change needs — then delete them in the same PR. `openspec/` was that and
  outlived its change by months, becoming a backlog nobody read. What outlives a PR is code, an
  issue, or an entry in `design.md`.

  **This departs from the hub convention** (`~/hub/conventions/openspec.md`), which keeps a
  persistent `openspec/` per project as the durable record of what and why. Here that record is
  `design.md` — numbered decisions the code cites by number — and the backlog is issues. Two
  shipped `openspec/` change folders sat for months restating decisions the code had moved past,
  and the code cited them by numbers that collided across the two.
- Cite issue numbers in the code that owns a gap, as `travel_backfill.sql` and `smoke-search.ts` do.

`product.md` is why-we-chose, beside this file's how-it-is-built.

## How to write here

Issues, comments, commit messages, docs, code comments. Plain language, facts and evidence.

- **Cut** `simply`, `genuinely`, `honestly`, `really`, `actually`, `very`, `obviously`, `of course`,
  `clearly`, `it is worth noting`. Delete and put nothing back. `obviously` substitutes for the
  evidence that would convince; `honest` and `genuine` describe the writer, not the number.
- **Number, not adjective.** Not "wildly off" but "17 min against Google's 11 over 813 m". Not
  "widespread" but "215 of 609 postcodes".
- **Never present an estimate as a measurement.** Say which it is.
- **No throat-clearing, and no metaphor that isn't carrying a mechanism.**

## The four facts the design rests on (verified against live pages)

1. Search pages carry `__NEXT_DATA__` (plain DOM JSON, every card) — but it doesn't follow the
   client-side pager; `staleAgainst` notices.
2. Listing pages carry `window.__PAGE_MODEL` (double underscore), index-reference encoded.
3. Nearest stations are already in that blob — zero API calls.
4. The full postcode is in the blob even though the page hides it. **Route from the postcode,
   not the lat/lon.**

## Testing

```bash
pnpm check          # oxlint + tsc — run on every change
pnpm check:all      # + every pure-function check (seconds)
```

Pure-function checks (each `pnpm check:<name>`): `area`, `facts`, `filter`, `listing` (which URLs are a
listing, and what a share hands over), `invite` (what state an invitation is in, once, for both
screens that show one), `hubs`, `stage`, `shortlist`, `sweep`, `travel` (what a cached journey means,
and what one ask may cost before it is dispatched),
`geo` (the sentence a refused position gets, and a maps link that is not a guess about the phone),
`png`, `analysis`, `routes` (every route says whether it needs a
session, and the ones that do not are on a list with a reason),
`one-client`, `migrations` (no two migrations claim the same version string),
`bridge`, `withdrawn`, `recheck`, `full-sweep` (the unattended sweep's sequencing,
against a fake extension and clock). Each pins reasoning invisible when wrong — a bad bearing still
looks like a bearing.

Needing a local Supabase (`supabase start`, ports 5434x; not in `check:all`): `pnpm check:rls`
(the security boundary asserted by real JWTs) and `pnpm check:spend` (concurrent cap claims for
*different* listings — the case that defeated the earlier design). Known trap: local PostgREST
12.0.1 intermittently dies mid-request; the `rpc()` helper retries.

Fixtures (real page shapes — run after a Rightmove deploy):

```bash
pnpm fixture <id>              && pnpm check:extractor .fixtures/<id>.html
pnpm fixture:search <hub>      && pnpm check:sweep .fixtures/search-<hub>.html
```

Browser smoke (Playwright; screenshots in `.fixtures/shots/`). All three sign a fixture user in
against the local stack — `tools/fixture-session.ts` is the seed and says why a signed-in harness
has to be a local-stack one:

| Command | What it drives | Needs a saved page |
|---|---|---|
| `pnpm smoke <fixture>` | The listing panel, in the built extension, on a real listing | yes |
| `pnpm smoke:search` | Search badges and the sweep panel; records real sightings, never completes a sweep | yes |
| `pnpm smoke:web` | The website: shortlist, compare, map, triage, the other tabs, and joining | **no** |

`pnpm smoke:all` runs all three cheapest-first, stops at the first failure, and prints timings;
`pnpm smoke:all web search` runs a subset. Within one harness the rule is the opposite — every
problem is collected and reported together.

`smoke:web` takes names too, one level down: `pnpm smoke:web list rating` runs those sections and
`pnpm smoke:web joining` runs that one, in the order the file declares them (`session`, `list`,
`rating`, `funnel`, `offmarket`, `table`, `map`, `triage`, `tabs`, `refusals`, `joining`). The setup is not optional — the
fixture and a production build of the website happen either way — so a subset
saves the browser work and a few seconds of a forty-second run, which is the difference worth having
while you iterate on one assertion. A name that matches no section stops the run and prints the
list, as `smoke:all` does with harnesses.

`smoke:web` serves the **production** build, not `next dev`: the app ships a CSP with no
`unsafe-eval` and React's dev build needs `eval()`, so under `next dev` the bundle dies on load and
renders nothing. Needing no Rightmove page is what makes it the browser check CI can run.

**Both `smoke` and `smoke:web` start the website themselves** (`startWebApp` in
`tools/servers.ts`), because everything this app runs server-side is a route on it. That is new for
`smoke`, which drives the extension against a real listing: the panel asks `/api/travel` for its
station walks the moment it renders, so with nothing serving that it sits on a spinner and the
harness reports "panel never left its loading state" — a sentence about a spinner for what is really
a server nobody started. It used to start `supabase functions serve` for the same reason, and before
that started nothing and passed only when a server left over from something else happened to be
answering.

The cost is that `pnpm smoke` now waits for a `next build` like `smoke:web` does. Both are built and
served against the local stack, on `WEB_APP_PORT` — which the smoke extension is compiled to call
(`tools/build-smoke.ts`), so a build on one port and a server on another is an extension whose every
call is refused with nothing on screen to say why.

**A harness owns the servers it starts, and refuses the ones it did not** (`tools/servers.ts`).
Both are spawned in a process group of their own and stopped as a group: `pnpm exec next start` is
two processes, and signalling the wrapper alone left the website holding 3199 after the harness had
exited, which the next run then asserted against — green, about a build from another branch, and
visible only as a page stuck on "Working…" or a connection refused halfway through. The group means
Ctrl-C no longer reaches them through the terminal, so both harnesses pass the interrupt on. Before
starting, `smoke:web` checks that 3199 is free and stops with the port and a `lsof` line if it is
not.

Harness rules live in `tools/offline.ts` and the harness files; the cross-cutting one: no harness
may reach Rightmove (`OFFLINE_ARGS` kills DNS for the domain). `SMOKE_LOG=all` widens the output —
on `smoke` it dumps the extension's own diagnostic ring buffer, which is how you tell a write that
was refused from one that was never attempted.

**What is and is not covered, with timings and what to build next: `docs/coverage.md`.** Read it
before adding a check — the gaps are ranked, and the biggest is that almost every *write* is
asserted up to the button and no further.

**Standing a fresh machine up, and where the fixtures come from: `docs/fixtures.md`.** It also
says why the saved Rightmove pages are deliberately *not* committed — a frozen fixture answers
"do we still parse last month's page", green, while the live one drifts — and what CI runs
instead (`.github/workflows/check.yml`: `check:all`, `check:rls`, `check:spend`, `smoke:web`).

## Debugging

- "Shows nothing" is usually a session (`signed-out` / `no-project` testids) or the spend cap. Auth is read once per page — reload after signing in elsewhere.
- **Can't sign in / forgot the password?** `python3 tools/set-password.py <email>` — its
  docstring explains why there is no reset email.
- The first stop is Settings → Diagnostics → **Copy log**.
- The network lives in the background worker: `chrome://extensions` → Inspect service worker.
  The panel is in a Shadow DOM — go through `.shadowRoot`.
- Read the database directly when a view disagrees with reality:
  `PGPASSWORD="$SUPABASE_DB_PASSWORD" psql -h aws-1-eu-west-1.pooler.supabase.com -p 5432 -U "postgres.$SUPABASE_PROJECT_REF" -d postgres`
  (source `.env` first). **Migrations reach production on merge** —
  `.github/workflows/migrate.yml` runs `supabase db push` when anything under `supabase/migrations/`
  lands on main, and `supabase_migrations.schema_migrations` records what has run. Applying one by
  hand with `psql -f` still works and is what you want mid-review, but the table has to agree
  afterwards or the workflow will run it a second time.
- Admin identity and the first project's name are deployment data, not schema: copy
  `supabase/seed.example.sql` to the untracked `supabase/seed.sql`.
- Extraction broke after a Rightmove deploy? `pnpm check:extractor`, then
  `tools/decode_page_model.py`.
- Config problems look like data problems: only prefixed vars are bundled. Verify:
  `grep -c "$(grep WXT_SUPABASE_URL .env | cut -d/ -f3)" apps/extension/.output/chrome-mv3/background.js` → 1.
- A stale copy in Chrome is the most common "bug": reload the extension *and* the tab, and check
  for a second older copy (only id `jkcidomcogoaociobhbjankcpjgnhlji` carries the pinned key).

## Packaging

`pnpm package` → `apps/web/public/rightmove-house-hunt.zip`, which is **committed**: Vercel builds
only `apps/web` and cannot build the extension, so the install page serves it as a static asset and
the artefact in git is the artefact people download — rebuilt and committed by
`.github/workflows/package.yml` when extension or shared-package source lands on main, so it is
never a step somebody has to remember. `pnpm package` also writes
`rightmove-house-hunt.sources.json`, the hash of every source file it was built from, and
`pnpm check:zip` recomputes those and compares. The version strings are checked too, but they are
the weaker half and were never the problem: three of them agreed perfectly while the zip beside them
was a month old. `apps/web/public/install.sh` is the terminal route onto the same zip, and lives in `public/` because
the file people execute has to be the file in git — a copied-into-place installer is the step that
does not get done, which the zip beside it already demonstrated. It takes the site's origin as an
argument (the Install tab's one-liner passes its own, so previews and localhost work) and reads the
version out of the downloaded manifest rather than being told it, so it is not a fourth copy of that
number. `tools/package-stamp.ts` says why this is a stamp rather than a rebuild — the
bundle bakes in `WXT_*`, so CI's `.env.ci` build could never match a zip built against the real one. `SETUP.md` goes with it. The manifest carries a fixed `key` so the
extension id survives moving the folder.

## Code Review

**`.coderabbit.yaml` carries these rules to the automated reviewer, per path.** Change a rule here
and change it there — a rule it does not name is a rule it does not apply, and it names the docs it
ingests by filename, so renaming or deleting one breaks it silently. Its `filePatterns` resolved
empty on the first PR and nothing said so.

In addition to the usual:

- **Comments explain why, not what.** Flag comments that restate the code, and overly long ones
  where a few words would do.
- **Copy-paste instead of reuse.** Two blocks differing by a variable or a string get a shared
  function with a parameter. Same for reinventing a helper the repo (or stdlib) already has —
  search before accepting a new utility.
- **Swallowed errors and silent defaults.** Empty catches, catch-and-log-only, or a
  plausible-looking fallback where the code should throw. Corollary of "fail loudly": a default
  should be intentional, not a way to dodge error handling.
- **Fixing tests instead of code.** Changed assertions or expected values that make a check
  tautological — especially replacing a hardcoded expected value with the computation under test.
- **Orphaned scaffolding.** Imports, functions, or variables added in the diff and never
  referenced; `TODO`/stub bodies in code that's meant to be finished.
- **Collateral damage.** Deletions, rewrites, or reformatting unrelated to the stated change —
  and safety checks (validation, guards, auth) removed to get past an error instead of fixing it.
- **Unnecessary abstraction.** Wrappers that delegate with the same signature, patterns with
  exactly one implementation, when the problem needed one function.
- **Regex-parsing structured output.** String-splitting CLI or API output that offers `--json`
  or an equivalent structured form.
- **Lazy non-typing.** `any` (or a blind `as` cast) where a real type would do. At a network
  boundary — a request body, a reply from TfL or postcodes.io, `__PAGE_MODEL`, `__NEXT_DATA__` —
  **narrow field by field and answer a stated outcome; never `as` a payload into a type and read
  it.** Read each field, check that it is the shape you need, and fall to a named result:
  `not-found`, `unreadable`, a 400 that says which field. `packages/core/src/listing.ts`,
  `app/api/resolve-location` and `checkAsk` in `app/api/travel` are what that looks like.

  This used to say "parsed with zod, not asserted". zod is not a dependency of this workspace and
  never has been, so the rule named a library nobody could use and was declined every time a
  reviewer applied it — four times before anybody noticed the rule itself was the problem (#119).
  Adopting it was the other available answer and was not chosen: `listing.ts` decodes an
  index-reference encoding *before* any schema could see an object, the hand-narrowing returns a
  stated outcome where a schema would throw, and `packages/core` is bundled into an MV3 worker where
  a parser is a real cost for restating what the code already does.