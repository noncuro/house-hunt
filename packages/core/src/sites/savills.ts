/** Savills, read out of the Redux state its listing page ships in `__NEXT_DATA__`.
 *
 *  The whole property is server-rendered into `props.initialReduxState.propertyDetail.property` —
 *  the page could not draw itself otherwise — so nothing here needs the tokenless JSON API that
 *  sits behind the same site, and `extract` stays a pure decode of the string it is handed.
 *
 *  Four fields the app has elsewhere are absent from all seven Savills pages read while writing
 *  this: an availability date, a listing-history sentence, station distances, and a branch id of
 *  Rightmove's kind. They stay null rather than being manufactured from `ModifyDate` or from the
 *  transport prose in `Location`.
 */
import { ListingWithdrawn, parseAreaFromText } from '../listing';
import type { FloorArea, Floorplan, Listing } from '../types';
import {
  arr,
  blankListing,
  bool,
  councilTaxIn,
  dig,
  meta,
  nextData,
  num,
  obj,
  outcodeIn,
  outcodeOf,
  poundsIn,
  postcodeIn,
  priceText,
  sqmToSqft,
  statedSqft,
  str,
  textFromHtml,
  trimmed,
} from './read';
import { propertyKey, type Site } from './types';

const NAME = 'Savills';

/** Savills' own id, as it appears in the URL: office and reference run together, sixteen lowercase
 *  alphanumerics on each of the 16 listings one search page offered (`gbisreclv675394l`). Bounded
 *  loosely rather than pinned at sixteen, and lowercase-only because that is the one casing the
 *  site's canonical link, its `ExternalPropertyIDFormatted` and its own links all use — one casing
 *  is one row per flat. */
const ID = /^[a-z0-9]{6,40}$/;

/** `/property-detail/<id>`, behind the optional country/language prefix every non-GB locale of the
 *  site carries. The page's own hreflang list names 40-odd of them for one flat
 *  (`/us/en/…`, `/com/zh-tw/…`), all the same listing, so a link pasted from a Hong Kong tab has
 *  to reduce to the same id as one pasted from London. */
const PATH = /^(?:\/[a-z]{2,3}\/[a-z]{2}(?:-[a-z]{2})?)?\/property-detail\/([a-z0-9]+)\/?$/;

const HOST = 'search.savills.com';

/** The id in a Savills listing URL, or null when the URL is not one.
 *
 *  Host compared outright rather than by suffix: `search.savills.com.example.com` ends with the
 *  domain and is not Savills. Listings live only on this host — `savills.co.uk` is the marketing
 *  site and answers 404 for `/property-detail/<id>`, so it is not a second way in and is not in
 *  `hosts`. */
export function savillsListingId(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  if (parsed.hostname.toLowerCase() !== HOST) return null;

  const id = PATH.exec(parsed.pathname.toLowerCase())?.[1] ?? null;
  return id !== null && ID.test(id) ? id : null;
}

export const savills: Site = {
  id: 'savills',
  name: NAME,
  hosts: [HOST],
  listingId: savillsListingId,
  listingUrl(id) {
    // Validated rather than escaped, because `app/api/listing` fetches what this returns: an id
    // that is not this shape must stop here instead of becoming a path, a host, or a scheme.
    if (!ID.test(id)) throw new Error(`savills: ${JSON.stringify(id)} is not a listing id`);
    return `https://${HOST}/property-detail/${id}`;
  },
  extract,
};

function extract(html: string, url: string): Listing {
  const data = nextData(html);
  if (data === null) throw new Error('savills: this page carries no __NEXT_DATA__');
  const slice = obj(dig(data, 'props', 'initialReduxState', 'propertyDetail'));
  if (!slice) throw new Error('savills: no propertyDetail in __NEXT_DATA__');

  const property = obj(slice.property);
  if (!property) {
    // Savills answers an id it has no property for with the app shell under HTTP 404: the same
    // `/property` page, `propertyDetail.property` explicitly null, and none of the head tags the
    // server writes for a real listing. Both halves are required — a redesign that moved the
    // property elsewhere in the store would leave the `og:url` behind, and reading that as "gone"
    // would take every live flat off the worklist in one evening.
    //
    // A flat that has been let is not this page. It stays served in full with `IsLet` true, which
    // is `archived` below rather than this — the site drops the record only later, and only then
    // does a stored flat land here.
    if (slice.property === null && meta(html, 'og:url') === null) throw new ListingWithdrawn(NAME);
    throw new Error('savills: propertyDetail carries no property');
  }

  const externalId = savillsListingId(url) ?? payloadId(property);
  if (!externalId) throw new Error(`savills: no listing id in ${url} or in its payload`);

  const line2 = trimmed(property.AddressLine2);
  const displayAddress = [trimmed(property.AddressLine1), line2].filter((s) => s !== null).join(', ');
  const postcode = postcodeIn(displayAddress);
  const description = prose(property);
  // Deposit, EPC and council tax arrive as one list of the agent's own sentences rather than as
  // fields, so each fact is read out of the sentence that states it.
  const notes = arr(property.AdditionalInformation)
    .flatMap((line) => trimmed(line) ?? [])
    .join('\n');
  const office = obj(dig(property, 'PrimaryAgent', 'Office'));
  const isLet = bool(property.IsLet);
  const isSold = bool(property.IsSold);
  const size = obj(property.Size);
  const bathrooms = num(property.Bathrooms);

  return {
    ...blankListing('savills', externalId, propertyKey('savills', externalId), url),
    postcode,
    // Only when there is no full postcode, and only from the town line: a street name can carry a
    // letter-then-digit token ("Block A1") that reads as an outcode, and the town line cannot.
    outcode: outcodeOf(postcode) ?? (line2 === null ? null : outcodeIn(line2)),
    displayAddress: displayAddress === '' ? 'Unknown address' : displayAddress,
    // "£3,750" and "Weekly" are two halves of one quantity and the page prints them together. One
    // of the seven listings read while writing this is priced weekly, so dropping the basis would
    // file a flat at £16,250 a month beside one at £3,750.
    price: priceText([trimmed(property.DisplayPriceText), trimmed(property.RentBasisDescription)]
      .filter((s) => s !== null)
      .join(' ')),
    bedrooms: num(property.Bedrooms),
    // Zero is this payload's unset value in a fixed-shape struct — `Size`, `CarSpaces` and
    // `SizeMaximum` all sit at 0 when nothing was measured — and no flat has no bathroom. Zero
    // bedrooms is left alone: that one is a studio.
    bathrooms: bathrooms === 0 ? null : bathrooms,
    latitude: num(property.Latitude),
    longitude: num(property.Longitude),
    floorArea: floorArea(size, description),
    furnishType: trimmed(property.FurnishedFormatted),
    deposit: deposit(notes),
    letType: trimmed(property.LetTypeFormatted),
    councilTaxBand: councilTaxIn(notes),
    agentBranch: trimmed(office?.OfficeName),
    // A fact about the host rather than about the page: every listing here is marketed by Savills,
    // under one of its own branches. The named negotiators beside the branch are people, and this
    // reads the office instead — an office name and its number are business contact details.
    agentCompany: NAME,
    agentPhone: trimmed(office?.OfficePhoneNumber),
    floorplans: floorplans(property.FloorPlanGallery),
    imageUrls: arr(property.ImagesGallery).flatMap((raw) => largestImage(obj(raw)) ?? []),
    description,
    // The two booleans the payload states about this flat, and nothing else. A let flat carries
    // `IsLet` true beside `PropertyStatusFlagTranslation` "Let"; that same field also reads "New"
    // and "Under offer" on two of the seven, neither of which means gone, and the rest of its
    // vocabulary is unseen — so the flag is not read and the booleans are.
    archived: isLet === null && isSold === null ? null : isLet === true || isSold === true,
  };
}

/** The id the payload names itself by, for a page reached at a URL this adapter cannot reduce.
 *  Held to the same shape as the URL's, because it ends up in a primary key either way. */
function payloadId(property: Record<string, unknown>): string | null {
  const id = trimmed(property.ExternalPropertyIDFormatted)?.toLowerCase()
    ?? trimmed(property.ExternalPropertyID)?.toLowerCase()
    ?? null;
  return id !== null && ID.test(id) ? id : null;
}

/** The agent's own words: the one-line summary the page leads with, then the body it expands into.
 *  Both, because they overlap in wording rather than in content — the summary names the development
 *  and the body does not. Through `textFromHtml` for the `<BR/>`s the body is written in. */
function prose(property: Record<string, unknown>): string | null {
  const parts = [trimmed(property.Description)];
  for (const entry of arr(property.LongDescription)) {
    const block = obj(entry);
    parts.push(trimmed(block?.Head), trimmed(block?.Body));
  }
  const joined = parts.filter((part) => part !== null).join('\n\n');
  return joined === '' ? null : textFromHtml(joined);
}

/** Square feet as stated, else the square metres beside them, else whatever the prose says.
 *  The zeros this struct holds when nothing was measured fall out at `statedSqft`, which refuses
 *  anything under 100 sq ft. */
function floorArea(size: Record<string, unknown> | null, description: string | null): FloorArea | null {
  const sqm = num(size?.SqMt);
  const stated = statedSqft(num(size?.SqFt)) ?? statedSqft(sqm === null ? null : sqmToSqft(sqm));
  if (stated) return stated;
  const fromProse = description === null ? null : parseAreaFromText(description);
  return fromProse === null ? null : { sqft: fromProse, source: 'description' };
}

/** The tenancy deposit, not the holding deposit. Savills states both — a week against five or six —
 *  and the smaller one is what reserves the flat rather than what is put down on it. Neither is
 *  labelled consistently: "Deposit Payable: £4,153.85 (5 weeks)" on one listing and
 *  "Deposit Payable  £2,134.60 ( 5 weeks )" on another. */
function deposit(notes: string): number | null {
  const line = notes.split('\n').find((l) => /deposit/i.test(l) && !/holding/i.test(l));
  return poundsIn(line ?? null);
}

function floorplans(v: unknown): Floorplan[] {
  return arr(v).flatMap((raw) => {
    const plan = obj(raw);
    const url = largestImage(plan);
    return url === null ? [] : [{ url, caption: trimmed(plan?.Caption) }];
  });
}

/** The original where the payload carries one, else the largest resize it offers. The URL and only
 *  the URL: the photograph stays on Savills' CDN and is never copied onto ours. */
function largestImage(image: Record<string, unknown> | null): string | null {
  return str(image?.ImageUrl) ?? str(image?.ImageUrl_L) ?? str(image?.ImageUrl_M) ?? str(image?.ImageUrl_S);
}
