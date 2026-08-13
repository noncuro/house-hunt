# What the smoke tests cover, and what they do not

An honest map. The point of writing it down is the second column: a screen nothing has ever opened
is the one that breaks quietly, and "we have smoke tests" is the sentence that stops anybody
checking which.

Timings are a warm run on a laptop, measured with `pnpm smoke:all`, and exclude `supabase start`
(about a minute, once).

| Harness | Time | Drives |
|---|---|---|
| `pnpm check:all` | 8s | Every pure function. No database, no browser. |
| `pnpm smoke:search` | 2.2s | The extension on a saved search page. |
| `pnpm smoke` | 6s, or ~35s cold | The extension's panel on a saved listing page. |
| `pnpm smoke:web` | ~32s | The website, end to end, including joining and the refusals. |
| `pnpm check:rls` | ~25s | 180 assertions on the security boundary. |
| `pnpm check:spend` | ~15s | 53 assertions on the cap arithmetic. |

The spread on `smoke` is the Edge Function runtime: whichever harness starts it first waits about
half a minute for Deno to come up, and the ones after it do not. Nothing is wrong when a single run
of it takes thirty seconds.

`supabase start` is the only thing you have to have running. Both browser harnesses that need the
Edge Functions now serve them themselves (`tools/edge-functions.ts`) and stop them again. `pnpm
smoke` did not, for a while, and passed anyway — because a `supabase functions serve` left over
from something else was answering. That is the worst shape a green tick can have: it goes red the
first time somebody runs it on a clean machine, and it says "panel never left its loading state",
which is a sentence about a spinner for what is really a process nobody started.

The same thing arrives by the other door when a harness leaves a server behind, and `smoke:web` did:
`next start` under `pnpm` survived the kill and kept 3199, so the run after it quietly asserted
against the previous build. The servers are stopped as a process group now, and `smoke:web` refuses
to start at all when something already holds the port — see `tools/servers.ts`.

`pnpm smoke:all` runs the three browser harnesses cheapest-first and **stops at the first failure**
— there is no point building the website to discover the extension never loaded. It takes names to
run a subset (`pnpm smoke:all web search`) and prints per-harness timings either way. Within a
single harness the opposite rule holds: each one collects every problem and reports them together,
because three findings from one run beat three runs.

`smoke:web` takes names of its own, for the same reason and with the same rule about a name that
matches nothing: `pnpm smoke:web list rating`, or `pnpm smoke:web joining`. The sections are
`session`, `list`, `rating`, `funnel`, `table`, `map`, `triage`, `tabs`, `refusals` and `joining`, and they
always run in that order. What a subset cannot skip is the setup — the fixture, the Edge Functions
and a production build of the website — so the saving is the browser work: six seconds for the list
and the rating against forty for all of it, and nearly all of those six are the setup. Every
section is written to stand on its own against that setup, which is what makes running one of them
mean anything.

## Covered

**The listing panel** (`smoke`) — the decode of a real `__PAGE_MODEL`, the panel rendering under
Rightmove's own page, nearest stations, travel times against saved places, the verdict buttons, the
photo gallery painting *over* the site (asserted with `elementFromPoint`, because the markup cannot
tell you), and `record_property` actually writing the link — read back from the database, not
inferred from a panel that looked right.

**Search and sweeping** (`smoke:search`) — every card found and badged, the recorded count matching
what is on the page, the stale-page detection, the hide toggle, and the per-hub sweep state. Its
sighting rows are genuine sightings of genuine listings, which is why it never *completes* a sweep
— that would narrow what the next real sweep looks at.

**The website** (`smoke:web`) — the shortlist's embedded read (the three-table join most likely to
be quietly wrong), the default showing rules, verdict attribution, the compare table, the map
*including its tiles*, triage in both layouts, the bulk-rate buttons being dead until something is
ticked, and the Settings / Your Hunt / Sweep / Install tabs each rendering their own content.

**Rating a flat** (`smoke:web`) — the note typed in, the button clicked, and then the row read back
out of Postgres: the rating, the note, the author, and the archived previous value in
`verdict_history`. Read back rather than believed, because the mutation is optimistic — the card
repaints from local state the instant it is clicked and only rolls back if the reply fails, so a
verdict that never reached the database looks exactly like one that did until somebody reloads
days later. It is asserted on `set_by` and not on `set_by_name`: the name column belongs to the
pre-auth identity model, new rows leave it null, and the name on screen is resolved from project
membership. The first run of this check asserted the name and reported a perfectly attributed
verdict as anonymous.

**Joining** (`smoke:web`) — an invite is minted through the real `invite` function, the code is
typed into the real sign-in screen with a chosen password, and the account that comes out is signed
in *and in the project*. Four things in a row that each look fine alone: `create_invite` hashes,
`redeem_code` checks the code against the address, the `password` function makes the account (the
only unauthenticated endpoint in the system), and `consume_invites()` turns the invite into a
membership. A break anywhere leaves an invited person holding an account in no project.

**Two refusals on the sign-in screen** (`smoke:web`) — a wrong password, and a code nobody was
sent. Each refusal has wording of its own, which is most of why that screen is as long as it is, so
a regression collapsing them into "Something went wrong" would have passed every check in this repo
while leaving the person who mistyped a code and the person whose invite expired with the same
useless sentence. The wrong code is aimed at an uninvited address rather than at the live invite:
guessing is rate-limited in the database, and spending an attempt would make this check the reason
the joining check below it fails.

**The boundary** (`check:rls`, `check:spend`) — asserted from outside by real clients holding real
JWTs, including that `signUp()` is refused outright, which every `to authenticated` policy is
predicated on.

**Triage's filters** (`smoke:web`, `check:filter`) — a bar nothing can clear empties the pile,
says so, and leaves the filter bar on screen, because the control that caused it is the only way
out; clearing restores the pile. `check:filter` pins the rule underneath: a flat is dropped only
when it is *known* not to qualify, so an unmeasured flat clears every bar and is counted separately.
A filter that dropped unknowns would look exactly like a shortlist with fewer flats in it.

**The funnel** (`smoke:web`) — a place moved along it and then archived with a reason, both read
back out of Postgres, plus the assertion the whole separation rests on: the verdict is read before
the archive and compared with itself afterwards. A stage that overwrote a rating would look like a
tidy screen and would put a training label on a flat nobody chose, which is invisible from every
view. `check:stage` pins the other half — the funnel's *order*, which is not the alphabet's:
sorted by name, "archived" leads and a viewing follows the visit it was booked for.

## Not covered

Roughly in the order the risk deserves.

| Gap | Why it matters |
|---|---|
| **The other writes.** Adding a place, adding a hub, marking off-market, renaming a project, and bulk rating from triage are all asserted up to the button and no further. | These are the actions, and the reads are well covered only because reads are easy to assert. Rating one flat now goes all the way to Postgres, which is the pattern the rest should follow: click it, then read the row. Bulk rating is the deliberate exception — it writes verdicts nobody gave onto every ticked row, so it stops at the buttons being dead until something is ticked. |
| **The gallery's gestures.** `smoke` opens it from the panel and asserts it paints over Rightmove; nothing drives the swipe, and nothing opens it on the website at all. | The swipe was checked by hand in a mobile-emulated Chromium driving real touch input through CDP — Playwright's own `touchscreen` only taps — and the cases worth keeping are the ones that are not the happy path: a short drag must not advance *or* dismiss, a cancelled gesture must not advance either, the arrows must still work after a pointer capture, and a tap on the photo must not close it. `smoke:web` could open it from a card's photo strip. |
| **The Admin tab.** | Never opened by anything. It is admin-only, so the fixture would need an admin — one row in `admin_email`. Users, projects, invites and spend all render there against real queries. |
| **The extension↔website bridge.** `check:bridge` covers the contract as a pure function; nothing drives the actual handover. | It is how signing in on the website signs the extension in. It fails silently by design (`handOver` swallows), so a break shows up as "the extension is signed out" days later. |
| **The paced opener** (Sweep's fill-in run). | It was covered by `smoke:sweep` before the split, and that harness was deleted rather than ported. It opens tabs one at a time; the old harness stubbed its worklist so the pacing assertion could not silently skip. |
| **The Detail view** and the flat-by-URL deep link (`#card-<id>`). | The reason the app moved off `chrome-extension://` at all. |
| **The rest of the sign-in refusals.** A wrong password and a code nobody was sent are now checked; expired, already-registered and rate-limited are not. | Every refusal is its own sentence on purpose — the design note at the top of `SignIn.tsx` — and the three left over are the ones that cost something to provoke: `already-registered` needs an account the fixture then has to work around, and `rate-limited` means hammering the endpoint the real joining check depends on. |
| **`analyse`.** No harness analyses anything. | It costs money per run, which is a real reason. The cap arithmetic around it is covered by `check:spend`. |
| **Driving times**, which deliberately throw. | Cheap to pin; nothing does. |
| **`check:predict` is skipping.** | It needs `.fixtures/predict-*.json`, which is committable by design (`.gitignore` un-ignores it) and has never been generated. It says "this proves nothing; it only declines to fail" — but it is still a green tick in `check:all` for a check that did not run. Generate one with `tools/export-predict-fixture.ts`. |

## What to build next

1. **`check:predict`'s fixture.** The cheapest by far — one command, and it turns an existing green
   tick from a lie into a check.
2. **The remaining writes**, each driven through the UI and read back from the database, the way
   rating a flat now is. Adding a place is the next most valuable: every travel time on every card
   is measured against one.
3. **An admin fixture**, which is one row and unlocks the whole Admin tab.
4. **The refusal sentences on the sign-in screen.** The invite fixture already mints codes, so a
   wrong-code and an already-registered case are a few lines each on top of what joining does.
