# Tasks

Ordered so the database is correct before anything reads it, and so the existing
install keeps working until the cutover in phase 8. The extension is
load-unpacked on two laptops, so "deploy" means rebuild and reload — there is no
staged rollout to hide behind, which is why the migrations are written to be
runnable against the live project in one pass.

## 1. Schema and RLS

- [x] 1.1 `profile` (id -> auth.users, email, display_name, is_admin,
      active_project_id, monthly_cap_usd, created_at, last_seen_at) plus the
      `on auth.users insert` trigger that creates it.
- [x] 1.2 `project` (id, name, created_by, monthly_cap_usd, max_members,
      created_at) and `project_member` (project_id, user_id, role, joined_at).
- [x] 1.3 `is_admin()` and `is_member(uuid)` as `SECURITY DEFINER` with a pinned
      `search_path`. Test them from inside a policy on `profile` — a plain
      function recurses and the error names nothing useful (design D8).
- [x] 1.4 `project_property` (project_id, rightmove_id, first_seen_at,
      last_seen_at) and backfill from today's `property` rows.
- [x] 1.5 `project_hub`, and re-key `hub_sweep` onto it. Seed the original five with
      their existing coordinates and location identifiers verbatim (D11).
- [x] 1.6 Add `project_id` to `place`, `search_sighting`.
- [x] 1.7 `verdict_history`; copy every existing verdict into it; re-key
      `verdict` to `(project_id, rightmove_id)` with `set_by`, `set_by_name`,
      `updated_at`, collapsing to the most recently updated per property (D6).
- [x] 1.8 Re-key `travel_time` to `(origin_postcode, dest_postcode, mode)`,
      joining through `place` and **carrying `basis` across** — dropping
      it silently invalidates the whole cache (D5).
- [x] 1.9 `invite` (id, email, project_id null, invited_by, status, expires_at,
      created_at, accepted_at).
- [x] 1.10 `api_usage` and `model_price`, seeded with the current gpt-5.6-terra
      rates including the cached-input rate.
- [x] 1.11 Replace every policy in every existing migration: `to authenticated`,
      predicated on membership; `anon` granted nothing anywhere. On the five
      global tables the `authenticated` role gets **SELECT only** — no INSERT,
      no UPDATE, and DELETE for `service_role` alone (D4).
- [x] 1.11a The `SECURITY DEFINER` write RPCs the clients call instead:
      `record_property` (writes the property **and** the `project_property` link
      in one transaction, checking `is_member` on the project it writes as — the
      earlier "requires an existing link" wording described a gate that could
      never be satisfied for a listing nobody had opened), `cache_travel`,
      `cache_station_point`,
      `cache_station_walk`. `lib/supabase.ts` already funnels these writes
      through four named functions, so this changes what they call and nothing
      about the shape of the calling code.
- [x] 1.12 Seed the first project with a fixed uuid and attach all
      existing rows (D12).
- [x] 1.13 `tools/check-rls.ts` — the boundary asserted from the outside, and
      the test that matters most in this change. As project A: every
      project-scoped table shows zero rows belonging to project B; every write
      into B's rows is refused; a DELETE against each of the five global tables
      removes nothing; and `record_property` for a listing A has no
      `project_property` link to is refused. Adversarial cases, not happy ones.

## 2. Auth in the extension

- [ ] 2.1 Turn off public signup in the Supabase project; add `{{ .Token }}` to
      the magic-link email template. Without this the email carries no code and
      sign-in is impossible with nothing in any log to say why (D1).
      **This is the only thing that makes the product invite-only.**
      `shouldCreateUser: false` is a request parameter, and anyone holding the
      publishable key can decline to send it — leaving them a real authenticated
      account with everything granted `to authenticated`. `supabase/config.toml`
      now sets `enable_signup = false` on both the auth block and the email
      provider so a local run exercises the boundary we ship; the hosted project
      is a dashboard setting this repo cannot reach. Do it before anyone is
      invited, not after.
- [x] 2.2 `lib/auth.ts`: the `chrome.storage.local` storage adapter,
      `persistSession: true`, `autoRefreshToken: false`, `ensureSession()` with
      a five-minute margin, and the `chrome.alarms` heartbeat (D2).
- [x] 2.3 Delete `lib/identity.ts` and the `identity:get` / `identity:set`
      messages; replace with `auth:state`, `auth:request-code`, `auth:verify`,
      `auth:sign-out`.
- [x] 2.4 Gate every database-touching handler in `background.ts` on
      `ensureSession()`, returning a typed `unauthenticated` envelope rather
      than throwing.
- [x] 2.5 Sign-in view on the shortlist: email, code, wrong-code, rate-limited
      and not-invited as distinct states (D1, D13).
- [x] 2.6 Signed-out states everywhere else: the one-line panel on a listing, no
      badges on search cards, no sweep panel (D13).
- [x] 2.7 Lint rule or check that `lib/supabase.ts`'s runtime export is imported
      only by `background.ts` — the invariant the whole session design rests on.

## 3. Projects in the extension

- [x] 3.1 Every query in `lib/supabase.ts` takes the active project; a project
      context resolved once per session in the worker.
- [x] 3.2 Project view: name, members, leave, switch active project.
- [x] 3.3 Verdict UI carries the author and time; `search.content` renders one
      badge per card instead of one per person (D6).
- [x] 3.4 Hubs read from `project_hub`: `lib/hubs.ts` and `lib/sweep.ts` stop
      being compile-time constants. `hubsWithPlaces` keeps widening with places.
- [x] 3.5 Hub management in Settings, and the `resolve-location` Edge Function —
      rate-limited, user-initiated, one request, with the no-crawl reasoning
      restated at the call site (D11).
- [x] 3.6 The empty-hub state on the sweep view for a new project.

## 4. Invites

- [x] 4.1 `invite` Edge Function: validate the caller (admin, or member of the
      named project), write the row, create the auth user via the Admin API.
      Refuse at `max_members` (6) counting **members plus pending, non-expired
      invites** in the same statement that writes the row, and return a stated
      at-capacity result rather than an error (D7).
- [x] 4.2 Consume the pending invite on first successful sign-in — membership,
      active project, and a fresh project when the invite carried none.
- [x] 4.3 Invite UI on the Project view for members; revoke and resend; the
      at-capacity state, shown before the field is submitted where the count is
      already known.

## 5. Spend

- [x] 5.1 `analyse` verifies its JWT, resolves the caller, checks membership and
      the `project_property` link. Drop `--no-verify-jwt` from
      `deploy:function`; the extension sends the access token as bearer (D10).
- [x] 5.2 `claimed_by_project` / `claimed_by_user` on `property_analysis`, so a
      running claim is an attributable reservation.
- [x] 5.3 Cap check in `claim_analysis`, holding `pg_advisory_xact_lock` on the
      project **then** the user (fixed order, no deadlock), counting spend plus
      in-flight reservations against both caps, reserving `ESTIMATE_USD`, and
      returning `{ status: 'capped', scope, spent, cap, resets_at }`. Locking
      the listing alone does not serialise different listings — that was the
      race in the first draft (D9).
- [x] 5.4 Record `api_usage` on success **and** on failure-with-usage, priced
      from `model_price`, cached input at its own rate; release the reservation
      in the same step.
- [x] 5.5 Panel and shortlist render the capped state and the 80% warning.
- [x] 5.6 `pnpm check:spend`: month boundaries in Europe/London, the cached-input
      rate, the both-caps rule, that a cached analysis charges nobody, and a
      **concurrent test over different listing ids** proving only the affordable
      ones proceed — the race the first draft of D9 missed.

## 6. Admin

- [x] 6.1 Admin policies: `is_admin()` reads across profiles, projects, invites
      and usage.
- [x] 6.2 Admin tab, hidden for non-admins: users, projects, invites, spend this
      month and last, drill into individual charges.
- [x] 6.3 Raise or lower a cap; revoke an invite.

## 7. Search criteria a project can set (last — after everything above works)

Today `lib/sweep.ts` builds one search URL shape: a hub's location identifier plus
`maxDaysSinceAdded`. Everything else Rightmove's own form offers — bedrooms, price
range, property type, radius, whether Let Agreed is included — is fixed at
whatever the code happens to imply. That is fine for one couple looking for the
same kind of flat every time and wrong for anyone else, and it is wrong in the
expensive direction: a sweep that returns studios and six-bed houses fills the
worklist with listings the paced opener then pays a vision model to analyse.

Deliberately last. It is the one part of this change that is not load-bearing for
anyone being able to sign in, and it wants the project plumbing above to exist
before it has somewhere to live.

- [ ] 7.1 `project_hub` (or a `project_search` alongside it — decide when the hub
      table is real rather than now) gains the criteria Rightmove's form exposes:
      `min_bedrooms`, `max_bedrooms`, `min_price`, `max_price`, `property_types`,
      `radius`, `include_let_agreed`. Every one nullable, meaning "no preference",
      so a project that sets nothing sweeps exactly as it does today.
- [ ] 7.2 `buildSearchUrl` in `lib/sweep.ts` takes them and maps them to
      Rightmove's query parameters. Verify each against a real search URL rather
      than guessing the parameter names — a wrong one is silently ignored and the
      sweep quietly widens.
- [ ] 7.3 The criteria are editable next to the hub they belong to, in Settings.
- [ ] 7.4 `check:sweep` pins the built URL for each criterion, the same way it
      already pins the window boundaries. This is where a silently-ignored
      parameter gets caught.
- [ ] 7.5 Changing criteria **must reset the hub's sweep progress**. `last_swept_at`
      says "we have seen everything this search returns up to here", and that
      sentence is about a specific search. Widening the criteria without resetting
      would skip every listing the old, narrower search never returned — the same
      failure the sweep window is carefully built to avoid, arriving by a different
      door.

## 8. Cutover and documentation

> These were numbered 7.1–7.7, colliding with section 7's own 7.1–7.5. Renumbered,
> because "7.3 is done" was ambiguous between a harness run and a search filter.

- [ ] 8.1 Run the migrations against the live project. Verify the existing
      shortlist shows the same properties before and after, and that the travel
      cache did not empty.
- [ ] 8.2 Invite the second person; both sign in; run the one-shot mapping `set_by_name` ->
      `set_by` (D12 step 4).
- [x] 8.3 `pnpm check` plus every existing harness, then `pnpm smoke`,
      `pnpm smoke:search` and `pnpm smoke:sweep` — all three now need a signed-in
      session, so each grows a fixture session rather than being quietly skipped.
- [x] 8.4 Rewrite the "No user auth" decision in `AGENTS.md`; re-argue the
      private-distribution rule on the new footing (the no-crawl and
      no-re-hosting rules are unchanged and stay); document the caps.
- [x] 8.5 `SETUP.md` becomes the invite flow.
- [x] 8.6 Update `registry/tools/rightmove-extension.yaml`: security model,
      health check, runbook (a broken session and a hit cap are now the two most
      likely "it stopped working" reports).
- [x] 8.7 Add the D14 enumeration fix to `TODO.md` as a follow-up change. Done as
      `rightmove-extension/TODO.md`, which also records the other risks this
      release accepts rather than fixes, each with what it would take to close.
