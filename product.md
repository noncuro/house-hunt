# product.md — how we decide what to build next

`AGENTS.md` is how the thing is built. This is **how we choose what to work on**,
written down for the same reason: the reasoning disappears once the decision is made,
and whoever comes next re-derives it badly.

Every heuristic below is followed by the real case that taught it. A heuristic without its case
becomes a slogan, and slogans lose arguments to whoever is loudest.

**A note on how this is written.** Bugs are described by what a person *sees*, not by ticket number.
Issue numbers are in footnotes. This is not decoration — a backlog written in ticket numbers can
only be reasoned about by someone holding all the tickets in their head, which is nobody, including
the person who wrote them.

---

## What we assume about the people using this

**People hunting a flat together agree.** They are choosing one home to live in together, so a
single shared verdict per flat is the right shape and disagreement is not the interesting signal.

This is worth stating because the early research argued the opposite — that the interesting signal
is where two people disagree, and a shared rating destroys it. That was wrong about this product.
The shipped design is one verdict per flat per project and that is deliberate, not a compromise
that got away from us.

What follows: a hunt is one mind with several hands. Surfaces do not need to attribute an opinion
to a person, resolve conflicts between members, or show two ratings side by side. The one
disagreement worth drawing is between the hunt and its verdict-score model, the model fitted on
the hunt's own ratings. Where the score expected one thing and the people said another, either
the model or the reasoning is wrong.

---

## 0. Check the backlog against the code before ranking anything

**An unreconciled backlog lies, and it lies in the direction that costs you most.**

On the pass that produced this file, **ten of seventeen open issues were wrong.** Six described
things that had already been fixed and never closed. Four described work that had partly landed, so
the ticket overstated what was left.

One of them opened with the sentence *"Verified against the parser as it stands on `main`."* That
was true the day it was written and false by the time anyone read it, and nothing about the issue
said which.

The cost is not looking disorganised. It is that somebody picks up a solved problem and solves it
again — and that the apparent size of the debt inflates until the list feels hopeless and stops
being read at all. In this repo only three issues had ever been closed, all on a single day, while
at least six more got fixed in the fortnight afterwards.

**So: before any prioritisation, check every open issue against the code.** It fans out cheaply and
it is the highest-value step in the whole exercise. Close what is done. Rewrite what half-landed. A
stale issue is worse than no issue, because it is confidently wrong.

**Closing is part of the work, not admin afterwards.** A fix that leaves its ticket open has not
been delivered, only performed.

> Cases: the installer's completeness check, the installer's ownership check, the table's picked
> count, the compass predicate, the sweep screen's duplicate probe, and the floor-area parser — all
> fixed, all still open when the pass found them. #30, #31, #33, #38, #45, #54.

---

## 1. Silent wrongness beats visible brokenness to the front of the queue

Something that looks broken costs irritation. Something that looks *fine* and is wrong costs a
decision.

The clearest pair we had:

- **A swiped photo moves on its own and the next one only appears when you lift your finger.** It
  reads as broken. You know instantly, you swipe again, nothing is lost.
- **A flat shows a column of blanks where its travel times should be — and some of the blanks are
  wrong.** Blanks look exactly like "we haven't got to it yet", so nobody investigates. Somebody
  rules out a flat because the tube times look impossible, and those particular tube times are
  fiction.

  **The measured numbers, which are not the ones the ticket led with.** Of roughly 3,700 journeys
  recorded as having no route, most are *correct*. The planner will not route a fifteen-mile walk,
  and walking shows a hard cliff at two miles — zero successes in 1,597 attempts beyond it.
  Refusing those is the right answer. What is wrong is a smaller, sharper set: cycling and transit
  failing at short distances, 2–5% in every band including under a mile, of which about **250** are
  demonstrably poisoned. Separately, and more widely, **96% of those rows carry a fabricated
  explanation**. They predate the column that records *why*, and the read path fills the gap with a
  confident sentence asserting what the planner said, on rows that recorded nothing of the kind.

  That is two defects behind one number: a few hundred journeys that are wrong, and several
  thousand that are probably right but explain themselves with an invented reason. Both are silent,
  they need different fixes, and the ticket's single headline figure hid the split.

Both are bugs. Only one changes which flat you go and see on Saturday.

**The test: what is a wrong output indistinguishable from?** If wrong data looks like missing data,
or like a slow load, or like an agent who never stated a figure, it will not be reported and it will
not be noticed. That is the class to fix first.

This is the prioritisation-level reading of a rule `AGENTS.md` already has for extraction — **"fail
loudly; blanks look like real data."** Same instinct, applied to choosing work.

The floor-area parser was the same shape and is why it was worth fixing though nobody had
complained: a dropped size renders as a listing with missing data rather than a parser that threw
away data it had — *and it feeds the verdict model*, where "unknown" and a real figure are different
inputs.

> Cases: #46 (visible), #47 (silent), #54 (silent, and it reached the model).

---

## 2. Bugs that poison their own future are urgent regardless of severity

Most bugs are as bad on the day you fix them as on the day you found them. Some get worse while you
deliberate, and those jump the queue on timing alone.

When the journey planner says "I need you to clarify that postcode", we write it down as **"there is
no route"** — permanently. Nothing re-asks a settled negative. Every day that stands, more rows are
poisoned. And the sting: because those rows look *answered*, the process that fills in missing
journeys skips them. **The bug suppresses its own symptom.**

**Ask of any bug: does waiting make the fix bigger?** If it writes durable state, the answer is
usually yes, and the cleanup you will eventually need is a cost you are accruing right now.

> Case: #47.

---

## 3. Order the work for cost, not just for priority — fixes interact

Ranking issues independently is the standard mistake. Sequencing can be worth more than ranking.

Two pieces of work on our list:

- **Stop measuring journeys to places that only exist to be searched around.** A sweep walks the
  Rightmove search results around a neighbourhood, recording every listing it sees. Add a
  neighbourhood so the sweep has a centre, and today the app also measures the walk, cycle and
  tube time from every flat to the middle of it. About 2,100 such lookups are queued.
- **Fix the wrongly-cached "no route" answers**, which means re-asking those journeys for real.

Do the second first and you pay to re-ask journeys the first was about to tell you nobody wanted. Do
them in the other order and that spend never happens.

Neither ticket mentions the other. The interaction is visible only with both on the table at once —
which is the argument for triaging the backlog as a *set*, not an issue at a time.

> Case: #51 before #47.

---

## 4. Shipping a feature can promote a bug nobody touched

The backlog is not independent of the roadmap. New code changes the blast radius of old bugs.

We merged an **unattended sweep runner**: sweeps on a timer, nobody watching. Separately, a known
weakness had been filed as *"not urgent"*: the travel rate limit checks the count and then makes its
calls, rather than reserving capacity first, so simultaneous requests can all pass the same check.
Part of why that was tolerable was that a person was always present.

The runner drives a real browser holding a **user** session — so unlike the scheduled backfill it is
*not* exempt from that limit.

Nothing in the bug changed. Its priority did.

**So: when a PR lands, ask which open issues it just made more likely to bite.** Specifically — does
it increase the *volume*, the *concurrency*, or the *unattendedness* of a path a known bug sits on?

> Case: PR #59 promoting #37.

---

## 5. Weight bugs by times-per-session, not by surface area

Count how often a person meets the thing, not how much of the codebase it touches.

Looking at photos and stepping through triage *are* the product — they are what you do a hundred
times in an evening. So a stutter in the triage loop, or travel rows that will not line up on the
panel you read every listing through, are worth more than their small code footprint suggests.

A bug on a screen met twice a year is a different animal at identical severity.

**But frequency is the weakest of the four axes, and loses to the other three.** The obvious example
is a trap we nearly fell into: the Admin screen is met twice a year, and it is also the screen
showing what the hunt has spent. A wrong number there is rare, silent, and about money — which is
axis one, axis two and axis eight all at once. `docs/coverage.md` records that nothing has ever
opened that screen in a test.

So this axis breaks ties between bugs that are otherwise alike. It does not outrank silence.

> Cases: #44, #49 — both small in code and constant in use. And the correction: the low-frequency
> surface we waved past turned out to be the one denominated in money.

---

## 6. Separate "needs a decision" from "needs engineering"

Some issues are not waiting on effort. They are waiting on somebody to *choose*, and they sit in the
backlog looking like work while the only blocker is a judgement call.

Next to each station we show a walk time and a distance — say "9m · 0.2 mi". The minutes are ours,
routed street by street. The miles are the listing site's, straight-line, rounded so hard that "0.1
mi" covers anything from eighty to two hundred and sixty yards. Read as one fact they are nonsense.
There are three sensible answers and the engineering for any of them is small. It stayed open
because nobody picked one.

**Flag these explicitly and separately.** A decision costs a conversation, not a sprint, and keeping
it in the same queue as build work is exactly how it goes unmade for a month.

> Case: #43.

---

## 7. Write down what you are *not* doing, and the trigger that changes the answer

Already practised here, and the best thing in the repo's process. `TODO.md` opened by saying
these gaps were deliberately unfixed *before the first release with users other than the original
pair*, and that **membership is the real boundary** — which is what made them affordable then and
unaffordable at a hundred users. Each entry also recorded what closing it would take, "so a later
pass has somewhere to start rather than rediscovering the reasoning".

That is a deferral with an **expiry condition attached**, and that is the whole difference between a
decision and a punt.

The obligation it creates: **when the trigger fires, the list must be re-read.** "Getting ready for
other people" *was* that file's stated trigger. A deferral with no trigger is just an oubliette.

### 7a. Know how many backlogs you have — the ones outside the tracker are invisible

This project had **five**, and the pass that wrote this section found two of them.

GitHub issues. `TODO.md`, holding thirteen deferred items that were not tickets and never had been.
`docs/coverage.md`, whose "Not covered" table is explicitly *"roughly in the order the risk
deserves"* and which ends with a numbered "What to build next". The `openspec/changes/` folders.
And issue numbers written into source comments.

A triage pass over issues sees only the first. On the pass that produced this file the whole GitHub
list was reconciled, ranked and sequenced — and `TODO.md` was quoted approvingly *in this document*
without being opened. It took the owner asking "is `TODO.md` in your backlog?" to catch it, and a
second reader to point out that the section warning about invisible backlogs had itself missed two
more while being written.

That is also **how a trigger fires with nobody noticing**. Nothing watches a list that is not the
backlog, so the condition that was supposed to bring items back into play just passes.

**The test for whether a document is secretly a backlog: does it contain a list of things that
ought to happen?** If it does, that list is a backlog no matter what the file is called. A document
that says *how something works* is reference. A document that says *what to build next* is a queue,
and a queue nobody looks at is worse than no queue, because its existence is what stopped the items
being filed properly.

**The resolution here:** issues are the backlog. Documents describe and link; they do not
accumulate. Concretely — `TODO.md` was migrated and deleted. `coverage.md` should keep its map of
what is and is not tested, which is reference somebody reads before adding a check. Its ranked gap
list and its "what to build next" should go to issues, under a label the document then points at.
The `openspec/changes/` folders are the record of design processes that have shipped; they are an
archive, and should say so, with anything still unbuilt in them filed. Issue numbers in source
comments are the one that stays: they are pointers *into* the backlog, not a second copy of it.

And when re-ranking, do not silently prefer the list that happens to be in the tool. That preference
is invisible and looks like judgement.

**The deferred list is where the sharpest reasoning usually lives**, which is what makes ignoring it
expensive. These entries were not carelessly parked — each records what closing it would take and
why now is not the time. The best of them state their own expiry condition in a sentence you can
check against reality: *"At six invited people that is a conversation, not a control."* That one line
tells you precisely when the item comes back, and it came back.

---

## 8. Low probability is not low priority when the outcome is unrecoverable

Two installer bugs were both unlikely and both ended in **deleting a user's files**. One replaced
a working extension with a broken one after the backup had already been removed. The other
recursively deleted a user's own file because its name happened to match a directory in the new
build.

Give destructive outcomes their own column. Improbable-but-unrecoverable, landing on somebody who
did nothing wrong, outranks probable-but-annoying.

Note *how* one of them was fixed, because it generalises: **the repair was placement, not logic.**
The check already existed and was correct; it ran after publishing instead of before. And it
was made one shared implementation rather than two, because — in the issue's own words — *two copies
of the same parser can agree on the same wrong answer.*

> Cases: #30, #31.

---

## 9. Prefer the fix that cannot come back to the fix that works

When a bug has already returned once, weight the structural repair over the local one.

A screen hand-rolled its own copy of a shared data query, and in doing so re-armed background
refetching on a key three other screens depend on being frozen. The visible result was a banner
saying the extension is not installed, sitting directly above a green message saying it *is*. That
had been fixed once. A call site that looked harmless brought it back.

The repair used the shared hook at both sites **and left a comment naming the hazard.** That is the
prioritisation reading of `AGENTS.md`'s **"one fact, one renderer"**: the rule exists because a
duplicate drifted, so every new duplicate is a scheduled recurrence.

The same rule with the bill not yet paid: the panel and the website render the same travel
information two different ways, and the panel is on the losing side of a comparison that was already
made and decided.

> Cases: #45 (paid), #49 (outstanding).

---

## 10. When the world moves under an issue, rewrite it — do not just close it

One request was that the personal model learn from the notes already written when rating a flat.
Meanwhile a separate piece of work grew that model from fourteen inputs to twenty-one and gave it a
prior that starts it off pointed the right way, making it meaningfully better when there are few
ratings to learn from.

That work attacks the request's **stated motivation** — "so it becomes useful after fewer
verdicts" — from a completely different direction, and closes part of the gap. The **literal ask** —
that the notes count for something — is untouched, and now has a richer set of features to map notes
onto.

Closing it would discard a real request. Leaving it as written would overstate the gap. **Rewrite
it**, saying what changed and why the remainder is still worth having.

A second thing had moved that nobody would have looked for: retraining was already bumping against a
two-second processing limit at around 190 flats, and a separate piece of work went in purely to fit
underneath it. So the request now arrives with a **budget attached** — anything that does extra work
per rating at training time is spending against a ceiling that is already close. That is worth more
to whoever picks this up than the feature discussion, and it was nowhere in the ticket.

**Generally:** an issue states a problem, a motivation, and usually a proposed solution. Those three
rot at different rates. Work out which part is stale before acting on any of it — and look for
constraints that appeared while nobody was watching, not just for work that got done.

### 10a. The premises rot too, and those are the dangerous ones

A stale *status* wastes a day. A stale *premise* gets built on.

Well-written tickets here lean on a supporting fact, stated in passing as settled background. Three
of ours were false by the time anyone acted:

- One argued a new setting could take its default from which of **two different ways** a place was
  added. There is now only one way to add a place, and it demands a postcode — the other route was
  removed when the table underneath it was replaced. The design that inherited its default from "how
  it was added" had nothing to inherit from.
- Another said the fix was safe because merging two stations already carries both lines forward. It
  does merge the field — but **nothing displays that field**; the coloured line markers come from
  somewhere else entirely. Building on the sentence would have shipped one line's markers on a row
  standing for two.
- A third said a shared component was the single renderer of a fact. Two more renderers of the same
  fact existed elsewhere, which is precisely what made the tempting simplification wrong.

These are worse than a stale status because a status gets checked — "is this still broken?" is the
obvious first question — while a premise reads as context and slides past. And they are *load-
bearing*: each was the reason the proposed solution was thought safe.

**So: when a ticket says "X already does Y" or "the interface already distinguishes Z", that is the
sentence to verify first, not last.** It is doing the most work and receiving the least scrutiny.

The shape of all three is the same: each was true when written. Nobody was careless. The ticket
outlived the world it described, and said nothing about when it was written down.

> Case: #16, against PR #34 (the features and the prior) and PR #61 (the CPU budget).

---

# Design principles

The heuristics above are about *what to work on*. These are about *how the thing should behave* —
also written down, also with their cases.

## 11. A surface's word budget is set by how often it is seen

Explanatory text is a **recurring** cost. The confusion it prevents is usually a **one-time** cost —
the reader works out the distinction once and never needs telling again. So a sentence on a screen
somebody sees a hundred times an evening is paid a hundred times to solve a problem that was already
solved after the first.

That gives a straightforward rule:

| Surface | Seen | Budget |
|---|---|---|
| Install page, onboarding, first-run, a one-off dialog | Once, or once a year | A sentence, or a paragraph. Spend it. |
| Empty states, error states, refusals | Rarely, and by definition exceptionally | A sentence. The user is stuck; words are the point. |
| A row, a card, a column header, anything in the main loop | Constantly | **A word. Preferably none.** |

The mistake is easy to make because a caption is the *cheapest thing to write* and reads as
thoroughness. It is a tax on the people who use the product most.

**The case.** Each station row shows a routed walk time and a straight-line distance, and they look
like one measurement that contradicts itself. The proposed fix was a caption under the block:
*"Minutes are the walk from this flat. Miles are the straight line."* Accurate, well-worded, and
wrong for the surface — that block is on every listing, and the sentence would be re-read forever to
convey something learned once.

## 12. If a screen needs a sentence, the presentation is usually the bug

Prose that prevents a misreading is treating the reader. The misreading itself is nearly always
caused by how the thing is laid out, and fixing *that* is cheaper, permanent, and costs no space.

Two numbers read as one fact because they are set identically and sit adjacent with nothing between
them. The repairs are all presentational: attach the qualifier to the number itself so it
travels with it (`0.1 mi direct` — one word, no caption), or separate them typographically so the
eye stops treating them as a pair, or drop the weaker number from the surfaces that do not need it.

**Ask, before writing a word of UI prose: what about the layout made this sentence necessary?**
Usually the answer is the actual fix, and the sentence was a way of not doing it.

## 13. Put the minimum on the screen and the explanation one interaction away — reachable by thumb

The two audiences differ and both are real: somebody meeting the screen for the first time needs the
distinction spelled out; somebody on their four-hundredth listing needs it never. Permanent prose
serves the first and taxes the second.

Resolve it by layering: **the minimum viable signal always visible** (a word, a unit, a weight
difference), **the full explanation behind a deliberate act** (hover, tap, an info affordance).

The trap, which we walked into: hover is not an interaction on a touchscreen. This app is installed
to a phone home screen, has a share target, and is explicitly built to be opened on the Underground.
A hover-only explanation is missing for a large share of real use — and, in the case that prompted
this, would have appeared *only* on the desktop panel where the confusion was reported and nowhere
else. **Whatever carries the detail must have a touch path.**

## 14. A machine-read fact must look different from a stated one

Four of the facts on a listing are read off photographs by a vision model. They can be wrong. A
figure the agent typed and a figure a model inferred from a picture carry different weight, and the
screen must never present them identically.

**The rule: it is always visually clear which facts were inferred. Confidence is attached where it
is relevant, and is not required everywhere.**

The codebase has already worked most of this out and the reasoning is worth keeping:

- **Low confidence is when the reader most needs to notice**, so marks are spent there rather than
  spread evenly. A mark on everything is a mark on nothing.
- **The words hedge, not just the markings.** A claim phrased as a claim carries its own uncertainty
  without needing an icon beside it.
- **Uncertainty must never read as a second verdict.** Colour is the trap: a red confidence bar and
  a red "we don't like it" are indistinguishable at a glance, and the reader merges them.
- **Never show precision the model does not have.** The score's percentage was demoted to a hint
  because a few hundred ratings cannot tell 0% from 3%, and a number implies it can.

The corollary from the parser side, which points the other way and is also right: **prefer absent to
wrong.** Where a reading is doubtful the code errs toward the veto, because a confidently wrong
figure is worse than a blank. Those two live together — *never invent a value; never hide a flat.*

## 15. When the app must err, it errs toward showing more — and lets you say otherwise

Filters keep flats whose numbers are unknown. The sweep window snaps up, never down. A filter bar
that a place can no longer answer is dropped so the pile widens. A flat off the market is hidden
into Archived rather than deleted.

Every one of those chooses to show more rather than less when the app is uncertain, and that is the
right default: the alternative hides things invisibly, and what is hidden invisibly is never
questioned.

**The limit, which matters because triage exists to shrink a pile:** the rule governs what the app
does when *it* is uncertain, not what the user asks for. A user narrowing a search is not an error
being resolved.

**And a default the user cannot change is not a default.** Where the app widens on the user's behalf,
ship the control to say otherwise in the same change. Keeping unknowns is right by default and wrong
for somebody who wants to see only what is confirmed, and today there is no way for them to say so.

That is the rule, and it forbids something specific: **a widening behaviour that ships without its
off switch.** Every one of the four cases above did — filters keeping unknowns, the sweep window
snapping up, dropping a dead filter bar, hiding off-market flats into Archived. Each was the right
default. None of them can be turned off, and the count of them is how a sensible default becomes a
behaviour nobody chose.

## 16. Two ways of using this, and they need different words

There are two, and a design that serves one and forgets the other is half a design:

1. **Desktop, with the Chrome extension** — the listing panel on Rightmove, a keyboard, a pointer,
   a real connection.
2. **A phone, on intermittent internet** — the installed web app, opened on the Underground, no
   extension (no phone browser loads one), touch only.

`AGENTS.md` already states the structural half: the website is the whole product, the extension is
one of two ways in, and nothing may be reachable only through it. This is the presentational half.

**Helper text may differ between the two, and should.** Hover is a desktop affordance and does not
exist on touch, so a hover-only explanation is a desktop-only explanation. The same fact may need
different carriers on the two surfaces, and that is not a duplicate renderer — the fact is one, the
affordance is not.

**The pattern to reach for on the phone: a `(?)` that announces itself once.** Loud on first
encounter, as part of onboarding, then quiet and available on tap forever after. It resolves the
tension in principle 11 — a new member gets the sentence, and the person on their four-hundredth
listing does not pay for it on every screen. We have barely used this and should use it more.

## Working notes

**Verify by running it, not by reading it.** The floor-area parser's status was settled by executing
the three example strings, not by reading the regular expression. Reading regexes to predict their
behaviour is how the bug got in.

**A check that cannot reproduce the bug is a green tick that means nothing.** Before writing an
assertion, confirm the test data can produce the failure. The travel rows misalign only
when a place has *no* answer for one of the modes — and every journey in the fixture is seeded as a
success, comfortably inside the walking limit. An alignment check written against it would pass
today, pass after a regression, and pass forever. The fixture has to be taught the failure before
the assertion is worth anything.

This has a sibling already in the repo, which is what makes it a pattern rather than an incident: one
check in the suite skips because the file it needs has never been generated, and it says of itself
that it *"proves nothing; it only declines to fail"* — while still printing a green tick in a run
everything else is trusted to. **Ask of any check: what would have to break for this to go red?** If
the answer is hard to state, the check is decoration.

**Distrust your own confident claim, especially when challenged.** "The component has no cache" and
"the user sees a flicker" are different claims, and establishing the first proves nothing about the
second. When the owner pushed back on a symptom, only the mechanism had been checked. Measure the
thing that was claimed.

**Check attribution, not just facts.** Writing this file, I credited a merged branch with growing the
model's inputs and giving it a better starting point. Both were true of the codebase and neither was
true of that branch — they had shipped weeks earlier in different work, and the branch in front of me
did something else entirely. Two unrelated changes shared a piece of jargon, and sharing a word was
enough to fuse them. A right fact attached to the wrong cause sends the next person to read the wrong
diff. `git log -S <symbol>` settles it in seconds and should be the reflex before "this PR did X".

**The code often knows its own backlog.** One screen carries a comment saying *"That is #55; it is
not fixable here without the harness."* A migration header says *"This is also what #47 needs."*
Grepping issue numbers in the source is a fast, high-precision way to find where work half-landed —
and it is the one good use of ticket numbers.

**A feature request is often a composition task, not a capability gap.** "Add location columns to
triage" turned out to be almost entirely built already — filtering by travel to a place, nearest
station as a destination, sorting by it, and the renderer that draws "0.4 mi NE of Angel" all exist.
The actual gap is that the triage row prints price, beds and size and nothing about *where the flat
is*, with the data already in scope and unused. Check what exists before sizing a feature.

**Estimate what a fix costs to deploy, not just to write.** The wrongly-cached journeys are roughly a
one-word code change. The re-asking it triggers is the expensive part and belongs in the estimate.

---

## Footnote: the ticket numbers

#16 notes into the model · #18 location columns in triage · #30, #31 installer safety ·
#33 the table's picked count · #37 rate limit is a check not a reservation · #38 the compass
predicate · #43 walk time versus straight-line distance · #44 station walks refetched on every step ·
#45 the duplicated extension probe · #46 the swiped photo · #47 a clarification cached as "no route" ·
#48 one interchange listed twice · #49 the panel's travel rows · #51 search-around versus travel-to ·
#54 the dropped floor area · #55 map framing.
