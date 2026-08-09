# Multi-tenant: accounts, projects, invites, RLS and a spend cap

## Why

The extension was built for exactly two people and says so everywhere. There is
no auth: the Supabase publishable key ships in the bundle and *is* the shared
secret, RLS grants the `anon` role full access to every table, and identity is a
name typed into Settings and written onto each verdict. `AGENTS.md` states the
consequence plainly — "anyone holding the key holds the data, so keep this
project to house-hunting and nothing else" — and `SETUP.md` is a set of
instructions for handing the bundle to one other laptop.

That design was right for two laptops and is the wrong shape for anyone else.
Three things it cannot do:

1. **Let a third person in.** Handing over the bundle hands over the whole
   database. There is no way to give someone their own house hunt.
2. **Keep two searches apart.** Every table is a single global namespace, so a
   second couple's flats, places, verdicts and sweeps would land in the same
   shortlist as the first one's.
3. **Bound what a stranger can spend.** The `analyse` Edge Function is deployed
   `--no-verify-jwt` and holds the owner's OpenAI key. It is not an open proxy — it
   only analyses a `property` row that already exists, once, behind an atomic
   claim — but the ceiling on cost is "however many listings anyone inserts",
   and nothing measures it. `cost()` in that function computes a dollar figure
   and writes it to a log line.

This change makes it a real, if small, product: invite-only accounts, projects
that hold a search, project-scoped RLS that survives a rotated key, an admin
view for the owner, and a hard $20/month fair-use cap on that OpenAI key.

It also pays off a debt. The single reason auth was dropped originally was the
MV3 service-worker session trap — a worker has no `localStorage` to persist a
session in and Chrome tears it down when idle. That trap is real but narrow, and
the architecture already avoids the hard part of it: **`background.ts` is the
only file that imports the Supabase client** (everything else imports types),
so exactly one context ever holds a session. Design D2 covers the rest.

## What Changes

- **Accounts, invite-only.** Public signup is disabled at the Supabase project.
  The only way an `auth.users` row comes into existence is an invite issued
  through an Edge Function running with the service role. Sign-in is a 6-digit
  email OTP typed into the shortlist page (`shouldCreateUser: false`), so there
  is no redirect URL, no token handoff and no web app on the critical path.
- **Sessions that survive a torn-down worker.** A custom Supabase storage
  adapter over `chrome.storage.local`, `autoRefreshToken: false`, and an
  explicit `ensureSession()` the background worker calls before every request,
  backed by a `chrome.alarms` heartbeat. See design D2.
- **Projects.** A project holds one house hunt. A user may be a member of
  several and has exactly one `active_project_id`; the extension only ever shows
  the active one. Any member may invite another person — new or existing — to
  their project. An admin may invite someone to the platform, which creates a
  fresh project for them.
- **RLS rewritten around membership, and `anon` loses everything.** Every policy
  becomes `to authenticated` and predicated on project membership. The
  publishable key stops being a secret, which is what makes distribution beyond
  two trusted laptops defensible at all.
- **Facts global, opinions project-scoped.** `property`, `property_analysis`,
  `station_point`, `station_walk` and `travel_time` are shared across projects,
  so two projects looking at the same flat pay OpenAI once. `place`, `verdict`,
  `search_sighting`, `hub_sweep`, hubs and a new `project_property` link are
  project-scoped. Design D4, with the residual read leak and its fix in D14.
- **No client writes a shared fact directly.** The five global tables grant
  `authenticated` **SELECT only**; writes go through validating
  `SECURITY DEFINER` RPCs, and `DELETE` belongs to `service_role` alone. A
  blanket write grant would have included DELETE, putting the 351-leg travel
  cache one client bug away from empty.
- **`travel_time` re-keyed to `(origin_postcode, dest_postcode, mode)`,** off
  `place_id`. A place is project data; a journey between two postcodes is not,
  and keying the cache on a project's row made every project pay again for the
  same journey.
- **A verdict becomes project state, not per-person.** One rating per property
  per project, carrying `set_by` and `updated_at`. This reverses the original
  schema's deliberate choice ("the interesting signal is where the two of you
  disagree") by decision; the existing per-person rows are preserved
  in `verdict_history` and the UI names who set the current one. Design D6.
- **Hubs become project data.** `SWEEP_HUBS`/`HUBS` are five hardcoded London
  neighbourhoods with Rightmove location identifiers looked up by hand; they
  move into `project_hub`, seeded with today's five for the first project. Adding
  one needs a name-to-location-identifier lookup, which becomes a user-initiated
  Edge Function doing exactly what `pnpm find:locations` does today. Design D11.
- **Every OpenAI call is priced and recorded.** An `api_usage` row per request
  with model, tokens, computed `cost_usd`, project and user. Prices live in a
  `model_price` table so a repricing needs no deploy, and `cost_usd` is stored
  rather than recomputed so history stays true.
- **A $20/month cap, per project *and* per user.** Checked before OpenAI is
  called, against the current calendar month in Europe/London, under an advisory
  lock on the **budget** rather than on the listing — claiming a listing does not
  serialise a different listing, which is exactly what a paced sweep does. An
  in-flight call reserves an estimate and reconciles to its actual cost. Over the
  cap, analysis is refused with a structured result the panel renders as an
  explicit state; travel times, verdicts and sweeps keep working. Design D9.
- **The `analyse` function verifies its JWT.** `--no-verify-jwt` is dropped; the
  function resolves the caller, checks project membership, records spend, and
  enforces the cap.
- **An admin tab on the shortlist,** visible only to admins: users, projects,
  pending and accepted invites, and month-to-date spend per user and per
  project, with the ability to raise a cap or revoke an invite.

## Impact

- **Schema**: new `profile`, `project`, `project_member`, `project_property`,
  `project_hub`, `invite`, `api_usage`, `model_price`, `verdict_history`;
  `project_id` added to `place`, `search_sighting`, `hub_sweep`; `verdict`
  re-keyed; `travel_time` re-keyed; every policy in every existing migration
  replaced. This is the largest schema change the project has had.
- **Code**: `lib/identity.ts` is replaced by an auth module; `lib/supabase.ts`
  gains a session and a project context on every query; `background.ts` grows an
  auth gate and new message types; the shortlist gains Sign-in, Project and
  Admin views; `lib/hubs.ts` and `lib/sweep.ts` stop being compile-time
  constants and start reading project data; the `analyse` function gains JWT
  verification, spend recording and cap enforcement.
- **Docs**: `AGENTS.md`'s "No user auth" decision is reversed and the standing
  rule about keeping distribution private is re-argued on the new footing (the
  ToS/no-crawl rules are unchanged and still binding); `SETUP.md` becomes an
  invite flow; `registry/tools/rightmove-extension.yaml` needs a new security
  model, health check and runbook.
- **Existing data** (55 properties, 18 verdicts, 55 analyses, 65 sightings and
  351 cached travel legs) is migrated into one seeded project, with the travel
  cache carried across rather than re-fetched. Verdict authorship is kept as a name
  until both accounts exist, then mapped to user ids in a one-shot follow-up.
- **Not in scope**: the landing page and any public marketing surface; a web
  app; payment or paid tiers; per-project realtime subscriptions; closing the
  cross-project property enumeration leak (D14 — accepted for now, with the fix
  written down); Google Routes driving mode, which remains unimplemented.
