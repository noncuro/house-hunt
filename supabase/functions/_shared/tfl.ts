// GENERATED — do not edit. Copied from packages/core/src/ by tools/sync-edge-function.ts.
// Edit the original and run `pnpm sync:function`.

import { logInfo, logWarn } from './log.ts';
import type { TravelMode } from './types.ts';

const BASE = 'https://api.tfl.gov.uk/journey/journeyresults';

/** A TfL failure we could not get past. `transient` separates "TfL was unhappy just now" from
 *  "there genuinely is no such journey" — the two look identical in the panel otherwise, and
 *  only one of them is worth retrying. */
export class TflError extends Error {
  constructor(
    message: string,
    readonly transient: boolean,
  ) {
    super(message);
    this.name = 'TflError';
  }
}

const RETRY_DELAYS_MS = [400, 1200, 3000];

/** Fetch with retries on the failures that pass. TfL rate-limits (429), has the occasional 5xx,
 *  and the service worker's network drops out; none of those mean anything about the journey.
 *  A 404 ("No journey found") and a 300 (ambiguous location) are real answers and are not
 *  retried — retrying them just makes the panel slower at being wrong. */
async function tflFetch(url: string, what: string): Promise<Response> {
  let last = '';

  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) {
      const wait = RETRY_DELAYS_MS[attempt - 1]!;
      logWarn('tfl', `retrying ${what} in ${wait}ms`, { attempt, last });
      await new Promise((r) => setTimeout(r, wait));
    }
    try {
      const response = await fetch(url);
      if (response.ok || !retryable(response.status)) return response;
      last = `HTTP ${response.status}`;
    } catch (e) {
      last = e instanceof Error ? e.message : String(e);
    }
  }
  throw new TflError(`TfL unreachable for ${what} after ${RETRY_DELAYS_MS.length + 1} tries (${last})`, true);
}

function retryable(status: number): boolean {
  return status === 429 || status === 408 || status >= 500;
}

/** TfL's journey planner takes a postcode directly, which is why we route from the postcode
 *  rather than the fuzzed map pin. Free, 500 req/min with a key. See RESEARCH.md §3. */
const MODES: Record<TravelMode, string | null> = {
  transit: null, // planner default: tube, bus, rail, DLR, walking legs
  walking: 'walking',
  cycling: 'cycle',
};

export interface Journey {
  seconds: number;
  changes: number | null;
  /** Distinct ways of making the trip, fastest first. */
  options: JourneyOption[];
}

export interface JourneyOption {
  minutes: number;
  legs: Leg[];
}

export interface Leg {
  /** TfL mode id: walking, tube, bus, overground, elizabeth-line, national-rail, … */
  mode: string;
  /** Line id where there is one, for the colour. Buses have their route number here. */
  lineId: string | null;
  /** What to call it: "Northern", "43". Absent for walking. */
  lineName: string | null;
  minutes: number;
}

export interface Point {
  lat: number;
  lon: number;
}

export interface StationInfo extends Point {
  /** TfL line ids, e.g. ["district", "piccadilly"]. */
  lines: string[];
}

/** Official TfL line colours. Anything unknown (a National Rail operator, say) falls back to the
 *  generic rail purple, so a new line never renders as an invisible dot. */
/** Bus routes are numbered, not named, so they never match a line id — they take the London bus
 *  red as a group. */
export const BUS_COLOUR = '#E1251B';

export const LINE_COLOURS: Record<string, string> = {
  bakerloo: '#B36305',
  central: '#E32017',
  circle: '#FFD300',
  district: '#00782A',
  'hammersmith-city': '#F3A9BB',
  jubilee: '#A0A5A9',
  metropolitan: '#9B0056',
  northern: '#000000',
  piccadilly: '#003688',
  victoria: '#0098D4',
  'waterloo-city': '#95CDBA',
  elizabeth: '#6950A1',
  dlr: '#00A4A7',
  tram: '#84B817',
  'london-overground': '#EE7C0E',
  liberty: '#5D6061',
  lioness: '#FAA61A',
  mildmay: '#0077AD',
  suffragette: '#5BBD72',
  weaver: '#823A62',
  windrush: '#ED1B00',
  'national-rail': '#3A3A6A',
};

export const FALLBACK_LINE_COLOUR = '#3A3A6A';

/** Black or white text on a line's own colour. The Circle line's yellow and the Waterloo & City's
 *  pale green are unreadable under white text, so this is picked per line rather than fixed. */
export function textOn(background: string): string {
  const hex = background.replace('#', '');
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number];
  // Relative luminance, per WCAG.
  const channel = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const luminance = 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
  return luminance > 0.45 ? '#12263a' : '#ffffff';
}

/** Resolve a station name to coordinates.
 *
 *  Needed because TfL's journey planner accepts neither a station name (300 disambiguation, or
 *  404) nor a Naptan id (300) as a destination — but it does accept "lat,lon". Verified against
 *  "Essex Road Station" and "Earls Court Station". */
export async function resolveStation(
  name: string,
  appKey: string | undefined,
): Promise<StationInfo | null> {
  for (const query of searchQueries(name)) {
    const params = new URLSearchParams({ modes: SEARCH_MODES });
    if (appKey) params.set('app_key', appKey);

    const response = await tflFetch(
      `https://api.tfl.gov.uk/StopPoint/Search/${encodeURIComponent(query)}?${params}`,
      `station search "${query}"`,
    );
    if (!response.ok) continue;

    const body = (await response.json()) as {
      matches?: Array<{ id?: string; lat?: number; lon?: number }>;
    };
    const match = body.matches?.[0];
    if (typeof match?.lat !== 'number' || typeof match?.lon !== 'number') continue;

    logInfo('tfl', `resolved station "${name}"`, { query, id: match.id });
    return { lat: match.lat, lon: match.lon, lines: match.id ? await stationLines(match.id, appKey) : [] };
  }
  logWarn('tfl', `no TfL match for station "${name}"`);
  return null;
}

const SEARCH_MODES = 'tube,dlr,overground,national-rail,elizabeth-line';

/** Rightmove's station names don't always exist in TfL's index — "Kings Cross Thameslink" returns
 *  nothing, while "Kings Cross" returns the hub. So drop the trailing qualifier and try again
 *  rather than giving up, which is what left that row with no walk time and no lines. */
function searchQueries(name: string): string[] {
  // Rightmove suffixes every name with "Station"; TfL's index doesn't, and the extra word costs
  // matches.
  const base = name.replace(/\s+(Rail\s+)?Station$/i, '').trim();
  const words = base.split(/\s+/);
  const queries = [base];
  if (words.length > 2) queries.push(words.slice(0, -1).join(' '));
  return queries;
}

/** The modes worth a coloured dot. Buses and National Rail are deliberately absent: King's Cross
 *  lists 15 bus routes and 8 rail operators, which rendered as a row of twenty identical dots
 *  that told you nothing. What decides a flat is which tube and Overground lines you're on. */
const SHOWN_MODES = new Set(['tube', 'overground', 'elizabeth-line', 'dlr', 'tram']);

/** The search result carries no lines, so this is a second call — made once per station ever,
 *  then cached. A failure here costs the colour dots, not the walking time. */
async function stationLines(stopPointId: string, appKey: string | undefined): Promise<string[]> {
  try {
    const params = appKey ? `?app_key=${encodeURIComponent(appKey)}` : '';
    const response = await tflFetch(
      `https://api.tfl.gov.uk/StopPoint/${stopPointId}${params}`,
      `station lines ${stopPointId}`,
    );
    if (!response.ok) return [];

    const body = (await response.json()) as {
      lineModeGroups?: Array<{ modeName?: string; lineIdentifier?: string[] }>;
    };
    const lines = new Set<string>();
    for (const group of body.lineModeGroups ?? []) {
      if (!SHOWN_MODES.has(group.modeName ?? '')) continue;
      for (const id of group.lineIdentifier ?? []) lines.add(id);
    }
    return [...lines];
  } catch {
    return [];
  }
}

/** Walking seconds from a postcode to a point. */
export async function walkTo(
  fromPostcode: string,
  point: Point,
  appKey: string | undefined,
): Promise<number> {
  const journey = await journeyTime(fromPostcode, `${point.lat},${point.lon}`, 'walking', appKey);
  return journey.seconds;
}

/** What a cached number *means*, per mode — and the reason the cache can be trusted at all.
 *
 *  TfL's journey planner, asked without a date, plans against right now. So a transit time was
 *  whatever the network happened to be doing at the moment somebody opened the listing: a Sunday
 *  evening with the Northern line part-suspended, or half past eleven at night when the answer is
 *  a night bus. That number was then cached forever and shown as *the* commute. Worse, the compare
 *  table's entire purpose is ranking flats against each other, and it was ranking a Tuesday-morning
 *  measurement against a Sunday-midnight one as though they were the same question.
 *
 *  So transit is pinned to a weekday morning — see `nextWeekdayMorning`. Walking and cycling do
 *  not depend on the timetable and are marked `anytime`, which is not a technicality: it is what
 *  keeps a basis change from needlessly invalidating two thirds of the cache.
 *
 *  The string is stored on each cached row, and a row whose basis is not the current one is
 *  treated as a miss and recomputed. That is what makes this self-healing rather than a migration:
 *  every number already in the database was measured on an unknown basis, and every one of them
 *  will quietly correct itself the next time its listing is opened. Change the pinned time and the
 *  same thing happens again. */
export const TRAVEL_BASIS: Record<TravelMode, string> = {
  walking: 'anytime',
  cycling: 'anytime',
  transit: 'weekday-0900',
};

/** The next weekday at 09:00 local time, as TfL's `date`/`time` pair.
 *
 *  Forward rather than backward, because TfL will not plan a journey in the past. A weekday
 *  because that is the journey being asked about — nobody is choosing a flat on its Sunday
 *  commute. Nine because it is when you would arrive, and because peak and off-peak are
 *  genuinely different journeys on this network, not the same journey with a different number.
 *
 *  Note this deliberately does NOT enter the basis string: which particular Tuesday hardly
 *  matters, and putting the date in the basis would invalidate the whole cache every night. */
export function nextWeekdayMorning(now = new Date()): { date: string; time: string } {
  const when = new Date(now);
  when.setHours(9, 0, 0, 0);
  // Already past nine today, or today is not a weekday: step forward until both are true.
  if (when <= now) when.setDate(when.getDate() + 1);
  while (when.getDay() === 0 || when.getDay() === 6) when.setDate(when.getDate() + 1);

  const pad = (n: number) => String(n).padStart(2, '0');
  return {
    date: `${when.getFullYear()}${pad(when.getMonth() + 1)}${pad(when.getDate())}`,
    time: '0900',
  };
}

/** How long a "there is no such journey" answer is allowed to stand.
 *
 *  Negatives have to be cached — a postcode TfL cannot route to fails slowly, every time, on
 *  every page load — but a negative is the one cached answer that can become false without
 *  anything about the flat changing. A station opens, a route is added, a postcode that TfL's
 *  geocoder did not know last month it now knows. So they expire, and positives do not. */
export const NO_ROUTE_RETRY_DAYS = 30;

/** A cached row we should not use, and why — null when the row is good.
 *
 *  Returning the reason rather than a boolean is deliberate: this is the function that decides to
 *  spend an API call, and when the cache is thrashing the log has to say which rule did it.
 *
 *  Structural parameter rather than `CachedTravel` because supabase.ts imports this module, and
 *  the dependency must not run both ways. */
export function staleTravel(
  row: { basis: string | null; noRoute: boolean; options?: unknown; computedAt: string },
  mode: TravelMode,
  now = new Date(),
): string | null {
  if (row.basis !== TRAVEL_BASIS[mode]) {
    // Covers null too, which is every row written before basis tracking — measured at an unknown
    // time of day and so not comparable with anything measured since.
    return `measured on basis "${row.basis ?? 'unknown'}", not "${TRAVEL_BASIS[mode]}"`;
  }
  if (row.noRoute) {
    const age = (now.getTime() - new Date(row.computedAt).getTime()) / (24 * 60 * 60 * 1000);
    // An unparseable timestamp gives NaN, and NaN > n is false, so a bad row is kept rather than
    // refetched on every load. Wrong in the cheap direction.
    if (age > NO_ROUTE_RETRY_DAYS) return `a no-route answer ${Math.round(age)} days old`;
    return null;
  }
  // A transit row cached before we stored the leg breakdown has a duration and no route, and
  // because a hit is never revisited the hover showing which lines you ride would have stayed
  // empty on those rows forever. An answer missing a field we now show is not an answer.
  if (mode === 'transit' && !row.options) return 'no leg breakdown stored';
  return null;
}

export async function journeyTime(
  fromPostcode: string,
  toPostcode: string,
  mode: TravelMode,
  appKey: string | undefined,
  now = new Date(),
): Promise<Journey> {
  const params = new URLSearchParams();
  const tflMode = MODES[mode];
  if (tflMode) params.set('mode', tflMode);
  // Only where it changes the answer. Sending a date for a walk would be noise in the URL and,
  // more to the point, would tie a walking time to a basis it does not actually depend on.
  if (TRAVEL_BASIS[mode] !== 'anytime') {
    const { date, time } = nextWeekdayMorning(now);
    params.set('date', date);
    params.set('time', time);
    params.set('timeIs', 'Departing');
  }
  if (appKey) params.set('app_key', appKey);

  const url = `${BASE}/${encodeURIComponent(fromPostcode)}/to/${encodeURIComponent(toPostcode)}?${params}`;
  // tflFetch, not a bare fetch: journeys were the one call that got no retries at all, and a
  // dropped connection threw a raw TypeError that the caller then read as a settled "no such
  // journey" — and, since negatives are cached, remembered forever.
  const response = await tflFetch(url, `journey ${fromPostcode} -> ${toPostcode} by ${mode}`);

  if (!response.ok) {
    // 300 means the planner wants disambiguation — usually a postcode it can't resolve.
    if (response.status === 300) {
      throw new TflError(`TfL could not resolve "${fromPostcode}" or "${toPostcode}"`, false);
    }
    // 404 is TfL's "no journey found" — a settled answer, and the one case worth remembering.
    if (response.status === 404) throw new TflError('TfL found no journey for this mode', false);
    // Anything else (a 403 from the CDN, say) is not a statement about the journey, so it must
    // not be cached as one.
    throw new TflError(`TfL returned ${response.status}`, true);
  }

  const body = (await response.json()) as { journeys?: RawJourney[] };
  const journey = body.journeys?.[0];
  if (!journey || typeof journey.duration !== 'number') {
    throw new TflError('TfL found no journey for this mode', false);
  }

  return {
    seconds: journey.duration * 60,
    changes: countChanges(journey.legs),
    options: distinctOptions(body.journeys ?? []),
  };
}

interface RawJourney {
  duration?: number;
  legs?: Array<{
    mode?: { id?: string };
    duration?: number;
    routeOptions?: Array<{ name?: string; lineIdentifier?: { id?: string } }>;
  }>;
}

/** How many distinct routes to keep. TfL returns three, but they are frequently the same trip
 *  with a different bus number at the front — so we dedupe by shape first and usually end up
 *  showing one or two. */
const MAX_OPTIONS = 3;

/** Turn TfL's journeys into the leg-by-leg breakdown the tooltip draws, keeping only genuinely
 *  different routes. Two journeys that ride the same sequence of lines are the same answer to
 *  "how do I get there", however much their departure times differ. */
function distinctOptions(journeys: RawJourney[]): JourneyOption[] {
  const seen = new Set<string>();
  const options: JourneyOption[] = [];

  for (const journey of journeys) {
    if (typeof journey.duration !== 'number') continue;
    const legs = (journey.legs ?? []).flatMap((leg) => {
      const mode = leg.mode?.id;
      const minutes = leg.duration;
      if (!mode || typeof minutes !== 'number') return [];
      const route = leg.routeOptions?.[0];
      return [
        {
          mode,
          lineId: route?.lineIdentifier?.id ?? null,
          lineName: route?.name && route.name.length > 0 ? route.name : null,
          minutes,
        },
      ];
    });

    // The shape of a route is which lines you ride, in order — walking legs are consequences of
    // that choice, not part of it.
    const shape = legs
      .filter((l) => l.mode !== 'walking' && l.mode !== 'cycle')
      .map((l) => l.lineId ?? l.mode)
      .join('>');
    if (seen.has(shape)) continue;
    seen.add(shape);

    options.push({ minutes: journey.duration, legs });
    if (options.length >= MAX_OPTIONS) break;
  }
  return options;
}

/** Legs include the walk to the station and the walk at the other end, so leg count overstates
 *  changes — walk/tube/walk is a direct journey, not two changes. Count only the legs you ride. */
function countChanges(legs: Array<{ mode?: { id?: string } }> | undefined): number | null {
  if (!Array.isArray(legs)) return null;
  const ridden = legs.filter((leg) => {
    const id = leg.mode?.id;
    return typeof id === 'string' && id !== 'walking' && id !== 'cycle';
  }).length;
  return ridden > 0 ? ridden - 1 : 0;
}
