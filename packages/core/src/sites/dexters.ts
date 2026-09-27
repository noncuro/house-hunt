/** Dexters, read off a server-rendered Joomla page (Starberry CMS).
 *
 *  There is no payload here — no `__NEXT_DATA__`, no flight tree, no preloaded state — so this
 *  reads the page in the order that survives a redesign: the schema.org `Product` block, then the
 *  `<meta>` tags, then the markup. The block is required rather than preferred, because it is the
 *  only place three facts are stated: the full postcode, the canonical URL, and whether the flat
 *  is still on the market. A page without it is Dexters' 404 or a template nobody here has seen,
 *  and reading the markup alone would hand back a flat with no postcode — a flat with no travel
 *  times and no explanation.
 *
 *  Twelve fields have no source but the markup. Each is keyed on something the page means — an id,
 *  an href, a heading's own words, a `<b>Label:</b>` — except the price and the description, which
 *  have nothing on them but a class.
 */
import { parseAreaFromText } from '../listing';
import type { Listing, Station } from '../types';
import {
  balanced,
  blankListing,
  councilTaxIn,
  decodeEntities,
  meta,
  num,
  obj,
  outcodeIn,
  outcodeOf,
  poundsIn,
  postcodeIn,
  sortedStations,
  str,
  textFromHtml,
  trimmed,
} from './read';
import { propertyKey, type Site } from './types';

const HOSTS = ['dexters.co.uk', 'www.dexters.co.uk'];

/** Dexters' own id: the numeric last segment of a listing path. Bounded so a stray year or house
 *  number in a malformed path cannot pass as one. */
const ID = /^\d{4,10}$/;

/** `/property-for-rent/<slug>/<id>` and `/property-for-sale/<slug>/<id>`. The two channels share one
 *  id space — `/property-for-sale/x/278989` and `/property-for-rent/x/278989` both answer 200 with
 *  the same flat — so the channel segment is not part of the id. The search pages sit under
 *  `/property-lettings/` and `/property-sales/` and are not matched. The last segment is taken
 *  loosely here and held to `ID` after, so the id's character class is stated once. */
const LISTING_PATH = /^\/property-for-(?:rent|sale)\/[^/]+\/([^/]+)\/?$/;

function dextersListingId(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  if (!HOSTS.includes(parsed.hostname.toLowerCase())) return null;
  const last = LISTING_PATH.exec(parsed.pathname)?.[1];
  return last !== undefined && ID.test(last) ? last : null;
}

/** The slug is decorative: `/property-for-rent/property/278989` answers 301 to the canonical, and
 *  a fetch follows it. So the id alone rebuilds a URL, which is what keeps a doctored id from
 *  aiming the server's fetch anywhere but at one numbered page on one host. */
function dextersListingUrl(id: string): string {
  if (!ID.test(id)) throw new Error(`dexters: "${id}" is not one of its listing ids`);
  return `https://www.dexters.co.uk/property-for-rent/property/${id}`;
}

// ------------------------------------------------------------------------------------------------
// Reading the page.
// ------------------------------------------------------------------------------------------------

/** Dexters' schema.org `Product`, parsed past the stray closing brace its template emits.
 *
 *  `jsonLdOfType` cannot see this block: the body is `{…}}` on all four listing pages read, so
 *  `JSON.parse` over the whole of it fails and the block reads as absent. Brace-matching from the
 *  first `{` takes the object and leaves the stray behind, which is what a browser's own JSON-LD
 *  reader does with it. Private rather than pushed into `read.ts` because it is one template's bug
 *  and not a shape other sites have. */
function productBlock(html: string): Record<string, unknown> | null {
  const tag = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  for (const block of html.matchAll(tag)) {
    const body = block[1] ?? '';
    const text = balanced(body, body.indexOf('{'));
    if (text === null) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      // Not JSON is not our block. Every ld+json script on the page is offered in turn and the
      // caller reports the absence of the one it wants.
      continue;
    }
    const node = obj(parsed);
    if (node && str(node['@type'])?.toLowerCase() === 'product') return node;
  }
  return null;
}

/** The inner HTML of the `<div>` or `<span>` whose opening tag matches `marker`, counting nested
 *  tags of the same name.
 *
 *  A non-greedy `</div>` stops at the first nested close, which truncates the description at the
 *  block Dexters nests inside it once a property is let. */
function elementBody(html: string, name: 'div' | 'span', marker: RegExp): string | null {
  const at = html.search(marker);
  if (at < 0) return null;
  const start = html.indexOf('>', at);
  if (start < 0) return null;
  const tags = new RegExp(`<${name}\\b|</${name}\\s*>`, 'gi');
  tags.lastIndex = start + 1;
  let depth = 1;
  for (let tag = tags.exec(html); tag; tag = tags.exec(html)) {
    depth += tag[0].startsWith('</') ? -1 : 1;
    if (depth === 0) return html.slice(start + 1, tag.index);
  }
  return null;
}

/** The line of `text` carrying `label`. Dexters states the deposit and the council tax band as
 *  `<b>Label:</b> value` pairs at the foot of the description, one per line once `textFromHtml` has
 *  turned the `<br>`s into newlines. Taking the line rather than the whole description is what
 *  keeps `councilTaxIn` off an EPC band mentioned in the prose. */
function lineWith(text: string, label: RegExp): string | null {
  return trimmed(text.split('\n').find((line) => label.test(line)) ?? null);
}

/** Every photograph of listing `id` in `fragment`, once each, at the widest size the page names it
 *  in, in the order the page first names it.
 *
 *  Dexters serves one photograph off several paths differing only in a size token —
 *  `property_image.133cm88.v1/…` for the thumbnail strip, `.x800.` for the gallery, `.858cm626.`
 *  for the hero — so grouping on the path after the token collects the photograph once. The largest
 *  number in the token orders the variants, which is as much as the token has to mean here. The
 *  path also carries the listing's own id, and requiring it is what lets the whole page be scanned
 *  without a related-properties strip ever putting somebody else's flat in this gallery. The id
 *  goes into a pattern, which is safe because `ID` has already held it to digits.
 *
 *  URLs only. Nothing is fetched or copied: the photographs are the photographer's and are shown
 *  from Dexters' own CDN. */
function widestPhotos(fragment: string, id: string): Map<string, string> {
  const widest = new Map<string, { url: string; size: number }>();
  const image = new RegExp(`https://[^"'\\s]*/property_image\\.([A-Za-z0-9]+)\\.v1/([^"'\\s]*/${id}/[^"'\\s]+)`, 'g');
  for (const found of fragment.matchAll(image)) {
    const path = found[2] ?? '';
    const size = Math.max(0, ...(found[1] ?? '').split(/\D+/).map(Number).filter(Number.isFinite));
    const held = widest.get(path);
    if (!held || size > held.size) widest.set(path, { url: found[0], size });
  }
  return new Map([...widest].map(([path, held]) => [path, held.url]));
}

/** The stations Dexters lists, nearest first.
 *
 *  Markup, keyed on its own heading's words rather than on the list's class, and on the row shape
 *  `<p>Clapham South - 0.3m</p>`. The `m` is miles rather than metres — 0.3 is the fixture's walk
 *  to Clapham South, which is around 500 m. The line names beside each row are left out: they are
 *  in a decorative class, and `Stations` already draws lines from the travel cache. */
function stations(html: string): Station[] {
  const at = html.search(/>\s*Travel information\s*</i);
  if (at < 0) return [];
  const list = /<ul[^>]*>([\s\S]*?)<\/ul>/i.exec(html.slice(at))?.[1];
  if (!list) return [];
  const found: Station[] = [];
  for (const row of list.matchAll(/<li\b[\s\S]*?<\/li>/gi)) {
    const stated = /<p>\s*([^<]+?)\s*-\s*(\d+(?:\.\d+)?)\s*m\s*<\/p>/i.exec(row[0]);
    const name = trimmed(decodeEntities(stated?.[1] ?? ''));
    const distance = num(stated?.[2] ?? null);
    if (name === null || distance === null) continue;
    found.push({ name, types: [], distance, unit: 'miles' });
  }
  return sortedStations(found);
}

/** The map plugin's own coordinates, keyed on the function name rather than on anything around it.
 *  `id`, `lat` and `lng` are its first three arguments, so the window is well past them. */
function coordinates(html: string): { latitude: number | null; longitude: number | null } {
  const at = html.indexOf('loadLocratingPlugin');
  if (at < 0) return { latitude: null, longitude: null };
  const config = html.slice(at, at + 400);
  return {
    latitude: num(/\blat\s*:\s*(-?\d+(?:\.\d+)?)/.exec(config)?.[1] ?? null),
    longitude: num(/\blng\s*:\s*(-?\d+(?:\.\d+)?)/.exec(config)?.[1] ?? null),
  };
}

/** The quotation as the page words it: "£1,154 Pw / £5,000 Pcm".
 *
 *  The run from the first £ to the end of the last figure-and-qualifier pair, rather than the
 *  line's whole text, because the line also carries a fees link and — once the flat is let — a
 *  one-word status after the figures. Kept as the agent's string and never reduced to the
 *  `data-price` number beside it: weekly and monthly are different quantities and a bare number
 *  would let one be compared against the other. */
const PRICE = /£[\d,]+(?:\s*(?:pw|pcm|pa|per\s+\w+))?(?:\s*\/\s*£[\d,]+(?:\s*(?:pw|pcm|pa|per\s+\w+))?)?/i;

/** The address, the bedroom count and the bathroom count, out of the one `<meta>` description
 *  Dexters writes: "View our 3 bedroom 2 bathroom 1 reception Flat to rent in Windmill Drive,
 *  London, SW4. (Ref 278989)". A meta tag rather than the `<h1>` beside it because the heading's
 *  street and area sit in two spans that only a class name separates. */
const SUMMARY = {
  address: /\bin\s+(.+?)\s*\(Ref\s*\d+\)/i,
  bedrooms: /(\d+)\s+bedroom/i,
  bathrooms: /(\d+)\s+bathroom/i,
};

/** On the market according to the `Product` block's `offers.availability`, which Dexters splices
 *  its own word into: `schema.org/InStock` while it is on, `schema.org/Let` once it has gone. Those
 *  two are what four pages showed; the rest are schema.org's own words for the same fact and cost
 *  nothing to accept. Anything else is null rather than a guess: `archived` draws a flat under
 *  Archived and keeps it out of the triage pile, so getting it wrong on a live one hides it from
 *  both lists it belongs in, with nothing on screen to say what happened. */
const OFF_MARKET = new Set(['let', 'sold', 'soldout', 'outofstock']);

function offMarket(availability: string | null): boolean | null {
  const word = availability?.split('/').at(-1)?.toLowerCase();
  if (word === undefined) return null;
  if (word === 'instock') return false;
  return OFF_MARKET.has(word) ? true : null;
}

/** Dexters answers a listing it no longer serves with its site-wide 404 page — a `<title>` of
 *  "404 - Error: 404" and nothing about the property — so there is no page here to recognise as
 *  "this flat has gone" and `ListingWithdrawn` is never thrown. The fact still arrives, by the
 *  route that matters more: a let property keeps its whole page and says so in `availability`,
 *  which lands in `archived`. What `extract` does with the 404 is throw for the missing `Product`
 *  block, and the caller has the HTTP status to say what that was. */
function extract(html: string, url: string): Listing {
  const product = productBlock(html);
  if (!product) throw new Error('no schema.org Product block on this Dexters page');

  const offers = obj(product.offers);
  const stated = str(offers?.url);
  const id = dextersListingId(url) ?? dextersListingId(stated ?? '');
  if (id === null) throw new Error(`no Dexters listing id in ${url} or in the page's own Product block`);

  // The page's own canonical when it names this listing. A URL rebuilt from the id alone carries a
  // placeholder slug and only reaches the page through a redirect.
  const canonical = stated !== null && dextersListingId(stated) === id ? stated : dextersListingUrl(id);
  const listing = blankListing('dexters', id, propertyKey('dexters', id), canonical);

  const summary = meta(html, 'description') ?? '';
  const address = trimmed(SUMMARY.address.exec(summary)?.[1]?.replace(/\.$/, '') ?? null);

  // The full postcode is in the `Product` block's own name — "3 Bedroom Flat To Let in Clapham
  // Common, London, SW4 9DE" — and nowhere the page shows a reader. Read from that string and not
  // from the page, which also carries the branch office's postcode a few hundred bytes away.
  const postcode = postcodeIn(str(product.name) ?? '');

  const body = elementBody(html, 'div', /class="section-entry/);
  const description = body === null ? null : str(textFromHtml(body));
  const taxLine = description === null ? null : lineWith(description, /council\s*tax/i);
  const sqft = description === null ? null : parseAreaFromText(description);

  const plans = widestPhotos(elementBody(html, 'div', /id="floorplan-modal"/) ?? '', id);
  // The energy certificate is a photograph of neither the flat nor its plan, and putting it in
  // front of the vision pass would have it read a chart as a room.
  const certificate = widestPhotos(elementBody(html, 'div', /id="epc-modal"/) ?? '', id);
  const photos = widestPhotos(html, id);
  for (const path of [...plans.keys(), ...certificate.keys()]) photos.delete(path);

  // The branch is the one anchor on the page that names itself — a link into `/contact-us/our-offices/`
  // — and the office's number is the first `tel:` after it, which is what keeps this off the ones in
  // the header and the footer.
  const branch = /<a[^>]*href="\/contact-us\/our-offices\/[^"]*"[^>]*>([\s\S]*?)<\/a>/i.exec(html);
  const phone = branch === null ? null : /<a[^>]*href="tel:([^"]*)"[^>]*>([\s\S]*?)<\/a>/i.exec(html.slice(branch.index));

  return {
    ...listing,
    ...coordinates(html),
    postcode,
    outcode: outcodeOf(postcode) ?? (address === null ? null : outcodeIn(address)),
    displayAddress: address ?? listing.displayAddress,
    price: trimmed(PRICE.exec(textFromHtml(elementBody(html, 'span', /class="price"/) ?? ''))?.[0] ?? null),
    bedrooms: num(SUMMARY.bedrooms.exec(summary)?.[1] ?? null),
    bathrooms: num(SUMMARY.bathrooms.exec(summary)?.[1] ?? null),
    nearestStations: stations(html),
    floorArea: sqft === null ? null : { sqft, source: 'description' },
    deposit: poundsIn(description === null ? null : lineWith(description, /deposit/i)),
    councilTaxBand: taxLine === null ? null : councilTaxIn(taxLine),
    agentBranch: trimmed(textFromHtml(branch?.[1] ?? '')),
    agentCompany: trimmed(obj(product.brand)?.name),
    agentPhone: trimmed(textFromHtml(phone?.[2] ?? '')) ?? trimmed(phone?.[1] ?? null),
    floorplans: [...plans.values()].map((url) => ({ url, caption: null })),
    imageUrls: [...photos.values()],
    description,
    archived: offMarket(str(offers?.availability)),
  };
}

/** `furnishType`, `letAvailableDate`, `letType`, `listingUpdate` and `agentBranchId` are left null
 *  on purpose: `<b>Security Deposit:</b>` and `<b>Council Tax Band:</b>` are the only labelled
 *  fields on any of the four pages read, and Rightmove's branch id has no counterpart here. */
export const dexters: Site = {
  id: 'dexters',
  name: 'Dexters',
  hosts: HOSTS,
  listingId: dextersListingId,
  listingUrl: dextersListingUrl,
  extract,
};
