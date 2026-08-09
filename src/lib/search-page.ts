/** Reading a Rightmove search-results page.
 *
 *  **This is not `__PAGE_MODEL`.** The listing pages carry that blob and `lib/decode.ts` unpacks
 *  it; the search pages do not have it at all. I checked before designing around it, on a saved
 *  copy of the Hampstead sweep URL: there is no `__PAGE_MODEL` anywhere in the document. What a
 *  search page has instead is Next.js's `__NEXT_DATA__`, a plain JSON `<script>` in the markup,
 *  holding `props.pageProps.searchResults` with every card on the page — id, address, price,
 *  beds, baths, coordinates and the date it first appeared. It is not reference-encoded, so
 *  nothing here needs the decoder.
 *
 *  Two consequences worth knowing. It is ordinary DOM, so the isolated world can read it and no
 *  MAIN-world script is needed — the reason `page-model.content.ts` exists is that
 *  `window.__PAGE_MODEL` is a JavaScript variable, and this is not. And it is server-rendered
 *  once, so it does **not** follow a soft SPA navigation; `staleness` below is how we notice.
 *
 *  Reading it is reading a page the user opened, which is the line AGENTS.md draws. Nothing here
 *  fetches anything.
 */

/** One card, reduced to what is worth keeping about a property we have not opened yet. */
export interface SearchCard {
  rightmoveId: string;
  url: string;
  displayAddress: string;
  /** Rightmove's own formatting, "£4,800 pcm" — kept as text for the same reason `property.price`
   *  is text: the qualifier ("pcm", "pw") is part of the fact. */
  price: string | null;
  bedrooms: number | null;
  bathrooms: number | null;
  /** Rightmove's fuzzed pin. Good enough to tell which hub a card belongs to, and deliberately
   *  not used for anything finer — the postcode-derived point on the property row is the accurate
   *  one, and we do not have a postcode until the listing itself is opened. */
  latitude: number | null;
  longitude: number | null;
  /** When Rightmove first showed it, ISO. */
  firstVisibleAt: string | null;
  /** When it last changed, ISO — and **this, not `firstVisibleAt`, is what `maxDaysSinceAdded`
   *  filters on**. A saved Hampstead search with a 14-day window returned a flat first listed 27
   *  days earlier whose price had been cut 5 days before; every one of the 25 cards was inside
   *  the window by this date and only 24 were by the other. The filter means "added or changed
   *  since", which is worth knowing before trusting a sweep to have caught everything new. */
  listingUpdateAt: string | null;
  /** "new" or "price_reduced" on the page we checked. */
  listingUpdateReason: string | null;
  /** Their wording — "Added yesterday", "Reduced on 04/08/2026". Worth storing verbatim because
   *  "reduced" and "added" are different events and the date alone loses which one happened. */
  addedOrReduced: string | null;
}

export interface SearchPage {
  /** `<locationType>^<id>` as the page itself resolved it — the thing to match a hub against.
   *  Matching on the URL's query string instead would trust what we asked for over what we got. */
  locationIdentifier: string;
  locationName: string;
  /** Total across every page, not the count on this one. */
  resultCount: number;
  page: number;
  totalPages: number;
  /** What `maxDaysSinceAdded` the page was actually served with, if any. Lets the panel notice
   *  that the human is looking at an unfiltered search and warn before "swept" is recorded. */
  maxDaysSinceAdded: number | null;
  cards: SearchCard[];
}

export type SearchPageResult =
  | { ok: true; page: SearchPage }
  | { ok: false; error: string };

/** Pull the search results out of a document. Fails loudly and specifically: a shape change here
 *  must read as "Rightmove moved something", never as "this search found nothing". */
export function readSearchPage(doc: Document = document): SearchPageResult {
  const script = doc.getElementById('__NEXT_DATA__');
  if (!script?.textContent) {
    return { ok: false, error: 'no __NEXT_DATA__ script on this page — Rightmove may have changed the search page' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(script.textContent);
  } catch (e) {
    return { ok: false, error: `__NEXT_DATA__ is not valid JSON: ${e instanceof Error ? e.message : String(e)}` };
  }

  // An untyped JSON blob from someone else's page is exactly what this is, and `any` is the
  // honest description of the boundary. Every field is narrowed on the way out.
  // oxlint-disable-next-line no-explicit-any
  const results = (parsed as any)?.props?.pageProps?.searchResults;
  if (!results) {
    return { ok: false, error: '__NEXT_DATA__ has no props.pageProps.searchResults — the search page shape changed' };
  }
  if (!Array.isArray(results.properties)) {
    return { ok: false, error: 'searchResults.properties is missing or not a list' };
  }

  const location = results.location;
  if (!location?.locationType || location.id === undefined) {
    return { ok: false, error: 'searchResults.location does not say which area was searched' };
  }

  const parameters = results.searchParameters ?? {};
  const maxDays = Number(parameters.maxDaysSinceAdded);

  return {
    ok: true,
    page: {
      locationIdentifier: `${location.locationType}^${location.id}`,
      locationName: location.displayName ?? location.shortDisplayName ?? 'this area',
      // resultCount arrives formatted once it passes a thousand ("37,666"), so it is a string as
      // often as it is a number.
      resultCount: Number(String(results.resultCount ?? '').replace(/[^0-9]/g, '')) || 0,
      page: Number(results.pagination?.page ?? 1) || 1,
      totalPages: Number(results.pagination?.total ?? 1) || 1,
      maxDaysSinceAdded: Number.isFinite(maxDays) && maxDays > 0 ? maxDays : null,
      // One entry per flat. Rightmove lists a featured property in its own strip *and* again in
      // the results below, so `properties` can carry the same id twice — which made the panel
      // count 25 listings on a page showing 24 flats, and made every tally downstream
      // (new / part-filled / done, and what the opener has left to do) quietly wrong.
      cards: distinctById(
        // oxlint-disable-next-line no-explicit-any
        results.properties.map(toCard).filter((card: SearchCard | null): card is SearchCard => card !== null),
      ),
    },
  };
}

/** Keeps the first of each id. Which copy wins does not matter — both are the same listing read
 *  from the same blob — but the order does, because the panel's opener works down this list and
 *  should follow the page's own reading order. */
function distinctById(cards: SearchCard[]): SearchCard[] {
  const seen = new Set<string>();
  const kept: SearchCard[] = [];
  for (const card of cards) {
    if (seen.has(card.rightmoveId)) continue;
    seen.add(card.rightmoveId);
    kept.push(card);
  }
  return kept;
}

// oxlint-disable-next-line no-explicit-any
function toCard(raw: any): SearchCard | null {
  const id = raw?.id;
  if (id === undefined || id === null) return null;
  const rightmoveId = String(id);

  return {
    rightmoveId,
    // Their own `propertyUrl` carries a `#/?channel=RES_LET` fragment that the listing page does
    // not need and that would make the stored URL differ from the one `property` already holds
    // for the same flat. Build the canonical form instead.
    url: `https://www.rightmove.co.uk/properties/${rightmoveId}`,
    displayAddress: raw.displayAddress ?? '',
    price: raw.price?.displayPrices?.[0]?.displayPrice ?? null,
    bedrooms: numberOrNull(raw.bedrooms),
    bathrooms: numberOrNull(raw.bathrooms),
    latitude: numberOrNull(raw.location?.latitude),
    longitude: numberOrNull(raw.location?.longitude),
    firstVisibleAt: typeof raw.firstVisibleDate === 'string' ? raw.firstVisibleDate : null,
    listingUpdateAt:
      typeof raw.listingUpdate?.listingUpdateDate === 'string' ? raw.listingUpdate.listingUpdateDate : null,
    listingUpdateReason:
      typeof raw.listingUpdate?.listingUpdateReason === 'string' ? raw.listingUpdate.listingUpdateReason : null,
    addedOrReduced: typeof raw.addedOrReduced === 'string' && raw.addedOrReduced ? raw.addedOrReduced : null,
  };
}

function numberOrNull(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Whether the blob still describes what is on screen.
 *
 *  `__NEXT_DATA__` is written once, server-side. Rightmove's pager is a client-side route change,
 *  so clicking through to page 2 swaps every card in the DOM and leaves this JSON describing page
 *  1 — and a sweep that recorded it would write twenty-four sightings for properties nobody is
 *  looking at, then report the page fully recorded. The existing `search.content` script sidesteps
 *  this by reading ids off the card links, which do change; we cannot, because we want the price
 *  and the coordinates that only the blob has.
 *
 *  So we compare the two. Any id on screen that the blob does not know about means the page has
 *  moved on and the only honest answer is to ask for a reload. */
export function staleAgainst(page: SearchPage, idsOnScreen: string[]): string[] {
  const known = new Set(page.cards.map((card) => card.rightmoveId));
  return idsOnScreen.filter((id) => !known.has(id));
}
