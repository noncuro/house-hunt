# Rightmove extension — feasibility research

**Date:** 2026-08-09. **Question:** can we build a Chrome extension that (a) shows how far a
listing is from the places we actually care about, and (b) lets a couple mark
places yes/no against a shared database?

**Answer: yes, and it's easier than expected.** Rightmove hands the extension everything it
needs in the page itself. The travel-time half is free inside London. The shared-state half is
a small Supabase schema. Estimated build: **~3 focused days** to something genuinely useful.

Everything marked ✅ below was verified live against rightmove.co.uk on 2026-08-09, not taken
from a blog post. Several widely-cited blog claims are **out of date** — see §2.

> **Read this as the document that was written before the extension existed.** It is kept because
> it is where the reasoning lives: what else is already on the market, what the page actually
> hands you, why TfL rather than Google, and where the terms of service sit. Those parts are still
> the best account of why the design is the shape it is, and §2 in particular is load-bearing —
> the decoder in `src/lib/decode.ts` still points at it.
>
> What it is *not* is a description of what was built. The proposals in §4, §6, §7 and §8 were
> written as proposals and several were decided differently once there was code. Each place that
> happened now carries a note saying so, and the short version is: there is no login and no
> `household` table, there is no popup, and the Chrome Web Store was ruled out rather than
> deferred. `AGENTS.md` is the source of truth for what exists today.

---

## 1. Prior art — this has been built many times

Worth knowing before writing code: the space is crowded, and two existing products already do
roughly one half each of what we want.

### Closest existing products

| Product | What it does | Overlap with us |
|---|---|---|
| [Commutable](https://commutable.io/) | Overlays live commute times onto Rightmove search results **and** listing pages. Set a destination, pick a mode, filter by max travel time. | **The travel-time half, almost exactly.** Free tier + paid "unlimited". |
| [Commute Time for Rightmove & Zoopla](https://chrome-stats.com/d/oiicpghmoodgebjoigmmopghpckbddcm) | Same idea, separate vendor, multiple travel modes. | Same. |
| [MoveTwo](https://movetwo.app/blog/share-rightmove-shortlist-with-partner.html) | Built **specifically for couples house-hunting together** — shared dashboard instead of texting each other screenshots. | **The shared-verdict half.** |
| [Rightmove Property Notes](https://chromewebstore.google.com/detail/rightmove-property-notes/ddnkogahnfkgkechllbdfgacnkikddbf) | Per-listing annotations. | Notes, but single-user. |
| [Property Log](https://chromewebstore.google.com/detail/property-log/jccihedpilhidcbkconacnalppdeecno) | Price-change history per listing. Running since 2018, self-reports "tens of thousands" of daily users. | None — but proves the category is durable and tolerated. |

**Nobody found does both halves against *your own* named places.** That's the gap, and it's a
real one: Commutable gives you commute time to *a* destination; what you actually want is a
row of distances to *your* set — nearest tube, the office, Heathrow, in-laws, the gym — plus a
shared verdict, on one card.

### Other feature categories people have built (as an idea menu)

Crime data ([Property Insights](https://chromewebstore.google.com/detail/property-insights-for-rig/ekekfaccokekemoaafkomdhgbgppljkd),
[Crime info](https://chromewebstore.google.com/detail/crime-info-for-properties/ebdnmmnchominjgodeldfnagmdnepcfo)),
schools/Ofsted ([MySchoolHub](https://chromewebstore.google.com/detail/myschoolhub-for-rightmove/ekoakncbhojndngofkankcomhbpjcpob),
[Locrating](https://chromewebstore.google.com/detail/locrating-property-portal/cafiegpgchhbobdeofoicnjjjmjieipo)),
flood risk + noise (Locrating, Area360), yield/ROI analytics
([PaTMa](https://www.patma.co.uk/page/property-tools-browser-extensions/),
[Lendlord](https://lendlord.io/unlock-hidden-investment-data-on-rightmove-with-lendlord-deal-analyser),
[PropertyData](https://propertydata.co.uk/browser-extension)), CSV export
([RightmoveCSV](https://rightmovecsv.com/)), missing filters
([RightMove Filters](https://chromewebstore.google.com/detail/rightmove-filters/blpfmchlppdpboalglpbjhipdojnfpgp) — bathroom count).

Note: **"hide seen listings" and "saved shortlists" are already native Rightmove account
features** ([Hide it](https://www.rightmove.co.uk/news/articles/property-news/introducing-hide-it/),
[Property Lists](https://www.rightmove.co.uk/news/articles/property-news/property-lists/)) — no
need to rebuild them. What's *not* native is a shared, two-person, opinionated verdict.

### Open-source reference implementations

Rightmove's own extensions are closed-source, but these are readable:

- [afspies/homehunt](https://github.com/afspies/homehunt) — Rightmove + Zoopla CLI, does commute
  analysis via the TravelTime API and coordinate extraction. Closest in spirit to our goal.
  Also documents that **Zoopla needs an anti-bot bypass service while Rightmove doesn't** —
  useful if we ever extend beyond Rightmove.
- [scrapfly/scrapfly-scrapers/rightmove-scraper](https://github.com/scrapfly/scrapfly-scrapers/blob/main/rightmove-scraper/rightmove.py)
  — the canonical `PAGE_MODEL` decode logic (see §2 for the gotcha).
- [nikitaindik/funda-neighbourhoods](https://github.com/nikitaindik/funda-neighbourhoods) and
  [BigMistake/FundaExtend](https://github.com/BigMistake/FundaExtend) — open-source *extensions*
  (Dutch portal Funda) doing exactly this pattern. Good structural reference.
- [daattali/cashflow-calculation-extension](https://github.com/daattali/cashflow-calculation-extension)
  — clean MV3 extension injecting a panel into Zillow/Redfin listings.

---

## 2. How to get the data out of the page ✅

**This is the good news. We do not need to scrape anything — Rightmove ships a complete JSON
blob of the listing into the page, and we just read it.**

### The global is `window.__PAGE_MODEL`, not `window.PAGE_MODEL`

Every blog post and scraper tutorial still says `window.PAGE_MODEL`. **That name no longer
exists.** Verified live:

```
$ grep -c "window\.PAGE_MODEL[^_]"  rm.html   →  0
$ grep -o  "window\.__PAGE_MODEL"   rm.html   →  window.__PAGE_MODEL
```

Existing scrapers still work only because they match with an XPath *substring*
(`contains(., 'PAGE_MODEL = ')`), which `window.__PAGE_MODEL = ` still satisfies. A content
script reading the property by name would get `undefined`. **Use the double underscore.**

### The payload is reference-encoded, not plain JSON

```js
window.__PAGE_MODEL = { data: "<a JSON string>", encoding: "on" }
```

When `encoding === "on"`, `data` parses to a **flat array of nodes**, where every object value
is an *index into that array* rather than the value itself. `{"propertyData": 1}` means "node 1
holds the real object". You must resolve recursively:

```js
function decode(nodes, idx) {
  const node = nodes[idx];
  if (Array.isArray(node)) return node.map(i => decode(nodes, i));
  if (node && typeof node === "object")
    return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, decode(nodes, v)]));
  return node;                       // primitive
}
const nodes = JSON.parse(window.__PAGE_MODEL.data);
const property = decode(nodes, nodes[0].propertyData);
```

Miss this and you silently get integers where you expected objects. (Verified working —
`house-hunt` scratch decoder round-tripped a live page.)

### What we get ✅ (real output from a live listing)

```jsonc
"location":  { "latitude": 51.53853, "longitude": -0.1689,
               "pinType": "APPROXIMATE_POINT", "zoomLevel": 15 },

"address":   { "displayAddress": "Avenue Road, St Johns Wood, London, NW8",
               "outcode": "NW8", "incode": "6HS",          // ← full postcode!
               "deliveryPointId": 72365290, "ukCountry": "England" },

"prices":    { "primaryPrice": "£49,950,000", "pricePerSqFt": "£2306.20 per sq ft" },

"nearestStations": [
  { "name": "St. John's Wood Station",  "types": ["LONDON_UNDERGROUND"], "distance": 0.3628, "unit": "miles" },
  { "name": "Swiss Cottage Station",    "types": ["LONDON_UNDERGROUND"], "distance": 0.4158, "unit": "miles" },
  { "name": "South Hampstead Station",  "types": ["LONDON_OVERGROUND"],  "distance": 0.4872, "unit": "miles" }
],
"nearestAirports": [ /* same shape; empty on urban listings */ ]
```

Full top-level key list: `id, status, text, prices, address, keyFeatures, images, floorplans,
customer, rooms, location, streetView, nearestAirports, nearestStations, sizings, brochures,
epcGraphs, bedrooms, bathrooms, transactionType, tags, listingHistory, broadband, tenure,
livingCosts, mortgageCalculator, propertySubType, features, reviews, …`

### Two findings that materially improve the product

**① Nearest stations are free — they're already on the page.**
`nearestStations` is pre-computed server-side and baked into the HTML. Your headline feature
("distance to the nearest tube") costs **zero API calls and zero latency**. Caveat: these are
straight-line miles, not walking time — we can upgrade to walking time via TfL if we want.

**② The full postcode is in the JSON even though the page hides it.**
The listing *displays* "London, NW8" and the map pin is deliberately fuzzed
(`pinType: "APPROXIMATE_POINT"`). But `outcode` + `incode` give **NW8 6HS** — a precise
postcode, backed by a Royal Mail `deliveryPointId`. This is a big deal: **route from the
postcode, not the fuzzed lat/lon**, and travel times will be accurate rather than
approximately-right. TfL's journey planner accepts a postcode directly.

### Search results pages are a different app

| | Property detail page | Search results page |
|---|---|---|
| Framework | React + `loadable-components`. **No `__NEXT_DATA__`** ✅ | Next.js Pages Router, `getServerSideProps` |
| Data location | `window.__PAGE_MODEL` (ref-encoded) | `<script id="__NEXT_DATA__">` → `props.pageProps.searchResults.properties` (plain JSON, ~25 per page) |
| Navigation | Full document load | Possibly **soft SPA transitions** on pagination/filter — use a `MutationObserver` |
| Stable selectors | — | `data-testid="propertyCard-N"`. **Never** the hashed CSS-module classes (`PropertyCard_propertyCardContainer__VSRSA`) — those change every deploy |

Search-result objects carry `id, price, displayAddress, location{lat,lng}, bedrooms,
bathrooms, propertySubType, propertyUrl, customer` — enough to badge every card with a verdict
and a travel time without opening anything.

### MV3 mechanics: you need a MAIN-world content script

A default content script runs in an **isolated world** and cannot see page globals — it would
never see `window.__PAGE_MODEL`. Since Chrome 111 you can declare this in the manifest:

```json
{ "matches": ["https://www.rightmove.co.uk/properties/*"],
  "js": ["main-world-extractor.js"],
  "world": "MAIN",
  "run_at": "document_start" }
```

A MAIN-world script has **no access to `chrome.*` APIs**, so the standard pattern is: MAIN
script reads + decodes → `window.postMessage()` → ISOLATED content script (which has
`chrome.runtime`) → background service worker.
([Chrome docs](https://developer.chrome.com/docs/extensions/reference/manifest/content-scripts))

### Undocumented endpoints (available, but we probably shouldn't use them)

Both return JSON to a plain unauthenticated GET:
`https://los.rightmove.co.uk/typeahead?query=…` (place → `locationIdentifier`) and
`https://www.rightmove.co.uk/api/property-search/listing/search?…`. **Recommendation: don't.**
See §5 — calling the search API in the background is the one behaviour that turns "a notes app
for pages I'm looking at" into "a crawler".

---

## 3. Travel times to the places we care about

### Recommended: TfL first, Google only as fallback

| Source | Covers | Cost | Verdict |
|---|---|---|---|
| **Page JSON** (`nearestStations`) | Nearest tube/rail, straight-line | **Free, already there** | Use always |
| **[TfL Unified API](https://api.tfl.gov.uk)** | London public transport, walking, cycling, driving — door-to-door with changes | **Free**, 500 req/min with a key | **Primary** |
| **Google Routes API** | Anywhere in the UK, driving with live traffic | Paid per element, tiered from ~$5 CPM | Fallback for non-London destinations |
| TravelTime API | Isochrones, bulk matrices | Paid, free trial | Only if we want map isochrones later |

TfL's journey planner takes raw coordinates *or* a postcode — verified format:

```
GET https://api.tfl.gov.uk/journey/journeyresults/{from}/to/{to}?app_key=…
    e.g. .../journeyresults/NW8 6HS/to/EC2A 2BB
```

Free key from [api-portal.tfl.gov.uk](https://api-portal.tfl.gov.uk). Heathrow, Gatwick,
Stansted and Luton are all reachable in TfL's planner, so "how long to the airport" is free
too. Only genuinely out-of-London destinations (parents in another city) need Google.

> **Since built:** the journey planner turned out to answer unauthenticated, so no key was ever
> obtained. `WXT_TFL_APP_KEY` is optional and only raises the rate limit. The Google Routes
> fallback was never written: asking TfL for a driving route throws a clear error rather than
> returning a public-transport number under a driving label, and Google remains the planned fix.
> The cache is keyed on `(postcode, place_id, mode)` as sketched below, and it also stores the
> basis a measurement was taken on, because a transit time is only comparable against another one
> measured at the same time of week — see the `TRAVEL_BASIS` note in `AGENTS.md`.

### Cache aggressively — it makes the API cost ~nothing

Travel time from a postcode to a fixed place doesn't change. Cache in Supabase keyed on
`(postcode, place_id, mode)`. Because **both users share the cache**, each property costs its
API calls exactly once, ever, across both machines. A few hundred viewed properties × 5 saved
places = low thousands of calls total — comfortably free on TfL.

---

## 4. Proposed architecture

```
┌─ Rightmove tab ─────────────────────────────────────────┐
│  MAIN world script    reads window.__PAGE_MODEL, decodes │
│         │ postMessage                                    │
│  ISOLATED content script                                 │
│         │  renders panel (Shadow DOM, so Rightmove CSS   │
│         │  can't leak in and ours can't leak out)        │
│         │  chrome.runtime.sendMessage                    │
└─────────┼───────────────────────────────────────────────┘
          ▼
   Background service worker
     • Supabase client (storage adapter → chrome.storage.local)
     • travel-time fetches (TfL / Google), cache read-through
          │
          ▼
      Supabase  ──  shared between both laptops, realtime
```

This is what was built, with three corrections the notes below explain: there is no storage
adapter because there is no session, Google is not wired up, and realtime is enabled on the tables
without anything subscribing to it, so the other laptop sees a change on its next load rather than
instantly. The Edge Function that runs the vision pass over the photos is missing from the picture
entirely — it did not exist as an idea yet.

**Stack:** [WXT](https://wxt.dev) + React + TypeScript. WXT is the best-maintained extension
framework in 2026 — Vite-based, actively developed, ~400 KB output; Plasmo has effectively
gone into maintenance mode.

**Supabase auth in MV3 — the one known trap.** Service workers have no `localStorage`, and
Chrome tears them down when idle, so a default Supabase client loses its session on every
restart. Fix: pass a custom storage adapter backed by `chrome.storage.local`, and set
`persistSession: true`, `autoRefreshToken: true`, `detectSessionInUrl: false` (no `window` in a
service worker). For two trusted users, **email + password sign-in in the popup** avoids the
whole `chrome.identity.launchWebAuthFlow` / offscreen-document dance — recommend that.

> **Not built, and deliberately so.** There is no sign-in at all. The publishable key ships in the
> bundle and *is* the shared secret between the two laptops, identity is a name typed into
> Settings, and the client is created with `persistSession: false` — there is no session to lose,
> so the trap above is sidestepped rather than solved. There is also no popup: clicking the
> extension icon opens the shortlist page, and Settings is a tab on it. The tradeoff is that
> anyone holding the key holds the data, which is why the zip is treated as a password in
> `SETUP.md` and why distribution stays private. Bringing auth back is the subject of
> `openspec/changes/multi-tenant/`, which is a proposal and not implemented.

### Schema sketch

```sql
household        (id, name)
household_member (household_id, user_id)              -- RLS pivot: the two of us

place            (id, household_id, label, postcode, lat, lng, modes[])
                 -- "Office", "Heathrow", "Mum & Dad", "the gym"

property         (id, household_id, rightmove_id, url, postcode, lat, lng,
                  price, bedrooms, address, nearest_stations jsonb,
                  first_seen_at, snapshot jsonb)

verdict          (property_id, user_id, rating, note, updated_at)
                 -- rating: 'no' | 'maybe' | 'love'   ← per person, so disagreement is visible

travel_time      (postcode, place_id, mode, seconds, changes, computed_at)
                 -- shared cache, the thing that makes this cheap
```

RLS: every policy is `household_id in (select household_id from household_member where
user_id = auth.uid())`. One shared household, both members, done.

**Why `verdict` is per-user, not per-property:** the interesting signal is where you two
*disagree*. A single shared rating destroys that. Per-user ratings let the panel show
"👍 Alex / 👎 Sam" and surface exactly the listings worth arguing about.

> **What the schema actually became.** The per-user verdict survived and is the one part of this
> sketch that shipped as drawn, except that it keys on a `person` name rather than a `user_id`,
> because there are no users. Everything to do with households went away with the auth decision:
> there is no `household` or `household_member` table, and there is no tenancy column anywhere.
> RLS is enabled on every table and every policy is a single permissive `shared_household` grant
> to `anon` — enabled so that turning it into something real is a policy change rather than a
> migration, and permissive because the key in the bundle is the only credential there is.
>
> The tables today are `property`, `verdict`, `place`, `travel_time`, `property_analysis`,
> `search_sighting`, `hub_sweep`, `station_point` and `station_walk`. `property` keys on
> `rightmove_id` rather than a surrogate id and carries the extracted listing in named columns
> rather than a `snapshot jsonb`; the last four tables are all things this document did not
> anticipate — the photo and floorplan analysis, the record of which search pages have been swept,
> and the station coordinate and walking-time caches. `supabase/migrations/` is the real
> record, in order, with a comment on each explaining what it was for.

### The feature that will actually change your day

Badging **search results**. Once a verdict exists, every card on every future search page shows
it — greyed out for "no", highlighted for "love", with the note on hover. You stop re-opening
listings you already rejected, which is the single most annoying part of portal house-hunting.
Travel times on the cards (from cache) come along for free.

---

## 5. Terms of service — read this bit

Rightmove's [Terms of Use](https://www.rightmove.co.uk/c/terms-of-use/) are broader than you
might hope, and I'd rather flag it now than have it surprise you:

- **5.2** prohibits "bots, crawlers, scrapers or other automated programs or means to access or
  collect data".
- **5.5** restricts access to "direct human interaction with the menu system, hyperlinks and
  search and filter functions" via a browser or the approved app.
- **5.5.1** requires **prior written consent from Rightmove Legal** for programmatic access.
- **13.4 / 13.5** specifically prohibit embedding Rightmove **images** or other assets in an
  "extension, plug in, or computer program" without written consent — this clause appears
  written with browser extensions in mind.

**Honest read:** there is no ToS carve-out for "it's a content script in my own browser". The
technical distinction is real and significant — reading JSON that Rightmove already sent to
your own browser for a page you personally opened puts no extra load on them and is
indistinguishable from browsing — but the ToS text doesn't grant it special status. Note also
that the ToS is a *contract* matter, not a criminal one; the practical downside is account
action, not liability, and dozens of these extensions have run publicly for years (Property Log
since 2018) without visible enforcement.

**Design rules that keep the footprint minimal — all of these are also just good engineering:**

1. **Never call the search API in the background.** Only read pages you actually opened. This
   is the line between "a notes app" and "a crawler", and it's the one that matters.
2. **Don't re-host their images.** Store the image *URL* only, or nothing. Clause 13.4 is
   explicit.
3. **Keep it private.** Load-unpacked only. Do not publish, at any visibility setting — see the
   note in §6 for why the Chrome Web Store option offered here was later ruled out entirely.
4. Store only what's needed for your own decision-making, and don't redistribute it.

None of this constrains the product you actually described — it's already "annotate the pages
we look at". Worth deciding consciously rather than by accident.

---

## 6. Distribution

- **v1: `chrome://extensions` → Load unpacked** on both laptops. Zero friction, no $5 fee, no
  review. Downside: no auto-update, and Chrome nags about developer mode on each launch.
- **v2: Chrome Web Store, visibility "Private"** — installable *only* by the Google accounts you
  list as trusted testers. Gets auto-updates and kills the nag. Costs the one-off $5 developer
  fee and a review pass. ("Unlisted" is *not* the right choice — anyone with the URL could
  install it.)

Recommend unpacked until the schema settles, then a private listing.

> **Decided otherwise.** v2 is not going to happen, and it is now a standing rule that it must
> not. The reason is the auth decision above: with the database key compiled into the bundle,
> putting the extension anywhere a stranger can obtain it hands out the database, and a Chrome Web
> Store listing is exactly that whatever its visibility setting. Load-unpacked is the permanent
> answer rather than the starter one. The manifest carries a fixed `key` so that the extension id
> survives moving or replacing the folder, which recovers the one thing a store listing would have
> given us — settings that outlive an update.

---

## 7. Build plan

| Stage | Scope | Est. |
|---|---|---|
| **v1 — shared verdicts** | WXT skeleton, MAIN-world extractor + decode, Supabase schema + RLS + email/password auth, panel on detail pages with 👍/🤔/👎 + note, `nearestStations` rendered (free), verdict badges on search cards | ~1 day |
| **v2 — travel times** | `place` CRUD in the popup, TfL journey planner via background worker, Supabase read-through cache, travel-time row in the panel | ~1 day |
| **v3 — the daily driver** | Travel times on search cards, filter/sort by them, dim rejected listings, realtime sync so a verdict appears on the other laptop instantly, Google Routes fallback for out-of-London places | ~1 day |

**Biggest open risk:** Rightmove renaming `PAGE_MODEL` → `__PAGE_MODEL` (as they already did
once) or changing the encoding. Mitigate by extracting via substring match rather than property
name, validating the decoded shape, and failing loudly in the panel ("couldn't read this
listing") rather than silently rendering blanks.

> **How the three stages actually went.** All three shipped, in roughly this order and rather
> faster than a day each, with the auth line of v1 dropped and the Google fallback of v3 never
> started. What the plan did not contain is most of what the tool now is: the vision pass over the
> photos and the floorplan, the neighbourhood hubs that let a flat read as "0.4 mi NE of Angel",
> and sweeping, which is the deliberate half of the tool and the only part that goes looking
> rather than reacting. `AGENTS.md` describes those. The failure-loudly mitigation was taken and
> is now a standing rule.

---

## 8. Decisions still to make

1. **Build vs buy.** Commutable + MoveTwo together cover ~80% of this for maybe £10–15/mo. We'd
   be building for the last 20% — *your* exact places, one panel, one shared DB, no
   subscription. Fine reason to build; just naming it.
2. **Which places?** The initial `place` list — office(s), Heathrow, in-laws, gym, anything else.
   Postcodes are enough.
3. **Rent or buy channel** — or both? Affects which page patterns we match.
4. **Zoopla / OnTheMarket later?** Doesn't change v1 architecture (the extractor is already
   pluggable), but Zoopla is meaningfully harder and worth deferring.

> **Answered, and the answers are what got built.** Build rather than buy. The places are Work
> (EC1V 1JN), Oxford Circus and Heathrow, and they are rows in the database rather than anything
> in the code, so the list changes in Settings and not in a deploy. Rent only: the panel matches
> `rightmove.co.uk/properties/*` and the sweep panel matches `property-to-rent/find.html`, so a
> for-sale search gets nothing. Zoopla was deferred and has stayed deferred. What the question
> list missed is the neighbourhoods: five of them, in `SWEEP_HUBS`, and they turned out to matter
> more to reading a listing than the saved places do, which is why a hub always outranks a place
> when the panel labels where a flat is.

---

## Sources

Verified live 2026-08-09: `rightmove.co.uk/properties/155320229`,
`rightmove.co.uk/property-for-sale/find.html`, `los.rightmove.co.uk/typeahead`,
`rightmove.co.uk/api/property-search/listing/search`.

[Rightmove Terms of Use](https://www.rightmove.co.uk/c/terms-of-use/) ·
[Chrome content-script `world`](https://developer.chrome.com/docs/extensions/reference/manifest/content-scripts) ·
[Chrome distribution options](https://developer.chrome.com/docs/webstore/cws-dashboard-distribution) ·
[TfL Unified API](https://tfl.gov.uk/info-for/open-data-users/api-documentation) ·
[Google Maps Platform pricing](https://developers.google.com/maps/billing-and-pricing/pricing) ·
[WXT](https://wxt.dev) ·
[Supabase in MV3 service workers](https://github.com/orgs/supabase/discussions/6527) ·
[ScrapFly Rightmove guide](https://scrapfly.io/blog/posts/how-to-scrape-rightmove) ·
[scrapfly-scrapers/rightmove.py](https://github.com/scrapfly/scrapfly-scrapers/blob/main/rightmove-scraper/rightmove.py) ·
[afspies/homehunt](https://github.com/afspies/homehunt) ·
[funda-neighbourhoods](https://github.com/nikitaindik/funda-neighbourhoods) ·
[cashflow-calculation-extension](https://github.com/daattali/cashflow-calculation-extension)
