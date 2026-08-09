# Design

The decisions behind the multi-tenant change, and the traps each one avoids.
Read `proposal.md` first for what is changing; this is why.

---

## D1 — Email OTP, not magic links

Sign-in is `signInWithOtp({ email, shouldCreateUser: false })` followed by
`verifyOtp({ email, token, type: 'email' })`, with the 6-digit code typed into
the shortlist page.

A magic link would need somewhere to land. In an extension that means either a
hosted page that hands the session back across a boundary, or a
`chrome-identity`-style redirect flow — a second deploy target and a handoff
step whose failure mode is a silent dead end. OTP has neither: the code goes
from the email into a field in the page that already exists, and the whole
exchange happens inside the extension. It also keeps the landing page genuinely
optional rather than quietly load-bearing.

**Trap.** Supabase's default "Magic Link" email template contains only the link.
`{{ .Token }}` has to be added to the template or the email arrives with no code
in it and sign-in is impossible with nothing in any log to explain why. Changing
the template is a step in `tasks.md`, not an afterthought.

**Rate limiting.** Supabase's default is a handful of OTP emails per hour per
address. The sign-in view must render "you've asked too many times, wait a few
minutes" as its own state rather than a generic failure, because at that point
the correct action is to stop pressing the button.

---

## D2 — Sessions in MV3, and why the trap is narrower than it looked

The original decision to drop auth cited the known trap: a service worker has no
`localStorage`, and Chrome tears the worker down when idle. Both are true. What
makes them survivable here is that the architecture already puts every network
call in one place — `background.ts` is the only file that imports the Supabase
client, and every other file imports types only. So:

- **Storage** is a custom adapter over `chrome.storage.local`. supabase-js v2
  accepts an async `getItem`/`setItem`/`removeItem`, which is exactly
  `chrome.storage.local`'s shape. `persistSession: true`.
- **Refresh** is explicit. `autoRefreshToken: false`, because the built-in
  refresher hangs off timers and visibility events that a torn-down worker does
  not have. Instead `ensureSession()` runs at the top of every message handler
  that touches the database: it reads the session, and if the access token
  expires within a margin (5 minutes) it calls `refreshSession()` and awaits the
  result before proceeding. A `chrome.alarms` heartbeat every 30 minutes does
  the same thing unprompted, so a session that sat idle for a week is refreshed
  before the refresh token itself ages out rather than after.
- **Concurrency** is not a problem *because* only one context holds a client.
  Two contexts refreshing at once with the same refresh token is the classic way
  to invalidate a session; Web Locks would be shared across the extension origin
  and would cover it, but the cleaner guarantee is that the shortlist page and
  the content scripts never construct a client at all. **This is now a rule, not
  an accident** — see the requirement in `specs/accounts/spec.md`. A future
  view that imports `supabase` directly would reintroduce the trap that this
  whole design was originally abandoned over.

**Sign-out and expiry** must be a first-class state, not an error. The worker
returns a typed `unauthenticated` response; the panel on a Rightmove page shows
"sign in to the house hunt extension" and the shortlist shows the sign-in view.
This follows the standing "fail loudly" rule: a panel rendering blanks looks
like a listing with no data.

---

## D3 — `anon` loses everything, and the bundle stops carrying a secret

Every policy becomes `to authenticated` and is predicated on membership. The
`anon` role gets no grants on any table.

This is the load-bearing change. Today the publishable key *is* the credential,
which is why `AGENTS.md` says keep this to house-hunting and keep distribution
private. Afterwards the key identifies the project and authorises nothing, and
the security boundary is a session obtained by proving control of an invited
email address.

Two rules survive unchanged and for unchanged reasons: **never crawl** and
**never re-host Rightmove images**. Those come from Rightmove's terms, not from
the key model, and nothing here touches them. Distribution stays load-unpacked
for now — the Web Store becomes *possible* rather than *advisable*, and that is
a separate decision with its own review surface.

---

## D4 — Facts global, opinions project-scoped

| Global (any signed-in user) | Project-scoped |
|---|---|
| `property` | `place` |
| `property_analysis` | `verdict` (+ `verdict_history`) |
| `station_point` | `search_sighting` |
| `station_walk` | `hub_sweep` |
| `travel_time` | `project_hub`, `project_property`, `invite`, `api_usage` |

The split is "is this a fact about a listing, or an opinion about it". Facts are
expensive and identical for everyone: the vision pass over a listing's photos
costs real money, and a station's coordinates are the same for every user
alive. Opinions are the product.

Two projects looking at the same flat — which will happen constantly, since
London rentals are relisted and cross-posted, and the project already has
`duplicateIds` because *one project* found the same flat twice — pay OpenAI
once. Under full siloing every duplicate is a fresh charge against a $20 cap.

**Writes to global tables are far narrower than reads, and an earlier draft of
this design got that wrong.** It granted every authenticated user blanket write
access to `property`, `station_point`, `station_walk` and `travel_time` on the
grounds that these are derived from a page the user is looking at, and waved at
the risk as "someone could write a wrong price". That understates it twice over:
a blanket `for all` policy includes `DELETE`, so any invited client — or any bug
in one — could empty the 351-leg travel cache or drop shared rows for every
project at once; and it placed no constraint on *which* rows a client may touch,
so one project could rewrite a listing it has never opened.

The rule is therefore: **no client writes a global table directly.** Every write
to a shared fact goes through a `SECURITY DEFINER` RPC that validates it. In RLS
terms, on all five global tables:

- **`DELETE` is granted to nobody but `service_role`.** Nothing in the extension
  has ever needed to delete a shared fact, and a cache that can only be added to
  and corrected cannot be emptied by a client bug.
- **`INSERT` and `UPDATE` are granted to nobody**; the RPCs hold the privilege.
- `property_analysis` stays `service_role` only end to end, written exclusively
  by the Edge Function.

The RPCs are thin and specific — `record_property`, `cache_travel`,
`cache_station_point`, `cache_station_walk` — each validating its arguments and,
for `record_property`, **requiring a `project_property` link for one of the
caller's projects**, so a client can only write facts about listings its own
project has actually opened. That link is created on the same path, from the
listing the user is on.

This is strictly better than the blanket grant and costs little: `lib/supabase.ts`
already funnels these writes through four named functions, so the change is what
those four call, not how the rest of the code is shaped. It also closes the write
half of D14 in advance, leaving only the read-side enumeration deferred.

**What remains accepted.** A member can still write a wrong fact about a listing
their own project opened, and other projects that later open the same listing
will read it. There is no server that could independently verify a price read off
a page, so this is irreducible without dropping the shared cache entirely.
Membership is invite-only, capped at six per project, and revocable.

---

## D5 — `travel_time` re-keyed onto postcodes

Today: `travel_time (postcode, place_id, mode)`. A `place` belongs to a project,
so the cache is inescapably per-project — two projects with an office on the
same street pay TfL twice and, worse, hold two rows that can disagree.

After: `travel_time (origin_postcode, dest_postcode, mode)`. A journey between
two postcodes is a fact, which puts it on the correct side of D4. `place` keeps
its postcode and the lookup resolves through it.

The existing `basis` column and `staleTravel` logic are untouched, which
matters: the design note that a cached transit time carries the basis it was
measured on is unchanged, and the migration must carry `basis` across or
it will silently invalidate the whole cache.

---

## D6 — A verdict becomes project state

By decision, two users on one project share one rating per property.
`verdict` is re-keyed to `(project_id, rightmove_id)` with `rating`, `note`,
`set_by uuid` and `updated_at`.

This reverses an explicit decision in `20260809000000_init.sql`: *"Per-person,
not per-property: the interesting signal is where the two of you disagree, and a
single shared rating destroys that."* The concern is real, so two things blunt
it rather than pretending it away:

- **`verdict_history` keeps every prior row**, including the per-person rows
  that exist today, so the disagreement signal is recoverable and reverting this
  decision later is a query rather than an archaeology exercise.
- **The current rating names who set it and when.** A shared rating whose author
  is invisible turns a disagreement into a silent overwrite — one person marks a
  flat "not our place", the other sees no trace of it having been anything else.
  Rendering "no — Alex, 2h ago" is what keeps last-write-wins honest.

`search.content` currently badges cards with `${emoji} ${person}` per verdict and
must become one badge per card.

---

## D7 — Invite-only, enforced by there being no signup path

Public signup is **disabled at the Supabase project level**. That is the whole
enforcement; everything else is bookkeeping.

- An `invite` row is created by an Edge Function running with the service role,
  which validates the caller first: an admin may invite anyone; a member may
  invite to *their own active project* and nothing else.
- The same function calls the Admin API to create the `auth.users` row for that
  email. So an account exists only if someone with standing asked for it.
- Sign-in is `shouldCreateUser: false`, so an uninvited address requesting a
  code gets nothing — no account is created as a side effect of trying.
- A trigger on `auth.users` insert creates the `profile`. Invite consumption
  happens on **first successful sign-in**, not at invite time, so a pending
  invite that is never used leaves no membership behind.

One `invite` table serves both kinds. `project_id` set means "join this
project"; `project_id` null means an admin is inviting someone to the platform,
and consuming it creates a fresh project for them, which they can name. Invites
carry an `expires_at` (14 days) and a `status` of pending/accepted/revoked.

**Bounding the blast radius.** Any member being able to invite means the user
count can grow without an admin doing anything, and every user is a claim on the
owner's OpenAI key. Two things bound it. The per-user and per-project caps in D9 bound
the money. `project.max_members` — **6**, admin-raisable — bounds the growth, so
a project cannot be turned into a mailing list and the invite graph cannot fan
out indefinitely one member at a time.

**Pending invites count toward the ceiling.** Otherwise six outstanding invites
all land and the project holds twelve people. The count is
`members + pending, non-expired invites`, checked in the same statement that
writes the invite row.

Hitting the ceiling is a **stated state, not a failure**: the interface says the
project is at its limit of six people and what to do about it. A generic error
here just gets the same address typed in again.

---

## D8 — Admin, and the RLS recursion trap

`profile.is_admin boolean`, seeded for the deployment's admin address. Policies
call `public.is_admin()`.

**Trap.** `is_admin()` reads `profile`. If it is an ordinary function called
from a policy *on* `profile`, Postgres re-enters that policy to answer it and
the query fails with infinite recursion. It must be `SECURITY DEFINER` with a
pinned `search_path`, owned by a role that bypasses RLS. Same for
`is_member(project_id)`, which is called from policies on tables that join to
`project_member`. Getting this wrong produces an error message that points
nowhere near the cause, so both helpers ship with a test that exercises them
from inside a policy.

The admin tab lives on the shortlist rather than in a web app: it reuses the
shell, the React Query setup and the single background-worker Supabase client,
and adds no deploy target. It shows users (email, joined, last seen, projects,
MTD spend), projects (members, properties, MTD spend), invites (pending,
accepted, revoke, resend) and lets an admin raise a cap.

---

## D9 — Spend accounting and the $20 cap

**Recording.** One `api_usage` row per OpenAI call: `occurred_at`, `project_id`,
`user_id`, `kind`, `model`, `input_tokens`, `cached_input_tokens`,
`output_tokens`, `cost_usd numeric(10,6)`, `rightmove_id`. Written by the Edge
Function with the service role, in the same step that writes the analysis, so a
successful analysis that was never charged for is not a reachable state.

A failed call still costs money if OpenAI produced tokens before the failure, so
usage is recorded whenever the response carried a usage block — the `catch` path
that releases the claim records spend first.

**Pricing.** A `model_price` table (`model`, the three per-Mtok rates,
`effective_from`) replaces the hardcoded `cost()` in the function. `cost_usd` is
**stored, never recomputed**: a repricing must not retroactively change what
last month's cap counted. Cached input tokens are priced separately because they
are an order of magnitude cheaper and the current `cost()` charges them at full
rate, overstating spend.

**Caps.** `$20` per calendar month, per project and per user, both overridable
(`project.monthly_cap_usd`, `profile.monthly_cap_usd`). The month boundary is
**Europe/London**, matching every other date in this project.

**Enforcement point, and the race an earlier draft of this design had.** Putting
the check "inside the claim transaction" is not on its own sufficient, and the
first version of this document claimed it was. `claim_analysis` serialises on the
*listing*: two requests for the same `rightmove_id` cannot both win. Requests for
*different* listings never contend at all, so a paced sweep opening five
unanalysed flats near the cap has five transactions each reading the same
under-cap total and all proceeding. The budget is shared state and the claim
never touched it.

So the check locks the budget, not the listing:

1. `pg_advisory_xact_lock` on the project, then on the user — **always in that
   order**, so two callers can never hold one lock each and wait on the other.
2. Compute `spent` (this month's `api_usage`) and `reserved` (see below) for both
   scopes.
3. If `spent + reserved + ESTIMATE_USD` exceeds either cap, return `capped` and
   commit nothing.
4. Otherwise claim the listing and commit. The locks release with the
   transaction, so the next caller sees this reservation.

**Reservations are what make the bound real.** The cost of a call is not knowable
before it is made, so the check reserves `ESTIMATE_USD` (default $0.10,
configurable — comfortably above a typical listing) and reconciles to the actual
cost when the usage row is written. A reservation is not a new table: it is a
`property_analysis` row in `status: 'running'` attributed to a project and a
user, which is why `claimed_by_project` and `claimed_by_user` are added to that
table. `reserved` is the count of that project's (or that user's) non-stale
running claims times `ESTIMATE_USD`, and it drains as each call finishes or its
claim goes stale — the existing stale-claim path, unchanged.

**What the bound actually is.** Not "one listing". Overshoot is capped at the
amount by which a single completed call exceeds `ESTIMATE_USD`, which for a
correctly-set estimate is zero, and in the worst case is one unusually expensive
listing. Concurrency no longer widens it, because every concurrent call has
already reserved against the same locked budget. This is worth stating precisely
because the previous phrasing was both wrong and reassuring, which is the worst
combination for a limit on someone else's money.

**Refusal is a state, not an error.** The function returns
`{ status: 'capped', scope: 'project' | 'user', spent, cap, resets_at }` and the
panel renders it as such — "the monthly analysis budget is used up, back on the
1st" — per the fail-loudly rule. A warning appears at 80%. Everything that
doesn't cost money keeps working: travel times (TfL is free), verdicts, sweeps,
extraction, the shortlist.

---

## D10 — The `analyse` function verifies its caller

`--no-verify-jwt` is dropped. The extension sends the user's access token as the
`Authorization` bearer rather than the publishable key, and the function:

1. resolves the caller from the JWT, rejecting an absent or expired one;
2. checks the caller's active project and its membership;
3. checks that the project has claimed this property (`project_property`), so
   the function cannot be driven to analyse arbitrary listing ids;
4. checks the caps;
5. claims, calls OpenAI, records usage, writes the analysis.

The current defence — "it accepts a rightmove_id and nothing else, and only
analyses a property row that already exists" — was adequate for a two-laptop
tool and is not adequate once the key is on other people's machines.

The function keeps its service-role client for writes; the JWT is used for
identity, not for the writes themselves, because `property_analysis` and
`api_usage` are deliberately not client-writable (D4).

---

## D11 — Hubs become project data

`HUBS` and `SWEEP_HUBS` are compile-time constants describing five London
neighbourhoods. `AGENTS.md` is careful that they answer different questions —
`HUBS` is "what can a listing be near", `SWEEP_HUBS` is "what do we go looking
through". One table preserves both:

```
project_hub (id, project_id, name, lat, lon,
             rightmove_location_id text null,   -- null => not searchable
             max_days_since_added int null,
             last_swept_at timestamptz null,
             sort_order int)
```

A row with no location identifier answers the first question only; a row with
one answers both. `hubsWithPlaces` continues to widen the first list with the
project's saved places, unchanged. `hub_sweep` re-keys onto `project_hub.id`.

The original five are seeded into the first project, coordinates and location
identifiers intact — they were verified against TfL's StopPoint API and
reverse-geocoded through postcodes.io, and re-deriving them would risk the
silent corruption of every bearing that `AGENTS.md` warns about.

**Adding a hub** needs two lookups: a postcode or station name to coordinates
(postcodes.io / TfL, both already wired) and a neighbourhood name to a Rightmove
location identifier. The second is what `pnpm find:locations` does by hand
today: fetch one Rightmove SEO path and read the identifier out of it. It
becomes a `resolve-location` Edge Function, and it stays inside the standing
no-crawl rule for the same reasons the existing script does — **one** request,
initiated by a person adding **one** hub, never in the background, never
enumerating. It is rate-limited per user and the reasoning is repeated in a
comment at the call site, because this is precisely the kind of thing that looks
like precedent later.

**A new project starts with no hubs**, which means an empty sweep view. That is
honest — the alternative is a first-run experience naming Hampstead at someone
searching in Manchester.

---

## D12 — Migrating the data that exists

55 properties, 18 verdicts, 55 photo analyses, 65 search sightings and 351
cached travel legs, all currently unowned.

1. Create the first project with a fixed uuid, and the admin's `profile`
   with `is_admin`.
2. Link every existing `property` into it via `project_property`; assign every
   `place`, `search_sighting` and `hub_sweep` to it; seed `project_hub`.
3. Copy every existing `verdict` row into `verdict_history` verbatim, then
   collapse to one row per property — the most recently updated wins — keeping
   the author's name in `set_by_name` and leaving `set_by` null.
4. Once both people have signed in, a one-shot migration maps
   `set_by_name` to `set_by` user ids.

Step 4 is separate because the user ids do not exist when the schema migration
runs, and inventing them would mean creating auth users from a migration.

**`travel_time` needs care.** Its rows key on `place_id`; the migration must
join through `place` to write `dest_postcode` and preserve `basis`, or
every cached journey is silently discarded and re-fetched, which is a cost the
new caps would then count.

---

## D13 — What the extension shows when nobody is signed in

- **Panel on a listing**: a single line, "sign in to the house hunt extension",
  linking to the shortlist. It does not attempt extraction, does not record the
  property, and does not look like a broken panel.
- **Shortlist**: the sign-in view, and nothing else in the shell.
- **Search-page badges and the sweep panel**: absent. A dimmed card implies a
  verdict, and a verdict implies a project.
- **Signed in with no active project** (possible only mid-invite-consumption):
  the project picker.

---

## D14 — Deferred: cross-project enumeration, and how it gets closed

Accepted for now by decision, written down because it is cheap to fix.

Making `property` and `property_analysis` readable by any authenticated user
means a signed-in member of any project can enumerate every listing anyone has
ever analysed. The data is public Rightmove content with no opinion attached, so
the leak is "which flats have been looked at, by someone", not "what anybody
thinks".

The fix keeps every benefit of D4:

- `SELECT` on `property` / `property_analysis` is gated on a `project_property`
  row for one of the caller's projects.
- The Edge Function, holding the service role, still sees every row — so the
  cache-before-spend check is unaffected and duplicate listings still cost
  OpenAI once.
- A project's first sighting of a listing inserts the `project_property` link
  server-side, after which the row is visible. The claim path already exists;
  this is one insert on the same path.

The write half of this is **no longer deferred** — D4 now routes every client
write through a validating `SECURITY DEFINER` RPC and denies client DELETE
outright, after review found the original blanket grant would have let any
client empty a shared cache. What remains here is only the read-side
enumeration.

This is a follow-up change, not a task in this one.

---

## D15 — As built: where the schema departed from this document

The migrations are the contract, not this file. Where the two disagree the
migrations win, and these are the places they disagree — recorded here because
each one was a decision, not an oversight.

- **The travel basis column is `basis`.** This document and the task list both
  called it `travel_basis`; `20260809180000_travel_basis.sql` names the column
  `basis`. Corrected throughout. Had the migration followed the spec it would
  have added a second column and silently invalidated 351 cached legs.
- **`record_property` creates the link it used to demand — and the two-step that
  preceded this was unimplementable.** D4 said the `project_property` link "is
  created on the same path" while the spec scenario required `record_property` to
  *refuse* without one, and reconciling those into two ordered steps produced a
  cycle: `project_property.rightmove_id` has a foreign key to `property`, so
  linking first fails for a listing that does not exist yet and recording first
  is refused for want of the link. Every genuinely new listing was unrecordable;
  it worked only for the 55 rows the migration had backfilled, which is why 133
  RLS checks missed it. `record_property` now upserts the property and the link
  in one transaction, keeping the membership check and the foreign key.

  The gate was worse than useless rather than merely awkward: it made the primary
  case impossible while leaving the case it meant to stop wide open, since any
  member may link a listing and then write about it. What actually protects these
  tables is that every write goes through a validating `SECURITY DEFINER`
  function with a membership check, and that no client has a DELETE path.
  `property.written_by_project` was added in its place — the risk D4 accepts as
  irreducible does not go away, but it stops being anonymous.
- **`set_property_point` exists.** `locateProperties()` wrote `property` directly,
  which SELECT-only now forbids. It has the same link gate as `record_property`.
- **`claim_analysis` returns jsonb and takes five arguments** —
  `(rightmove_id, project_id, user_id, estimate_usd, stale_after)`. The old
  boolean two-argument version is gone, so every caller changes.
- **Caps move only through admin RPCs.** RLS gates rows, not columns, so there is
  no policy that lets a member update their own project while leaving
  `monthly_cap_usd` alone. `admin_set_user_cap`, `admin_set_project_cap` and
  `admin_set_max_members` are the only writable path, and they check `is_admin()`.
- **Admin is seeded by email, in a table.** D8 said "seeded for the admin's
  email", which cannot be a `profile` row because no `auth.users` row exists yet
  at migration time. An `admin_email` table carries the addresses and the sign-up
  trigger reads it. The migration creates the table empty and a deployment seeds
  its own address (`supabase/seed.example.sql`), narrowed to one row: each address
  in that table is another way to become admin, so the reason to add one should be
  a person rather than a hedge.
- **`project_hub.lat` / `lon` are nullable.** King's Cross and Highbury were hubs
  once and were dropped, so live `hub_sweep` rows reference them with no
  coordinates to re-key onto. Deleting those rows would discard real sweep
  history, so the migration keeps a coordinate-less hub to carry it. **Anything
  computing a bearing must skip a hub with no point** rather than defaulting one —
  the same rule `hubsWithPlaces` already applies to places, and a hub in the wrong
  place silently corrupts every bearing on the page.

Two things the RLS test caught that no part of this design had considered, both
now closed, both worth remembering as classes of mistake:

- **Postgres grants EXECUTE on new functions to `anon` by default**, and
  `revoke ... from public` does not remove it. `claim_analysis` was callable by
  anyone holding the bundled key — reserving budget against someone else's cap
  without signing in. Revoked by name, plus a sweep over the schema.
- **A user could set `active_project_id` to a project they are not in.** A column
  grant cannot express that constraint; it needs a trigger.
