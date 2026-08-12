import { decodePageModel } from './decode';
import type { FloorArea, Floorplan, Listing, Station } from '@house-hunt/core';

const SQM_TO_SQFT = 10.7639;

/** Reads a decoded propertyData object into our narrow Listing shape.
 *  Every field is defensive: Rightmove has renamed things before (PAGE_MODEL -> __PAGE_MODEL),
 *  so a missing sub-object degrades that one field rather than failing the whole extraction.
 *  The exception is `id`, which we genuinely cannot work without. */
export function toListing(property: Record<string, unknown>, url: string): Listing {
  const id = property.id;
  if (id === undefined || id === null || String(id).length === 0) {
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

function sizings(v: unknown): number | null {
  if (!Array.isArray(v)) return null;
  let sqm: number | null = null;
  for (const raw of v) {
    const s = obj(raw);
    // Rightmove publishes a min and a max; they're equal for a stated size, and where they
    // differ the minimum is the honest number.
    const size = num(s?.minimumSize) ?? num(s?.maximumSize);
    const unit = str(s?.unit)?.toLowerCase();
    if (size === null || size <= 0) continue;
    if (unit === 'sqft') return Math.round(size);
    if (unit === 'sqm') sqm = size;
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
    // Anything outside this range is a typo, not a floor area.
    if (sqft < 100 || sqft > 100_000) continue;

    const at = m.index ?? 0;
    const end = at + m[0]!.length;
    // What the number is called, read from right beside it. "1,200 sq ft garden" is a garden
    // whatever the rest of the sentence says.
    const adjacent = text.slice(Math.max(0, at - ADJACENT), end + ADJACENT);
    if (NOT_THE_FLAT.test(adjacent)) continue;

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

/** Read + decode the page global. MAIN world only — an isolated content script sees a
 *  different `window` and would always get undefined here. */
export function extractFromPage(win: Window & typeof globalThis, url: string): Listing {
  const model = (win as unknown as Record<string, unknown>).__PAGE_MODEL;
  if (model === undefined) {
    throw new Error('window.__PAGE_MODEL not found — Rightmove may have renamed the page global');
  }
  return toListing(decodePageModel(model), url);
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
