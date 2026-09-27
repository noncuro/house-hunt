import { parseAreaFromText } from '../listing';
import type { Floorplan, Listing } from '../types';
import {
  arr,
  blankListing,
  councilTaxIn,
  findOne,
  flightPayload,
  flightRef,
  flightRows,
  meta,
  num,
  obj,
  objectNamed,
  outcodeIn,
  outcodeOf,
  postcodeIn,
  str,
  textFromHtml,
  trimmed,
} from './read';
import { propertyKey, type Site } from './types';

const NAME = 'Portico';

/** `.com`, not `.co.uk`. `asset.portico.com` serves the site's images and no listings, which is why
 *  the host check is against this list rather than a suffix test. */
const HOSTS = ['portico.com', 'www.portico.com'];

/** Portico — a Starberry build on Next.js' App Router, read out of the RSC flight payload.
 *
 *  The served HTML does carry the flat in markup, and it is the wrong place to read it from: the
 *  address, the price and the beds are three separate hashed-class divs, while the postcode, the
 *  coordinates, the images and the branch's number appear only in the payload. So the whole read is
 *  `self.__next_f` reassembled, and the listing is found by the prop name it is passed under rather
 *  than by a path through the React tree — see `objectNamed`.
 *
 *  **What the page does not say**, and so is left null rather than filled in: furnishing, the
 *  deposit, the let type, the listing's own history, and how far the stations are. Nothing here
 *  states a floor area either; where the agent puts one in their prose `parseAreaFromText` finds it,
 *  and it is marked `description` for the trust that carries.
 *
 *  The deposit is the one worth knowing about. Portico has no field for it, and the LRG boilerplate
 *  that some descriptions end with names two figures — "A Holding Deposit of £415.38" and "Deposit
 *  payable is £2,076.90" — which are a week's rent and five weeks' rent. Neither of the two rental
 *  subjects read here carried that boilerplate at all, so a parser for it would be written against
 *  wording seen only on somebody else's listing, and the failure it invites is reporting the holding
 *  deposit as the deposit: five times under, in a column people compare. */
export const portico: Site = {
  id: 'portico',
  name: NAME,
  hosts: HOSTS,

  listingId(url) {
    let parsed: URL;
    try {
      parsed = new URL(url.trim());
    } catch {
      return null;
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
    if (!HOSTS.includes(parsed.hostname.toLowerCase())) return null;

    const path = parsed.pathname.toLowerCase();
    const reference = LISTING_PATH.exec(path)?.[1] ?? SHORT_PATH.exec(path)?.[1] ?? null;
    return reference !== null && REFERENCE.test(reference) ? reference : null;
  },

  listingUrl(id) {
    const reference = id.trim().toLowerCase();
    if (!REFERENCE.test(reference)) throw new Error(`portico: ${id} is not a listing reference`);
    return `https://www.portico.com/${reference}/`;
  },

  extract(html, url) {
    const payload = flightPayload(html);
    if (payload.length === 0) throw new Error('portico: the page carries no __next_f flight payload');

    const property = objectNamed(payload, 'propertyData');
    if (!property) throw new Error('portico: the flight payload carries no propertyData');

    const reference = trimmed(property.crm_id)?.toLowerCase() ?? null;
    if (reference === null || !REFERENCE.test(reference)) {
      throw new Error(`portico: crm_id is not a reference (${String(property.crm_id)})`);
    }

    const key = propertyKey('portico', reference);
    const blank = blankListing('portico', reference, key, canonical(html, reference) ?? url);
    // Both fields hold the full postcode on the 3 pages read. Said twice, so read twice: a page
    // that keeps only one of them still routes.
    const stated = `${trimmed(property.post_code) ?? ''} ${trimmed(obj(property.address)?.postcode) ?? ''}`;
    const postcode = postcodeIn(stated);
    const displayAddress = trimmed(property.display_address);
    // Walked once and passed down: a row can only be found by walking from the one before it, so a
    // reader that re-walked per field would cost a pass of the payload for each.
    const description = prose(flightRows(payload), property);

    return {
      ...blank,
      postcode,
      outcode: outcodeOf(postcode) ?? outcodeIn(stated) ?? outcodeIn(displayAddress ?? ''),
      displayAddress: displayAddress ?? blank.displayAddress,
      price: price(property),
      bedrooms: num(property.bedroom),
      bathrooms: num(property.bathroom),
      latitude: num(property.latitude),
      longitude: num(property.longitude),
      floorArea: floorArea(description),
      letAvailableDate: available(property.available_from),
      councilTaxBand: band(property.council_tax),
      agentBranch: trimmed(objectNamed(payload, 'matchedBranch')?.title),
      // Every listing on this host is marketed by Portico; the payload names only the branch,
      // because the branch is the only thing that varies.
      agentCompany: NAME,
      agentPhone: deskPhone(payload, trimmed(property.search_type)),
      floorplans: floorplans(property.floorplan),
      imageUrls: arr(property.images).flatMap((raw) => {
        const picture = pictureUrl(raw);
        return picture === null ? [] : [picture];
      }),
      description,
      archived: archived(property.status),
    };
  },
};

/** Portico's own reference for a flat, as its URLs spell it: three letters of office code and six
 *  digits on all 8 seen across a listing page and both search pages (`pdu250192`, `clp260143`,
 *  `nsb260053`), widened a little either side. Deliberately no hyphen: the reference is the id, the
 *  id goes into a property key, and the key is then selected as `#card-<key>`. */
const REFERENCE = /^[a-z]{2,6}\d{4,10}$/;

/** The canonical listing path — `/properties-to-rent/<slug>/<reference>/`, and the same shape under
 *  `/properties-for-sale/`, which shares the reference space (both are the CRM's `crm_id`).
 *
 *  Sales are claimed rather than turned away because `listingUrl` never rebuilds this form: it
 *  rebuilds the short one below, which resolves for either channel. */
const LISTING_PATH = /^\/properties-(?:to-rent|for-sale)\/[a-z0-9-]+\/([a-z0-9]+)\/?$/;

/** The reference on its own at the root, which is what `listingUrl` builds and the site's own
 *  shortlink shape.
 *
 *  `/pdu250192/` answers 308 to the canonical slug URL, and so does `/clp260143/` to its
 *  `properties-for-sale` one, so the reference alone is the whole id. The slug cannot be dropped
 *  from the long form instead: it is looked up alongside the reference, and a wrong-but-well-formed
 *  slug answers 307 to the search page — including this listing's own slug against another
 *  listing's reference. Carrying both would put the flat's address in a database key.
 *
 *  This claims a root-level path, so the reference shape is doing the whole of the work of telling a
 *  listing from `/about-us/`: `REFERENCE` wants digits, and no page on the site is named that way. */
const SHORT_PATH = /^\/([a-z0-9]+)\/?$/;

/** A field that may be a `$NN` reference to a text row, as a string. `flightRef` in `read.ts` is
 *  what follows it; this is the "and I wanted prose" half. */
function referenced(rows: Map<string, unknown>, value: unknown): string | null {
  return str(flightRef(rows, value));
}

/** The agent's own words, with the markup they wrote them in taken out. Portico puts `<br>` inside
 *  the description field itself, and what reads this next is the vision pass's prompt.
 *
 *  Both fields are tried because either can be the one that carries it: they are the same prose on
 *  the two rentals read, and on the sale `description` is a `$28` reference to the whole of it while
 *  `long_description` is empty. */
function prose(rows: Map<string, unknown>, property: Record<string, unknown>): string | null {
  const raw = referenced(rows, property.description) ?? referenced(rows, property.long_description);
  return raw === null ? null : str(textFromHtml(raw));
}

/** The page's own address for this flat, when it names this same flat.
 *
 *  `listingUrl` builds the shortlink, so a flat added from a phone would otherwise be stored under
 *  `/pdu250192/` while the same flat captured on the page is stored under its slug URL. Guarded on
 *  the id rather than trusted: the only thing that may set this is a URL this site would answer for
 *  this reference. */
function canonical(html: string, reference: string): string | null {
  const stated = meta(html, 'og:url');
  return stated !== null && portico.listingId(stated) === reference ? stated : null;
}

/** The price as the page prints it: the figure, then the agent's qualifier beside it — "£2,100 pcm"
 *  on a rental, "£850,000 Offers in excess of" on a sale, which is the order the page's own two
 *  elements sit in. Kept as their string because pcm and pw are different quantities.
 *
 *  Grouped by hand rather than through `toLocaleString`, for the reason `sweep.ts` gives. */
function price(property: Record<string, unknown>): string | null {
  const amount = num(property.price);
  if (amount === null || amount <= 0) return null;
  const qualifier = trimmed(property.price_qualifier);
  const figure = `£${String(Math.round(amount)).replace(/\B(?=(\d{3})+$)/g, ',')}`;
  return qualifier === null ? figure : `${figure} ${qualifier}`;
}

/** Nothing on Portico states a floor area as data, so the prose is the only source and says so. */
function floorArea(description: string | null): Listing['floorArea'] {
  const sqft = description === null ? null : parseAreaFromText(description);
  return sqft === null ? null : { sqft, source: 'description' };
}

/** When the flat is free, worded as Portico words it — `2028-03-14T00:00:00.000Z` renders on the
 *  page as "14 March 2028".
 *
 *  Read in UTC, and by hand rather than through `Intl`, because both alternatives move the day: the
 *  other rental read here is free from `2026-08-28T23:00:00.000Z` and the page calls that 28 August,
 *  so a format in the reader's own zone would call it the 29th anywhere east of Greenwich. */
const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

function available(value: unknown): string | null {
  const stated = str(value);
  if (stated === null) return null;
  const when = new Date(stated);
  return Number.isNaN(when.getTime())
    ? null
    : `${when.getUTCDate()} ${MONTHS[when.getUTCMonth()]!} ${when.getUTCFullYear()}`;
}

/** The council tax band, which `council_tax` holds as the bare letter on 2 of the 3 pages read and
 *  as the string "False" on the third — so a letter is required rather than trusted, and the
 *  "Band D" wording falls to `councilTaxIn` in case a later page states it that way. */
function band(value: unknown): string | null {
  const stated = trimmed(value);
  if (stated === null) return null;
  return /^[A-H]$/i.test(stated) ? stated.toUpperCase() : councilTaxIn(stated);
}

/** Portico's status word, read as whether the flat is still on the market.
 *
 *  Seen across five pages: "To Let", "Let", "Let Agreed", "For Sale". The sale terms beside them are
 *  the same CRM's words for the same moment. Let-agreed counts as off the market for the reason
 *  Rightmove's `archived` does — the flat is spoken for — and is not a withdrawal: the page is still
 *  there and still says everything it said. A word not on either list reads as null, which is "we
 *  could not check" and never "still on".
 *
 *  There is no withdrawn page to detect. A reference Portico cannot place answers 404 with the
 *  site-wide "the page you were looking for cannot be found" — no propertyData, and the same page a
 *  mistyped URL gets — so the status code is the whole signal and `app/api/listing` already reads
 *  it. Matching that wording here would report any Portico page we misaddress as a flat that has
 *  gone, and quietly stop the app reopening it. */
const OFF_THE_MARKET = ['let', 'let agreed', 'sold', 'sold stc', 'under offer'];
const ON_THE_MARKET = ['to let', 'for sale'];

function archived(value: unknown): boolean | null {
  const status = trimmed(value)?.toLowerCase() ?? null;
  if (status === null) return null;
  if (OFF_THE_MARKET.includes(status)) return true;
  return ON_THE_MARKET.includes(status) ? false : null;
}

/** The branch's own number for the desk this listing belongs to.
 *
 *  A branch runs a lettings desk and a sales desk, sometimes on different lines, so the entry is
 *  chosen by the department's own type against the listing's `search_type` rather than by its
 *  `crm_code`: the codes agree with `office_mapping` on the rental read here ("PDU") and on neither
 *  entry of the sale ("RPS-CLP" and "PCL" against "CLP").
 *
 *  Read out of `matchedBranch` and never out of `crm_negotiator_details` or `branchTeam`, which sit
 *  beside it and name an individual, with their email and their mobile. An office number is a
 *  business contact; a named person's is not ours to store. */
function deskPhone(payload: string, searchType: string | null): string | null {
  const branch = objectNamed(payload, 'matchedBranch');
  if (!branch) return null;
  const channel = searchType?.toLowerCase() ?? null;
  const numbered = (entry: Record<string, unknown>): boolean => trimmed(entry.telephone) !== null;
  const ofThisChannel = (entry: Record<string, unknown>): boolean =>
    trimmed(obj(entry.department)?.type)?.toLowerCase() === channel;
  const desk =
    findOne(branch, (entry) => numbered(entry) && ofThisChannel(entry)) ?? findOne(branch, numbered);
  return trimmed(desk?.telephone);
}

/** Portico's own copy of a picture where it has one, the CRM's original where it does not — the
 *  floorplans only ever carry the second. Never downloaded, only linked: the photographs belong to
 *  whoever took them and are shown from the host the page itself names. `imagetransforms` holds
 *  resized webp variants of these same files and is deliberately passed over. */
function pictureUrl(raw: unknown): string | null {
  const picture = obj(raw);
  return str(picture?.url) ?? str(picture?.srcUrl);
}

function floorplans(value: unknown): Floorplan[] {
  return arr(value).flatMap((raw) => {
    const url = pictureUrl(raw);
    return url === null ? [] : [{ url, caption: trimmed(obj(raw)?.caption) }];
  });
}
