# house-hunt — shared house-hunting for Rightmove: a website plus a thin extension

A shared shortlist for people hunting a flat together: travel times to saved places,
one shared verdict per flat per project, and a vision pass over the photos for what the listing
won't say. Multi-tenant, invite-only, email-code sign-in; a **project** is one hunt (up to six
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

## Architecture map

| Piece | Job |
|---|---|
| ext `entrypoints/page-model.content.ts` (MAIN world) | Decodes `window.__PAGE_MODEL`, posts the listing out |
| ext `entrypoints/{panel,search,sweep}.content/` | Listing panel (Shadow DOM), search-card badges, sweep panel |
| ext `entrypoints/bridge.content.ts` | On the website's origin only; relays three messages so the two sessions stay in step |
| ext `entrypoints/background.ts` | All network + the only Supabase client in the extension |
| web `screens/*.tsx` | Shortlist, Compare, Map, Detail, Settings, Sweep, SignIn, Project, Admin |
| `packages/core/` | Facts, hubs, sweep, travel, analysis, db, bridge contract |
| `supabase/functions/` | `analyse` (vision, holds the OpenAI key), `travel` (TfL + postcodes, sole writer of the travel cache), `invite`, `resolve-location`, `password` |

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
- **Driving times deliberately throw** (TfL can't do them) rather than mislabel a transit number.

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

Pure-function checks (each `pnpm check:<name>`): `area`, `facts`, `hubs`, `sweep`, `travel`,
`png`, `analysis`, `functions` (deno check — Edge Functions are outside tsc/oxlint),
`one-client`, `bridge`. Each pins reasoning invisible when wrong — a bad bearing still looks
like a bearing.

Needing a local Supabase (`supabase start`, ports 5434x; not in `check:all`): `pnpm check:rls`
(the security boundary asserted by real JWTs) and `pnpm check:spend` (concurrent cap claims for
*different* listings — the case that defeated the earlier design). Known trap: local PostgREST
12.0.1 intermittently dies mid-request; the `rpc()` helper retries.

Fixtures (real page shapes — run after a Rightmove deploy):

```bash
pnpm fixture <id>              && pnpm check:extractor .fixtures/<id>.html
pnpm fixture:search <hub>      && pnpm check:sweep .fixtures/search-<hub>.html
```

Browser smoke (Playwright loads the built extension; screenshots in `.fixtures/shots/`):
`pnpm smoke <fixture>` (the listing panel) and `smoke:search` (the search badges and sweep panel —
the one harness that writes). The website's own shortlist and fill-in run have no browser smoke
since the app moved off the extension — see `TODO.md`. Harness rules live in `tools/offline.ts` and
the harness files; the cross-cutting one: no harness may reach Rightmove (`OFFLINE_ARGS` kills DNS
for the domain).

## Debugging

- "Shows nothing" is usually a session (`signed-out` / `no-project` testids) or the spend cap. Auth is read once per page — reload after signing in elsewhere.
- **Can't sign in / forgot the password?** `python3 tools/set-password.py <email>` — its
  docstring explains why there is no reset email.
- The first stop is Settings → Diagnostics → **Copy log**.
- The network lives in the background worker: `chrome://extensions` → Inspect service worker.
  The panel is in a Shadow DOM — go through `.shadowRoot`.
- Read the database directly when a view disagrees with reality:
  `PGPASSWORD="$SUPABASE_DB_PASSWORD" psql -h aws-1-eu-west-1.pooler.supabase.com -p 5432 -U "postgres.$SUPABASE_PROJECT_REF" -d postgres`
  (source `.env` first). Migrations are applied with `psql -f` and committed either way.
- Admin identity and the first project's name are deployment data, not schema: copy
  `supabase/seed.example.sql` to the untracked `supabase/seed.sql`.
- Extraction broke after a Rightmove deploy? `pnpm check:extractor`, then
  `tools/decode_page_model.py`.
- Config problems look like data problems: only prefixed vars are bundled. Verify:
  `grep -c "$(grep WXT_SUPABASE_URL .env | cut -d/ -f3)" apps/extension/.output/chrome-mv3/background.js` → 1.
- A stale copy in Chrome is the most common "bug": reload the extension *and* the tab, and check
  for a second older copy (only id `jkcidomcogoaociobhbjankcpjgnhlji` carries the pinned key).

## Packaging

`pnpm package` → `rightmove-house-hunt.zip` (gitignored). `SETUP.md` goes with it. The manifest
carries a fixed `key` so the extension id survives moving the folder.

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