/** John D Wood & Co., read out of the Homeflow payload its listing page ships inline.
 *
 *  Homeflow is a platform rather than a site, and this is its Rails generation: the page writes the
 *  whole listing into a script as `Homeflow.set('property_data', {…})`, which brace-matches out of
 *  the HTML string. Chestertons runs the same vendor's Next.js generation, where the listing arrives
 *  in an RSC flight payload instead — a different payload in a different place, so the two share a
 *  vendor and no code.
 *
 *  Two payloads, because the page states the flat twice and neither half is whole. `property_data`
 *  has the price, the description, the photographs, the branch and the sizes. The map's
 *  `var propertyData` has the full postcode, the coordinates and the date the listing appeared, and
 *  `property_data` has none of those.
 *
 *  Three fields the app holds elsewhere are stated nowhere on the four listings read while writing
 *  this: a deposit, an availability date and a council tax band. `available` is a field on the
 *  payload and was null on all four, so it is read rather than manufactured; the band is read from
 *  the agent's own words where they name one; the deposit has no field and no sentence, and stays
 *  null.
 */
import { ListingWithdrawn, parseAreaFromText } from '../listing';
import type { FloorArea, Floorplan, Listing, Station } from '../types';
import {
  arr,
  blankListing,
  councilTaxIn,
  jsonAfter,
  num,
  obj,
  outcodeIn,
  outcodeOf,
  postcodeIn,
  priceText,
  sortedStations,
  sqmToSqft,
  statedSqft,
  str,
  textFromHtml,
  trimmed,
} from './read';
import { propertyKey, type Site } from './types';

const NAME = 'John D Wood & Co';

/** Listings are served from `www`; the apex 301s onto it, so a pasted link arrives either way. */
const HOST = 'www.johndwood.co.uk';
const HOSTS = ['johndwood.co.uk', HOST];

/** Homeflow's own property number, and the whole of the id. Digits only, which is what keeps it
 *  safe in a `#card-<key>` selector and in a primary key. */
const ID = /^\d{5,12}$/;

/** `/properties/<id>/<channel>/<agent reference>`, with everything after the number optional.
 *
 *  Both trailing segments are decorative and neither identifies the flat. A wrong reference serves
 *  the listing (`/lettings/ZZZ999999/` -> 200, same payload), and so does the wrong channel: a sales
 *  listing fetched under `/lettings` comes back with its own `property_id` and `status: "For sale"`,
 *  and only the page's own heading changes wording. The number alone cannot be shortened to,
 *  though — `/properties/<id>` on its own redirects to the homepage — so `listingUrl` puts a channel
 *  back. Sales and lettings share one id space, and both are accepted here. */
const PATH = /^\/properties\/(\d+)(?:\/(?:lettings|sales)(?:\/[a-z0-9._-]*)?)?\/?$/;

/** Where each half of the page lives. */
const PAYLOAD = "Homeflow.set('property_data'";
const MAP_PAYLOAD = 'var propertyData';

/** The id in a John D Wood listing URL, or null when the URL is not one.
 *
 *  Host matched against the two spellings outright rather than by suffix: `johndwood.co.uk.example`
 *  ends with the domain and is not John D Wood. The path is lowercased before matching so a link
 *  someone has title-cased still reduces to the same id, which is one row per flat. */
export function johndwoodListingId(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  if (!HOSTS.includes(parsed.hostname.toLowerCase())) return null;

  const id = PATH.exec(parsed.pathname.toLowerCase())?.[1] ?? null;
  return id !== null && ID.test(id) ? id : null;
}

export const johndwood: Site = {
  id: 'johndwood',
  name: NAME,
  hosts: HOSTS,
  listingId: johndwoodListingId,
  listingUrl(id) {
    // Validated rather than escaped, because `app/api/listing` fetches what this returns: an id that
    // is not this shape must stop here instead of becoming a path, a host, or a scheme.
    if (!ID.test(id)) throw new Error(`johndwood: ${JSON.stringify(id)} is not a listing id`);
    return `https://${HOST}/properties/${id}/lettings`;
  },
  extract,
};

function extract(html: string, url: string): Listing {
  const data = obj(jsonAfter(html, PAYLOAD));
  if (!data) {
    if (isWithdrawn(html)) throw new ListingWithdrawn(NAME);
    throw new Error('johndwood: this page carries no Homeflow property_data');
  }

  const externalId = johndwoodListingId(url) ?? payloadId(data);
  if (!externalId) throw new Error(`johndwood: no listing id in ${url} or in its payload`);

  const mapped = mapEntry(html, externalId);
  const address = trimmed(data.address);
  const postcode = postcodeIn(str(mapped?.postcode) ?? '');
  const prose = words(data);
  const bathrooms = num(data.bathrooms);

  return {
    ...blankListing('johndwood', externalId, propertyKey('johndwood', externalId), url),
    postcode,
    // Only from the last comma-separated part of the address, which is where Homeflow puts the
    // outcode ("Glebe Place, Chelsea, SW3"). A street name can carry a letter-then-digit token that
    // reads as an outcode, and the tail of the line cannot.
    outcode: outcodeOf(postcode) ?? outcodeIn(address?.split(',').pop() ?? ''),
    displayAddress: address ?? 'Unknown address',
    // The agent's own quotation, kept whole: this site prices in both "£8,500 pw" and "£6,750 pcm",
    // and a bare number would file the first at four times what it is.
    price: priceText(data.price),
    bedrooms: num(data.bedrooms),
    // Zero bathrooms is this feed's unfilled value — a three-bedroom maisonette at £6,750 pcm states
    // it — and no flat has no bathroom. Zero bedrooms is left alone: that one is a studio.
    bathrooms: bathrooms === 0 ? null : bathrooms,
    latitude: num(mapped?.lat),
    longitude: num(mapped?.lng),
    nearestStations: stations(data.geoFeatures),
    floorArea: floorArea(data, prose),
    furnishType: furnishType(data.tags),
    letAvailableDate: trimmed(data.available),
    letType: letType(data.tags),
    councilTaxBand: councilTax(prose),
    listingUpdate: addedOn(mapped),
    // Homeflow's branch number, not Rightmove's, sharing the column with it. Nothing joins or groups
    // on this — `agentCompany` is what the app counts by — so the two numberings sit side by side
    // without meeting, and a branch that gets renamed is still recognisable.
    agentBranchId: num(data.branchID),
    agentBranch: trimmed(data.branchName),
    // The map payload's `agency_name` and not `property_data`'s `brandName`, which is "Countrywide":
    // the parent group, not the name the flat is advertised under.
    agentCompany: trimmed(mapped?.agency_name) ?? NAME,
    agentPhone: trimmed(data.contactTelephone),
    floorplans: floorplans(data.propertyFloorplans),
    imageUrls: arr(data.propertyPhotos).flatMap((raw) => absolute(str(obj(raw)?.url)) ?? []),
    description: prose,
    archived: archived(trimmed(data.status)),
  };
}

/** John D Wood's own answer for a listing it no longer has: the URL 301s to `/properties/lettings`,
 *  the lettings index, and the `listing` route's fetch follows redirects — so what lands here is
 *  that index page rather than anything about the flat.
 *
 *  Homeflow stamps its Rails route into every page, and the index says `properties#index` where a
 *  listing says `properties#show`. Narrow on purpose, and only asked with no `property_data` in
 *  hand: a redesign that moved the payload elsewhere would leave `properties#show` behind, so it is
 *  reported as unreadable rather than as every flat coming off the market in one evening.
 *
 *  Let agreed is not this. That listing is still served, still `properties#show`, and still carries
 *  its whole payload — it says so in `status`, which `archived` reads. */
const INDEX_ROUTE = /Homeflow\.set\(\s*'page_route'\s*,\s*'properties#index'\s*\)/;

function isWithdrawn(html: string): boolean {
  return INDEX_ROUTE.test(html);
}

/** The id the payload names itself by, for a page reached at a URL this adapter cannot reduce.
 *  Held to the same shape as the URL's, because it ends up in a primary key either way. */
function payloadId(data: Record<string, unknown>): string | null {
  const id = num(data.propertyID);
  const text = id === null ? null : String(id);
  return text !== null && ID.test(text) ? text : null;
}

/** The flat's row in the map payload, matched on its own id rather than taken as the first: the same
 *  variable holds every card on a search page, and one day it will hold the similar-properties strip
 *  on this one.
 *
 *  It is the only place the page states the full postcode — `property_data`'s address line stops at
 *  the outcode — and the app routes from the postcode rather than from the pin. */
function mapEntry(html: string, externalId: string): Record<string, unknown> | null {
  const rows = arr(obj(jsonAfter(html, MAP_PAYLOAD))?.properties)
    .flatMap<Record<string, unknown>>((raw) => obj(raw) ?? []);
  return rows.find((row) => String(num(row.property_id)) === externalId) ?? null;
}

/** The agent's own words: the bullet list they filled in, then the description they wrote.
 *
 *  Both, because the two carry different facts. The bullets are where a term, an EPC rating and a
 *  stated size appear ("1173sqft, Freehold"), and the description is where whether bills are
 *  included is ever said. Through `textFromHtml` for the `<br/>`s the description is written in. */
function words(data: Record<string, unknown>): string | null {
  const parts = [...arr(data.features).flatMap((line) => trimmed(line) ?? []), str(data.description)];
  const joined = parts.filter((part) => part !== null).join('\n');
  return joined === '' ? null : textFromHtml(joined);
}

/** The internal area, and only the internal one.
 *
 *  `squareFeet` and `squareMeters` sit beside `squareFeetInternal` and `squareMetersInternal` and
 *  were 0 and null on all four listings read. On a house the unqualified figure would be the plot,
 *  and a plot recorded as a floor area is the mistake `parseAreaFromText`'s own exclusion list
 *  exists to prevent — so the unqualified pair is not read at all. The zeros fall out at
 *  `statedSqft`, which refuses anything under 100 sq ft. */
function floorArea(data: Record<string, unknown>, prose: string | null): FloorArea | null {
  const sqm = num(data.squareMetersInternal);
  const stated = statedSqft(num(data.squareFeetInternal)) ?? statedSqft(sqm === null ? null : sqmToSqft(sqm));
  if (stated) return stated;

  const fromProse = prose === null ? null : parseAreaFromText(prose);
  return fromProse === null ? null : { sqft: fromProse, source: 'description' };
}

/** How the flat is let, as Homeflow tags it. Most specific first, so a feed carrying both
 *  "part furnished" and "furnished" is not reported as furnished. All three were seen across four
 *  listings. */
const FURNISH: [string, string][] = [
  ['part furnished', 'Part furnished'],
  ['unfurnished', 'Unfurnished'],
  ['furnished', 'Furnished'],
];

function furnishType(v: unknown): string | null {
  const tags = tagSet(v);
  return FURNISH.find(([tag]) => tags.has(tag))?.[1] ?? null;
}

/** The four tags a short let carries. There is no counterpart: the site's own lettings tag
 *  vocabulary offers New Listing, Short Lets, Country House and Let, and nothing for a long one. So
 *  a flat without one of these has not been called a long let and stays unknown, rather than being
 *  defaulted to "Long term" on the strength of a missing tag. */
const SHORT_LET = ['short let', 'short lets', 'short term', 'short term lets'];

function letType(v: unknown): string | null {
  const tags = tagSet(v);
  return SHORT_LET.some((tag) => tags.has(tag)) ? 'Short term' : null;
}

function tagSet(v: unknown): Set<string> {
  return new Set(arr(v).flatMap((tag) => trimmed(tag)?.toLowerCase() ?? []));
}

/** A band, but only where the words "council tax" are the ones stating it. `councilTaxIn` also
 *  accepts a bare "Band D", and this agent's bullet lists say "EPC D" — one "EPC Band D" away from
 *  filing an energy rating as a council tax band. */
function councilTax(prose: string | null): string | null {
  return prose !== null && /council\s*tax/i.test(prose) ? councilTaxIn(prose) : null;
}

/** "Added on 08/05/2025" — the shape `relativeUpdate` reads, from the one date the page states about
 *  the listing rather than about the flat. Homeflow writes no listing-history sentence of its own,
 *  and `createDate` is when the record appeared, which is what that sentence carries. Reformatted as
 *  text rather than through a `Date`, so no timezone can move the day. */
function addedOn(mapped: Record<string, unknown> | null): string | null {
  const parts = /^(\d{4})-(\d{2})-(\d{2})T/.exec(str(mapped?.createDate) ?? '');
  return parts ? `Added on ${parts[3]}/${parts[2]}/${parts[1]}` : null;
}

/** On the market, and off it, in the site's own words.
 *
 *  `status` is a short controlled vocabulary: "To let" and "For sale" for a live listing, "Let
 *  agreed" on one of the four read, and the theme's own overlay settings name the rest of it — let,
 *  under offer, sold stc, sold. Anything outside both lists stays null: unknown, not "still on".
 *
 *  Let agreed belongs here and not in `isWithdrawn`. The flat is off the market, which is what
 *  `archived` means on the Rightmove side too, and the page is still there to be read — so it is
 *  recorded and marked rather than thrown. */
const ON_MARKET = new Set(['to let', 'for sale']);
const OFF_MARKET = new Set(['let agreed', 'let', 'under offer', 'sold stc', 'sold']);

function archived(status: string | null): boolean | null {
  const word = status?.toLowerCase() ?? null;
  if (word === null) return null;
  if (OFF_MARKET.has(word)) return true;
  return ON_MARKET.has(word) ? false : null;
}

function stations(v: unknown): Station[] {
  return sortedStations(
    arr(v).flatMap((raw) => {
      const feature = obj(raw);
      const name = trimmed(feature?.name);
      const distance = num(feature?.distance);
      if (name === null || distance === null) return [];
      // Homeflow states the number and not the unit, and the numbers are miles — 0.6 to South
      // Kensington from a Chelsea listing is not kilometres. `stationDistance` renders "mi" off this
      // word. `type` is Homeflow's own vocabulary (`tube_stops`, `railway_stations`), passed through
      // rather than translated into Rightmove's, which nothing reads and which would be a guess.
      const type = trimmed(feature?.type);
      return [{ name, types: type === null ? [] : [type], distance, unit: 'miles' }];
    }),
  );
}

function floorplans(v: unknown): Floorplan[] {
  return arr(v).flatMap((raw) => {
    const url = absolute(str(obj(raw)?.propertyFloorplan));
    return url === null ? [] : [{ url, caption: null }];
  });
}

/** Homeflow ships its asset URLs protocol-relative (`//mr2.homeflow-assets.co.uk/…`), which is a URL
 *  only inside a page — these are handed to `fetch` server-side, so the scheme goes on here.
 *  Anything that is neither of those two shapes is refused rather than passed along.
 *
 *  The URL and only the URL: the photograph stays on Homeflow's CDN and is never copied onto ours.
 *  The `_x_` in the path is the geometry slot left unconstrained, which is the original and the
 *  largest variant on offer — the page's own floorplan link uses it. */
function absolute(url: string | null): string | null {
  if (url === null) return null;
  if (url.startsWith('//')) return `https:${url}`;
  return /^https?:\/\//i.test(url) ? url : null;
}
