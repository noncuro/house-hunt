/** One Rightmove listing page, read into our own narrow `Listing`.
 *
 *  This was `apps/extension/src/lib/{decode,extract}.ts` for as long as a listing could only be
 *  read by a content script standing on the page. A phone has no content script, so the same page
 *  is now also read server-side from its HTML — and the moment two surfaces read one page shape,
 *  the choice is one module or a fork. A fork of *this* is the expensive kind: every field here is
 *  a guess about somebody else's undocumented blob, and the day Rightmove renames one, a copy that
 *  did not learn about it does not fail — it returns a flat with no postcode, which is a flat with
 *  no travel times and no explanation.
 *
 *  Deliberately Deno-clean (no `node:` imports, no `import.meta.env`), because
 *  `tools/sync-edge-function.ts` copies it into `supabase/functions/_shared/`.
 */
import type { FloorArea, Floorplan, Listing, Station } from './types';

const SQM_TO_SQFT = 10.7639;

// ------------------------------------------------------------------------------------------------
// Which URLs are a listing at all.
// ------------------------------------------------------------------------------------------------

/** The id in a Rightmove listing URL, or null if that is not what this is.
 *
 *  Pure, and exported, because it is the gate on the server: `functions/listing` will fetch
 *  whatever URL it is handed, so "is this a Rightmove listing" has to be answered before the fetch
 *  rather than by looking at what came back. A host check that accepted anything *containing*
 *  `rightmove.co.uk` would accept `rightmove.co.uk.example.com`, which is the whole trick — so the
 *  host is compared against the suffix with its dot, or matched outright.
 *
 *  Accepts what people actually paste: `/properties/88023648`, a trailing slug or slash, a
 *  `#/media` fragment, and the `?channel=RES_LET` query the search page hangs off its links. The
 *  old `/property-to-rent/property-88023648.html` form is accepted too — it is what a link saved
 *  two years ago looks like, and Rightmove still redirects it. */
export function rightmoveListingId(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;

  const host = parsed.hostname.toLowerCase();
  if (host !== 'rightmove.co.uk' && !host.endsWith('.rightmove.co.uk')) return null;

  const modern = /^\/properties\/(\d{5,12})(?:[/#?].*)?$/.exec(parsed.pathname + parsed.hash);
  if (modern) return modern[1]!;

  const legacy = /^\/property-[a-z-]+\/property-(\d{5,12})\.html$/.exec(parsed.pathname);
  return legacy ? legacy[1]! : null;
}

// ------------------------------------------------------------------------------------------------
// Finding and decoding window.__PAGE_MODEL.
// ------------------------------------------------------------------------------------------------

/** Pull the `window.__PAGE_MODEL = {...}` object out of a page's HTML by brace matching.
 *
 *  Brace matching rather than a regex because the blob contains braces inside strings, and rather
 *  than a DOM parse because neither the server nor the harnesses have a DOM and the whole point is
 *  not to need one. A content script standing on the live page skips all of this and reads the
 *  global — see `extractFromPage` in the extension. */
export function readPageModel(html: string): unknown {
  const marker = /window\.__PAGE_MODEL\s*=\s*\{/.exec(html);
  if (!marker) throw new Error('no window.__PAGE_MODEL in this HTML');

  const start = marker.index + marker[0].length - 1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < html.length; i++) {
    const c = html[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return JSON.parse(html.slice(start, i + 1));
  }
  throw new Error('unbalanced braces in __PAGE_MODEL');
}

interface PageModel {
  data?: unknown;
  encoding?: string;
}

type Nodes = unknown[];

function resolveNode(nodes: Nodes, idx: unknown, depth = 0): unknown {
  // Rightmove's graph is shallow; a cycle would mean our index assumption is wrong, and looping
  // forever is a worse failure than giving up.
  if (depth > 64) throw new Error('__PAGE_MODEL nesting exceeded 64 levels — encoding changed?');
  if (typeof idx !== 'number' || !Number.isInteger(idx) || idx < 0 || idx >= nodes.length) {
    // Not a reference: encoding-off payloads and out-of-range values are literals.
    return idx;
  }
  const node = nodes[idx];
  if (Array.isArray(node)) return node.map((i) => resolveNode(nodes, i, depth + 1));
  if (node !== null && typeof node === 'object') {
    return Object.fromEntries(
      Object.entries(node as Record<string, unknown>).map(([k, v]) => [k, resolveNode(nodes, v, depth + 1)]),
    );
  }
  return node;
}

/** Turn a raw `window.__PAGE_MODEL` value into the decoded `propertyData` object.
 *
 *  Rightmove ships the listing as `{ data: "<json>", encoding: "on" }`. When encoding is on, the
 *  parsed data is a FLAT ARRAY of nodes and every object value is an index into that array rather
 *  than the value itself. Miss this and you silently get integers where you expected objects. See
 *  RESEARCH.md §2.
 *
 *  Throws on any shape we don't recognise — the caller renders that message. */
export function decodePageModel(model: unknown): Record<string, unknown> {
  if (!model || typeof model !== 'object') throw new Error('__PAGE_MODEL missing or not an object');
  const { data, encoding } = model as PageModel;

  // encoding "off" (or absent) means data is already a plain object.
  if (encoding !== 'on') {
    const plain = typeof data === 'string' ? JSON.parse(data) : (data ?? model);
    const property = (plain as Record<string, unknown>)?.propertyData;
    if (!property || typeof property !== 'object') {
      throw new Error('unencoded __PAGE_MODEL had no propertyData');
    }
    return property as Record<string, unknown>;
  }

  if (typeof data !== 'string') throw new Error('__PAGE_MODEL.encoding is "on" but data is not a string');
  const nodes = JSON.parse(data) as Nodes;
  if (!Array.isArray(nodes) || nodes.length === 0) throw new Error('__PAGE_MODEL.data is not a node array');

  const root = nodes[0];
  if (!root || typeof root !== 'object') throw new Error('__PAGE_MODEL node 0 is not an object');
  const ref = (root as Record<string, unknown>).propertyData;
  if (ref === undefined) throw new Error('__PAGE_MODEL root has no propertyData reference');

  const property = resolveNode(nodes, ref);
  if (!property || typeof property !== 'object') throw new Error('propertyData did not resolve to an object');
  return property as Record<string, unknown>;
}

/** The whole read, from a page's HTML. What the server does with a URL somebody pasted, and what
 *  the harnesses do with a saved page. */
export function listingFromHtml(html: string, url: string): Listing {
  return toListing(decodePageModel(readPageModel(html)), url);
}

// ------------------------------------------------------------------------------------------------
// propertyData -> Listing.
// ------------------------------------------------------------------------------------------------

/** Reads a decoded propertyData object into our narrow Listing shape.
 *  Every field is defensive: Rightmove has renamed things before (PAGE_MODEL -> __PAGE_MODEL),
 *  so a missing sub-object degrades that one field rather than failing the whole extraction.
 *  The exception is `id`, which we genuinely cannot work without. */
export function toListing(property: Record<string, unknown>, url: string): Listing {
  const id = property.id;
  if (id === undefined || id === null || String(id).length === 0) {
    if (isWithdrawn(property)) throw new ListingWithdrawn();
    throw new Error('listing has no id');
  }

  const address = obj(property.address);
  const location = obj(property.location);
  const prices = obj(property.prices);

  const outcode = str(address?.outcode);
  const incode = str(address?.incode);

  return {
    rightmoveId: String(id),
    url,
    // Route from this, not the lat/lon — the map pin is deliberately fuzzed
    // (pinType: "APPROXIMATE_POINT") but the postcode is exact. See RESEARCH.md §2.
    postcode: outcode && incode ? `${outcode} ${incode}` : null,
    outcode,
    displayAddress: str(address?.displayAddress) ?? 'Unknown address',
    price: str(prices?.primaryPrice),
    bedrooms: num(property.bedrooms),
    bathrooms: num(property.bathrooms),
    latitude: num(location?.latitude),
    longitude: num(location?.longitude),
    nearestStations: stations(property.nearestStations),
    floorArea: floorArea(property),
    furnishType: str(obj(property.lettings)?.furnishType),
    // e.g. "Reduced today", "Added on 05/08/2026". How long something has sat, and whether the
    // price has been cut, is a strong signal on a rental.
    listingUpdate: str(obj(property.listingHistory)?.listingUpdateReason),
    floorplans: floorplans(property.floorplans),
    imageUrls: imageUrls(property.images),
    description: str(obj(property.text)?.description),
    // `status: { published, archived }` — archived turns true when a listing is let-agreed or taken
    // down. Read `archived` directly; a missing status object stays null (unknown) rather than
    // false, so we never tell the panel a flat is definitely still on when we could not check.
    archived: bool(obj(property.status)?.archived),
    // The one field here that is not read off the page, and the only place it can honestly be
    // taken: this runs where the page model is decoded — at document_end in the content script,
    // or inside the `listing` function's fetch — so a tab restored from yesterday stamps
    // yesterday. Taken at the write instead it would say "now" for every reading including the
    // stale one, which is exactly why `written_at` could never tell two readings apart.
    observedAt: new Date().toISOString(),
  };
}

/** Gallery URLs only — Rightmove also ships pre-resized variants, and the full-size original is
 *  what the analyser wants for reading detail. */
function imageUrls(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((raw) => {
    const url = str(obj(raw)?.url);
    return url === null ? [] : [url];
  });
}

/** Structured `sizings` first; fall back to the description prose, which is where most rental
 *  agents put the number if they mention it at all. */
function floorArea(property: Record<string, unknown>): FloorArea | null {
  const fromSizings = sizings(property.sizings);
  if (fromSizings !== null) return { sqft: fromSizings, source: 'sizings' };

  const description = str(obj(property.text)?.description);
  const fromProse = description === null ? null : parseAreaFromText(description);
  return fromProse === null ? null : { sqft: fromProse, source: 'description' };
}

/** The range a floor area can be. Anything outside it is a typo or a placeholder, not a flat, and
 *  both sources are held to it: the prose parser always was, and the structured `sizings` were not
 *  until listing 92113695 reached the database as 1 sq ft — a stated figure, drawn as fact, that the
 *  size filter then excluded on and the verdict-score model priced at a thousand times the going
 *  rate per square foot. A stated size that small is refused rather than stored (#90). */
const MIN_SQFT = 100;
const MAX_SQFT = 100_000;

function plausibleSqft(sqft: number): boolean {
  return sqft >= MIN_SQFT && sqft <= MAX_SQFT;
}

function sizings(v: unknown): number | null {
  if (!Array.isArray(v)) return null;
  let sqm: number | null = null;
  for (const raw of v) {
    const s = obj(raw);
    const unit = str(s?.unit)?.toLowerCase();
    if (unit !== 'sqft' && unit !== 'sqm') continue;
    const toSqft = unit === 'sqft' ? 1 : SQM_TO_SQFT;
    // Rightmove publishes a min and a max; they're equal for a stated size, and where they differ
    // the minimum is the honest number — unless it is not a number at all. A minimum of 1 beside a
    // real maximum is a field somebody had to fill in, so the maximum is taken instead, and where
    // neither is a plausible flat the entry is skipped and the prose gets its turn.
    const size = [num(s?.minimumSize), num(s?.maximumSize)].find(
      (n): n is number => n !== null && plausibleSqft(Math.round(n * toSqft)),
    );
    if (size === undefined) continue;
    if (unit === 'sqft') return Math.round(size);
    sqm = size;
  }
  return sqm === null ? null : Math.round(sqm * SQM_TO_SQFT);
}

/** Words that mean the number next to them is not the flat. A "1,200 sq ft garden" beside "800
 *  sq ft of internal accommodation" is exactly the case that made this parser return the garden
 *  and the panel print it as the size of the flat. */
const NOT_THE_FLAT =
  /\b(garden|plot|terrace|balcony|patio|yard|roof\s?terrace|courtyard|decking|lawn|allotment|garage|parking|store|shed|outbuilding|loft\s+space|eaves)\b/i;

/** Words that mean the number next to them IS the flat, and the whole of it. */
const THE_WHOLE_FLAT =
  /\b(internal|gross internal|gia|total\s+(?:floor\s+)?area|floor\s?area|approximate\s+area|accommodation\s+(?:extends|measur)|extending\s+to|measuring\s+approximately)\b/i;

/** How far either side of a match to read. The disqualifying noun sits right against its number
 *  ("1,200 sq ft garden", "garden of 1,200 sq ft"), so that window is tight and it wins outright:
 *  in "800 sq ft of internal accommodation with a 1,200 sq ft garden" the word "internal" is
 *  within reach of BOTH numbers, so a naming phrase that could override adjacency would hand
 *  back the garden again. The naming phrase itself can sit further off ("extending to 1,258 sq
 *  ft"), so that window is wider. */
const ADJACENT = 16;
const CONTEXT = 60;

/** Where adjacency stops: `. ; ! ?`, then space, then a capital letter.
 *
 *  The window either side of a match is about what the number is *called*, and a noun in the next
 *  sentence does not name it. Without any break at all, "Total floor area 1,200 sq ft. Garden 500
 *  sq ft." loses both numbers — the total vetoed by the garden that follows it, the garden vetoed
 *  by itself — and the flat is drawn with no size, which is a stated total printed nowhere.
 *
 *  Every part of that pattern is holding off a way of getting this wrong, and the capital letter is
 *  the one that matters. A dot after a space is not the only dot in this text: the unit pattern
 *  deliberately accepts "sq." and "ft.", so "1,200 sq. ft. garden" ends its match at `ft` and is
 *  followed by exactly the ". " a sentence ends with. Break there and the trailing window is empty,
 *  the garden is never seen, and the parser hands back the garden as the flat — which is the one
 *  case this whole veto was written for, and the one `check:area` has always led with, merely
 *  spelled with the abbreviation. An abbreviation is followed by the rest of its phrase in lower
 *  case; a sentence is followed by a capital. That is the whole difference and it is the only
 *  signal in the text that carries it.
 *
 *  The space keeps a decimal out of it — "1,258.5 sq ft" is one sentence — and the capital rules out
 *  a figure as well, so "Rear garden. 800 sq ft" keeps the garden in reach of the 800 rather than
 *  reading the full stop as permission to forget it.
 *
 *  Where it errs it errs towards the veto: a sentence genuinely beginning in lower case keeps the
 *  neighbouring noun in the window and the number is dropped. That is the direction this file
 *  chooses everywhere — "a size that is confidently wrong is worse than no size at all". */
const SENTENCE_BREAK = /[.;!?]\s+(?=[A-Z])/;

/** The one exception to the capital: a sentence that starts on the number itself. "Garden. 1,200 sq
 *  ft of internal accommodation" is a stated total after a full stop, and the capital rule keeps the
 *  garden in reach of it and drops it (#65). Admitting a digit into `SENTENCE_BREAK` would break
 *  "1,200 sq. ft. garden" for the reason given above, so this is not a break at all: the leading
 *  window still holds the garden, and the number is let through only when the text after it names
 *  it as the whole flat. "Rear garden. 800 sq ft." stays vetoed — a bare number after "Garden." is
 *  as likely the garden in an agent's shorthand as anything else. */
const STARTS_A_SENTENCE = /[.;!?]\s+$/;

/** Where the sentence ends, asked looking *forward* from a number — a different question from the
 *  one `SENTENCE_BREAK` answers, and it has to be, because the two err in opposite directions.
 *
 *  `SENTENCE_BREAK` bounds the windows that decide whether a noun disqualifies a number. Failing to
 *  break there keeps the noun in reach and drops the number, so under-breaking is the safe side, and
 *  the capital is what keeps "1,200 sq. ft. garden" from breaking at its own abbreviation.
 *
 *  This one bounds the naming phrase that can overrule such a noun. Failing to break here lets the
 *  *next* sentence's name admit this sentence's garden — "Rear garden. 1,500 sq ft. 900 sq ft of
 *  internal accommodation." handed back the garden, and 1,500 of it — so over-breaking is the safe
 *  side, and a digit ends a sentence as surely as a capital does. Where it breaks too eagerly the
 *  number is merely dropped, which is the direction this file chooses everywhere.
 *
 *  They cannot be one expression: each is the other's unsafe side. */
const NAME_ENDS = /[.;!?]\s+(?=[A-Z0-9])/;

/** Pull "1,234 sq ft" / "115 sqm" / "115 m2" out of prose.
 *
 *  Prefers a match that names itself as the whole flat ("extending to 1,258 sq ft", "gross
 *  internal area"). Failing that, takes the largest match that is not obviously something else,
 *  because descriptions list room-by-room sizes and the total is what we want.
 *
 *  A number sitting next to "garden" or "terrace" is dropped outright rather than merely ranked
 *  lower: taking the largest match meant one flat's 1,200 sq ft garden was shown as its floor
 *  area, and a size that is confidently wrong is worse than no size at all. */
export function parseAreaFromText(html: string): number | null {
  const text = html.replace(/<[^>]*>/g, ' ');
  // The unit ends with a lookahead rather than \b, because \b never matches after "²".
  const pattern =
    /([\d,]+(?:\.\d+)?)\s*(sq\.?\s*(?:ft|feet|f)|sqft|ft2|ft²|sq\.?\s*m(?:tr|etres|eters)?|sqm|m2|m²)(?![a-z0-9])/gi;
  let best: number | null = null;
  let named: number | null = null;

  for (const m of text.matchAll(pattern)) {
    const value = Number(m[1]!.replace(/,/g, ''));
    if (!Number.isFinite(value) || value <= 0) continue;
    const metric = /m/i.test(m[2]!) && !/f/i.test(m[2]!);
    const sqft = Math.round(metric ? value * SQM_TO_SQFT : value);
    if (!plausibleSqft(sqft)) continue;

    const at = m.index ?? 0;
    const end = at + m[0]!.length;
    // What the number is called, read from right beside it and no further than the sentence it is
    // in. "1,200 sq ft garden" is a garden whatever the rest of the sentence says; a garden in the
    // *next* sentence is a different number's business — see `SENTENCE_BREAK`.
    const before = text.slice(Math.max(0, at - ADJACENT), at).split(SENTENCE_BREAK).at(-1)!;
    const after = text.slice(end, end + ADJACENT).split(SENTENCE_BREAK)[0]!;
    // The name that can overrule a noun behind a full stop is read to the end of this sentence and
    // no further: read past the stop and "Rear garden. 1,500 sq ft. Total floor area 900 sq ft."
    // licenses the garden with the next sentence's total and hands back 1,500 as the flat. It is
    // `NAME_ENDS` rather than `SENTENCE_BREAK` because the sentence that follows this one starts on
    // a number as often as not — that is the shape the escape hatch exists for.
    const namedAfter = THE_WHOLE_FLAT.test(text.slice(end, end + CONTEXT).split(NAME_ENDS)[0]!);
    if (NOT_THE_FLAT.test(m[0]! + after)) continue;
    if (NOT_THE_FLAT.test(before) && !(STARTS_A_SENTENCE.test(before) && namedAfter)) continue;

    // Deliberately wider than the windows above, and deliberately unbounded by the sentence: this
    // only decides whether a number that has already survived the veto is a stated total, and
    // `named` keeps the largest, so naming one too eagerly cannot promote a number over a bigger
    // stated total. The windows above decide whether a number is admitted at all, which is where
    // reading into the next sentence does damage.
    if (THE_WHOLE_FLAT.test(text.slice(Math.max(0, at - CONTEXT), end + CONTEXT))) {
      // Several stated totals should agree; if they don't, the larger is the whole property.
      if (named === null || sqft > named) named = sqft;
    }
    if (best === null || sqft > best) best = sqft;
  }
  // A number that says what it is beats a bigger number that says nothing.
  return named ?? best;
}

function floorplans(v: unknown): Floorplan[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((raw) => {
    const f = obj(raw);
    const url = str(f?.url);
    return url === null ? [] : [{ url, caption: str(f?.caption) }];
  });
}

/** The listing is gone, rather than unreadable. Its own class because the two need different
 *  sentences and different consequences: a page we cannot parse is our problem and sends you to
 *  `decode_page_model.py`, while a flat the agent has taken down is a fact about the flat. */
export class ListingWithdrawn extends Error {
  constructor() {
    super('this listing has been removed from Rightmove');
  }
}

/** Rightmove answers a withdrawn listing with HTTP 404 and a full page that says "This property has
 *  been removed by the agent". `window.__PAGE_MODEL` is still there — which is why this is not
 *  caught upstream — but hollowed out: `propertyData` keeps `customer` and `propertyUrls` and
 *  nothing else, with `id`, `status`, `address` and `text` all null.
 *
 *  Deliberately narrow. Reading a renamed `id` as "withdrawn" would tell you a flat you are looking
 *  at is gone, and quietly stop the sweep from ever opening it again — the fail-loudly rule pointed
 *  the wrong way. A rename leaves the other twenty fields in place, so requiring all four to be
 *  absent *and* the withdrawn page's own consolation link to be present separates them. */
function isWithdrawn(property: Record<string, unknown>): boolean {
  const gutted = ['status', 'address', 'text', 'prices'].every((key) => obj(property[key]) === null);
  return gutted && str(obj(property.propertyUrls)?.similarPropertiesUrl) !== null;
}

function obj(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** A real boolean or null — never coerces. A missing status field must read as "unknown", not
 *  "false", so a flat we could not check is never treated as definitely still on the market. */
function bool(v: unknown): boolean | null {
  return typeof v === 'boolean' ? v : null;
}

/** Rightmove does not return these in distance order, and the panel only shows the first few —
 *  so sort, or we'd show the third-nearest tube and hide the closest. */
function stations(v: unknown): Station[] {
  if (!Array.isArray(v)) return [];
  const parsed = v.flatMap((raw) => {
    const s = obj(raw);
    const name = str(s?.name);
    const distance = num(s?.distance);
    if (!name || distance === null) return [];
    return [
      {
        name,
        types: Array.isArray(s?.types) ? s!.types.filter((t): t is string => typeof t === 'string') : [],
        distance,
        unit: str(s?.unit) ?? 'miles',
      },
    ];
  });
  return parsed.sort((a, b) => a.distance - b.distance);
}
