# house-hunt — shared house-hunting for Rightmove: a website plus a thin extension

A shared shortlist for people hunting a flat together: travel times to saved places,
one shared verdict per flat per project, a funnel from shortlisted to archived, and a vision pass
over the photos for what the listing won't say. Multi-tenant, invite-only, email-code sign-in; a **project** is one hunt (up to six
people). In use on real listings.

Two apps in one pnpm workspace: `apps/web` (Next.js — shortlist, compare, map, settings, sign-in,
project/admin) and `apps/extension` (thin Chrome MV3 — the listing panel, search badges, sweep
panel, all only on Rightmove pages). Shared logic in `packages/core` and `packages/ui`. Config is
the workspace-root `.env` (see `.env.example`). **`RESEARCH.md`** is the source of truth for *why*;
this file is *how it's built and how to check you haven't broken it*.

## Running it

```bash
pnpm install
pnpm dev            # extension: Chrome with it loaded, hot-reloads
pnpm dev:web        # website: next dev on http://localhost:3100
pnpm build          # extension -> apps/extension/.output/chrome-mv3 ("Load unpacked")
pnpm build:web      # website: next build
pnpm compile        # typecheck both apps
```

The extension bundles only `WXT_*` vars, the website only `NEXT_PUBLIC_*`; both point at the same
Supabase project. `WXT_WEB_APP_URL` is where the extension sends sign-ins and the origin its
bridge trusts. Nothing runs locally in production: analysis, travel/postcode resolution, invites
and passwords are Supabase Edge Functions (`supabase/functions/`). Deploy: website to Vercel
(`apps/web`), functions via `pnpm sync:function && pnpm deploy:function` (refuses stale copies of
`packages/core/src/{analysis,png}.ts` — keep those Deno-clean: no `node:` imports, no
`import.meta.env`). Second machine: `SETUP.md`.

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
- **Change anything under `apps/extension/` and bump `apps/extension/package.json`'s `version`,
  and `EXPECTED_EXTENSION_VERSION` in `apps/web/src/lib/extension-version.ts` to match.** The two
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
  want the zip now; `pnpm check:zip` says when it is behind, as a note on a pull request and a
  failure anywhere else.
- **Rightmove's own mark may be used on the buttons that go to Rightmove**, and nowhere else. It
  labels an outbound link with the thing it opens, which is what a trademark is for, and it is the
  owner's decision on the owner's product. What stays forbidden is unchanged and is a different
  question: **listing photos and floorplans are never re-hosted.** Those are shown from Rightmove's
  own CDN URLs, which is why `.fixtures/` is gitignored and why every harness answers image
  requests from memory rather than saving them.

## Architecture map

| Piece | Job |
|---|---|
| ext `entrypoints/page-model.content.ts` (MAIN world) | Decodes `window.__PAGE_MODEL`, posts the listing out |
| ext `entrypoints/{panel,search,sweep}.content/` | Listing panel (Shadow DOM), search-card badges, sweep panel |
| ext `entrypoints/bridge.content.ts` | On the website's origin only; relays three messages so the two sessions stay in step |
| ext `entrypoints/background.ts` | All network + the only Supabase client in the extension |
| web `screens/*.tsx` | Shortlist, Compare, Map, Detail, Settings, Sweep, SignIn, Project, Admin |
| `packages/core/` | Facts, hubs, stage (the funnel), sweep, travel, analysis, db, bridge contract |
| `supabase/functions/` | `analyse` (vision, holds the OpenAI key), `travel` (TfL + postcodes, sole writer of the travel cache, and the scheduled `backfill` that drains the gap set), `invite`, `resolve-location`, `password` |

## Decisions an agent might otherwise "fix"

- **Invite-only until there's billing** — every analysis spends an OpenAI API key, so going
  public means charging users first. Enforced as `enable_signup = false` on the Supabase
  project, not a client argument. RLS is `to authenticated` everywhere; `anon` holds nothing.
  Shared fact tables are written only through `SECURITY DEFINER` functions; `DELETE` is
  `service_role` only.
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
- **Driving times deliberately throw** (TfL can't do them) rather than mislabel a transit number.
- **The travel backlog is derived, not enqueued.** Nothing inserts a job when a place is added:
  `travel_gaps` computes what is missing from a project's properties, its places and the modes we
  route, minus what `travel_time` already holds, and `.github/workflows/travel-backfill.yml` has the
  `travel` function work a budget of them every fifteen minutes. A queue written to on place-add is
  a queue that drifts — one failed insert and the gap is invisible for good — while a derived set
  cannot lose work it never stored. Lazy lookup alone never fetched anything for a flat nobody
  opened, which is how adding a place left a column of dashes that filled in only by hand.

**Every other decision is documented as a comment on the code that owns it** (`TRAVEL_BASIS` in
`tfl.ts`, `SWEEP_MARGIN_HOURS` in `sweep.ts`, `DEFAULT_SHOWING` and `duplicateIds` in
`shortlist.ts`, `FLAG_ICON` in `facts.ts`, `claim_analysis` in the migrations) — including new
ones. This file holds only cross-cutting rules and the decisions an agent working elsewhere
could silently violate. Accepted gaps live in `TODO.md`.

## The four facts the design rests on (verified; details in `RESEARCH.md` §2)

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

Pure-function checks (each `pnpm check:<name>`): `area`, `facts`, `filter`, `hubs`, `stage`, `sweep`, `travel`,
`png`, `analysis`, `functions` (deno check — Edge Functions are outside tsc/oxlint),
`one-client`, `bridge`, `withdrawn`. Each pins reasoning invisible when wrong — a bad bearing still
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
`rating`, `funnel`, `table`, `map`, `triage`, `tabs`, `refusals`, `joining`). The setup is not optional — the
fixture, the Edge Functions and a production build of the website happen either way — so a subset
saves the browser work and a few seconds of a forty-second run, which is the difference worth having
while you iterate on one assertion. A name that matches no section stops the run and prints the
list, as `smoke:all` does with harnesses.

`smoke:web` serves the **production** build, not `next dev`: the app ships a CSP with no
`unsafe-eval` and React's dev build needs `eval()`, so under `next dev` the bundle dies on load and
renders nothing. Needing no Rightmove page is what makes it the browser check CI can run.

**Both `smoke` and `smoke:web` serve the Edge Functions themselves** (`tools/edge-functions.ts`,
`functions serve --env-file supabase/.env`), because the runtime `supabase start` brings up has no
environment of its own: without `WEB_APP_ORIGIN` every travel call is refused by CORS and the page
spins forever. `smoke` did not, and passed anyway whenever a server left over from something else
happened to be answering — a green tick that turns red on a clean machine with a message about a
spinner. Its readiness probe is origin-matched for the same reason: Kong answers the CORS preflight
204 by itself with nothing behind it, so "did anything reply" stays green with no backend at all.

**A harness owns the servers it starts, and refuses the ones it did not** (`tools/servers.ts`).
Both are spawned in a process group of their own and stopped as a group: `pnpm exec next start` is
two processes, and signalling the wrapper alone left the website holding 3199 after the harness had
exited, which the next run then asserted against — green, about a build from another branch, and
visible only as a page stuck on "Working…" or a connection refused halfway through. The group means
Ctrl-C no longer reaches them through the terminal, so both harnesses pass the interrupt on. Before
starting, `smoke:web` checks that 3199 is free and stops with the port and a `lsof` line if it is
not, and `startFunctions` says so when another `supabase functions serve` is already running rather
than letting the two take turns holding the container.

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
was a month old. `tools/package-stamp.ts` says why this is a stamp rather than a rebuild — the
bundle bakes in `WXT_*`, so CI's `.env.ci` build could never match a zip built against the real one. `SETUP.md` goes with it. The manifest carries a fixed `key` so the
extension id survives moving the folder.

## Code Review

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
- **Lazy non-typing.** `any` (or a blind `as` cast) where a real type would do — untyped JSON
  from the network or `__PAGE_MODEL` should be parsed with zod, not asserted.