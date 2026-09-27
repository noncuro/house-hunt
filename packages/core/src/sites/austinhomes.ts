import { parseAreaFromText } from '../listing';
import type { FloorArea, Floorplan, Listing, Station } from '../types';
import {
  arr, blankListing, decodeEntities, flightPayload, jsonAfter, jsonLdOfType, num, obj, outcodeIn,
  outcodeOf, postcodeIn, poundsIn, priceText, sortedStations, sqmToSqft, statedSqft, str, trimmed,
} from './read';
import { propertyKey, type Site } from './types';

/** Austin Homes London — an Estate Track front end over a Street.co.uk CRM.
 *
 *  Two payloads, read in that order. `RealEstateListing` ld+json carries the address, the full
 *  postcode, the coordinates, the room counts, the gallery, the prose and the availability; the
 *  Next.js flight payload carries the record the CRM sent — the council-tax band, the available
 *  date, the deposit, the floorplan and the price in the words the site prints. Nothing here is
 *  read off a class name.
 *
 *  The id is the URL slug, and that is a compromise rather than a choice: the page states a stable
 *  CRM id (`databaseId`, and a Street reference UUID) but no id-addressed URL resolves —
 *  `/properties/residential-lettings/<databaseId>/` answers 200 with the department index and no
 *  listing on it, and `?p=<databaseId>` on the WordPress origin redirects to the front end's home
 *  page. `listingUrl` has to rebuild a fetchable URL from the id alone, so the id has to be the
 *  only thing a URL can be built from. The cost is that an agent retitling a listing changes its
 *  slug, and the same flat then arrives under a second key with none of the first one's verdicts. */

const HOST = 'austinhomes.london';

/** What a slug may contain, and the gate on both directions.
 *
 *  A strict allowlist because this id is free-form text rather than a number: it goes into a URL
 *  path that the `listing` route then fetches server-side, so anything that could re-point that
 *  fetch — a slash, a dot, a colon, a percent escape — has to be refused before the URL exists. It
 *  also has to survive being a property key (`_` is the separator) and a CSS identifier
 *  (`#card-<key>`). All 116 listing slugs in the site's own sitemap are this shape. */
const SLUG = /^[a-z0-9-]+$/;

/** The slug of a lettings listing, or null.
 *
 *  Only `/property-to-rent/`. The site publishes `/property-for-sale/` on the same shape and this
 *  app is a rental hunt, and taking both would leave `listingUrl` unable to say which of the two
 *  paths a bare slug belonged to. */
function listingId(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;

  const host = parsed.hostname.toLowerCase();
  if (host !== HOST && host !== `www.${HOST}`) return null;

  const slug = /^\/property-to-rent\/([^/]+)\/?$/.exec(parsed.pathname)?.[1];
  return slug !== undefined && SLUG.test(slug) ? slug : null;
}

/** The trailing slash is load-bearing: without it the site answers 308 rather than the page. */
function listingUrl(id: string): string {
  if (!SLUG.test(id)) throw new Error(`not an austinhomes slug: ${JSON.stringify(id)}`);
  return `https://${HOST}/property-to-rent/${id}/`;
}

function extract(html: string, url: string): Listing {
  const externalId = listingId(url);
  if (externalId === null) throw new Error(`not an austinhomes listing URL: ${JSON.stringify(url)}`);

  const flight = flightPayload(html);
  const ld = jsonLdOfType(html, 'RealEstateListing');
  const property = propertyPayload(flight);
  if (!ld && !property) {
    throw new Error(`no RealEstateListing ld+json and no property payload on ${url}`);
  }

  const offers = obj(ld?.offers);
  const item = obj(offers?.itemOffered);
  const address = obj(item?.address);
  const geo = obj(item?.geo);
  const agent = jsonLdOfType(html, 'RealEstateAgent');

  const displayAddress = trimmed(address?.streetAddress) ?? trimmed(ld?.name) ?? trimmed(property?.address);
  const postcode = postcodeIn(str(address?.postalCode) ?? '') ?? postcodeIn(str(property?.postcode) ?? '');
  const description = trimmed(ld?.description);
  const gallery = urlsIn(arr(item?.image));

  return {
    ...blankListing('austinhomes', externalId, propertyKey('austinhomes', externalId), url),
    postcode,
    // The district survives when the incode does not: every display address here ends in one, and a
    // flat with an outcode is still a flat somebody can place on the map.
    outcode: outcodeOf(postcode) ?? (displayAddress === null ? null : outcodeIn(displayAddress)),
    displayAddress: displayAddress ?? 'Unknown address',
    price: priceText(decodeEntities(str(property?.formattedPrice) ?? '')) ?? offerPrice(offers),
    bedrooms: num(item?.numberOfBedrooms) ?? num(property?.bedrooms),
    bathrooms: num(item?.numberOfBathroomsTotal) ?? num(property?.bathrooms),
    latitude: num(geo?.latitude) ?? num(property?.latitude),
    longitude: num(geo?.longitude) ?? num(property?.longitude),
    nearestStations: stations(flight),
    floorArea: floorArea(property, description),
    letAvailableDate: trimmed(property?.availableDate),
    deposit: poundsIn(trimmed(property?.deposit)),
    councilTaxBand: councilTaxBand(property),
    listingUpdate: addedOn(ld?.datePosted),
    // `agentBranchId` stays null: it is Rightmove's own branch number and has no counterpart here.
    // The company is read off the page rather than taken from `Site.name`, so that an empty field
    // reads as one — this site ships `RealEstateAgent.name` as "" on all 4 pages read.
    agentBranch: trimmed(property?.office),
    agentCompany: trimmed(agent?.name),
    agentPhone: trimmed(agent?.telephone),
    floorplans: floorplans(property),
    imageUrls: gallery.length > 0 ? gallery : urlsIn(arr(property?.images)),
    description,
    archived: offMarket(offers),
  };
}

/** The CRM record the flight payload carries.
 *
 *  `"property":` appears three times on a listing page — the flat, and two cards in the rail of
 *  similar ones — so the one carrying `databaseId` is taken rather than the first. */
function propertyPayload(flight: string): Record<string, unknown> | null {
  for (const match of flight.matchAll(/"property":\s*\{/g)) {
    const found = obj(jsonAfter(flight.slice(match.index), '"property":'));
    if (found && num(found.databaseId) !== null) return found;
  }
  return null;
}

const PERIODS: Record<string, string> = { MONTH: 'pcm', WEEK: 'pw' };

/** The offer in the words the site prints beside it, for a page that has the ld+json but not the
 *  flight payload. A period we do not recognise gives null rather than a figure with no unit —
 *  a rent quoted per week and shown as a month is the mistake `price` stays a string to avoid. */
function offerPrice(offers: Record<string, unknown> | null): string | null {
  const spec = obj(offers?.priceSpecification);
  const amount = num(spec?.price) ?? num(offers?.price);
  const period = PERIODS[str(spec?.unitText)?.toUpperCase() ?? ''];
  return amount === null || period === undefined ? null : `£${amount.toLocaleString('en-GB')} ${period}`;
}

/** Stations the site lists for the flat, from the local-area block. `dist` is in miles: it quotes
 *  Chancery Lane at 0.357 from a flat the coordinates put 574 m away. The type of each is not
 *  stated as data — only inside the name — so `types` is left empty rather than parsed out of it. */
function stations(flight: string): Station[] {
  const listed = arr(jsonAfter(flight, '"trainMetroStations":')).flatMap((raw) => {
    const s = obj(raw);
    const name = trimmed(s?.commonName);
    const distance = num(s?.dist);
    return name === null || distance === null ? [] : [{ name, types: [], distance, unit: 'miles' }];
  });
  return sortedStations(listed);
}

/** The CRM's own area field first, then the prose. The unit is a separate field and an area with
 *  none is not a measurement, so it is dropped rather than assumed to be square feet. Empty on all
 *  4 pages read, lettings and sales, so this path is written from the field names alone. */
function floorArea(property: Record<string, unknown> | null, description: string | null): FloorArea | null {
  const stated = num(property?.floorAreaFrom);
  const unit = str(property?.floorAreaUnits)?.toLowerCase().replace(/[^a-z0-9]/g, '');
  const sqft = stated === null ? null
    : unit === 'sqft' || unit === 'ft2' ? stated
    : unit === 'sqm' || unit === 'm2' ? sqmToSqft(stated)
    : null;

  const fromField = statedSqft(sqft);
  if (fromField !== null) return fromField;

  const fromProse = description === null ? null : parseAreaFromText(description);
  return fromProse === null ? null : { sqft: fromProse, source: 'description' };
}

/** A–H only. The field is named, so what arrives in it is the band or it is somebody's note. */
function councilTaxBand(property: Record<string, unknown> | null): string | null {
  const band = trimmed(property?.councilTaxBand)?.toUpperCase();
  return band !== undefined && /^[A-H]$/.test(band) ? band : null;
}

/** `datePosted` worded the way `relativeUpdate` reads it — "<verb> on dd/mm/yyyy" becomes how long
 *  the flat has sat, and anything else passes through as written. */
function addedOn(datePosted: unknown): string | null {
  const posted = /^(\d{4})-(\d{2})-(\d{2})/.exec(str(datePosted) ?? '');
  return posted === null ? null : `Added on ${posted[3]}/${posted[2]}/${posted[1]}`;
}

/** schema.org availability terms that mean the flat is no longer to let.
 *
 *  One of the four was read off the site — a listing on its own let-properties index says
 *  `LimitedAvailability` where a live one says `InStock` — and the other three are the vocabulary's
 *  remaining ways of saying unavailable. A term outside either list leaves `archived` null:
 *  unknown, never "still on". */
const GONE = new Set(['limitedavailability', 'soldout', 'outofstock', 'discontinued']);

function offMarket(offers: Record<string, unknown> | null): boolean | null {
  const term = str(offers?.availability)?.toLowerCase().split('/').at(-1);
  if (term === undefined) return null;
  if (term === 'instock') return false;
  return GONE.has(term) ? true : null;
}

/** Every URL in one of the site's file lists, whichever way it was shipped: the ld+json gallery is
 *  plain strings and the CRM's galleries and floorplans are `{ url, dataUrl }` objects, where
 *  `dataUrl` is an inline blur placeholder rather than a photograph. All of them point at the
 *  site's own CDN and stay pointing at it — nothing here is copied. */
function urlsIn(items: unknown[]): string[] {
  return items.flatMap((raw) => {
    const url = str(obj(raw)?.url) ?? str(raw);
    return url === null ? [] : [url];
  });
}

function floorplans(property: Record<string, unknown> | null): Floorplan[] {
  // The site captions nothing, so every plan is one the panel labels for itself.
  return urlsIn(arr(property?.floorplans)).map((url) => ({ url, caption: null }));
}

export const austinhomes: Site = {
  id: 'austinhomes',
  name: 'Austin Homes London',
  hosts: [HOST, `www.${HOST}`],
  listingId,
  listingUrl,
  extract,
};
