# house-hunt — shared house-hunting for Rightmove: a website plus a thin extension

A shared shortlist for people hunting a flat together on Rightmove: travel times to saved places,
one shared verdict per flat per project, and a vision pass over the photos for what the listing
won't say. Multi-tenant, invite-only, email-code sign-in; a **project** is one hunt (up to six
people). In use on real listings.

Two apps in one pnpm workspace: `apps/web` (Next.js — shortlist, compare, map, settings, sign-in,
project/admin) and `apps/extension` (thin Chrome MV3 — the listing panel, search badges, sweep
panel, all only on Rightmove pages). Shared logic in `packages/core` and `packages/ui`. Config is
the workspace-root `.env` (see `.env.example`). **`RESEARCH.md`** is the design document and the
source of truth for *why*; this file is *how it's built and how to check you haven't broken it*.

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
- **Read pages the user opened; never crawl.** Never call Rightmove's search API in the
  background. The sweep only reads pages a human opened; `pnpm find:locations` is a hand-run
  one-off lookup, not precedent. See `RESEARCH.md` §5.
- **Never re-host Rightmove images** — store the URL or nothing (their ToS 13.4).
- **Keep distribution private** — load-unpacked only, never the Chrome Web Store. Access is an
  invite, not a download.
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

## Decisions worth knowing (the ones an agent might otherwise "fix")

- **Invite-only is `enable_signup = false` on the Supabase project**, not a client argument.
  RLS is `to authenticated` everywhere; `anon` holds nothing. Shared fact tables are written
  only through `SECURITY DEFINER` functions; `DELETE` is `service_role` only.
- **The MV3 session lives only in `background.ts`** (chrome.storage adapter, explicit
  `ensureSession()`, alarms heartbeat) — a second client holder silently kills the session.
- **`SEED_HUBS` is for dev tools/checks only** — hubs are project data (`project_hub`), and a
  surface reading the constant puts one project's neighbourhoods on another's flats. A hub with
  no coordinates is skipped, never defaulted.
- **The sweep window snaps up, never down** — a too-narrow window drops listings and looks like
  success. Details in `packages/core/src/sweep.ts`.
- **Driving times deliberately throw** (TfL can't do them) rather than mislabel a transit number.
- **Duplicate listings (⧉) are never merged**; **impossible model answers are dropped, not
  rendered** (`validateAnalysis` — constraints live in code because OpenAI strict mode can't
  express them).

Everything else — verdict history, the spend cap's lock ordering, flag severities, the travel
basis, `DEFAULT_SHOWING`, accepted security gaps — is documented where it lives:
`packages/core/src/facts.ts`, `claim_analysis` in the migrations, `lib/tfl.ts`,
`lib/shortlist.ts`, and `TODO.md`.

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
pnpm check:all      # + every pure-function check (207 assertions, seconds)
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
`pnpm smoke <fixture>`, `smoke:shortlist`, `smoke:search` (the one harness that writes),
`smoke:sweep`. Hard-won harness rules live in `tools/offline.ts` and the harness files: no
harness may reach Rightmove (`OFFLINE_ARGS` kills DNS for the domain), a silent skip is worse
than a failure, and assert what a person could see, not what the markup says.

## Debugging

- "Shows nothing" is usually a session (`signed-out` / `no-project` testids) or the spend cap,
  not a bug. Auth is read once per page — reload after signing in elsewhere.
- **Can't sign in / forgot the password?** There is deliberately no reset email (sign-in stopped
  depending on email, and the dashboard's "Reset password" button sends a recovery link to a Site
  URL that isn't running). The repair is `python3 tools/set-password.py <email>` — it prompts for
  the password twice (so it never reaches the shell history, process list, or a transcript) and
  writes it with bcrypt through pgcrypto, the same scheme GoTrue uses, confirming the account if it
  was left unconfirmed. Reads `SUPABASE_PROJECT_REF`/`SUPABASE_DB_PASSWORD` from `.env`.
- Start with Settings → Diagnostics → **Copy log** — it exists because the other laptop has no
  debugger.
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

`pnpm package` → `rightmove-house-hunt.zip` (gitignored). `SETUP.md` goes with it. The zip is not
the shared secret — access is an invite. The manifest carries a fixed `key` so the extension id
survives moving the folder.

## Related

- `../house-purchase/` — buy-vs-rent analysis; its `AGENTS.md` has the Rightmove
  asking-vs-achieved methodology.
- `registry/tools/rightmove-extension.yaml` — the hub manifest.
