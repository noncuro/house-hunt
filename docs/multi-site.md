# Eight agents' own websites: what was measured, and what was built

The app read Rightmove and nothing else. It now reads nine sites. This is the record of both the measurement that preceded that and the seam that came out of it, because the measurement says something the code does not: **the adapters were not built because the stock was missing.**

## What was measured

Seven of the eight sites were measured against Rightmove, each independently, before any adapter existed.

| Site | Sample matched | Site's own book | Rightmove's book for the same branches |
|---|---|---|---|
| Chestertons | 19/20 | 76 (Islington) | **79** |
| Austin Homes | 24/24 | 53 | 52 |
| Portico | 10/10 | 168 | ~180 extrapolated |
| Savills | 13/13 | — | Rightmove carried 2 Savills flats the site's own first page did not |
| Dexters | 46/48 | 48 live (SW4) | 46, every one accounted for |
| Foxtons | 25/25 in band | 150 live | superset in all 8 outward codes |
| TK International | 4/4 in band | 16 live London | — |
| John D Wood | 69/76 | 76 (4 Chelsea branches) | 110 rows, 39 of the 41 unmatched were let-agreed |

Two sites carry stock Rightmove does not:

- **John D Wood**: 4–5 of 76 (5–7%) appear nowhere on Rightmove under any agent, concentrated at the top of the market — the most expensive is £36,833 pcm.
- **Foxtons below £3,900 pcm**: roughly 7–12% of live stock is absent. The hunt's band is £4,500–£6,000, which sits above that tail, so it does not bear on this deployment.

Everything else is one CRM record rendered twice. These are feed-driven sites: the website and the portal read the same row, so there is no mechanism for holding stock back. Rightmove is a superset about as often as it is a subset.

The fallback argument was richer fields on the same flats — floor area without a vision pass, exact available-from, deposit, council tax. That one failed too, and closer to home. Across the four saved Rightmove fixtures `window.__PAGE_MODEL` carries:

```
full postcode      4/4      furnished          4/4      agent branch name    4/4
floor area sq ft   3/4      available from     4/4      agent company        4/4
council tax band   3/4      deposit            2/4      agent branch id      4/4
EPC image          4/4      let type           4/4      agent phone          4/4
```

`toListing` read none of the last five. The fields the adapters were going to buy were on the page this project already decodes, unread. They are read now (`20260905000000_multi_site_and_letting_terms.sql`).

Two of the site reports asserted that Rightmove withholds the full postcode. It does not — 4 of 4 — and `AGENTS.md`'s fourth fact was right.

## What was built anyway, and why that is not a contradiction

The measurement answers "will this find flats we are missing", and the answer is mostly no. It does not answer the other two things the seam bought, and those are what the code is for:

- **A flat can be added from wherever it is found.** Somebody sent a Dexters link; before this, that link had to be turned into a Rightmove search by hand. Every one of the eight can be read server-side, so `app/api/listing` reaches all of them and a phone keeps parity with a laptop — the rule in `AGENTS.md` that nothing may be reachable only through the extension.
- **The panel works where the reader is.** The same verdict, the same travel times, the same analysis, on an agent's own page rather than only on the portal.

Neither depends on exclusive stock. The overlap finding is still the reason nobody should build a **sweep** across these sites: sweeping eight more sites for flats Rightmove already has is eight times the work for the 5% at the top of John D Wood's book.

## The seam

`packages/core/src/sites/` — `types.ts` is the contract, `read.ts` the shared decoders, one file per site, `index.ts` the registry.

**`extract` takes an HTML string and never a `Document`.** That single constraint is what keeps a site addable from a phone: the route calls it on `await response.text()` server-side, and a `Document` parameter would quietly make a site extension-only. It is why no adapter uses a DOM parser and why none was added as a dependency.

**Keys are `<site>_<external id>`, and Rightmove's stay bare.** `property.rightmove_id` is referenced by ten tables, eight SQL functions and some five hundred call sites; renaming it buys a better word and no behaviour. Leaving Rightmove's ids as bare numbers means every row already written, every `#card-12345` link somebody bookmarked, and the `/^\d+$/` gates on `predict` and `analyse` kept working untouched. The separator is `_` because a key goes into a DOM id selected as `#card-<key>`, and `#card-foxtons:chpk123` parses as a CSS pseudo-class and matches nothing, with no error.

The database holds `site` and `external_id` beside the key, with a check constraint that the three agree. It is stated as an identity rather than as a list of nine sites, so a tenth needs no migration and a typo'd prefix still fails loudly.

### Platforms

| Site | Platform | Where the listing data is | Key |
|---|---|---|---|
| Chestertons | Homeflow, Next.js "pegasus" | RSC flight payload | numeric id |
| John D Wood | Homeflow, classic Rails | `Homeflow.set('property_data', …)` plus a separate map payload for postcode and coordinates | numeric id |
| Portico | Starberry, Next.js App Router | RSC flight payload, Strapi snake_case | CRM reference |
| Austin Homes | Estate Track over Street.co.uk | JSON-LD plus the flight payload | **URL slug** |
| Savills | bespoke Next.js | `__NEXT_DATA__` → Redux preloaded state | site id |
| Dexters | Joomla | JSON-LD `Product` plus markup | numeric id |
| Foxtons | Next.js Pages Router | `__NEXT_DATA__` | office reference |
| TK International | WordPress over Reapit | markup; the Yoast `@graph` describes the page, not the flat | **URL slug** |

**Chestertons and John D Wood are the same vendor two generations apart, not one adapter.** An earlier reading of this — 98 Homeflow references on John D Wood's homepage — was taken to mean one adapter covered both. It does not: one is a Rails app with an inline `property_data` object, the other a Next.js app with a flight payload. The vendor name is shared and nothing else is.

**Rightmove is the only one that cannot be read server-side** — it answers 403 from Varnish — which is why the extension exists at all.

### The RSC framing trap

Two adapters were written independently against App Router flight payloads, and both got the same thing wrong first, in a way that decoded one page perfectly and truncated another: **a `T<hex>,` row's length is a count of UTF-8 bytes, not of characters.** One curly apostrophe in a description makes the row one UTF-16 unit shorter than its own frame says, the walk lands short of the next header, and every row after it is lost — silently, because the rows that did parse look right. A framed row is also not newline-terminated: the next row's header follows its last byte immediately, so splitting the payload on newlines is wrong for two separate reasons.

That is now written once, in `flightRows` in `read.ts`, with the explanation attached. It is the strongest argument in this document for the shared-decoder file existing.

### Two sites key on a URL slug, and that is a real cost

Austin Homes and TK International name no id in their listing URLs. Both pages carry a stable CRM id — a `databaseId`, a WordPress post id, a Reapit reference — and on neither site does an id-addressed URL resolve to the listing. `listingId` is handed a URL and nothing else, and the key has to be derivable before any fetch, so the slug is the key.

What breaks: an agent retitles a listing, the permalink changes, and the same flat arrives under a second key with none of the first one's verdicts or funnel stage. TK's own archive already shows WordPress's dedupe suffixes in the wild (`…-nw3-6aa-3`, `…-nw3-7sb-2`), so this is observed rather than theoretical.

The mitigation is `packages/core/src/duplicates.ts`, which is the same mechanism that notices a flat on both an agent's site and Rightmove: a re-listing arrives as a same-site pair with the same postcode and the same rent, which is the loudest thing on that list. It advises and never merges — two flats in one block share a postcode, a bed count and often a rent, and a wrong merge attaches somebody's verdict to a flat they never saw.

### Withdrawn detection, where it exists

`ListingWithdrawn` is thrown only where a site has a page that *positively* says the listing has gone. Three do:

| Site | Signal |
|---|---|
| Rightmove | hollowed-out `__PAGE_MODEL` plus the withdrawn page's own consolation link |
| Foxtons | redirects to the outcode's search page; the landed page is `PropertySearchTemplate` with no `propertyDetail` |
| John D Wood | 301 to `/properties/lettings` with `page_route` of `properties#index` |
| Savills | `propertyDetail.property` explicitly null **and** no server-rendered `og:url` |

The other four answer a removed listing with a generic 404 or a redirect to the home page. There is nothing narrow to key on, so none of them guesses: `extract` throws a plain `Error` naming what was missing, and `app/api/listing` turns a 404 plus a throw into `withdrawn`. Reading an absence as "gone" would tell somebody a live flat had been taken down and stop the app reopening it — the same objection `isWithdrawn` in `listing.ts` was written around.

**Let-agreed is not withdrawn** and every adapter keeps them apart. A let flat serves its whole page and says so, which lands in `archived` — the flat stays readable and moves under Archived, and the verdict and the funnel stage are untouched. John D Wood's measurement is what makes this concrete: 39 of its 41 listings unmatched on Rightmove were let-agreed and still on the site.

## What was not measured

- **Anything but lettings**, and mostly one outward code per site. Dexters was SW4, John D Wood four Chelsea branches, Foxtons and TK Hampstead and Islington.
- **Chestertons and Savills at the prime end**, where an agent has the most reason to hold stock back. John D Wood's exclusive 5% was all prime, so this is where the finding is most likely to bend.
- **Whether the panel renders correctly on all eight**, as opposed to whether the adapter decodes the page. `pnpm check:sites` asserts the second against saved pages; nothing drives a browser against a live agent site (`docs/coverage.md`).
