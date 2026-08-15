# TODO — rightmove-extension

## Accepted for the first multi-tenant release

These are known and deliberately not fixed before the first release with users other than the
original pair on it. Each is written down with what it would take to close, so a later pass has
somewhere to start rather than rediscovering the reasoning.

The shape of the whole list: **membership is the real boundary.** Invites are the only way in, the
member cap is six, and an admin can revoke. Everything below is a hole a *member* could reach
through, not a stranger. That is what makes them affordable now and not affordable at a hundred
users.

### A member can enumerate every listing any project has analysed

`property`, `property_analysis`, `station_point`, `station_walk` and `travel_time` are readable by
any authenticated user, because that is what makes a listing analysed once rather than once per
project — the thing that keeps the OpenAI bill down. The cost is that a signed-in member can
select the whole `property` table and see every address every other project has opened.

Opinions do not leak: `verdict`, `place`, `search_sighting`, `hub_sweep` and `project_hub` are all
predicated on membership, so what another project *thinks* stays theirs. What leaks is which flats
they looked at.

**Closing it** means splitting "may I read this cached fact" from "may I list the table" — a
`SECURITY DEFINER` reader taking an explicit list of `rightmove_id`s, with no blanket SELECT
policy behind it. The cache stays shared and the enumeration goes away. It is real work because
every read path (shortlist, panel, sweep classification, the map) would go through it.

Deferred deliberately (design D14).

### A member can write a wrong fact that every other project reads

`record_property` validates the caller's membership and its arguments, and nothing else. No server
can independently check a price read off a listing page, so a member whose client is wrong — or
who is deliberately wrong — writes a value the other projects then see as settled fact.

Not closable in general. What we did instead is make it attributable: `property.written_by_project`
names the last project to write each row. If a value is ever disputed there is a name against it.

### The same listing in two projects: last writer wins the shared row

Two projects that both open a flat share one `property` row, and `record_property` upserts the
whole row. Ordinary and correct — both are reading the same page — with one edge: if one project
opens a stale cached page, its older numbers overwrite the newer ones for everyone. `written_at`
records when, so it is visible after the fact.

The per-project halves are all separate and were checked: `project_property` is keyed
`(project_id, rightmove_id)`, `search_sighting` on `(project_id, rightmove_id, hub)`, `verdict` on
`(project_id, rightmove_id)`, and `hub_sweep` on the project's own hub id. Two projects sweeping a
hub of the same name do not share a window.

### The publishable key still ships in the bundle

It authorises nothing now — every policy is `to authenticated` and `anon` holds no grant — so the
key is no longer the shared secret it was. It is still worth knowing it is readable, because a
future policy written `to public` by accident would hand the database back to anyone with the zip.
`pnpm check:rls` asserts `anon` can reach nothing and is the guard on that.

### The $20 cap is a soft cap, and one call can cross it

Found by an adversarial review, and worth stating precisely because the word "cap" implies more
than is true. `claim_analysis` **reserves a flat estimate** (`ESTIMATE_USD`, $0.10) before the call
and records what it actually cost afterwards. So the cap is checked against an estimate, not
against the bill.

Concurrency is genuinely handled: the advisory locks on project then user mean N simultaneous
requests cannot each read the same under-cap total and all proceed. What is not handled is one
call being much dearer than the estimate. A member with $0.05 of headroom can open a listing with
forty photographs and take the project past $20 in a single request.

Two of the three ways that could run away are now closed — `MAX_IMAGES` (40) bounds the input and
`MAX_OUTPUT_TOKENS` (4000) bounds the dearer output side, which previously had no ceiling at all.
The remaining gap is that nothing bounds the *bytes or dimensions* of a downloaded image, and the
reservation is a flat figure rather than a computed worst case.

Closing it properly means computing a conservative per-call maximum from the image count and size
and reserving *that*, refusing the call unless the whole worst case fits. The cost is that a nearly
exhausted budget would refuse calls it could in fact afford. For six invited people on one person's
key, overshooting by a few dollars in the worst month is the cheaper error.

It also does not stop a member burning their own $20 on flats nobody cares about. At six invited
people that is a conversation, not a control.

### Admin is an email in a table

`admin_email` holds one row. Anyone who can write that table is an admin, and the RPCs that raise
a project's cap or its member limit check `is_admin()` and nothing further — no second factor, no
audit of who raised what. Fine for one admin who is also the person paying the bill.

### Switching house hunts on one laptop leaves another laptop stale

The worker caches the active project id per user and clears it on sign-out or when the project is
switched *on that machine*. Switch on laptop B and laptop A keeps reading the old hunt until its
service worker is torn down, which in MV3 happens on its own soon enough but not predictably.

Not a boundary problem — both projects are the user's own, and RLS would refuse anything that
wasn't. It shows up as a shortlist that is a hunt behind. A `chrome.storage.onChanged` listener,
or simply not caching, would close it; the cache exists to keep a profile read off every query.

### Signing in does not repaint pages that were already open

Auth is read once when a content script loads, so a Rightmove tab open at sign-in keeps showing
the signed-out line until it is reloaded. The copy says to reload. The fix is the same
`chrome.storage.onChanged` listener as above, and it needs a decision about who owns that key.

### The website's shortlist and its fill-in run have no browser smoke

When the app moved to the website (design D5) the extension's own `shortlist.html` was deleted, and
with it went `smoke:shortlist` and `smoke:sweep` — the two Playwright harnesses that had loaded that
page against a local Supabase. They exercised real coverage worth naming: the embedded PostgREST
join behind a shortlist card (property + verdict + analysis in one round trip), RLS on a bulk rate,
and the paced opener itself. The website has the same screens and the same core queries, so nothing
is untested in principle — but there is no harness driving them, because the smokes drive a built
extension and the website is `next dev`. `smoke:search` still asserts the Rightmove sweep panel
points the user at the website's Sweep tab; the fill-in run on the *website* — now the only opener —
is unproven end to end. Closing it means a `next dev` Playwright harness signed in against the
fixture Supabase, plus a stub extension to answer the `open-tab` bridge call so a run can be watched
opening background tabs.

### Two backfill runs on one leg can leave a backoff row against a cached answer

`record_travel_failure` declines to record a failure for a pair `travel_time` already answers, and
the success path clears any backoff unconditionally, so both orderings of "one run succeeds while
another fails" settle correctly. One case survives both. Under READ COMMITTED the guard's `not
exists` cannot see a `cache_travel` insert that has not committed, so a losing run whose statement
snapshot predates the winner's commit passes the guard, and if the winner's `clear_travel_failure`
has already been and gone by the time the loser's insert lands, the backoff row stays.

What it costs is an `attempts` counter one higher than the pair earned. The row suppresses nothing
while the answer beside it exists — `travel_gaps` drops the leg on the cached row before it ever
consults `next_attempt_at` — and nothing in the application deletes a `travel_time` row; only
`tools/fixture-session.ts` and `check:rls` do, to their own fixtures. The window is inside a single
statement, while the winner has to commit its cache write and then make a separate round trip to
clear, so the loser's one statement has to straddle both.

**Closing it** means a transaction-scoped advisory lock on the journey key in `cache_travel` as well
as in `record_travel_failure` — a lock taken on every cached journey, most of which come from the
interactive path rather than the backfill, to protect a counter. Not worth it at this size. Worth
revisiting the day a `travel_time` row becomes something the application itself deletes, because
that is when the leftover row stops being inert.

## Wanted, not yet built

- **Customisable search criteria** (bedrooms, price, property type, radius, Let Agreed) — phase 7
  of the multi-tenant change. The danger is written down there: changing a hub's criteria **must**
  reset its sweep progress, because `last_swept_at` means "we have seen everything this search
  returns up to here" and that sentence is about a specific search.
- **A landing page**, for distribution. Deferred deliberately.
- Promote `inviteState`/`inviteIsLive` out of `Project.tsx` into `src/components/`. `Admin.tsx`
  renders invites too, and one-fact-one-renderer says they should not each decide what "expired"
  means.
