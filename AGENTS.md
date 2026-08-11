# house-hunt — shared house-hunting for Rightmove, a website with a thin extension beside it

A shared house-hunting tool for people looking for a flat together. It exists because house-hunting
as a pair is a shared decision made from separate laptops on separate evenings, and Rightmove gives
you no way to hold a shared opinion, no way to know how far anywhere actually is from anywhere you
care about, and no way to tell which flats you have already looked at.

It was built for a couple looking for a flat together and ran for a year as a two-laptop Chrome
extension with no login. It is now multi-tenant: sign-in by email code, **invite only**, and a
**project** — one house hunt, up to six people, one shared shortlist and one shared opinion per
flat. A user belongs to as many projects as they are invited to and has exactly one active at a
time.

It is now **two apps in one pnpm workspace**, plus shared packages. `apps/web` is a **Next.js
website** (the shortlist, compare, map, settings, sign-in, project and admin screens — everything
that is not on a Rightmove page). `apps/extension` is a **thin Chrome MV3 extension** that keeps
only the Rightmove half: the listing panel, the search-card badges and the sweep panel. The two
share one sign-in: the extension carries a **bridge** content script on the website's origin that
relays three messages so the two sessions stay in step. Shared logic lives in `packages/core`
(facts, hubs, sweep, travel, db, analysis) and `packages/ui`. Config is the **workspace-root
`.env`** (see `.env.example`).

> Status: **in use**, on real listings. 55 properties, 18 verdicts, 55 photo analyses, 65 search
> sightings, 351 cached travel legs — all carried into the original project by the migration, none of
> it orphaned or dropped.

## What it does, and why

Three intentions, in the order they matter.

**1. Tell us how far it is from the places we care about.** Every listing shows travel time to
each saved place (the office, Heathrow, the in-laws) by walk, bike and public transport, plus the
nearest tube stations with the lines they carry. A rental decision is mostly a decision about a
commute, and "0.4 miles from Angel" is not that. Transit times are pinned to a weekday 09:00
departure so that two flats measured on different evenings are actually comparable.

**2. Hold one shared opinion.** Anyone on the house hunt marks a place *not our place* / *maybe* /
*exciting*, with a note, and it appears on everyone else's laptop and on Rightmove's own search
results. One rating per flat per project, attributed to whoever set it, with the previous value
kept — a shared opinion is the point, and an unattributed one turns a disagreement into a silent
overwrite.

**3. Say what is wrong with a flat before we spend an evening on it.** A vision model reads the
photos and the floorplan for the four things the listing text will not tell you: is there a
bathtub, is there outdoor space worth sitting in, how big is the main room, and what is the real
floor area. Anything it worked out wears confidence bars, because a claim about a flat nobody has
visited is worth exactly what the evidence behind it is worth.

Everything else is in service of those:

| Feature | What it is for |
|---|---|
| **Panel** on every listing page | All three of the above, on the page you are already looking at. Lives in the extension. |
| **Shortlist** (the website) | Everything either of you has opened, as cards, a sortable compare table, or a map. Clicking the extension icon opens the website. |
| **Red / amber flags** | No bath and no outdoor space mean don't bother viewing; a small main room means raise it at the viewing. The compare table shows only what is *against* a place. |
| **Hubs** | The five neighbourhoods being searched. Every flat reads as "0.4 mi NE of Angel" rather than as a postcode. |
| **Sweep** | Working a neighbourhood's search results to the end, deliberately, rather than reacting to whatever page you happened to open. Scan the pages, then fill in everything scanned in one paced run. |
| **Diagnostics** | A log of what the extension actually did, copyable, because the other laptop is not one you can put a debugger on. |

## Start here

**`RESEARCH.md`** is the design document: prior art, verified Rightmove page internals, the
travel-time API comparison, the schema and architecture, the terms-of-service position, and the
staged build plan. It is the source of truth for *why* the design is what it is.

This file is the source of truth for *how it is built and how to check you have not broken it*.

## Running it

```bash
pnpm install
pnpm dev            # extension: launches Chrome with it loaded, hot-reloads   (@house-hunt/ext)
pnpm dev:web        # website: next dev on http://localhost:3100               (@house-hunt/web)
pnpm build          # extension: writes apps/extension/.output/chrome-mv3 for "Load unpacked"
pnpm build:web      # website: next build
pnpm compile        # typecheck both apps (tsc -p apps/extension && tsc -p apps/web)
```

Config comes from the **workspace-root `.env`** — the extension's `wxt.config.ts` sets
`envDir: repoRoot`, and Next reads `.env` from the same place. `.env.example` lists every key. The
extension bundles only `WXT_*`-prefixed vars and the website only `NEXT_PUBLIC_*`; everything else
(the `SUPABASE_DB_PASSWORD`, `SUPABASE_PROJECT_REF`) stays server-side. The two clients need the
same Supabase project, so `WXT_SUPABASE_URL`/`WXT_SUPABASE_PUBLISHABLE_KEY` and
`NEXT_PUBLIC_SUPABASE_URL`/`NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` are the same values twice.
`WXT_WEB_APP_URL` is where the extension sends people to sign in and the origin its bridge trusts —
`http://localhost:3100` in dev, the deployed site in a store build. Verify a key made it into the
extension bundle after changing it:

```bash
grep -c "$(grep WXT_SUPABASE_URL .env | cut -d/ -f3)" apps/extension/.output/chrome-mv3/background.js   # 1
```

First run: click the extension icon (it opens the website), then Settings — set who you are and add
the places you measure against.

**Nothing runs locally in production.** The analysis and the travel/postcode resolution used to run
on a laptop; both are now Edge Functions on the same Supabase project, so either laptop produces
results whether or not the other is on. The functions are `analyse` (the vision pass, holds the
OpenAI key), `travel` (TfL + postcode resolution, and the only writer of the travel cache),
`invite`, `resolve-location`, and `password`. To iterate on a prompt without deploying,
`supabase functions serve <fn>` runs it locally against the same database.

`packages/core/src/analysis.ts` and `packages/core/src/png.ts` are the source of truth and are
copied into `supabase/functions/_shared/` by `pnpm sync:function`; `pnpm deploy:function` refuses to
deploy a stale copy and then deploys every function. Both were deliberately written with no `node:`
imports and no `import.meta.env` reads so they run unchanged under Deno — keep them that way.

To deploy: the website goes to **Vercel** (`apps/web`), the functions via `pnpm deploy:function`.
To set a second machine up, see **`SETUP.md`**.

## How it fits together

Paths are relative to `apps/extension/src/` and `apps/web/src/` respectively.

| Piece | World | Job |
|---|---|---|
| ext `entrypoints/page-model.content.ts` | **MAIN** | The only script that can see `window.__PAGE_MODEL`. Decodes it, `postMessage`s the listing out. |
| ext `entrypoints/panel.content/` | isolated | Renders the panel in a Shadow DOM, talks to the background worker. |
| ext `entrypoints/search.content/` | isolated | Badges search cards with verdicts; dims ones either of you rejected. |
| ext `entrypoints/sweep.content/` | isolated | The sweep panel on a search page: records every card, says which pages are still outstanding, says when it's safe to leave. |
| ext `entrypoints/bridge.content.ts` | isolated, **on the website's origin** | The only thing the extension runs on the website. Relays three named messages between the page and the worker so the two sessions stay in step; carries no flat, verdict or project, and answers only when asked. |
| ext `entrypoints/background.ts` | worker | Supabase reads/writes and TfL lookups. The only place in the extension with network access, and **the only place that constructs a Supabase client**. |
| web `screens/Sweep.tsx` | Next.js page | Both ends of sweeping — the hub links to scan with, and the paced opener that fills in everything scanned. |
| web `screens/SignIn.tsx` | Next.js page | Email, then a six-digit code. Every refusal gets its own sentence: not invited, rate-limited, wrong code, expired. |
| web `screens/Project.tsx` | Next.js page | Who is on this house hunt, who has been asked, switching between hunts. |
| web `screens/Admin.tsx` | Next.js page | Admins only. Users, projects, invites and spend, ordered by what things cost. |
| web `screens/{Compare,Detail,Map,Settings}.tsx`, `screens/Extension.tsx` | Next.js page | The shortlist proper, plus the page the extension opens to bridge a sign-in. |
| `packages/core/` | shared | Facts, hubs, sweep, travel, analysis, db client, the bridge contract — imported by both apps and by the checks. |
| `supabase/functions/analyse/` | Deno, on Supabase | The vision pass over the photos. Holds the OpenAI key, which cannot ship in a bundle anyone can read. |
| `supabase/functions/travel/` | Deno, on Supabase | TfL journeys and postcode resolution, server-side; **the only writer of the travel cache**. |
| `supabase/functions/{invite,resolve-location,password}/` | Deno, on Supabase | Invites, hub location-identifier lookup, and password sign-in. |

## Decisions worth knowing

- **Auth, and the MV3 trap it had to beat.** This project shipped with no login for a year: the
  Supabase publishable key in the bundle *was* the shared secret between two laptops, and identity
  was a name typed into Settings. That stopped working the moment anyone else was invited, so
  there is now email-OTP sign-in, projects, and row-level security. The key authorises nothing —
  every policy is `to authenticated` and `anon` holds no grant on any table.

  The reason it was avoided the first time is real and has not gone away: **an MV3 service worker
  has no `localStorage` to persist a session in, and Chrome tears it down when idle.** What makes
  it tractable is an invariant this codebase already had — **only `background.ts` constructs a
  Supabase client.** One holder means one refresh token being refreshed by one thing; two contexts
  racing to refresh the same token is how a session silently dies. The session lives in
  `chrome.storage.local` through a storage adapter, `autoRefreshToken` is off, `ensureSession()`
  is explicit, and a `chrome.alarms` heartbeat keeps it warm. `pnpm check:one-client` enforces the
  invariant, and it is not decoration: it is the thing the whole design rests on.
- **A verdict belongs to the project, not to a person.** Two people on one house hunt hold one
  opinion per flat, because that is what a shared decision is. Prior values go to
  `verdict_history`, and every surface showing a rating shows who set it and when — a shared
  rating whose author is invisible turns a disagreement into a silent overwrite.
- **Facts are global, opinions are scoped.** `property`, `property_analysis`, `station_point`,
  `station_walk` and `travel_time` are readable by any signed-in user, so a flat is analysed once
  across every project rather than once per project — that is what keeps the OpenAI bill down.
  Everything that carries an opinion is predicated on membership. No client writes a shared fact
  table directly: writes go through `SECURITY DEFINER` functions that validate their arguments,
  and `DELETE` belongs to `service_role` alone. A blanket write grant would have included DELETE,
  and the 351-leg travel cache was one client bug away from empty.
- **The spend cap locks the budget, not the listing.** Twenty dollars a month, per project and per
  user, against the owner's OpenAI key. `claim_analysis` takes advisory locks on the project then the
  user — always that order, so it cannot deadlock against `create_invite` or `consume_invites` —
  and reserves against running claims. Checking the total while holding only the *listing* lock is
  the bug this replaced: concurrent requests for different listings all read the same under-cap
  total and all proceed. **It is a soft cap**: the reservation is a flat estimate and the real cost
  lands afterwards, so one unusually dear call can cross the line even though N concurrent ones
  cannot. `TODO.md` says what closing that would cost.
- **Invite-only is a Supabase project setting, not a client argument.** `shouldCreateUser: false`
  is a request parameter, and anyone holding the publishable key can simply not send it. What makes
  this invite-only is `enable_signup = false` on the project and on its email provider. With signup
  on, a stranger with the key gets a real authenticated account and everything granted `to
  authenticated`. `consume_invites()` is the only thing that turns an invite into membership, takes
  no arguments so it can only ever act on the caller's own address, and runs immediately after a
  successful code verification — before it does, an invited person is an account in no project.
- **Known and accepted for this release: see `TODO.md`.** A signed-in member can enumerate every
  listing any project has analysed, and can write a fact every other project then reads. Both are
  written down with what it would take to close them. Membership is the real boundary — invite
  only, capped at six, revocable.
- **TfL needs no key.** Verified working unauthenticated. `WXT_TFL_APP_KEY` is optional and
  only raises the rate limit; set it from api-portal.tfl.gov.uk if we ever hit throttling.
- **Driving times are not implemented.** TfL's planner doesn't do door-to-door driving, so that
  mode throws a clear error rather than returning a public-transport number mislabelled. Google
  Routes is the planned fallback.
- **Realtime is speccd but not subscribed.** The tables are in the publication; the panel
  refetches on load instead. Add a subscription only if refetch proves too slow in practice.
- **Square footage falls back to the description.** Rentals frequently ship an empty `sizings`
  (verified: 1 of 5 live listings had none). A parsed-from-prose number is marked with `*` and a
  dotted underline, because it deserves less trust than one Rightmove published as data. The
  parser drops any figure with "garden" or "terrace" against it — it used to take the largest area
  in the text, and on one listing that was a 1,200 sq ft garden shown as the size of the flat.
- **Red / amber / good is a defined thing, not a colour choice.** Red means don't bother viewing:
  no bath, nowhere to sit outside. Amber means raise it at the viewing: a small main room, an
  unreadable floorplan. The severities live with the flags in `facts.ts` (`flagsFor`), and the
  compare table shows `problemsOnly` — a column reading "bathtub" down fourteen of seventeen rows
  spends its width saying nothing. **The icon carries the severity and nothing else** (`FLAG_ICON`
  in `facts.ts`): ⛔ red, ⚠️ amber, and a subject icon only on good news. Every flag used to take
  ⚠️ whatever it meant, and 🛁 marked both "bathtub" and "no bathtub" — an icon arguing against
  the words beside it.
- **Anything the model inferred wears the confidence bars** (`components/Confidence.tsx`),
  including the confident ones: their presence is what says a model worked this out, which is the
  half of the message the hedged wording alone never carried. Three ascending bars, filled to the
  level, with the unreached ones drawn in grey — the footprint is the same at every level, which is
  what the concentric rings before them got wrong: filling from the centre out made the mark shrink
  as confidence fell, so a low reading was a speck you had to hunt for. Exactly backwards. Five
  candidates were rendered at real size before this was picked; the reasoning is in the file.
- **Hubs** (`lib/hubs.ts`) are the neighbourhoods being searched around, mostly tube stations, and
  every listing shows which one it is near and in which direction. Coordinates came from TfL's
  StopPoint API and were reverse-geocoded through postcodes.io to confirm the ward — a hub in the
  wrong place silently corrupts every bearing on the page. Nothing within a mile says so rather
  than naming somewhere far away. **A neighbourhood always outranks a saved place**, even a much
  nearer one: "0.3 mi NW of Work" says how long the commute is and nothing about where the flat
  is, and the name is the part of that label a reader takes at face value. A place answers only
  when no hub is in range, which is the case places were added for.
- **Sweeping is how we go looking, and it is the deliberate half of the tool.** The rest of this
  extension reacts to a page you happened to open; a sweep works one neighbourhood's search
  results to the end. `lib/sweep.ts` builds the search URL per hub and decides how far back it
  looks, `lib/search-page.ts` reads the results, and `sweep.content` is the panel. It builds
  links a human clicks and never fetches a search — the standing rule below is what the whole
  design is arranged around.
- **Scanning and filling in are separate jobs with separate homes.** Scanning is per page and
  instant, so it lives on the Rightmove search page where the cards are. Filling in is one long
  unattended run and lives on the shortlist's Sweep view (`components/Opener.tsx`), where the tab
  stays open and the worklist is a database question — `pendingSightings`, everything swept and not
  yet opened, across every hub. Bolted onto the search page it could only see the two dozen cards
  in front of it and died the moment you paged on: five hubs of four pages meant twenty separate
  unattended runs.
- **A hub marks itself swept; there is no button.** `sweepProgress` tracks which pages have been
  recorded and completes the sweep when they cover 1..N. What the old "Mark swept" button really
  guarded is still guarded: recording *a* page is not finishing a sweep, and since results come
  back newest-first, treating page 3 of 3 as the end would narrow the next window past everything
  on pages 1 and 2. Page 1 restarts the count, and so does a changed page total. Until a pass is
  complete, `last_swept_at` stays null and the window stays as wide as it needs to be.
- **Two questions about hubs, and neither is answered by a constant any more.** "What can a
  listing be near" is `hubsFromProject`, widened by `hubsWithPlaces` with the saved places, so Work
  can answer for a flat no neighbourhood is near. "What do we go looking through" is
  `sweepableHubs` — only the hubs carrying a Rightmove location identifier, read out of Rightmove's
  own page rather than guessed. A sweep page for Heathrow would be nonsense. Read the one that
  matches your question.

  Hubs are **project data** (`project_hub`) now, because a second project searching Manchester
  cannot be shown Hampstead. `SEED_HUBS` in `lib/hubs.ts` keeps the original five for the hand-run
  dev tools and the checks, and **is not the list any surface reads** — a surface reading it would
  put one project's neighbourhoods on another project's flat. `nearestHub` deliberately has no
  default for its hub list for the same reason. `lat`/`lon` are nullable and readers must skip a
  hub with no point rather than default one: a guessed coordinate silently corrupts every bearing
  computed from it, and nothing on screen would look wrong.
- **The sweep window snaps up, never down, and errs wide on purpose.** A window narrower than the
  gap since the last sweep drops listings on the floor and then reports the page fully recorded,
  which is the only failure here that looks exactly like success. Hence `SWEEP_MARGIN_HOURS`, and
  hence "Mark swept" being unavailable until the last page — marking a hub swept from page one
  would narrow the next window past everything nobody looked at. `pnpm check:sweep` pins the
  boundaries to the day.
- **The panel pages, not Rightmove.** Rightmove's own pager is a client-side route change: every
  card in the DOM is swapped and `__NEXT_DATA__` is left describing the page you were on. The
  panel notices (`staleAgainst`) and refuses to record — correct, and firing on every single page
  turn, which turned an honest warning into the normal experience. `nextPageUrl` builds the next
  page as a real navigation, from the URL you are actually on so a hand-narrowed search survives,
  and the panel offers that as the primary action once a page is recorded.
- **A paid placement is not a search result.** Rightmove puts a developer advert at the top of some
  results pages (`data-testid="RDL-property-card"`, "FEATURED NEW HOME — BUILT FOR RENTERS"). It
  links to a real listing and is deliberately absent from the results blob, so anything matching on
  `/properties/` links counted it as a card — and that mismatch is exactly what `staleAgainst`
  exists to notice. Every Primrose Hill page therefore reported itself as stale on load. `findCards`
  skips them, which is also right for badging: a sponsored new-build is not something either of
  them went looking for.
- **`maxDaysSinceAdded` is really "added *or changed* since".** It filters on the listing's update
  date, not on when it first appeared. Verified on a saved Hampstead page: all 25 cards were
  inside a 14-day window by update date, but one had been listed 27 days earlier and merely had
  its price cut five days before. `search_sighting` stores both dates for exactly this reason.
- **A cached travel time carries the basis it was measured on.** TfL's planner, asked without a
  date, plans against *right now* — so every transit number was whatever the network happened to
  be doing when somebody opened that listing, cached forever and then shown as "the commute". The
  compare table was ranking a Tuesday-morning measurement against a Sunday-midnight one. Transit
  is pinned to a weekday 09:00 departure (`TRAVEL_BASIS` in `lib/tfl.ts`); walking and cycling are
  `anytime`, which is what stops a basis change from invalidating two thirds of the cache.
  `staleTravel` decides whether a row still answers the question we now ask, so changing what we
  ask TfL heals the cache by itself rather than needing a migration. No-route answers expire
  (`NO_ROUTE_RETRY_DAYS`); positive ones do not — a negative is the one cached answer that can
  become false with nothing about the flat changing.
- **An impossible number from the model becomes an absent one.** `validateAnalysis` in
  `lib/analysis.ts` drops what cannot be true (a negative area, a room bigger than the flat, a
  total on an illegible floorplan) and warns rather than passing it on, because every view renders
  a number as settled fact. A broken *shape* still throws — half a row is worse than none. The
  constraints live there and not in the JSON schema because OpenAI's strict mode rejects
  `minimum`/`maximum` and cannot express cross-field conditions at all.
- **One flat can be two listings.** Rightmove relists, and two agents can carry the same place:
  Danbury Street is in the database twice, same postcode, same rent, with the two records
  disagreeing about everything the model read off their (different) photos. `duplicateIds` in
  `lib/shortlist.ts` matches on postcode *and* price and marks both rows ⧉. They stay two rows —
  merging them would pick one set of inferences over the other with nothing to justify the choice.
- **Every view starts on what you have an opinion about, and triage is where the rest goes.**
  `DEFAULT_SHOWING` in `lib/shortlist.ts` is the one place that decides it: excited and maybe on,
  unrated and rejected off, obeyed by the cards, the compare table and the map. A sweep is a
  machine for producing unrated listings — thirty-eight of them against thirteen rated — and mixed
  in they drown the decision the view exists to support. Nothing is hidden for good: each of those
  views turns the pile back on in one click. **Triage** is the other half of the same call. It
  shows only the unrated pile, gives each card a tick box and rates the whole selection at once,
  because the pile is mostly a "no" you can see from the card and one-at-a-time is why it never
  empties. Bulk rating writes no note deliberately — anything you have something to say about
  deserves the card's own note field. `smoke:shortlist` checks the selection and that the buttons
  are dead until something is ticked, and stops there: it reads the real database, and a bulk
  write would put verdicts neither of them gave onto real listings.
- **One fact, one renderer.** The panel and the shortlist have repeatedly drifted into stating the
  same thing differently — different sq ft from the same row, different travel rules, different
  wording for the same photo finding. Anything both views show lives in `packages/ui/src/` (see
  `Size.tsx`, `Journey.tsx`) or `packages/core/src/facts.ts`. Do not re-implement a fact in a view.

## The four facts that shape the whole design

1. **Search-results pages carry `__NEXT_DATA__`, not `__PAGE_MODEL`** — checked on a saved page
   before anything was built on it. It is plain JSON in the markup, holding every card on the
   page with id, address, price, beds, coordinates and dates, and it needs neither the decoder
   nor a MAIN-world script, because unlike `__PAGE_MODEL` it is ordinary DOM. It is written once
   server-side, so it does *not* follow Rightmove's client-side pager — `staleAgainst` in
   `lib/search-page.ts` is how the sweep notices rather than recording a page nobody is on.
2. **`window.__PAGE_MODEL`** (double underscore — the widely-cited `window.PAGE_MODEL` no
   longer exists) holds a complete JSON blob of the listing. We read it; we do not scrape.
   Its payload is **index-reference encoded** when `encoding === "on"` and must be decoded
   recursively — see `RESEARCH.md` §2 for the decoder.
3. **Nearest stations are already in that blob** (`nearestStations`), pre-computed server-side.
   The headline feature costs zero API calls.
4. **The full postcode is in the blob** (`address.outcode` + `address.incode`) even though the
   page only displays the outcode and fuzzes the map pin (`pinType: "APPROXIMATE_POINT"`).
   **Route from the postcode, not the lat/lon** — it is materially more accurate.

## Standing rules

- **Read pages the user opened; never crawl.** Do not call
  `rightmove.co.uk/api/property-search/listing/search` in the background, even though it works
  unauthenticated. That single line separates "a notes app" from "a scraper", both in spirit
  and under Rightmove's terms. See `RESEARCH.md` §5.

  The sweep panel does not bend this: it reads the results page you opened and clicked through
  yourself, and its paced opener opens listing pages one at a time in front of you. `pnpm
  find:locations` is the one thing here that fetches anything — five SEO paths, run by hand, to
  learn what Rightmove resolves each hub name to. It is a lookup you run once when the hub list
  changes, never something the extension does. **Do not take it as precedent for fetching in
  bulk**, and never move it into the extension.
- **Never re-host Rightmove images.** Store the URL or nothing (their ToS 13.4 is explicit
  about extensions embedding assets).
- **Keep distribution private** — load-unpacked only, never the Chrome Web Store. This rule
  predates auth and survives it. It is no longer about the key (which authorises nothing now); it
  is that a tool reading Rightmove listing pages, distributed at scale, is a different thing under
  their terms from one a handful of invited people run on pages they opened themselves. Access is
  an invite, not a download. `pnpm package` writes the zip; `SETUP.md` is the instructions that go
  with it. The manifest carries a fixed `key` so the
  extension id survives moving or replacing the folder, and with it the saved settings.
- **Select on `data-testid`, never on CSS-module class names.** Rightmove's hashed classes
  (`PropertyCard_propertyCardContainer__VSRSA`) change on every deploy.
- **Fail loudly.** If the page shape changes and extraction breaks, the panel must say so.
  Silently rendering blanks is worse than an error — it looks like "this listing has no nearby
  stations".

## Testing

Three tiers, fastest first. Run the first two on every change; the third when you have touched
anything a browser renders.

```bash
pnpm check          # oxlint + tsc. Under a second. No excuse for skipping it.
pnpm check:all      # the above plus every pure-function check below — 207 assertions, a few seconds
```

**Tier 1 — pure functions.** No browser, no network, no database. Each pins reasoning that is
invisible when it goes wrong, which is the whole reason they exist: a wrong bearing still looks
like a bearing, and a search window one bucket too narrow still returns a page full of flats.

| Command | What it protects |
|---|---|
| `pnpm check:area` | The sq-ft-from-prose parser. It once reported a 1,200 sq ft *garden* as the size of the flat. |
| `pnpm check:facts` | Which source wins when the listing and the floorplan disagree, hedged wording, elapsed dates, impossible values. |
| `pnpm check:hubs` | Distances, bearings, compass points, the 1-mile edge, and that a saved place never displaces a neighbourhood. |
| `pnpm check:sweep` | The sweep window's boundaries to the day, the search URL, the results reader, and when a hub counts as swept. |
| `pnpm check:travel` | What a cached travel time means, and when it stops meaning it. |
| `pnpm check:png` | Floorplan flattening. `--live` also fetches a real floorplan. |
| `pnpm check:analysis` | The model answers that are impossible rather than merely wrong. |
| `pnpm check:functions` | `deno check` over the Edge Functions. They are excluded from `tsc` and oxlint (Deno globals fail under the extension's tsconfig), so for a long time nothing checked them at all — which stopped being tolerable when the same tree grew JWT verification, the cap arithmetic and the invite ceiling. |
| `pnpm check:one-client` | That only `background.ts` constructs a Supabase client. The invariant the whole session design rests on; see the auth decision above. |
| `pnpm check:bridge` | The three-message contract between the website and the extension bridge — the relay that keeps the two sessions in step. |

**Tier 1b — the ones that need a database.** Deliberately **not** in `check:all`, which must stay
Docker-free and fast. They need a local Supabase (`supabase start` in this directory — this
project's stack sits on ports **5434x**, moved off the defaults because another project holds
54321-54324). Both fail loudly with instructions when no stack is up rather than skipping.

| Command | What it protects |
|---|---|
| `pnpm check:rls` | The security boundary, asserted from outside by real clients holding real JWTs. A policy that reads correctly and denies nothing looks exactly like a policy that works, and no amount of reading the SQL tells them apart. It also asserts what must still *work*: a database that refuses everything passes an adversarial test perfectly. |
| `pnpm check:spend` | The cap arithmetic, including concurrent claims for **different** listings — the case that defeated an earlier design, because a claim serialising on the listing lets every concurrent request read the same under-cap total. |

One trap in `check:rls` worth knowing before you debug it: **PostgREST 12.0.1, which the Supabase
CLI pins locally, intermittently dies mid-request.** The backend resets the connection, Kong
reports "an invalid response was received from the upstream server", and the process respawns
under the *next* call — so it surfaces as a boundary failure in a function that is entirely
correct. The `rpc()` helper retries it twice, which is only safe because the suite counts rows
afterwards.

**Tier 2 — the real page shapes.** These run the *shipped* extractor against a saved page, so a
break here is a break in the panel. Run them after a Rightmove deploy.

```bash
pnpm fixture 88023648                          # save a listing page (gitignored — their content)
pnpm check:extractor .fixtures/88023648.html   # prints the decoded Listing, flags empty fields

pnpm fixture:search Hampstead                  # a search page, built by the same function the links use
pnpm check:sweep .fixtures/search-hampstead.html
```

The sweep gets its own fixture because a search URL is a query string built from a hub's location
identifier rather than `/properties/<id>`, and hand-writing one is how you end up saving the wrong
neighbourhood.

**Tier 3 — the whole thing in a browser.** Playwright loads the built extension into Chromium and
reports what actually rendered, with screenshots in `.fixtures/shots/`.

```bash
pnpm build && pnpm smoke .fixtures/88023648.html   # the listing panel
pnpm smoke:shortlist                 # cards, compare table, map, settings, the lightbox
pnpm smoke:search                    # the sweep panel on a search page
pnpm smoke:sweep                     # the shortlist's Sweep view: hub links, the paced opener, Stop
```

### What the harnesses taught us the hard way

- **Playwright *fulfils* the real Rightmove URL from the saved file**, so the manifest's match
  patterns are satisfied and the content scripts inject exactly as they do in life, while no
  request leaves the machine.
- **Only `http(s)` is intercepted.** Aborting `chrome-extension://` requests starves the panel of
  its own stylesheet and it renders unstyled — which looks like a CSS bug that isn't there.
- **No harness may reach Rightmove, and interception alone did not achieve that** (`tools/offline.ts`).
  Two were quietly going out: `smoke:shortlist` fetched every saved property's thumbnails from
  Rightmove's CDN — hundreds of requests a run — and `smoke:sweep` drove the paced opener, which
  opens real listing pages. `keepOffline` answers the images from memory and blocks the rest, and
  the counts are printed so a run says what it stopped. What it could not stop is the opener's
  tabs: they are opened by the extension via `chrome.tabs.create`, and Playwright does not route
  that first navigation — the giveaway was every font and script of a listing page showing up as
  blocked, which meant the *document* had already loaded for real. So `OFFLINE_ARGS` makes the
  whole domain fail to resolve. Stubs are unaffected (they are answered before DNS), the opener's
  tabs land on Chrome's error page, which is all that check needs, and a future harness that
  forgets the route still cannot leak. Both go on every harness that launches a browser.
- **Wait for the text to stop changing, not for first paint.** The panel renders immediately and
  fills in identity, places and travel times as they arrive; an early screenshot shows an empty
  panel and reads as a broken database.
- **Rightmove's own CSS, JS and images are blocked**, so the page *behind* the panel is
  deliberately bare and the screenshots look washed out. That is the harness, not the extension.
- **A silent skip is worse than a failure.** `smoke:shortlist` once skipped its route-tooltip
  check without saying so, because `Hint` renders no wrapper when it has nothing to show — which
  is how a whole column of empty `journeys` survived review. `smoke:sweep` stubs its worklist for
  the same reason: left to the real database it would skip the pacing assertion whenever
  everything happened to be filled in. If a check cannot run, it has to say so loudly.
- **Assert what a person could see, not what the markup says.** The gallery painting *under* later
  cards was invisible to both markup and CSS inspection; `document.elementFromPoint` caught it.
- **`smoke:search` is the one harness that writes.** Recording a page into `search_sighting` is
  the behaviour under test and the rows are genuine sightings of genuine listings. It never
  completes a sweep — that would narrow what the *next* real sweep looks at.

## Packaging and distribution

```bash
pnpm build          # writes apps/extension/.output/chrome-mv3 for "Load unpacked"
pnpm package        # build + zip -> rightmove-house-hunt.zip (gitignored)
```

The **website deploys to Vercel** (`apps/web`, root directory `apps/web`, framework Next.js). It
needs `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`. A store build of the
extension then sets `WXT_WEB_APP_URL` to the deployed origin so the icon and the bridge point at
the live site rather than `localhost:3100`.

**`SETUP.md` is the instructions that go with the zip** — read it before sending anything. What
changed with auth: the zip is **no longer the shared password**. The publishable key compiled into
the bundle authorises nothing, and access is an invite to an email address plus a code sent to it.
Sending someone the zip without inviting them gives them a sign-in screen that will refuse them.

Load-unpacked only, never the Chrome Web Store — see the standing rule below. The manifest carries
a fixed `key` so the extension id survives replacing or moving the folder, and with it the saved
settings; without it Chrome derives the id from the folder path and a move silently empties
`chrome.storage`.

The Edge Functions deploy separately:

```bash
pnpm sync:function          # copy packages/core/src/{analysis,png}.ts into supabase/functions/_shared
pnpm deploy:function        # refuses to deploy if that copy is stale, then deploys every function
```

## Debugging

**"It shows nothing" is now most often a session, not a bug.** A signed-out panel says so, and a
signed-in one with no active project says that instead — both carry `data-testid` (`signed-out`,
`no-project`) so a harness can tell them apart from a real failure. Auth is read once per page, so
signing in from another tab does not repaint an open Rightmove page; the copy says to reload.
Second most often it is the cap: a project or a user past $20 for the month gets a `capped` notice
naming the scope and the reset date, and no analysis is requested.

**Start with the log.** Settings → Diagnostics → **Copy log** is what the extension actually did:
every TfL call, every retry, every failure, with timings. It exists because the other laptop is
not one you can attach a debugger to — when the person on it says "it's broken", this is what you
ask for.

**The background worker is where the network lives**, so most real failures are there rather than
in the panel. `chrome://extensions` → the extension card → **Inspect views: service worker**. MV3
tears the worker down when idle; opening the inspector wakes it, and a worker that was asleep is
not a worker that was broken.

**The panel lives in a Shadow DOM**, so `document.querySelector('.rm-panel')` finds nothing from
the page console. Select the host element and go through `.shadowRoot`, or use the smoke harness,
which already pierces it.

**Read the database directly** when you need to know what is really stored rather than what a view
renders. This is how the empty `journeys` column was found, and how the duplicated Danbury Street
listing was confirmed to be two real listings rather than a bug:

```bash
cd ~/GitHub/house-hunt && set -a && source .env && set +a
PGPASSWORD="$SUPABASE_DB_PASSWORD" psql \
  -h aws-1-eu-west-1.pooler.supabase.com -p 5432 \
  -U "postgres.$SUPABASE_PROJECT_REF" -d postgres
```

Migrations are applied the same way — run the file in `supabase/migrations/` through `psql -f`,
and commit it either way. (A global hook blocks the Supabase CLI's push command; it belongs to
another project and does not reflect anything about this one.)

**Two values are not in the migrations, on purpose.** Who the admin is and what the first project
is called belong to a deployment rather than to the schema, so the migration creates
`admin_email` empty and names the seeded project with a placeholder. `supabase/seed.example.sql`
is the template; copy it to `supabase/seed.sql` (untracked) and edit it. A fresh install with no
`seed.sql` has no admin, which is a visible state rather than a silent one: the Admin tab simply
never appears.

**When extraction breaks after a Rightmove deploy**, `pnpm check:extractor` tells you *that* it
broke; `tools/decode_page_model.py` tells you *what the page now looks like*, by verifying the
reference-encoding decode in isolation and printing the raw blob fields.

**Config problems look like data problems.** Only `WXT_*`-prefixed vars are bundled, so a missing
prefix produces an empty panel rather than an error. Check the key is actually in the build before
looking anywhere else:

```bash
grep -c "$(grep WXT_SUPABASE_URL .env | cut -d/ -f3)" apps/extension/.output/chrome-mv3/background.js   # 1
```

**A stale copy in Chrome is the most common "bug".** Reloading the extension is not enough for a
content script — the open Rightmove tab keeps running the old bundle until it is refreshed too.
And check `chrome://extensions` for a *second*, older copy loaded from a different folder: only
the one with id `jkcidomcogoaociobhbjankcpjgnhlji` carries the pinned key, and the other will
happily show you last week's behaviour.

## Related

- `../house-purchase/` — the buy-vs-rent analysis for the house we currently rent. Separate
  question, same domain; its `AGENTS.md` carries the standing methodology notes on Rightmove
  asking-vs-achieved prices and the Land Registry / EPC join.
- `registry/tools/rightmove-extension.yaml` — the hub manifest.
