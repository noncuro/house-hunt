# What the smoke tests cover, and what they do not

An honest map. The point of writing it down is the second column: a screen nothing has ever opened
is the one that breaks quietly, and "we have smoke tests" is the sentence that stops anybody
checking which.

Timings are a warm run on a laptop, measured with `pnpm smoke:all`, and exclude `supabase start`
(about a minute, once).

| Harness | Time | Drives |
|---|---|---|
| `pnpm check:all` | 8s | Every pure function. No database, no browser. |
| `pnpm smoke:search` | 3.5s | The extension on a saved search page. |
| `pnpm smoke` | 5.3s | The extension's panel on a saved listing page. |
| `pnpm smoke:web` | ~31s | The website, end to end, including joining. |
| `pnpm check:rls` | ~25s | 180 assertions on the security boundary. |
| `pnpm check:spend` | ~15s | 53 assertions on the cap arithmetic. |

`pnpm smoke:all` runs the three browser harnesses cheapest-first and **stops at the first failure**
— there is no point building the website to discover the extension never loaded. It takes names to
run a subset (`pnpm smoke:all web search`) and prints per-harness timings either way. Within a
single harness the opposite rule holds: each one collects every problem and reports them together,
because three findings from one run beat three runs.

## Covered

**The listing panel** (`smoke`) — the decode of a real `__PAGE_MODEL`, the panel rendering under
Rightmove's own page, nearest stations, travel times against saved places, the verdict buttons, the
photo gallery painting *over* the site (asserted with `elementFromPoint`, because the markup cannot
tell you), and `record_property` actually writing the link — read back from the database, not
inferred from a panel that looked right.

**Search and sweeping** (`smoke:search`) — every card found and badged, the recorded count matching
what is on the page, the stale-page detection, the hide toggle, and the per-hub sweep state. The
one harness that writes.

**The website** (`smoke:web`) — the shortlist's embedded read (the three-table join most likely to
be quietly wrong), the default showing rules, verdict attribution, the compare table, the map
*including its tiles*, triage in both layouts, the bulk-rate buttons being dead until something is
ticked, and the Settings / Your Hunt / Sweep / Install tabs each rendering their own content.

**Joining** (`smoke:web`) — an invite is minted through the real `invite` function, the code is
typed into the real sign-in screen with a chosen password, and the account that comes out is signed
in *and in the project*. Four things in a row that each look fine alone: `create_invite` hashes,
`redeem_code` checks the code against the address, the `password` function makes the account (the
only unauthenticated endpoint in the system), and `consume_invites()` turns the invite into a
membership. A break anywhere leaves an invited person holding an account in no project.

**The boundary** (`check:rls`, `check:spend`) — asserted from outside by real clients holding real
JWTs, including that `signUp()` is refused outright, which every `to authenticated` policy is
predicated on.

## Not covered

Roughly in the order the risk deserves.

| Gap | Why it matters |
|---|---|
| **Every write except joining.** Rating a flat, adding a place, adding a hub, marking off-market, renaming a project — all are asserted up to the button and no further. | These are the actions. The reads are well covered precisely because they are easy to assert; a verdict that renders but does not persist would pass everything here. The fixture project is disposable, so the reason not to is now habit rather than safety. |
| **The Admin tab.** | Never opened by anything. It is admin-only, so the fixture would need an admin — one row in `admin_email`. Users, projects, invites and spend all render there against real queries. |
| **The extension↔website bridge.** `check:bridge` covers the contract as a pure function; nothing drives the actual handover. | It is how signing in on the website signs the extension in. It fails silently by design (`handOver` swallows), so a break shows up as "the extension is signed out" days later. |
| **The paced opener** (Sweep's fill-in run). | It was covered by `smoke:sweep` before the split, and that harness was deleted rather than ported. It opens tabs one at a time; the old harness stubbed its worklist so the pacing assertion could not silently skip. |
| **The Detail view** and the flat-by-URL deep link (`#card-<id>`). | The reason the app moved off `chrome-extension://` at all. |
| **Sign-in refusals.** Wrong password, wrong code, expired code, already-registered, rate-limited. | Every one is its own sentence on purpose — that is the design note at the top of `SignIn.tsx` — and nothing checks that the right sentence appears. `check:rls` covers the server's refusals; this is the screen's. |
| **`analyse`.** No harness analyses anything. | It costs money per run, which is a real reason. The cap arithmetic around it is covered by `check:spend`. |
| **Driving times**, which deliberately throw. | Cheap to pin; nothing does. |
| **`check:predict` is skipping.** | It needs `.fixtures/predict-*.json`, which is committable by design (`.gitignore` un-ignores it) and has never been generated. It says "this proves nothing; it only declines to fail" — but it is still a green tick in `check:all` for a check that did not run. Generate one with `tools/export-predict-fixture.ts`. |

## What to build next

1. **`check:predict`'s fixture.** The cheapest by far — one command, and it turns an existing green
   tick from a lie into a check.
2. **One write per surface**, driven through the UI and read back from the database, the way
   `smoke` already does for `record_property`. Rating a flat from the shortlist is the obvious
   first: it is the product's central action and it is the one write with a history table behind
   it.
3. **An admin fixture**, which is one row and unlocks the whole Admin tab.
4. **The refusal sentences on the sign-in screen.** The invite fixture already mints codes, so a
   wrong-code and an already-registered case are a few lines each on top of what joining does.
