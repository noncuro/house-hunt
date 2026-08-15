/** Narrowing a pile of flats down to the ones worth looking at.
 *
 *  Triage is the one screen where you work through everything nobody has judged, and after a sweep
 *  that is two or three hundred places. Most of them fail on something you would have written down
 *  in advance: under 600 sq ft, over £3,000, no outdoor space at all. Reading each of those as a row
 *  and deciding it again is the work this exists to skip.
 *
 *  **A filter drops a flat only when it is known not to qualify.** Unknown is kept, every time. Most
 *  of what is filtered on here is read off photographs by a model — a floor area, a main room, a
 *  dishwasher — and "we could not tell" is a genuine and common answer. Dropping those would hide
 *  exactly the flats nobody has looked at properly, which is the pile triage *is*; and it would do
 *  it invisibly, since a filtered-out row leaves nothing behind to notice. `unknowns` counts them,
 *  so the screen can say how many are still there only because we do not know.
 */
import { AMENITIES, amenityPresent, resolveSize, type AmenityKey } from './facts';
import { parseMonthlyPrice } from './predict';
import type { ShortlistEntry } from './db/supabase';
import { sizeOf } from './shortlist';
import { TRAVEL_MODES, type TravelMode, type TravelTime } from './types';
import { distanceMiles } from './hubs';
import type { Point } from './postcode';

/** How far a place may be from somewhere this hunt saved, measured on the map rather than by any
 *  journey. Miles as the crow flies, between two coordinates.
 *
 *  Here because a journey time is not always available and sometimes not the question. Every
 *  neighbourhood folded in from the old hub list has a coordinate and no postcode, and TfL is asked
 *  for a route between postcodes — so "twenty minutes to Belsize Park" can never be answered, and a
 *  bar naming it would keep the whole pile on the unknown rule while looking like it was filtering.
 *  A straight line to it is answerable for every flat whose own position we have, which is nearly
 *  all of them. It is also the honest measure for "somewhere round here": half a mile of Angel is a
 *  thing people mean, and it does not depend on what the Northern line is doing. */
export const CROW = 'crow';

/** What a bar can be measured in. The three journeys, and the straight line. */
export type BarMode = TravelMode | typeof CROW;

export const BAR_MODES: BarMode[] = [...TRAVEL_MODES, CROW];

/** "No more than twenty minutes to the office, on the tube." Or half a mile of Angel.
 *
 *  A place and a mode together, because neither answers on its own: forty minutes to work is a
 *  different flat depending on whether it is forty minutes of walking or forty on the Victoria
 *  line, and a hunt that cycles has no use for a bar measured on foot. Both surfaces already show
 *  the numbers per place *and* per mode, so a filter that collapsed either would be asking a
 *  question the screen cannot show you the answer to. */
export interface TravelBar {
  /** The saved place, by id — `place.id`, the same key the compare table's columns use. */
  placeId: string;
  mode: BarMode;
  /** Minutes for a mode you travel by, miles for `crow`. One number rather than two, because the
   *  bar is one control and its unit is whatever the mode measures in — the screen writes "min" or
   *  "mi" beside it from the same fact. */
  max: number;
}

/** Enough of a place to know what can be asked about it. */
export interface Measurable {
  postcode: string | null;
  lat: number | null;
  lon: number | null;
}

/** The bars this place can actually answer.
 *
 *  A journey needs a postcode, because that is what TfL is asked with. A straight line needs a
 *  coordinate, because that is what a distance is between. Most places have both; the neighbourhoods
 *  folded in from the old hub list have only the second, and a place whose postcode never resolved
 *  to a point has only the first.
 *
 *  Empty is a real answer and means this place cannot be measured to at all. A bar against one would
 *  read `unknown` for every flat in the hunt — which keeps the whole pile, so the control sits there
 *  looking like a filter and doing nothing, and that is the one failure this file exists to refuse.
 *  The picker offers only these, and `withKnownPlaces` drops a stored bar that has stopped being
 *  one of them. */
export function barModesFor(place: Measurable): BarMode[] {
  const modes: BarMode[] = place.postcode === null ? [] : [...TRAVEL_MODES];
  if (place.lat !== null && place.lon !== null) modes.push(CROW);
  return modes;
}

/** What a new bar against this place starts as, and what an existing one becomes when it is moved
 *  onto a place measured differently.
 *
 *  Thirty minutes on public transport where there is a postcode to route from — the commute is what
 *  people save a place for. A mile as the crow flies where there is not.
 *
 *  The number comes with the mode and is never carried across. Thirty minutes and thirty miles are
 *  the same digits and nothing like the same filter: switching one to the other silently widened a
 *  half-hour commute to most of the South East, and switching back turned half a mile into thirty
 *  seconds and excluded every journey ever measured. Either way the control reads exactly as it did
 *  before, which is what makes it worth throwing the number away. */
export function startingBar(place: Measurable): { mode: BarMode; max: number } | null {
  const modes = barModesFor(place);
  if (modes.length === 0) return null;
  return modes.includes('transit') ? { mode: 'transit', max: 30 } : { mode: CROW, max: 1 };
}

/** The default for one mode, for when only the mode is changing. */
export function defaultMax(mode: BarMode): number {
  return mode === CROW ? 1 : 30;
}

/** Where the places are, by id, for the bars measured in miles. Only the ones with a coordinate:
 *  a place we cannot put on the map is one no straight line can be drawn to, and guessing a point
 *  would silently move every flat's answer. */
export type PlacePoints = Record<string, Point>;

/** Every travel time we have, keyed by the flat's own postcode — `cachedTravelTimes`' shape,
 *  handed in rather than fetched here because the pile is filtered on every keystroke and the
 *  cache read belongs to the screen. */
export type TravelIndex = Record<string, TravelTime[]>;

export interface TriageFilter {
  /** Monthly rent in pounds. A flat whose price cannot be parsed is unknown, not free. */
  maxPrice: number | null;
  minBedrooms: number | null;
  /** Floor area, resolved by the same rule every view shows it with (`resolveSize`) — so a filter
   *  can never be answering about a different number from the one on screen. */
  minSqft: number | null;
  /** The biggest room the model measured. "Great room" on the Your Hunt page is the same figure
   *  against a bar; this is the bar as a filter. */
  minGreatRoomSqft: number | null;
  /** Amenities the flat must be *known* to have. Absent from the list means "don't mind" — there is
   *  deliberately no "must not have": nothing here is something a hunt wants less of. */
  amenities: AmenityKey[];
  /** How far it may be from the places this hunt saved. Several, because "twenty minutes to work
   *  *and* a walk to the park" is one hunt's actual requirement rather than two alternatives. */
  travel: TravelBar[];
}

export const NO_FILTER: TriageFilter = {
  maxPrice: null,
  minBedrooms: null,
  minSqft: null,
  minGreatRoomSqft: null,
  amenities: [],
  travel: [],
};

export function filterIsOn(filter: TriageFilter): boolean {
  return (
    filter.maxPrice !== null ||
    filter.minBedrooms !== null ||
    filter.minSqft !== null ||
    filter.minGreatRoomSqft !== null ||
    filter.amenities.length > 0 ||
    filter.travel.length > 0
  );
}

/** Does this flat clear every bar the filter sets? Unknown clears them all — see the note above. */
export function matchesFilter(
  entry: ShortlistEntry,
  filter: TriageFilter,
  travel?: TravelIndex,
  points?: PlacePoints,
): boolean {
  if (filter.maxPrice !== null) {
    const price = parseMonthlyPrice(entry.price);
    if (price !== null && price > filter.maxPrice) return false;
  }
  if (filter.minBedrooms !== null && entry.bedrooms !== null && entry.bedrooms < filter.minBedrooms) {
    return false;
  }
  if (filter.minSqft !== null) {
    const size = resolveSize(sizeOf(entry));
    if (size && size.value < filter.minSqft) return false;
  }
  if (filter.minGreatRoomSqft !== null) {
    const room = entry.analysis?.biggestRoomSqft ?? null;
    if (room !== null && room < filter.minGreatRoomSqft) return false;
  }
  for (const key of filter.amenities) {
    // `false` is the only answer that drops a flat. `null` is the model saying it could not tell,
    // and a flat with no photos analysed yet would otherwise fail every amenity at once — which is
    // to say the filter would hide precisely the listings nobody has looked at.
    if (amenityPresent(key, entry.analysis) === false) return false;
  }
  for (const bar of filter.travel) {
    if (reach(entry, bar, travel, points) === 'beyond') return false;
  }
  return true;
}

/** Where this flat sits against one travel bar, in the same three answers everything else here
 *  deals in.
 *
 *  Read off the raw rows rather than through `readTravel`, which is what draws these numbers on
 *  screen, and the difference is deliberate. `readTravel` answers "what is the best way of making
 *  this trip", and to do that it discards a walk of over an hour as not a real option — correct for
 *  a headline number, and the wrong reading here, because a ninety-minute walk is precisely a known
 *  failure of "walk to the park in twenty" rather than something we could not tell. A filter asks a
 *  narrower question than a renderer does. */
function reach(
  entry: ShortlistEntry,
  bar: TravelBar,
  travel: TravelIndex | undefined,
  points: PlacePoints | undefined,
): Reach {
  // Measured on the map, so neither postcode nor cache comes into it — only whether we know where
  // both ends are. A flat with no coordinate is unknown for the same reason everything else here is.
  if (bar.mode === CROW) {
    const place = points?.[bar.placeId];
    if (!place || entry.lat === null || entry.lon === null) return 'unknown';
    return distanceMiles({ lat: entry.lat, lon: entry.lon }, place) <= bar.max ? 'within' : 'beyond';
  }
  if (!entry.postcode) return 'unknown';
  const rows = (travel?.[entry.postcode] ?? []).filter(
    (t) => t.placeId === bar.placeId && t.mode === bar.mode,
  );
  const measured = rows.find((t) => !t.error && t.seconds > 0);
  // Rounded, because the rounded figure is the one on the card. Comparing raw seconds would drop a
  // flat that says "20m" against a bar of twenty, which reads as the filter being broken — and on
  // this screen you cannot check, since a dropped row leaves nothing behind.
  if (measured) return Math.round(measured.seconds / 60) <= bar.max ? 'within' : 'beyond';
  // TfL was asked and said there is no such journey: settled, not missing. A place you cannot reach
  // by this mode at all is not within twenty minutes of it. A transient failure is a different
  // thing — that is us not having asked successfully yet, and it stays unknown.
  if (rows.some((t) => t.error && !t.transient)) return 'beyond';
  return 'unknown';
}

type Reach = 'within' | 'beyond' | 'unknown';

/** What the filter left, and how much of that is only there because we could not tell.
 *
 *  The second number is the honest half. A pile of forty that is thirty-one unmeasured flats is not
 *  a pile of forty places over 700 sq ft, and a screen that says "40" alone has claimed it is. */
export function applyFilter(
  entries: ShortlistEntry[],
  filter: TriageFilter,
  travel?: TravelIndex,
  points?: PlacePoints,
): { kept: ShortlistEntry[]; unknowns: number } {
  const kept = entries.filter((entry) => matchesFilter(entry, filter, travel, points));
  if (!filterIsOn(filter)) return { kept, unknowns: 0 };
  const unknowns = kept.filter((entry) => unknownTo(entry, filter, travel, points)).length;
  return { kept, unknowns };
}

/** True when this flat clears the filter with a shrug rather than an answer — at least one bar it
 *  was measured against has no measurement. */
function unknownTo(
  entry: ShortlistEntry,
  filter: TriageFilter,
  travel?: TravelIndex,
  points?: PlacePoints,
): boolean {
  if (filter.maxPrice !== null && parseMonthlyPrice(entry.price) === null) return true;
  if (filter.minBedrooms !== null && entry.bedrooms === null) return true;
  if (filter.minSqft !== null && !resolveSize(sizeOf(entry))) return true;
  if (filter.minGreatRoomSqft !== null && (entry.analysis?.biggestRoomSqft ?? null) === null) return true;
  if (filter.amenities.some((key) => amenityPresent(key, entry.analysis) === null)) return true;
  // The commonest unknown of the lot, and the one most worth counting. The travel cache only holds
  // pairings somebody has already looked up, so on a fresh sweep almost the whole pile is unmeasured
  // — a travel bar that dropped those would empty the screen and look like a hunt with nowhere to
  // live in it.
  return filter.travel.some((bar) => reach(entry, bar, travel, points) === 'unknown');
}

/** A filter as it comes back out of storage: anything unrecognised falls back to "don't mind".
 *
 *  Stored preferences outlive the code that wrote them. This has already gained a field once, and a
 *  filter saved before that has to keep working; so does one left behind by a half-finished edit, or
 *  by a browser that truncated the value. Every bar is validated on its own and a bad one is simply
 *  dropped, which fails in the safe direction — a filter that forgot something shows too many flats,
 *  and that is visible. Reviving a malformed bar as a number would hide them. */
export function parseFilter(raw: unknown): TriageFilter {
  if (!raw || typeof raw !== 'object') return NO_FILTER;
  const source = raw as Record<string, unknown>;
  const amenityKeys = new Set<string>(AMENITIES.map((a) => a.key));
  return {
    maxPrice: bar(source.maxPrice),
    minBedrooms: bar(source.minBedrooms),
    minSqft: bar(source.minSqft),
    minGreatRoomSqft: bar(source.minGreatRoomSqft),
    amenities: (Array.isArray(source.amenities) ? source.amenities : []).filter(
      (key): key is AmenityKey => typeof key === 'string' && amenityKeys.has(key),
    ),
    travel: (Array.isArray(source.travel) ? source.travel : []).flatMap((entry) => {
      if (!entry || typeof entry !== 'object') return [];
      const { placeId, mode, max, maxMinutes } = entry as Record<string, unknown>;
      // `maxMinutes` is what this was called before the bar could be measured in miles. Read as a
      // fallback so a filter somebody left in localStorage survives the rename rather than silently
      // widening to "any distance" on their next visit.
      const value = bar(max) ?? bar(maxMinutes);
      if (typeof placeId !== 'string' || !placeId) return [];
      if (!BAR_MODES.includes(mode as BarMode) || value === null) return [];
      return [{ placeId, mode: mode as BarMode, max: value }];
    }),
  };
}

/** One stored numeric bar, or "don't mind". Nought is not a bar — see the note on the input. */
function bar(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

/** The filter with any bar naming a place this project no longer has thrown away.
 *
 *  A saved place can be deleted, and a travel bar pointing at one that is gone is a bar the panel
 *  cannot draw and nobody can clear — it would sit there narrowing the pile with no control on
 *  screen to say so. Dropping it widens the filter, which is the direction that shows you more
 *  rather than less. */
export function withKnownPlaces(
  filter: TriageFilter,
  places: Iterable<Measurable & { id: string }>,
): TriageFilter {
  const known = new Map([...places].map((p) => [p.id, p]));
  const travel = filter.travel.filter((t) => {
    const place = known.get(t.placeId);
    // And a bar whose place can no longer answer it goes the same way, for the same reason: a
    // postcode removed from a place leaves its transit bars reading `unknown` for every flat in the
    // hunt, so the pile is unfiltered and the control says otherwise. The picker would not offer
    // that combination, but a filter restored from storage was never offered anything.
    return place !== undefined && barModesFor(place).includes(t.mode);
  });
  return travel.length === filter.travel.length ? filter : { ...filter, travel };
}
