import { parseAreaFromText } from '../listing';
import type { Floorplan, Listing } from '../types';
import {
  blankListing,
  councilTaxIn,
  decodeEntities,
  jsonLdOfType,
  meta,
  num,
  obj,
  outcodeOf,
  postcodeIn,
  str,
  textFromHtml,
  trimmed,
} from './read';
import { propertyKey, type Site } from './types';

/** TK International — a Hampstead lettings and sales agency, on WordPress over Reapit.
 *
 *  The page is server-rendered and its only structured block is Yoast's `@graph`, which describes
 *  the *page* rather than the flat: a `WebPage`, a `BreadcrumbList`, a `WebSite` and the agency's
 *  `Organization`. There is no `Residence`, no Reapit object inlined, no `wp-json` preload. So the
 *  agency name comes off schema.org and every fact about the flat is read out of the markup, keyed
 *  on the page's own words and ids — a heading, a section id, a list item that is nothing but a
 *  count — rather than on the theme's class names, per the rule in AGENTS.md.
 *
 *  Four fields the other sites carry are absent from every TK listing read (three live pages plus
 *  the fixture) and are therefore never set: furnish type, available date, deposit and let type.
 *  They are not stated in the markup, in a table, or in the description, so they stay null — which
 *  is the answer the triage filters are built to keep. */

const SITE = 'tkinternational';
const ORIGIN = 'https://www.t-k.co.uk';
const PATH = '/property-to-rent/';
const HOSTS = ['t-k.co.uk', 'www.t-k.co.uk'];

/** A WordPress permalink slug as `sanitize_title` leaves one: lowercase, digits, single hyphens.
 *
 *  The slug is the id here, so this is an allowlist and `listingUrl` throws on anything it refuses.
 *  That matters more than it does for the numeric-id sites: a slug is free-form text going into a
 *  URL *path*, so `.`, `/`, `%` and `..` have to be impossible by construction rather than
 *  unlikely — otherwise `app/api/listing` fetches whatever a caller writes. It is also what
 *  `propertyKey` puts inside a `#card-…` DOM id, which rules out the same characters again. */
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** The address, which the page states once, as its only `<h1>`. */
const HEADING = /<h1[^>]*>([\s\S]*?)<\/h1>/i;

/** Where the agent's prose lives. `id="description"` is the anchor the page's own in-page nav links
 *  to, which is what makes it the stable half of this section. */
const DESCRIPTION = /<section[^>]*\bid=["']description["'][^>]*>([\s\S]*?)<\/section>/i;
const DESCRIPTION_ID = /\bid=["']description["']/i;

/** One quoted figure. `£` is written literally on every page read, and the entity forms are here
 *  because a Reapit-fed field arriving escaped would otherwise read as no price at all. */
const AMOUNT = String.raw`(?:£|&pound;|&#163;)[\d,]+(?:\s*(?:pw|pcm|pm|pa|per\s+week|per\s+month|per\s+annum))?`;

/** A `<p>` whose whole content is money — "£1,846 pw / £7,999 pcm".
 *
 *  Matched on the shape of the text and anchored to both ends of the paragraph, so a figure quoted
 *  inside the agent's prose cannot win. TK quotes weekly and monthly side by side, and the run is
 *  kept whole because those are two quantities and a number would silently compare them. */
const PRICE = new RegExp(`<p[^>]*>\\s*(${AMOUNT}(?:\\s*/\\s*${AMOUNT})*)\\s*</p>`, 'i');

/** The banner's status pill. TK writes one of three words and `archived` covers the last two. */
const STATUS = /<span[^>]*>\s*(To Let|Let Agreed|Let)\s*<\/span>/i;

/** An image served out of a listing's own Reapit media folder. */
const MEDIA_SRC = /src=["'](https?:\/\/[^"']*\/wp-content\/uploads\/properties\/\d+\/[^"']+)["']/gi;

/** WordPress writes a `-1280x1200` resize beside every original; the vision pass wants the original. */
const RESIZED = /-\d+x\d+\.[a-z0-9]+$/i;

/** A row in the Documents list, and the modal it opens. */
const DOCUMENT_LABEL = /data-modal-target=["'](document-\d+)["'][^>]*>([\s\S]*?)<\/span>/gi;

/** The office number, off the link somebody would tap. */
const TELEPHONE = /href=["']tel:([^"']+)["']/i;

/** The map pin, carried as a JSON attribute on the map div. */
const MAP_MARKER = /data-map-marker=["']([^"']*)["']/i;

function listingId(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  if (!HOSTS.includes(parsed.hostname.toLowerCase())) return null;
  const path = parsed.pathname.toLowerCase();
  // Sales sit under `/property-for-sale/` and both archives under `/property-lettings/`, so the
  // prefix is what separates a listing from every other page here. `new URL` has already collapsed
  // any `..` and left `%2F` encoded, so what remains is one segment or it is not a listing.
  if (!path.startsWith(PATH)) return null;
  const slug = path.slice(PATH.length).replace(/\/+$/, '');
  return SLUG.test(slug) ? slug : null;
}

function listingUrl(id: string): string {
  if (!SLUG.test(id)) throw new Error(`${SITE}: "${id}" is not a listing slug`);
  return `${ORIGIN}${PATH}${id}/`;
}

/** "4 Bedrooms" as the whole content of a list item.
 *
 *  Keyed on the words rather than on the `icon-list__item--bedroom` class beside them. A count that
 *  fills an entire `<li>` is the banner's own summary; the agent's prose spells its numbers out and
 *  sits in `<p>`, so the two cannot be confused. */
function count(html: string, word: string): number | null {
  return num(html.match(new RegExp(`<li[^>]*>\\s*(\\d+)\\s*${word}s?\\s*</li>`, 'i'))?.[1]);
}

/** Whether the page says the flat has gone, read from the banner's own pill.
 *
 *  Bounded to the run between the heading and the description because the same pill is drawn on the
 *  related-flat cards further down, and those carry *other properties'* statuses — on one page two
 *  of them sit 53,000 characters below the banner. Without both anchors there is no reading at all:
 *  null is "we could not check", which withholds nothing, while a related card's word would mark a
 *  live flat gone. */
function archived(html: string, headingAt: number): boolean | null {
  const descriptionAt = html.search(DESCRIPTION_ID);
  if (headingAt < 0 || descriptionAt <= headingAt) return null;
  const pill = html.slice(headingAt, descriptionAt).match(STATUS)?.[1];
  return pill === undefined ? null : pill.toLowerCase() !== 'to let';
}

/** Each `document-N` modal and the image inside it.
 *
 *  Split on the attribute rather than matched across a window: a modal holding no image would
 *  otherwise be handed the next modal's, which is how an EPC certificate gets filed as a floorplan.
 *  Only the document modals are collected — the gallery is a modal too, and taking its first
 *  photograph here would then exclude that photograph from `imageUrls`. */
function documentImages(html: string): Map<string, string> {
  const images = new Map<string, string>();
  for (const chunk of html.split(/data-modal=/i).slice(1)) {
    const name = chunk.match(/^["']([^"']+)["']/)?.[1];
    const src = chunk.match(/src=["']([^"']+)["']/)?.[1];
    if (name?.startsWith('document-') && src) images.set(name, src);
  }
  return images;
}

/** A document the agent labelled as a floorplan, and nothing else.
 *
 *  The same list carries the EPC certificate and, on 3 of 4 pages read, a document whose label is
 *  the raw filename it was uploaded under — "Hi.jpg". A floorplan is what the vision pass measures
 *  rooms off, so filing an EPC chart as one is worse than filing nothing, and a filename says
 *  nothing about what is in the picture. Only the label decides. */
function floorplans(html: string, documents: Map<string, string>): Floorplan[] {
  const found: Floorplan[] = [];
  for (const match of html.matchAll(DOCUMENT_LABEL)) {
    const label = trimmed(decodeEntities(match[2] ?? ''));
    const url = documents.get(match[1] ?? '');
    if (url && label !== null && /floor\s*plan/i.test(label)) found.push({ url, caption: label });
  }
  return found;
}

/** The pin TK draws, out of the JSON its map div carries as an attribute.
 *
 *  Both values arrive as strings, and `num` is what refuses `""` — a listing whose CRM record has
 *  no position — rather than reading it as zero. A 0/0 pair is the same absence written the other
 *  way and is dropped for the same reason: Null Island is not in NW3. */
function position(html: string): { latitude: number; longitude: number } | null {
  const raw = html.match(MAP_MARKER)?.[1];
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeEntities(raw));
  } catch {
    return null;
  }
  const marker = obj(parsed);
  const latitude = num(marker?.lat);
  const longitude = num(marker?.lng);
  if (latitude === null || longitude === null) return null;
  return latitude === 0 && longitude === 0 ? null : { latitude, longitude };
}

/** Every photograph in this listing's media folder, largest variant only.
 *
 *  URLs and never bytes: the photographs are the photographer's and are shown from TK's own CDN.
 *  The documents are subtracted because the EPC chart and the floorplan live in the same folder and
 *  are not gallery photographs. */
function imageUrls(html: string, documents: Map<string, string>): string[] {
  const shown = new Set(documents.values());
  const originals = new Set<string>();
  for (const match of html.matchAll(MEDIA_SRC)) {
    const src = str(match[1]);
    if (src !== null && !RESIZED.test(src) && !shown.has(src)) originals.add(src);
  }
  return [...originals];
}

function extract(html: string, url: string): Listing {
  const externalId = listingId(url);
  if (externalId === null) throw new Error(`${SITE}: ${url} is not a listing address here`);

  const heading = HEADING.exec(html);
  const address = trimmed(decodeEntities(heading?.[1] ?? ''));
  const price = trimmed(decodeEntities(html.match(PRICE)?.[1] ?? ''));
  const bedrooms = count(html, 'Bedroom');

  // The loud failure. What a deleted listing answers with is WordPress's own 404 page, which
  // carries no `<h1>` at all, while every listing read carries one holding the address. Requiring a
  // price or a bed count beside it separates a listing from any other page that grew a heading: a
  // Listing of nulls under a real key is indistinguishable from a flat nobody has filled in.
  if (address === null || (price === null && bedrooms === null)) {
    throw new Error(`${SITE}: no listing at ${url} — no address heading with a price or a bed count`);
  }

  // Off the heading first. The slug ends in a postcode too and is the fallback rather than the
  // source: a permalink is a title somebody typed once, and the heading is the address.
  const postcode = postcodeIn(address) ?? postcodeIn(externalId.replace(/-/g, ' '));
  const description = str(textFromHtml(DESCRIPTION.exec(html)?.[1] ?? ''));
  const sqft = description === null ? null : parseAreaFromText(description);
  const pin = position(html);
  const documents = documentImages(html);

  return {
    ...blankListing(SITE, externalId, propertyKey(SITE, externalId), url),
    displayAddress: address,
    postcode,
    outcode: outcodeOf(postcode),
    price,
    bedrooms,
    bathrooms: count(html, 'Bathroom'),
    latitude: pin?.latitude ?? null,
    longitude: pin?.longitude ?? null,
    // Stated in the prose or not at all — TK publishes no structured sizing.
    floorArea: sqft === null ? null : { sqft, source: 'description' },
    // `councilTaxIn` reads a bare "band C" as a band, and the only band TK's prose ever names is
    // the EPC one. Ask it only where the words "council tax" appear, so the fallback cannot fire.
    councilTaxBand:
      description !== null && /council\s*tax/i.test(description) ? councilTaxIn(description) : null,
    // One office, named the same on every listing, so there is no per-listing branch to show and
    // `agentBranch` stays null rather than repeating the company. `agentBranchId` is Rightmove's
    // own identifier and has no equivalent here.
    agentCompany: trimmed(jsonLdOfType(html, 'Organization')?.name) ?? meta(html, 'og:site_name'),
    agentPhone: trimmed(decodeEntities(html.match(TELEPHONE)?.[1] ?? '')),
    floorplans: floorplans(html, documents),
    imageUrls: imageUrls(html, documents),
    description,
    archived: archived(html, heading?.index ?? -1),
  };
}

export const tkinternational: Site = {
  id: SITE,
  name: 'TK International',
  hosts: HOSTS,
  listingId,
  listingUrl,
  extract,
};
