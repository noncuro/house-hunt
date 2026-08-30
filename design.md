# design.md — the numbered decisions the code cites

Code comments cite these as `(design Dn)`. The numbers come from two shipped change
proposals: **multi-tenant** (D1–D15) and **split-web-app** (D1–D8). Both counted from
D1, so each number from D1 to D8 names two decisions; a bare cite is resolved by
subject, and each entry below is tagged with its origin. D9–D15 are multi-tenant only.
The proposals' task lists, phase plans and migration steps are gone with them; what
remains here is what still constrains the code. Where this file and the migrations
disagree, the migrations win.

---

### D1 (multi-tenant) — No redirect in sign-in, and every refusal is a named state

Sign-in never lands on a URL: `detectSessionInUrl: false` everywhere, no magic-link flow,
no hosted handoff page. Each sign-in refusal (wrong credentials, rate-limited, not
invited) is its own rendered state, because "something went wrong" gets the same button
pressed again.

The original decision was an emailed one-time code (OTP) rather than magic links. The
OTP itself is **superseded**: Supabase's built-in sender stops at roughly two emails an
hour per project, and normal use met that limit. Sign-in is now a password plus an
invite code handed over out of band
(`supabase/migrations/20260809320000_password_auth.sql`). The no-redirect and
named-states halves survive and are what the cites point at.

**Still true because** `apps/extension/src/lib/auth.ts:78-80`,
`packages/core/src/db/session.ts:42-50`.

### D1 (split-web-app) — One repo, a pnpm workspace, four packages

`AGENTS.md` states the layout (two apps, `packages/core`, `packages/ui`, shared
`supabase/`). The import boundaries it implies are enforced under D8 (split-web-app).

### D2 (multi-tenant) — Sessions survive a torn-down MV3 worker

The extension's session lives in a custom storage adapter over `chrome.storage.local`
with `autoRefreshToken: false`: the built-in refresher hangs off timers and visibility
events a suspended worker does not have. `ensureSession()` refreshes explicitly when the
token expires within `REFRESH_MARGIN_SECONDS` (5 minutes), and a `chrome.alarms`
heartbeat refreshes unprompted so an install left alone for a week does not come back
signed out. One client per process; `AGENTS.md` states the rule. Two holders of one
rotating refresh token eventually race, and the loser is signed out silently. Signed-out
is a rendered state, never a blank.

**Still true because** `apps/extension/src/lib/auth.ts` (adapter,
`REFRESH_MARGIN_SECONDS`), `apps/extension/src/entrypoints/background.ts:110-112`,
`tools/check-one-client.ts`.

### D2 (split-web-app) — Core constructs no client; each app calls `configure()` once

`packages/core` cannot know where it is running. A service worker needs the
`chrome.storage` adapter and explicit refresh; a tab is served by the supabase-js
defaults. So a client built in core would be wrong in one place, quietly — a session
persisted where it will not be found again looks exactly like being signed out. Each
app constructs one client and hands it over at start-up; `configure()` throws on a
second, different client.

**Still true because** `packages/core/src/db/client.ts:1-52`.

### D3 (multi-tenant) — `anon` holds nothing; the publishable key authorises nothing

`AGENTS.md` states it: row-level security (RLS) is `to authenticated` everywhere, and
`anon` holds nothing. The security boundary is a session obtained through an invite,
which is what makes distributing the bundle defensible at all.

### D3 (split-web-app) — One sign-in, on the website; the extension signs *itself* in

The two surfaces hold two independent Supabase sessions on purpose, because a shared
session would eventually sign one surface out. Supabase rotates the refresh token on
every use, and the tokens descended from one sign-in form a family: present a spent
token and the whole family is revoked. So two holders of one token diverge the first
time either refreshes. The loser is signed out days later, with nothing on screen
explaining why.

The extension therefore never receives a session. It has a bridge — a content script on
the website's origin that relays a few messages between the page and the extension. The
website's sign-in form posts the email and password across it, once; the background
worker then performs an ordinary sign-in of its own. The credentials are held in a local
variable and never stored. Someone who installs the extension after signing in on the
website is asked for the password once more ("connect the extension",
`apps/web/src/screens/Extension.tsx`).

Two requirements follow:

- **The website loads no third-party scripts.** The credentials cross a
  `window.postMessage` on the website's origin, readable by any script running there. The
  CSP (`script-src 'self'`) in `apps/web/next.config.ts` is load-bearing, not hygiene —
  no analytics, no widget, no CDN-hosted library, ever, or the handoff must first be
  replaced with a server-minted second session.
- **The bridge stays minimal and is addressed by origin, never by extension id.** It
  carries four messages: `hello`, `sign-in`, `sign-out`, `open-tab`. The proposal
  shipped with three; `open-tab` was added for the paced fill-in run, and `hello` grew
  the version field the update check depends on. Nothing about a flat, a verdict or a
  project crosses it; both surfaces read the database directly. The unpacked and store
  builds have different ids, so a bridge keyed on an id would work with one install and
  silently not the other.

**Still true because** `packages/core/src/bridge.ts:1-46`, `apps/web/next.config.ts:35-45`,
`apps/extension/src/entrypoints/bridge.content.ts:10`.

### D4 (multi-tenant) — Facts global, opinions project-scoped

A fact about a listing (`property`, `property_analysis`, `station_point`,
`station_walk`, `travel_time`) is shared across projects, so two hunts opening the same
flat pay OpenAI and TfL once. An opinion (`place`, `verdict`, `search_sighting`,
`hub_sweep`, `project_hub`, `project_property`, and everything added since) is project
data. The write rules are in `AGENTS.md`: shared fact tables are written only through
validating `SECURITY DEFINER` RPCs, and `DELETE` is `service_role` only. A blanket
write grant would include DELETE, putting the shared caches one client bug away from
empty. `record_property` checks membership and records `written_by_project`, so a
client writes facts only about listings its own project opened, attributably.

Two corollary rules run through the data layer. **Every project-scoped query names the
active project** — relying on RLS to scope a query reads as a bug, and becomes one the
day a table lacks a policy. And **no client writes a shared fact table directly**.

Accepted residual: a member can write a wrong fact about a listing their own project
opened, and other projects later read it. No server can verify a price read off a page,
so this is irreducible without dropping the shared cache. Membership is invite-only,
capped, revocable.

**Still true because** `packages/core/src/db/supabase.ts:9-17`,
`supabase/migrations/20260809310000_multi_tenant.sql:1029-1049`.

### D4 (split-web-app) — Travel, stations and postcodes resolve server-side

The `travel` Edge Function is the only writer of the travel and station caches; the three
cache RPCs are revoked from `authenticated`. The client could only ever be trusted for
plausibility, not truth: the truth is whatever TfL said, and only whoever asked TfL
knows it. A wrong number in a global cache pollutes every project at once. The TfL key
lives server-side, and calls are attributable and rate-limitable per user. Every
journey is measured on the same basis — a pinned weekday-09:00 departure — enforced in
one place: `journeyTime` pins it itself, so the basis is a property of the system, not
of whoever asked.

**Still true because** `supabase/functions/travel/index.ts:318-322`,
`supabase/migrations/20260810010000_travel_writes_server_side.sql`, and `AGENTS.md`'s
architecture table ("sole writer of the travel cache").

### D5 (multi-tenant) — `travel_time` keys on two postcodes

`travel_time (origin_postcode, dest_postcode, mode)`, not `place_id`. A place belongs to
a project; a journey between two postcodes is a fact (D4), so keying the cache on a
project's row made every project pay again for the same journey and hold rows that could
disagree. The `basis` a journey was measured on travels with the row.

**Still true because** `packages/core/src/db/travel.ts:254`,
`supabase/migrations/20260815160000_travel_backfill.sql:80`.

### D5 (split-web-app) — The app is the website; the extension has no pages

Clicking the toolbar icon opens `WXT_WEB_APP_URL`. No popup, no extension page, no
`web_accessible_resources` — the extension is the panel on Rightmove and nothing else,
and the app has an address someone can be sent.

**Still true because** `apps/extension/src/entrypoints/background.ts:114-121`,
`apps/extension/wxt.config.ts:78`.

### D6 (multi-tenant) — One shared verdict per property per project

`verdict` keys on `(project_id, rightmove_id)`, reversing the original per-person
schema — `product.md`: people hunting a flat together agree, and disagreement between
members is not the interesting signal. Two things keep last-write-wins honest.
`verdict_history` keeps every prior row, so reverting is a query rather than
archaeology. And the current rating names who set it and when — a shared rating whose
author is invisible turns a disagreement into a silent overwrite.

**Still true because** `packages/ui/src/ratings.ts:4-60`,
`packages/core/src/db/supabase.ts:440`.

### D6 (split-web-app) — The message surface is what a content script needs

`background.ts` handles only what a script on a Rightmove page cannot do for itself —
auth state, recording, analysis, verdicts, places/hubs, travel, the sweep, `tab:open`.
The website calls `packages/core` directly; message handlers that existed only because
the old shortlist page could not reach the database were deleted, not ported. The DTOs
outlived the transport and live in `packages/core/src/contracts.ts`.

**Still true because** `packages/core/src/contracts.ts:1-11`.

### D7 (multi-tenant) — Invite-only, enforced by there being no signup path

`AGENTS.md` states the enforcement: `enable_signup = false` on the Supabase project, not
a client argument. The gates are written out by hand in the service-role `invite`
function. An admin may invite any address, to any project or to the platform
(`project_id` null; first sign-in then creates a project of their own). A member may
invite only to their own active project. `max_members` (6, admin-raisable) counts
members **plus pending, non-expired invites** — otherwise six outstanding invites all
land and the project holds twelve. `create_invite` counts and inserts in one
transaction under an advisory lock on the project, so the ceiling is the database's
invariant. Being full is a stated state, not an error. Invites expire after 14 days;
membership is created on first successful sign-in, never at invite time, so an unused
invite leaves nothing behind.

The account-creation moment moved with the password change (D1): the invite mints a code
(only its hash is stored) and the `password` function creates the account when the
invitee chooses a password against that code.

**Still true because** `supabase/functions/invite/index.ts:1-36`,
`supabase/migrations/20260809310000_multi_tenant.sql:614,640-650`.

### D7 (split-web-app) — The web app is client-rendered

Data is read by `supabase-js` in the browser under RLS — the same trust model as the
extension, so the data layer is shared without a security rethink. No server components
reading Supabase, no `@supabase/ssr`, no cookie sessions: that would be a second trust
model for loading behaviour nobody needs on a private six-person tool. The route-handler
surface is empty because the secrets live in Edge Functions; a route handler added for
convenience rather than for a secret is the wrong door.

**Still true because** `apps/web/src/app/` contains no route handlers and `apps/web`
imports no `@supabase/ssr`.

### D8 (multi-tenant) — `is_admin()` / `is_member()` are `SECURITY DEFINER`, or RLS recurses

Both helpers read tables that policies call them *from* (`profile`,
`project_member`), so as ordinary functions Postgres re-enters the policy to answer them
and fails with infinite recursion — an error that points nowhere near the cause. They
are `SECURITY DEFINER` with a pinned `search_path` (which is itself load-bearing: a
definer function with a mutable path can be hijacked through a schema).

**Still true because** `supabase/migrations/20260809310000_multi_tenant.sql:87-147`.

### D8 (split-web-app) — The boundaries are checked, not trusted

`tools/check-one-client.ts` asserts four invariants that all fail silently if only
written down: exactly one file per app constructs a Supabase client
(`apps/extension/src/lib/auth.ts`, `apps/web/src/lib/client.ts`); `packages/core`
constructs nothing; `packages/ui` never imports the data layer (a component takes data
as props, or every content-script bundle pulls in `@supabase/supabase-js` for a rating
colour); and the two apps do not import each other.

**Still true because** `tools/check-one-client.ts:1-40`.

### D9 — Spend accounting and the $20/month cap

One `api_usage` row per OpenAI call, written by the Edge Function in the same step as
the analysis. A failed call that produced tokens still records spend: the `catch` path
records usage before releasing the claim. Prices live in `model_price`; `cost_usd` is
**stored, never recomputed**, so a repricing cannot retroactively change what last
month's cap counted. Caps are $20 per calendar month per project *and* per user, both
overridable, month boundary Europe/London.

Enforcement locks the **budget, not the listing**. `claim_analysis` takes
`pg_advisory_xact_lock` on the project, then on the user, then counts this month's
spend plus reservations before claiming. The lock order is fixed — project before
user — or two callers hold one lock each and deadlock. Serialising on the listing was
the first draft's bug: requests for *different* listings never contend, so a paced
sweep near the cap had five transactions each read the same under-cap total and all
proceed. `tools/check-spend.ts` pins this case. A reservation is a `running`
`property_analysis` claim attributed to a project and user, costed at an estimate and
reconciled to the actual. Overshoot is bounded by the amount one completed call exceeds
the estimate, and concurrency does not widen it. An unknown budget is refused, not
treated as unlimited. `capped` is a structured result the panel renders as a state —
everything that costs no money keeps working.

**Still true because** `supabase/migrations/20260809310000_multi_tenant.sql:765-887`,
`supabase/functions/analyse/index.ts:54,111`, `packages/ui/src/Spend.tsx:5`.

### D10 — Edge Functions verify their caller from the JWT

The bearer token is the user's access token; the publishable key identifies the project
and authorises nothing. `requireCaller` resolves the user, their active project and
its membership. It, not platform JWT verification, is what gates these functions.
`analyse` additionally checks the project has claimed the property
(`project_property`), so it cannot be driven to analyse arbitrary listing ids. Then it
checks caps, claims, calls OpenAI, records usage. Functions keep a service-role client
for writes because the tables they write are deliberately not client-writable (D4); the
JWT is identity, not write authority.

**Still true because** `supabase/functions/_shared/caller.ts:7`,
`supabase/functions/_shared/http.ts:48`, `supabase/functions/analyse/index.ts:22-32`.

### D11 — Hubs are project data

A hub is a neighbourhood the hunt cares about. `project_hub` replaced the compile-time
hub lists, and one table answers both old questions: a row with no
`rightmove_location_id` is only "what can a listing be near"; a row with one is also
"what do we sweep". A new project starts with no hubs — honest, against a
first run naming Hampstead at someone searching Manchester. `AGENTS.md` carries the
corollary: `SEED_HUBS` is for dev tools only, and a hub with no coordinates is skipped,
never defaulted (see also D15).

Adding a hub resolves a name to a Rightmove location identifier through the
`resolve-location` function, which stays inside the standing no-crawl rule: **one**
request, initiated by a person adding **one** hub, never in the background, never
enumerating, rate-limited per user — restated at the call site because it is the kind of
thing that looks like precedent later.

**Still true because** `supabase/functions/resolve-location/index.ts:13`,
`packages/core/src/hubs.ts:9,97,182`.

### D13 — Signed-out and no-project are rendered states, resolved before anything else

On a listing, the signed-out panel is a single sign-in line linking to the website — no
extraction, no recording, nothing that looks like a broken panel. Search badges and the
sweep panel are absent entirely when signed out or with no project chosen: a dimmed card
implies a verdict, and a verdict implies a project. Signed-in-with-no-project renders
the project picker; the state is reachable mid-invite-consumption, while
`caller.project` is briefly null. The website resolves the auth state above everything,
because a shortlist with no project is not an empty shortlist — each state has its own
testid.

**Still true because** `apps/extension/src/entrypoints/panel.content/index.tsx:23,143`,
`supabase/functions/_shared/caller.ts:22`, `apps/web/src/app/page.tsx:70`,
`apps/web/src/screens/Project.tsx:60,661`.

### D14 — Deferred: any signed-in user can enumerate the shared fact tables

`property` and `property_analysis` are readable by any authenticated user, so a member
of any project can enumerate every listing anyone has analysed. Accepted deliberately:
the data is public Rightmove content with no opinion attached — the leak is "which flats
have been looked at, by someone". The written-down fix, if it is ever needed: gate
`SELECT` on a `project_property` row for one of the caller's projects, inserted
server-side on first sighting; the Edge Function keeps the service role, so
cache-before-spend and pay-once-per-listing are unaffected. The write half was closed
before shipping and lives in D4.

**Still true because** `supabase/migrations/20260809310000_multi_tenant.sql:1029-1036`
(the deferral is stated where the policy is created).

### D15 — As built: where the schema departed from the proposal

The migrations are the contract. The departures that still constrain changes:

- **`record_property` upserts the property and its `project_property` link in one
  transaction.** The proposed two-step (link first, then record) was unimplementable —
  the link has a foreign key to the property, so recording any listing the migration had
  not backfilled failed in one order and was refused in the other. What protects the
  shared tables is the validating `SECURITY DEFINER` function with its membership check
  and the absence of any client DELETE path, plus `written_by_project` attribution.
  `set_property_point` has the same membership-and-link gate.
- **Caps move only through admin RPCs** (`admin_set_user_cap`, `admin_set_project_cap`,
  `admin_set_max_members`). RLS gates rows, not columns, so no policy can let a member
  update their project while leaving `monthly_cap_usd` alone.
- **Admin is seeded by email, in the `admin_email` table**, read by the sign-up trigger —
  a `profile` row cannot exist before its `auth.users` row. Every address in that table
  is another way to become admin; keep it to people, not hedges.
- **`project_hub.lat`/`lon` are nullable** to keep the sweep history of hubs that were
  dropped. Anything computing a bearing must skip a hub with no point rather than
  default one — a hub in the wrong place silently corrupts every bearing on the page.
- Two classes of mistake the RLS test caught. **Postgres grants EXECUTE on new
  functions to `public` by default**, and `revoke ... from public` does not undo an
  existing grant — revoke by name. And **a column grant cannot constrain a column's
  value**: a user could set `active_project_id` to a project they are not in, and
  stopping that takes a trigger.

**Still true because** `supabase/migrations/20260809310000_multi_tenant.sql:1301-1523`,
`apps/web/src/screens/Admin.tsx:245`, `packages/core/src/hubs.ts:97`.
