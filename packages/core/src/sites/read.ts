import type { FloorArea, Listing, Station } from '../types';
import type { SiteId } from './types';

// ------------------------------------------------------------------------------------------------
// What every site adapter needs, written once.
//
// These are the narrowers `listing.ts` has always had, lifted out so the other eight sites share
// them rather than each carrying a private copy of `str`. They are narrowers and not casts on
// purpose: a field that is not the shape we need reads as absent, and the adapter falls to a
// stated outcome, which is the rule the review checklist states for every network boundary.
// ------------------------------------------------------------------------------------------------

export function obj(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

export function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

export function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/** `str` with the edges taken off. Agent sites pad far more than Rightmove does — a name split
 *  across two lines of a template arrives as `"\n      Knightsbridge\n    "`. */
export function trimmed(v: unknown): string | null {
  return typeof v === 'string' ? str(v.replace(/\s+/g, ' ').trim()) : null;
}

export function num(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  // Agent sites ship numbers as strings far more often than Rightmove, and the same field arrives
  // both ways on one site. Deliberately strict: "3 bedrooms" is not a number and must not read as 3
  // when the field it lands in is a count somebody filters on.
  if (typeof v === 'string') {
    const t = v.trim();
    if (!/^-?\d+(\.\d+)?$/.test(t)) return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export function bool(v: unknown): boolean | null {
  return typeof v === 'boolean' ? v : null;
}

/** Walk a path of keys through nested objects. `dig(root, 'props', 'pageProps', 'property')`.
 *  Any missing or non-object step ends the walk at null rather than throwing — these payloads are
 *  deep and a page that reshapes one level should cost one field, not the whole extraction. */
export function dig(root: unknown, ...path: string[]): unknown {
  let node: unknown = root;
  for (const key of path) {
    const o = obj(node);
    if (!o) return null;
    node = o[key];
  }
  return node ?? null;
}

/** Every object anywhere under `root` that satisfies `want`, outermost first.
 *
 *  For payloads whose shape is a vendor's build detail rather than a contract — an RSC flight tree,
 *  a Redux preloaded state — where the listing object is identifiable by its own keys but its path
 *  is not stable across a deploy. Bounded depth because these trees are cyclic often enough. */
export function findAll(root: unknown, want: (o: Record<string, unknown>) => boolean, maxDepth = 12): Record<string, unknown>[] {
  const found: Record<string, unknown>[] = [];
  const seen = new Set<unknown>();
  const walk = (node: unknown, depth: number): void => {
    if (depth > maxDepth || node === null || typeof node !== 'object') return;
    if (seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const child of node) walk(child, depth + 1);
      return;
    }
    const o = node as Record<string, unknown>;
    if (want(o)) found.push(o);
    for (const child of Object.values(o)) walk(child, depth + 1);
  };
  walk(root, 0);
  return found;
}

/** The first match of `findAll`, or null. */
export function findOne(root: unknown, want: (o: Record<string, unknown>) => boolean, maxDepth = 12): Record<string, unknown> | null {
  return findAll(root, want, maxDepth)[0] ?? null;
}

// ------------------------------------------------------------------------------------------------
// Getting structured data out of an HTML string.
//
// A string and never a Document, for the reason stated on `Site.extract`: these run server-side in
// `app/api/listing`, which is the phone's only way in.
// ------------------------------------------------------------------------------------------------

/** The contents of a `<script>` whose opening tag matches `attrs`, parsed as JSON.
 *  Null when the tag is absent or the body is not JSON — both are "this page is not the shape we
 *  expect", which the caller reports rather than guessing past. */
export function scriptJson(html: string, attrs: RegExp): unknown {
  const open = new RegExp(`<script[^>]*${attrs.source}[^>]*>`, 'i');
  const at = html.search(open);
  if (at < 0) return null;
  const start = html.indexOf('>', at);
  const end = html.indexOf('</script', start);
  if (start < 0 || end < 0) return null;
  return parseJson(html.slice(start + 1, end));
}

/** `__NEXT_DATA__`, the Pages Router's server payload. */
export function nextData(html: string): unknown {
  return scriptJson(html, /id="__NEXT_DATA__"/);
}

/** Every `application/ld+json` block on the page, flattened through `@graph`.
 *
 *  Worth reaching for first on any site that has it: schema.org names its fields, so a field read
 *  from here survives a redesign that moves every class name on the page. */
export function jsonLd(html: string): Record<string, unknown>[] {
  const blocks: Record<string, unknown>[] = [];
  const tag = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  for (const match of html.matchAll(tag)) {
    const parsed = parseJson(match[1] ?? '');
    for (const node of Array.isArray(parsed) ? parsed : [parsed]) {
      const o = obj(node);
      if (!o) continue;
      const graph = arr(o['@graph']);
      if (graph.length > 0) {
        for (const g of graph) {
          const child = obj(g);
          if (child) blocks.push(child);
        }
      } else {
        blocks.push(o);
      }
    }
  }
  return blocks;
}

/** The ld+json block whose `@type` is `type` (case-insensitive; `@type` may be an array). */
export function jsonLdOfType(html: string, type: string): Record<string, unknown> | null {
  const wanted = type.toLowerCase();
  for (const block of jsonLd(html)) {
    const t = block['@type'];
    const types = (Array.isArray(t) ? t : [t]).flatMap((x) => (typeof x === 'string' ? [x.toLowerCase()] : []));
    if (types.includes(wanted)) return block;
  }
  return null;
}

/** The App Router's flight payload, reassembled: every `self.__next_f.push([1,"…"])` chunk
 *  concatenated back into the one string the browser would have.
 *
 *  Returns the raw string rather than a parse, because it is not JSON — it is a sequence of
 *  `NN:` -prefixed rows, some of them JSON and some of them not. Adapters pull what they need out
 *  of it with `flightRow` or by locating a known key. */
export function flightPayload(html: string): string {
  const chunks: string[] = [];
  const push = /self\.__next_f\.push\(\[1,\s*("(?:[^"\\]|\\.)*")\]\)/g;
  for (const match of html.matchAll(push)) {
    const decoded = parseJson(match[1] ?? '');
    if (typeof decoded === 'string') chunks.push(decoded);
  }
  return chunks.join('');
}

/** The first JSON value in `payload` that starts at `marker` and brace-matches from there.
 *
 *  Brace-matching rather than a regex for the same reason `listing.ts` does it: these payloads
 *  contain the closing brace of the object inside prose, inside escaped strings, and inside other
 *  objects, and every regex that has ever been written for this stops at the first one. */
export function jsonAfter(payload: string, marker: string): unknown {
  const at = payload.indexOf(marker);
  if (at < 0) return null;
  const open = payload.indexOf('{', at + marker.length - 1);
  const bracket = payload.indexOf('[', at + marker.length - 1);
  const start = open < 0 ? bracket : bracket < 0 ? open : Math.min(open, bracket);
  if (start < 0) return null;
  const body = balanced(payload, start);
  return body === null ? null : parseJson(body);
}

/** From the bracket at `start`, the substring up to its match — string- and escape-aware. */
export function balanced(text: string, start: number): string | null {
  const opener = text[start];
  const closer = opener === '{' ? '}' : opener === '[' ? ']' : null;
  if (!closer) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === opener) depth++;
    else if (ch === closer) {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/** `JSON.parse` that answers null instead of throwing. Exported because three adapters wrote their
 *  own copy of it before this was. */
export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------------------------------------
// The App Router's flight payload, row by row.
//
// Written once because two adapters wrote it twice and both got the same thing wrong first, in a
// way that decoded one page perfectly and truncated another: **a `T<hex>,` row's length is a count
// of UTF-8 bytes, not of characters.** One curly apostrophe in a description makes a row one unit
// shorter in UTF-16 than its own frame says, the walk lands short of the next header, and every row
// after it is lost — silently, because the rows that did parse look right. A row is also *not*
// newline-terminated when it is framed: the next row's header follows its last byte immediately.
// Splitting the payload on newlines is the obvious implementation and it is wrong for both reasons.
// ------------------------------------------------------------------------------------------------

/** `<hex id>:` and then either the `T<hex>,` framing of a text row or the one- or two-letter tag a
 *  module table (`I[…]`) carries. Sticky, so the scan stays in step with the rows rather than
 *  matching an id-shaped run of hex inside one. */
const ROW_HEADER = /([0-9a-f]{1,8}):(?:T([0-9a-f]+),|[A-Za-z]{0,2})/y;

/** Every row in a flight payload, by its id.
 *
 *  A framed text row comes back as its string; a JSON row comes back parsed. One walk rather than
 *  one per lookup, because the rows can only be found in order — a row's start is the previous
 *  row's end, and there is no index. */
export function flightRows(payload: string): Map<string, unknown> {
  const rows = new Map<string, unknown>();
  let at = 0;
  while (at < payload.length) {
    ROW_HEADER.lastIndex = at;
    const header = ROW_HEADER.exec(payload);
    if (!header) {
      at = afterNewline(payload, at);
      continue;
    }
    const body = ROW_HEADER.lastIndex;
    const framed = header[2];
    if (framed !== undefined) {
      const end = afterUtf8Bytes(payload, body, parseInt(framed, 16));
      rows.set(header[1]!, payload.slice(body, end));
      at = end;
      continue;
    }
    const value = payload[body] === '{' || payload[body] === '[' ? balanced(payload, body) : null;
    if (value === null) {
      at = afterNewline(payload, at);
      continue;
    }
    const parsed = parseJson(value);
    if (parsed !== null) rows.set(header[1]!, parsed);
    at = afterNewline(payload, body + value.length);
  }
  return rows;
}

/** The index `bytes` UTF-8 bytes after `at`, counting in code points. See the block above. */
function afterUtf8Bytes(text: string, at: number, bytes: number): number {
  let index = at;
  let counted = 0;
  while (index < text.length && counted < bytes) {
    const code = text.codePointAt(index)!;
    counted += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
    index += code > 0xffff ? 2 : 1;
  }
  return index;
}

function afterNewline(payload: string, at: number): number {
  const newline = payload.indexOf('\n', at);
  return newline < 0 ? payload.length : newline + 1;
}

/** A value that may be a `$NN` reference to another row, followed to what it points at.
 *
 *  React streams a long string as its own row and leaves `"$28"` where the value was, so a field
 *  read without this comes back as the literal string `"$28"` — which is a value, looks like data,
 *  and is how a description becomes three characters. `$$` is React's escape for a value that
 *  really does begin with a dollar sign. */
export function flightRef(rows: Map<string, unknown>, value: unknown): unknown {
  if (typeof value !== 'string' || !value.startsWith('$')) return value;
  if (value.startsWith('$$')) return value.slice(1);
  return /^\$[0-9a-f]{1,8}$/.test(value) ? rows.get(value.slice(1)) ?? null : null;
}

/** The first object-valued `"<key>":` anywhere in a payload, brace-matched and parsed.
 *
 *  For a payload whose rows are not the useful unit — where the wanted object is nested inside one
 *  and its path is a build detail. The `(?=\{)` is load-bearing: the App Router writes these names
 *  twice, once as the object and once as a path string pointing back at it
 *  (`"$5:1:props:children:…:propertyData"`), in an order that is not stable, so a match that
 *  admitted the string form would brace-match into whatever object came after it. */
export function objectNamed(payload: string, key: string): Record<string, unknown> | null {
  for (const match of payload.matchAll(new RegExp(`"${key}"\\s*:\\s*(?=\\{)`, 'g'))) {
    const body = balanced(payload, match.index + match[0].length);
    if (body === null) continue;
    const found = obj(parseJson(body));
    if (found) return found;
  }
  return null;
}

// ------------------------------------------------------------------------------------------------
// Reading a page's own words.
// ------------------------------------------------------------------------------------------------

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', pound: '£', ndash: '–', mdash: '—',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', hellip: '…', eacute: 'é',
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith('#')) {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/** Tags out, entities decoded, whitespace collapsed. For a description an agent wrote as markup —
 *  never for finding a field, which `querySelector`-by-regex does badly and a payload does well. */
export function textFromHtml(fragment: string): string {
  return decodeEntities(
    fragment
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<\/(p|div|li|br|h[1-6]|tr)>/gi, '\n')
      .replace(/<br\s*\/?>/gi, '\n'),
  )
    .replace(/<[^>]*>/g, ' ')
    .replace(/[ \t ]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
}

/** The content of the first `<meta>` whose name or property is `key`. */
export function meta(html: string, key: string): string | null {
  const tag = new RegExp(
    `<meta[^>]*(?:name|property|itemprop)=["']${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["'][^>]*>`,
    'i',
  );
  const found = html.match(tag)?.[0];
  if (!found) return null;
  const content = found.match(/content=["']([\s\S]*?)["']/i)?.[1];
  return content ? trimmed(decodeEntities(content)) : null;
}

// ------------------------------------------------------------------------------------------------
// Facts every site states in its own words.
// ------------------------------------------------------------------------------------------------

/** A full UK postcode anywhere in `text`, normalised to "NW8 6HS".
 *
 *  Anchored on the incode shape (digit, two letters) rather than being permissive, because the
 *  thing this competes with is a house number and an outcode sitting next to each other. Null when
 *  the text carries only an outcode: that is `outcodeIn`'s job, and returning a made-up incode
 *  would route the whole hunt from the wrong end of a district. */
export function postcodeIn(text: string): string | null {
  const match = text
    .toUpperCase()
    .match(/\b([A-Z]{1,2}\d[A-Z\d]?)\s*(\d[A-Z]{2})\b/);
  return match ? `${match[1]} ${match[2]}` : null;
}

/** The outward half of a postcode anywhere in `text` — "NW8". Falls back to the outcode of a full
 *  postcode when there is one, so a caller can ask for this alone. */
export function outcodeIn(text: string): string | null {
  const full = postcodeIn(text);
  if (full) return str(full.split(' ')[0]);
  return text.toUpperCase().match(/\b([A-Z]{1,2}\d[A-Z\d]?)\b(?!\s*\d[A-Z]{2})/)?.[1] ?? null;
}

export function outcodeOf(postcode: string | null): string | null {
  if (!postcode) return null;
  return str(postcode.trim().toUpperCase().split(/\s+/)[0]);
}

const SQM_TO_SQFT = 10.7639;
const MIN_SQFT = 100;
const MAX_SQFT = 100_000;

/** A floor area an agent stated, in square feet, or null when it is outside the range a London
 *  flat can be. The bounds are `listing.ts`'s and exist because a site that ships the area of the
 *  *plot* — or a 0 for "not measured" — otherwise lands a number in a column people filter on. */
export function statedSqft(sqft: number | null): FloorArea | null {
  if (sqft === null || !Number.isFinite(sqft)) return null;
  const rounded = Math.round(sqft);
  return rounded >= MIN_SQFT && rounded <= MAX_SQFT ? { sqft: rounded, source: 'sizings' } : null;
}

export function sqmToSqft(sqm: number): number {
  return sqm * SQM_TO_SQFT;
}

/** A price as the page words it, tidied to one line. Kept as the agent's own string rather than a
 *  number for the reason the Rightmove side keeps `primaryPrice`: "£2,750 pcm" and "£635 pw" are
 *  different quantities, and a bare number would silently compare them. */
export function priceText(v: unknown): string | null {
  return trimmed(v);
}

/** A number of pounds out of a price string — "£2,750 pcm" -> 2750. For deposits, which are a
 *  quantity rather than a quotation. Null when the string names no figure. */
export function poundsIn(text: string | null): number | null {
  if (!text) return null;
  const match = text.replace(/,/g, '').match(/£?\s*(\d+(?:\.\d+)?)/);
  if (!match) return null;
  const n = Number(match[1]);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

/** A council tax band A–H stated in `text`, or null. Matches "Council Tax Band: D" and "Band D",
 *  and deliberately not a bare letter — "D" alone in a description is a word, not a band. */
export function councilTaxIn(text: string): string | null {
  return text.match(/council\s*tax[^A-Za-z0-9]{0,12}(?:band[^A-Za-z0-9]{0,4})?([A-H])\b/i)?.[1]?.toUpperCase()
    ?? text.match(/\bband[^A-Za-z0-9]{0,4}([A-H])\b/i)?.[1]?.toUpperCase()
    ?? null;
}

/** Stations a site listed, sorted nearest first — the same contract `listing.ts` has, and for the
 *  same reason: the panel shows the first few, so an unsorted list hides the closest one. */
export function sortedStations(stations: Station[]): Station[] {
  return [...stations].sort((a, b) => a.distance - b.distance);
}

/** The fields no adapter has an opinion about, so an adapter states only what its site says.
 *
 *  Spread first, override after. Everything optional starts absent rather than at a plausible
 *  default: a flat whose page did not say whether it is furnished must read as "we do not know",
 *  because the triage filters are built to keep unknowns and would otherwise be handed a fact
 *  nobody stated. */
export function blankListing(site: SiteId, externalId: string, key: string, url: string): Listing {
  return {
    rightmoveId: key,
    site,
    externalId,
    url,
    postcode: null,
    outcode: null,
    displayAddress: 'Unknown address',
    price: null,
    bedrooms: null,
    bathrooms: null,
    latitude: null,
    longitude: null,
    nearestStations: [],
    floorArea: null,
    furnishType: null,
    letAvailableDate: null,
    deposit: null,
    letType: null,
    councilTaxBand: null,
    listingUpdate: null,
    agentBranchId: null,
    agentBranch: null,
    agentCompany: null,
    agentPhone: null,
    floorplans: [],
    imageUrls: [],
    description: null,
    archived: null,
    // Stamped here for the reason `toListing` states: this is when the page was read, and a tab
    // open since yesterday must carry yesterday or `record_property` cannot order two readings.
    observedAt: new Date().toISOString(),
  };
}
