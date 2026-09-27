import { parseAreaFromText } from '../listing';
import type { FloorArea, Floorplan, Listing } from '../types';
import {
  arr,
  blankListing,
  bool,
  findOne,
  flightPayload,
  flightRef,
  flightRows,
  meta,
  num,
  outcodeIn,
  outcodeOf,
  postcodeIn,
  poundsIn,
  priceText,
  sqmToSqft,
  statedSqft,
  str,
  textFromHtml,
  trimmed,
} from './read';
import { propertyKey, type Site } from './types';

/** Chestertons — Homeflow's Next.js generation, read out of the App Router's flight payload.
 *
 *  There is no `__NEXT_DATA__` here and no listing markup worth reading: the page is an RSC stream,
 *  and the flat arrives inside it as one object with 92 fields on it. What that object is *called*
 *  on the way in is a build detail, so it is found by its own id rather than down a path — the saved
 *  page carries nineteen objects of that shape, the flat plus a carousel of eighteen others, and the
 *  id is the only thing that tells them apart.
 *
 *  John D Wood is the same vendor's earlier Rails generation and shares nothing with this but some
 *  field names; it has its own adapter and the two must not be merged.
 *
 *  **What the page does not say**, and so is left null rather than filled in: the nearest stations —
 *  the payload has no transport section at all, and the description names one in prose — and the
 *  council tax band, whose field is present and empty on both listings read.
 *
 *  **Withdrawn listings are not detected, on purpose.** An id Chestertons cannot place answers 200
 *  with Next's own "404: This page could not be found", which is also what a mistyped id gets and
 *  what any routing failure would get. Rightmove's `isWithdrawn` turns on the withdrawn page's own
 *  consolation link — a positive signal — and there is no equivalent here; reading an absence as
 *  "this flat has gone" would stop the app ever reopening a live one. A let-agreed listing still
 *  renders its payload, and `archived` carries that. */
export const chestertons: Site = {
  id: 'chestertons',
  name: 'Chestertons',
  hosts: ['chestertons.co.uk', 'www.chestertons.co.uk'],

  listingId(url) {
    let parsed: URL;
    try {
      parsed = new URL(url.trim());
    } catch {
      return null;
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
    if (!chestertons.hosts.includes(parsed.hostname.toLowerCase())) return null;
    return LISTING_PATH.exec(parsed.pathname)?.[1] ?? null;
  },

  listingUrl(id) {
    if (!ID.test(id)) throw new Error(`chestertons: ${id} is not a listing id`);
    return `https://www.chestertons.co.uk/properties/${id}`;
  },

  extract(html, url) {
    // Which listing this page is about, according to the page rather than the caller — the same way
    // round as Rightmove, where the id is read out of the payload. `og:url` is the canonical listing
    // URL and is on every page read here; the URL that was fetched is the fallback.
    const externalId = chestertons.listingId(meta(html, 'og:url') ?? '') ?? chestertons.listingId(url);
    if (externalId === null) throw new Error('chestertons: neither og:url nor the URL names a listing');

    const rows = flightRows(flightPayload(html));
    if (rows.size === 0) throw new Error('chestertons: the page carries no flight payload');

    const wanted = Number(externalId);
    const property = findOne([...rows.values()], (o) => num(o.id) === wanted && 'displayAddress' in o);
    if (!property) throw new Error(`chestertons: no listing ${externalId} in the flight payload`);

    const blank = blankListing('chestertons', externalId, propertyKey('chestertons', externalId), url);
    const postcode = postcodeIn(trimmed(property.postcode) ?? '');
    const displayAddress = trimmed(flightRef(rows, property.displayAddress));
    const description = prose(flightRef(rows, property.description));
    const available = bool(property.isAvailable);

    return {
      ...blank,
      postcode,
      outcode: outcodeOf(postcode) ?? addressOutcode(displayAddress),
      displayAddress: displayAddress ?? blank.displayAddress,
      price: priceText(flightRef(rows, property.price)),
      bedrooms: num(property.bedrooms),
      bathrooms: num(property.bathrooms),
      latitude: num(property.lat),
      longitude: num(property.lng),
      floorArea: floorArea(property, description),
      furnishType: furnishType(property),
      letAvailableDate: trimmed(property.availableOn),
      // `securityDeposit` is a price string and "£0" is what the field holds when nobody filled it
      // in, which `poundsIn` reads as absent rather than as a deposit of nothing.
      deposit: poundsIn(trimmed(property.securityDeposit)),
      letType: LET_TYPES[trimmed(property.term)?.toLowerCase() ?? ''] ?? null,
      councilTaxBand: band(property.councilTaxBand),
      listingUpdate: addedOn(trimmed(property.createdAt)),
      // Homeflow's own branch id, which is what this field is for: the branch name beside it is what
      // to show a person and can be renamed, and this cannot. It is not a Rightmove branch id and
      // nothing builds a URL out of it — it is stored and counted by.
      agentBranchId: num(property.branchId),
      agentBranch: trimmed(property.agencyBranchName),
      agentCompany: trimmed(property.agencyName),
      agentPhone: trimmed(property.contactTelephone),
      floorplans: floorplans(property.floorplans),
      imageUrls: imageUrls(property),
      description,
      // `isAvailable` is the page's own answer about the market and not about the move-in date — the
      // saved listing is available with an `availableOn` two months off. Absent stays unknown rather
      // than "still on", so a renamed field never tells somebody a live flat has gone.
      archived: available === null ? null : !available,
    } satisfies Listing;
  },
};

/** Chestertons' own id: digits and nothing else, because it ends up in a database key and in a
 *  `#card-<key>` selector. Bounded rather than `\d+` so that `/properties/0` cannot become one. */
const ID_BODY = '\\d{4,12}';
const ID = new RegExp(`^${ID_BODY}$`);

/** `/properties/22062858`, with the channel and the agent's reference decorative after it.
 *
 *  The id alone resolves: `/properties/22062858` serves the same page as
 *  `/properties/22062858/lettings`, and `/properties/22060057/lettings` serves a listing that is for
 *  sale — the channel segment is decoration and is not looked up. That is why `listingUrl` rebuilds
 *  the bare form rather than the canonical: it is handed an id and nothing else, and the id does not
 *  say whether the flat is to let or for sale.
 *
 *  The same prefix carries the searches — `/properties/lettings`, `/properties/sales` — and they are
 *  turned away by the id shape rather than by counting segments. */
const LISTING_PATH = new RegExp(`^/properties/(${ID_BODY})(?:/[A-Za-z0-9_-]+){0,2}/?$`);

/** `term` in Homeflow's words, decoded into the two this column means everywhere else: `letLength`
 *  hides "Long term" as the default and prints anything else on the card, so a bare "short" passed
 *  through would be shown to somebody as the word "short". A term outside these two reads as unknown
 *  for the same reason. */
const LET_TYPES: Record<string, string> = {
  short: 'Short term',
  long: 'Long term',
};





/** The agent's own words, with the `<br/>`s they are written in turned back into lines. */
function prose(value: unknown): string | null {
  const markup = str(value);
  return markup === null ? null : str(textFromHtml(markup));
}

/** Homeflow builds `displayAddress` as road, town, county, outcode — the outcode last and on its
 *  own — so this reads that segment rather than scanning the whole string, where a development
 *  called "N1 House" would answer for a flat in SE8. Only reached when the postcode field is empty. */
function addressOutcode(address: string | null): string | null {
  const last = address?.split(',').at(-1)?.trim();
  return last === undefined ? null : outcodeIn(last);
}

/** The internal area first, because that is the flat rather than whatever else the agent measured.
 *  `squareFeet` and `squareMeters` are null on all three listings read while `squareFeetInternal` is
 *  filled on all three, so they are fallbacks rather than second readings of the same field, and the
 *  description gets its turn after them. */
function floorArea(property: Record<string, unknown>, description: string | null): FloorArea | null {
  const sqm = num(property.squareMetersInternal) ?? num(property.squareMeters);
  const stated =
    statedSqft(num(property.squareFeetInternal) ?? num(property.squareFeet)) ??
    statedSqft(sqm === null ? null : sqmToSqft(sqm));
  if (stated !== null) return stated;

  const fromProse = description === null ? null : parseAreaFromText(description);
  return fromProse === null ? null : { sqft: fromProse, source: 'description' };
}

/** Homeflow states furnishing as three booleans rather than one word, so more than one of them can
 *  be true — a landlord who will let it either way. That is a thing the Rightmove vocabulary has a
 *  phrase for ("Furnished or unfurnished"), so they are joined into it rather than reduced to
 *  whichever flag comes first, which would state a choice nobody made. */
function furnishType(property: Record<string, unknown>): string | null {
  const stated = FURNISHING.filter(([key]) => bool(property[key]) === true).map(([, label]) => label);
  if (stated.length === 0) return null;
  const joined = stated.join(' or ');
  return joined[0]! + joined.slice(1).toLowerCase();
}

const FURNISHING: [string, string][] = [
  ['furnished', 'Furnished'],
  ['partFurnished', 'Part furnished'],
  ['unfurnished', 'Unfurnished'],
];

/** Empty on all 3 listings read, and named for the band alone, so it is read and shape-checked
 *  rather than assumed absent. `councilTaxIn` wants the words around the letter and this field
 *  carries none. Anything that is not a band is dropped rather than stored — the column is drawn as
 *  one letter everywhere it is shown. */
function band(value: unknown): string | null {
  const stated = trimmed(value);
  return stated !== null && /^[A-H]$/i.test(stated) ? stated.toUpperCase() : null;
}

/** `listingUpdate` worded the way Rightmove words it — "Added on 05/08/2026" — from `createdAt`,
 *  the one date Homeflow states about the listing rather than about the flat. How long a rental has
 *  sat is the signal that field carries. Read off the date part of the timestamp rather than through
 *  `Date`, which would move the day either side of midnight depending on where this runs. */
function addedOn(createdAt: string | null): string | null {
  const date = createdAt?.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return date ? `Added on ${date[3]}/${date[2]}/${date[1]}` : null;
}

function floorplans(value: unknown): Floorplan[] {
  return urls(value).map((url) => ({ url, caption: null }));
}

/** The gallery, falling back to `mainPhoto` for a listing whose `photos` is null. Both are URLs on
 *  Homeflow's CDN and neither is ever fetched here — see the re-hosting rule in AGENTS.md. */
function imageUrls(property: Record<string, unknown>): string[] {
  const photos = urls(property.photos);
  return photos.length > 0 ? photos : urls([property.mainPhoto]);
}

function urls(value: unknown): string[] {
  return arr(value).flatMap((raw) => {
    const url = str(raw);
    return url === null ? [] : [url];
  });
}
