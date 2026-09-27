import { ListingWithdrawn, parseAreaFromText } from '../listing';
import type { FloorArea, Floorplan } from '../types';
import {
  arr,
  blankListing,
  bool,
  dig,
  nextData,
  num,
  obj,
  outcodeIn,
  outcodeOf,
  postcodeIn,
  statedSqft,
  trimmed,
} from './read';
import { propertyKey, type Site } from './types';

const NAME = 'Foxtons';

/** `assets.` and `cms.` are real subdomains here and serve no listings, which is why the host check
 *  in `listingId` is against this list rather than a suffix test. */
const HOSTS = ['foxtons.co.uk', 'www.foxtons.co.uk'];

/** Foxtons — a Next.js Pages Router site, read entirely out of `__NEXT_DATA__`.
 *
 *  The payload is not the convenient path here, it is the only one: the served HTML carries the nav
 *  and the footer and nothing else. The flat, the price, even the `<title>`, are all written by the
 *  client from `props.pageProps`, so a reader that went looking for markup would find 2,540
 *  characters of chrome and no listing.
 *
 *  **What the page does not say**, and so is left null rather than filled in: when the flat is free,
 *  the deposit, and how far the stations are. The last one is the one worth knowing about, because
 *  the page *does* name them — `stationsData` lists twelve, with lines and zones and coordinates,
 *  and no distance to any of them. `Station.distance` is fed to `nearestStationMiles`, which the
 *  triage filter and the verdict-score model read alongside Rightmove's stated distances, so a
 *  figure computed here from two coordinates would be ranked against measurements as though it were
 *  one. `nearestStations` stays empty. */
export const foxtons: Site = {
  id: 'foxtons',
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
    return LISTING_PATH.exec(parsed.pathname.toLowerCase())?.[1] ?? null;
  },

  listingUrl(id) {
    const reference = id.trim().toLowerCase();
    if (!REFERENCE.test(reference)) throw new Error(`foxtons: ${id} is not a listing reference`);
    return `https://www.foxtons.co.uk/properties-to-rent/${reference}`;
  },

  extract(html, url) {
    const pageProps = obj(dig(nextData(html), 'props', 'pageProps'));
    if (!pageProps) throw new Error('foxtons: the page carries no __NEXT_DATA__ pageProps');

    const detail = obj(pageProps.propertyDetail);
    if (!detail) {
      if (trimmed(pageProps.template) === SEARCH_TEMPLATE) throw new ListingWithdrawn(NAME);
      throw new Error('foxtons: __NEXT_DATA__ carries no propertyDetail');
    }

    const reference = trimmed(detail.propertyReference)?.toLowerCase() ?? null;
    if (reference === null || !REFERENCE.test(reference)) {
      throw new Error(`foxtons: propertyReference is not a reference (${String(detail.propertyReference)})`);
    }

    const blank = blankListing('foxtons', reference, propertyKey('foxtons', reference), url);
    const postcode = postcodeIn(trimmed(dig(detail, 'postcode', 'name')) ?? '');
    const office = obj(pageProps.PropertyOfficeDetail) ?? obj(detail.office);
    const description = describe(detail);

    return {
      ...blank,
      postcode,
      // `postcodeShort` is the outcode on its own — "NW3" — and is present on listings whose full
      // postcode is not, so it is the fallback rather than a second reading of the same field.
      outcode: outcodeOf(postcode) ?? outcodeIn(trimmed(detail.postcodeShort) ?? ''),
      displayAddress: displayAddress(detail) ?? blank.displayAddress,
      price: price(detail),
      bedrooms: count(detail.bedrooms),
      bathrooms: count(detail.bathrooms),
      latitude: num(detail.latitude),
      longitude: num(detail.longitude),
      floorArea: floorArea(detail, description),
      furnishType: furnishType(detail),
      letType: LET_TYPES[trimmed(detail.instructionType)?.toLowerCase() ?? ''] ?? null,
      // Empty on 5 of the 5 listings read while writing this, and named for exactly this fact, so it
      // is read and shape-checked rather than assumed absent. `councilTaxIn` wants the words around
      // the letter and there are none here — the field holds the band alone.
      councilTaxBand: band(detail.councilBand),
      agentBranch: trimmed(office?.name),
      // Every listing on this host is marketed by Foxtons, which is why the payload never names a
      // company: the branch is the only thing that varies.
      agentCompany: NAME,
      agentPhone: trimmed(office?.phone),
      floorplans: floorplans(detail.floorplan),
      imageUrls: imageUrls(detail.photos),
      description,
      archived: bool(detail.isArchived),
    };
  },
};

/** Foxtons' own reference: a four-character office code and a seven-digit number — `chpk0975039`,
 *  `b2rc6211430`. The code holds a digit often enough to matter (233 of the 4,770 references in
 *  `sitemap-long-lettings.xml.gz` are `b2rc…`), and its first character is a letter in every one of
 *  them, which is what keeps an all-digit path segment from reading as a listing. */
const REFERENCE_BODY = '[a-z][a-z0-9]{3}\\d{7}';
const REFERENCE = new RegExp(`^${REFERENCE_BODY}$`);

/** The listing path, with the outcode in it optional because it is decorative.
 *
 *  `/properties-to-rent/chpk0975039` answers 307 to the canonical
 *  `/properties-to-rent/nw3/chpk0975039`, and `/properties-to-rent/sw1/chpk0975039` — the wrong
 *  outcode — answers 200 with the same flat. The reference alone is what Foxtons looks up, so it
 *  alone is the id and `listingUrl` rebuilds the short form.
 *
 *  The same prefix carries searches: `/properties-to-rent/london`,
 *  `/properties-to-rent/nw3/3-bedroom`. They are turned away by the reference shape rather than by
 *  counting segments, which is why the middle segment can be loose. Short lets are a different
 *  section (`/short-let-properties/…`) and are deliberately not claimed: their references do not
 *  resolve under this path — `/properties-to-rent/<a short-let reference>` answers 200 with the
 *  search page — so accepting one would produce an id whose rebuilt URL reads as withdrawn. */
const LISTING_PATH = new RegExp(`^/properties-to-rent/(?:[a-z0-9-]+/)?(${REFERENCE_BODY})/?$`);

/** What `pageProps.template` says on the page Foxtons answers with when a listing has gone.
 *
 *  Foxtons has no "this property is no longer available" page. A reference it cannot place answers
 *  307 to `/properties-to-rent/<outcode>#gone` — checked against `chpk9999999` — and a fetch that
 *  follows redirects lands on the outcode's search page, which carries a `__NEXT_DATA__` of its own
 *  with no `propertyDetail` in it. The fragment never reaches the server, so this template on a page
 *  we requested by reference is the whole of the signal, and it is narrow: `listingId` claims only
 *  `/properties-to-rent/<reference>`, and the one way that path renders a search is the redirect. */
const SEARCH_TEMPLATE = 'PropertySearchTemplate';

/** Foxtons states furnishing as `Yes` / `No` / `Semi` / `Flexible`, none of which is the word this
 *  column means everywhere else, so they are decoded rather than passed through: `predict.ts` scores
 *  the string by testing it for "unfurnished", and a bare `No` would score as furnished. Anything
 *  outside these four reads as unknown for the same reason — a word we cannot place would be scored
 *  as though we had.
 *
 *  `Flexible` keeps its own word because the Rightmove vocabulary has no term for it: the landlord
 *  will do either, and calling that furnished or part furnished would state a choice nobody made. */
const FURNISHING: Record<string, string> = {
  yes: 'Furnished',
  no: 'Unfurnished',
  semi: 'Part furnished',
  flexible: 'Flexible',
};

/** `instructionType` in Foxtons' own words, which is where the long/short distinction is legible —
 *  `instructionTypeShort` beside it says `LON` and `SHO`. A short let reaches this only if Foxtons
 *  moves one under the long-let path, so both are decoded rather than one assumed. */
const LET_TYPES: Record<string, string> = {
  letting: 'Long term',
  short_letting: 'Short term',
};

/** The rent as a sentence, built from the number because the page never states one.
 *
 *  Nothing on Foxtons renders a price server-side, so there is no agent's own string to keep the way
 *  Rightmove's `primaryPrice` is kept. `pricePcm` is per calendar month by its own name and the
 *  pounds-per-week `priceFrom` beside it is the same money (3,100 x 52 / 12 = 13,434), so the month
 *  is the figure to quote and "pcm" is what `parseMonthlyPrice` and every view already read. */
function price(detail: Record<string, unknown>): string | null {
  const pcm = num(detail.pricePcm);
  if (pcm === null || pcm <= 0) return null;
  // Grouped by hand rather than through `toLocaleString`, which answers differently depending on
  // where the browser thinks it is — the reason `sweep.ts` groups its own.
  return `£${String(Math.round(pcm)).replace(/\B(?=(\d{3})+$)/g, ',')} pcm`;
}

/** The address parts Foxtons states, narrowest first and each said once. `street` is not read: it
 *  repeats `addressLine2` on every listing sampled, and a duplicate in the middle of an address
 *  reads as a mistake rather than as detail. */
function displayAddress(detail: Record<string, unknown>): string | null {
  const said: string[] = [];
  const parts = [
    trimmed(detail.addressLine1),
    trimmed(detail.addressLine2),
    trimmed(dig(detail, 'location', 'name')),
    trimmed(detail.town),
  ];
  for (const part of parts) {
    if (part !== null && !said.some((already) => already.toLowerCase() === part.toLowerCase())) said.push(part);
  }
  return said.length > 0 ? said.join(', ') : null;
}

/** The agent's paragraph, then the points they chose to bullet.
 *
 *  Two fields on the page and one on a `Listing`, joined rather than picked between because the
 *  bullets carry what the paragraph leaves out — an en suite, a garden, who the bills are for — and
 *  this field is what the vision pass reads for the questions photographs cannot answer. Foxtons
 *  pads the bullet list to a fixed length with nulls, which `trimmed` drops. */
function describe(detail: Record<string, unknown>): string | null {
  const lines = [trimmed(detail.shortDescription), ...arr(detail.bulletPoints).map(trimmed)].filter(
    (line): line is string => line !== null,
  );
  return lines.length > 0 ? lines.join('\n') : null;
}

/** `floorArea` is square feet — a 2-bedroom flat reads 578 and a 3-bedroom house 1,371 — and is
 *  stated on 5 of the 6 listings sampled. The prose is the same fallback `toListing` has, and says
 *  so on the result: a number read out of a sentence deserves less trust than a stated one. */
function floorArea(detail: Record<string, unknown>, description: string | null): FloorArea | null {
  const stated = statedSqft(num(detail.floorArea));
  if (stated !== null) return stated;
  const prose = description === null ? null : parseAreaFromText(description);
  return prose === null ? null : { sqft: prose, source: 'description' };
}

function furnishType(detail: Record<string, unknown>): string | null {
  return FURNISHING[trimmed(detail.furnished)?.toLowerCase() ?? ''] ?? null;
}

/** A council tax band A-H, or null. Foxtons ships an empty string for "not stated" and, going by the
 *  field's name, the letter alone otherwise. Anything else is refused rather than stored, because
 *  this column is read as a band wherever it is drawn. */
function band(value: unknown): string | null {
  const stated = trimmed(value);
  return stated !== null && /^[A-H]$/i.test(stated) ? stated.toUpperCase() : null;
}

/** A whole number Foxtons states, or null. Zero is a studio and is a real answer; a negative is not
 *  a count of anything — Foxtons uses -1 in its own search facets for the properties whose bedroom
 *  count it does not hold. */
function count(value: unknown): number | null {
  const n = num(value);
  return n === null || n < 0 || !Number.isInteger(n) ? null : n;
}

/** Gallery URLs on Foxtons' own CDN, never a copy. `src` is already the largest variant Foxtons
 *  publishes — the `edited_` original, beside which the payload elsewhere carries `w/220` and
 *  `w/480` reductions of the same photograph — which is the one the analyser wants. */
function imageUrls(value: unknown): string[] {
  return arr(value).flatMap((photo) => {
    const src = trimmed(obj(photo)?.src);
    return src === null ? [] : [src];
  });
}

/** One plan at most, and an empty `src` when there is none. No caption: Foxtons ships an id and a
 *  timestamp beside it and never a name. */
function floorplans(value: unknown): Floorplan[] {
  const url = trimmed(obj(value)?.src);
  return url === null ? [] : [{ url, caption: null }];
}
