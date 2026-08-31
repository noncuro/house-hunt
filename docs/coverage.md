# What the smoke tests cover, and what they do not

A map. The point of writing it down is the second column: a screen nothing has ever opened is the
one that breaks quietly, and "we have smoke tests" is the sentence that stops anybody checking
which.

It is a map and not a queue. Read it before adding a check, to find out what is already driven and
by which harness. **What ought to happen next is not here** — every gap below is cited to an issue
in its row, and the backlog is the issue list (`AGENTS.md`, "Issues are the backlog — all of it").
They all cite #126, which is one issue with a numbered section per gap rather than nine issues
saying "nothing drives X" — a title that reads as a broken feature rather than a missing test, which
is how they were first filed. One row carries no issue and says so in the row itself, because its
"why" is a reason to stay uncovered rather than work nobody has started; a row that is neither is
this file quietly becoming the second list again, which is what it did before. This file used to end in a ranked list of four things to build, which is the second
backlog that rule exists to prevent: it was read by nobody, went stale against the issues, and
ranked work against a risk ordering that nothing kept up to date.

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

The spread on `smoke` is the `next build`: everything this app runs server-side is a route on the
website, the panel asks `/api/travel` for its station walks the moment it renders, so the harness
builds and serves the site like `smoke:web` does. Nothing is wrong when a single run takes half a
minute.

`supabase start` is the only thing you have to have running. Both browser harnesses that need a
server start it themselves (`startWebApp` in `tools/servers.ts`) and stop it again. `pnpm smoke` did
not, for a while, and passed anyway — because a `supabase functions serve` left over from something
else was answering. That is the worst shape a green tick can have: it goes red the first time
somebody runs it on a clean machine, and it says "panel never left its loading state", which is a
sentence about a spinner for what is really a process nobody started.

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
always run in that order. What a subset cannot skip is the setup — the fixture and a production
build of the website — so the saving is the browser work: six seconds for the list
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

**The unattended sweep** (`check:full-sweep`) — the one button that scans every place page by
page, opens what the scan found, then re-checks what is due, driven against a fake extension and a
fake clock so the *order* can be asserted: page 2 is not opened until page 1 is read back from
`hub_sweep`, a half-sweep abandoned last week does not answer for today's page 1, a page that never
records stops the run and names itself, and Stop counts only what was confirmed. Every one of those
is a run that would otherwise finish green having lost a page of sightings. The tabs it opens are
the same `open-tab` bridge call the fill-in run makes, and are covered exactly as far — to the call
and no further, which is as far as anything here can go: what is on the other side of it is a
Rightmove page, and no harness may fetch one (`tools/offline.ts`).

**The fill-in run** (`smoke:web sweep`) — the opener, driven end to end against a stub that answers
the `open-tab` bridge call and records what it was asked to open. The worklist is read out of
Postgres, the run is offered only because something answered `hello`, and the tabs are asked for one
at a time, newest sighting first, with the gaps measured. `check:full-sweep` asserts the same
sequencing against a fake clock, which is the right way to check pacing and no way at all to check
that the button is wired to it.

## Not covered

What no harness drives. The order is the order it was written in, not a ranking — where a gap is
worth work there is an issue, and the issue is where the argument for doing it belongs.

| Gap | Why it matters |
|---|---|
| **The other writes** (#126). Adding a place, adding a hub, marking off-market, renaming a project, and bulk rating from triage are all asserted up to the button and no further. | These are the actions, and the reads are well covered only because reads are easy to assert. Rating one flat now goes all the way to Postgres, which is the pattern the rest should follow: click it, then read the row. Bulk rating is the deliberate exception — it writes verdicts nobody gave onto every ticked row, so it stops at the buttons being dead until something is ticked. |
| **The phone half** (#126). Nothing drives the service worker, the offline restore, the share target, adding a flat by address beyond `check:listing`'s URL cases, or what the map does on a phone. | This is the whole of what a phone can do, and every piece of it fails quietly: a worker that caches nothing looks identical online, a restore that never runs looks like a slow load, and a share target that mis-parses lands somebody on the shortlist with no dialog and nothing to read. Most of it is drivable offline and belongs in `smoke:web` — `?add=<url>` must open the dialog prefilled, a paste that is not a listing must say so before the button does anything, `navigator.serviceWorker.ready` must resolve and `caches.match('/')` must find the shell, and the offline notice must appear under `context.setOffline(true)` over a shortlist that is still drawn. The map's phone behaviour is the newest of these and is drivable the same way: under a mobile viewport a tap on a pin must open the flat's panel and draw no dock, and a refused position must put `map-locate-error` on the screen — Chromium will hand a stubbed or denied `geolocation` to a context, and `check:geo` pins only the sentence, never that anything renders it. The one part that cannot be smoked is the fetch itself: `app/api/listing` reaches Rightmove, and no harness here may (`tools/offline.ts`). |
| **The gallery's gestures** (#126). `smoke` opens it from the panel and asserts it paints over Rightmove; nothing drives the swipe, and nothing opens it on the website at all. | The swipe was checked by hand in a mobile-emulated Chromium driving real touch input through CDP — Playwright's own `touchscreen` only taps — and the cases worth keeping are the ones that are not the happy path: a short drag must not advance *or* dismiss, a cancelled gesture must not advance either, the arrows must still work after a pointer capture, and a tap on the photo must not close it. `smoke:web` could open it from a card's photo strip. |
| **The Admin tab** (#126). | Never opened by anything. It is admin-only, so the fixture would need an admin — one row in `admin_email`. Users, projects, invites and spend all render there against real queries. |
| **The extension↔website bridge** (#126). `check:bridge` covers the contract as a pure function; nothing drives the actual handover. | It is how signing in on the website signs the extension in. It fails silently by design (`handOver` swallows), so a break shows up as "the extension is signed out" days later. |
| **The Detail view** and the flat-by-URL deep link (`#card-<id>`) (#126). | The reason the app moved off `chrome-extension://` at all. |
| **The rest of the sign-in refusals** (#126). A wrong password and a code nobody was sent are now checked; expired, already-registered and rate-limited are not. | Every refusal is its own sentence on purpose — the design note at the top of `SignIn.tsx` — and the three left over are the ones that cost something to provoke: `already-registered` needs an account the fixture then has to work around, and `rate-limited` means hammering the endpoint the real joining check depends on. |
| **`analyse`.** No harness analyses anything. **The one row here with no issue, deliberately.** | It costs money per run, which is a real reason to leave it uncovered rather than a gap waiting on somebody. The cap arithmetic around it is covered by `check:spend`. |
| **Driving times** (#126), which deliberately throw. | Cheap to pin; nothing does. |
| **`check:predict` is skipping** (#126). | It needs `.fixtures/predict-*.json`, which is committable by design (`.gitignore` un-ignores it) and has never been generated. It says "this proves nothing; it only declines to fail" — but it is still a green tick in `check:all` for a check that did not run. Generate one with `tools/export-predict-fixture.ts`. |
