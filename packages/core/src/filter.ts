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
import {
  AMENITIES,
  amenityPresent,
  nearestStationMiles,
  resolveSize,
  type AmenityKey,
  type AmenityWant,
  type HuntPreferences,
} from './facts';
import { parseMonthlyPrice } from './predict';
import type { ShortlistEntry } from './db/supabase';
import { sizeOf } from './shortlist';
import { TRAVEL_MODES, type Place, type TravelMode, type TravelTime } from './types';
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

/** The one destination every flat carries with it: whichever station Rightmove listed nearest.
 *
 *  A place id, and a fake one, because "within half a mile of a station" is the same question as
 *  "within half a mile of Angel" and deserves the same control rather than a fourth kind of bar
 *  bolted onto the row. It is not a place anybody saved and it is not on the map — the distance is
 *  Rightmove's own figure for the nearest of the stations it listed, already on every card — so it
 *  is measured as the crow flies and nothing else, and no project ever holds a row with this id.
 *
 *  It also answers for far more of the pile than a saved place can: a station distance arrives with
 *  the listing, where a journey time has to be looked up per flat and mostly has not been. */
export const NEAREST_STATION = 'nearest-station';

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
export function barModesFor(place: Measurable & { id?: string }): BarMode[] {
  // The nearest station has no postcode and no coordinate of its own — it is a different station
  // for every flat — so the general rule below would say it cannot be measured to at all. It can:
  // the distance came with the listing. Miles, and only miles, since it is Rightmove's figure and
  // there is nowhere fixed to route a journey from.
  if (place.id === NEAREST_STATION) return [CROW];
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
export function startingBar(place: Measurable & { id?: string }): { mode: BarMode; max: number } | null {
  const modes = barModesFor(place);
  if (modes.length === 0) return null;
  return modes.includes('transit') ? { mode: 'transit', max: 30 } : { mode: CROW, max: 1 };
}

/** The nearest station as a place, so the picker can offer it in the same select as everywhere the
 *  hunt saved. Every field but the label and the id is empty because none of them is true of it:
 *  it has no postcode to route from, no point on the map, and nothing to sweep. `barModesFor` is
 *  what knows better, and it is the only thing that has to. */
export const NEAREST_STATION_PLACE: Place = {
  id: NEAREST_STATION,
  label: 'Nearest station',
  postcode: null,
  lat: null,
  lon: null,
  locationIdentifier: null,
  displayLocationIdentifier: null,
  sweepRadiusMiles: null,
  maxDaysSinceAdded: null,
};

/** Somewhere a bar can be measured to: the hunt's own places, and the station every flat has. The
 *  saved ones first — a bar added with the button lands on the first of these, and the commute is
 *  what somebody saved a place for. */
export function destinationsFor(places: Place[]): Place[] {
  return [...places.filter((p) => barModesFor(p).length > 0), NEAREST_STATION_PLACE];
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
  /** Only listings that published a floorplan. `false` means "don't mind", never "must not have".
   *
   *  Not an amenity, and deliberately its own field. `AMENITIES` is a shared vocabulary — it drives
   *  the Your Hunt preferences and the flag chips on every card — and a floorplan is a fact about
   *  the *listing*, not about the flat. Folded in there, a place with no floorplan would be flagged
   *  as though the building were missing something.
   *
   *  It is also the one bar here that a missing value does *not* clear; see `matchesFilter`. */
  hasFloorplan: boolean;
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
  hasFloorplan: false,
  travel: [],
};

export function filterIsOn(filter: TriageFilter): boolean {
  return (
    filter.maxPrice !== null ||
    filter.minBedrooms !== null ||
    filter.minSqft !== null ||
    filter.minGreatRoomSqft !== null ||
    filter.amenities.length > 0 ||
    filter.hasFloorplan ||
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
  // The one bar on this screen where a missing value is an answer rather than a shrug, so it is the
  // one that drops a flat outright. Everything else here is read off photographs by the model, and
  // `null` there means nobody has looked yet — hence the rule that unknown clears every bar.
  // `floorplanUrl` is not that: it is read straight off the listing when the flat is first seen, so
  // null means the agent published no floorplan. Treating it as unknown would make this filter keep
  // every flat it was meant to remove, which is a control that appears to do nothing.
  if (filter.hasFloorplan && !entry.floorplanUrl) return false;
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
  // Rightmove's own number, off the listing, so neither end of it is a place with a position — and
  // a flat with no stations listed is unknown rather than infinitely far from one. Asked before the
  // mode, because the mode can only ever be `crow` here and a bar restored from storage with
  // anything else in it should still measure the thing it names.
  if (bar.placeId === NEAREST_STATION) {
    const miles = nearestStationMiles(entry.nearestStations);
    return miles === null ? 'unknown' : miles <= bar.max ? 'within' : 'beyond';
  }
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

/** Which of the bars this flat was measured against have no measurement — in the words a screen can
 *  put on the row.
 *
 *  The tally under the filter says how many flats are here on a shrug; it cannot say *which*, and on
 *  a row that is the whole question. "Kept: we have no size for this one" is a different instruction
 *  from "700 sq ft" — it is the one that says open the floorplan — and without it the two are drawn
 *  identically, which is the invisible half of the unknown rule finally made visible.
 *
 *  Short phrases, because they are chips beside an address and not a paragraph. Empty means the flat
 *  cleared every bar on an actual answer. */
export function unknownBars(
  entry: ShortlistEntry,
  filter: TriageFilter,
  travel?: TravelIndex,
  points?: PlacePoints,
): string[] {
  const missing: string[] = [];
  if (filter.maxPrice !== null && parseMonthlyPrice(entry.price) === null) missing.push('no rent');
  if (filter.minBedrooms !== null && entry.bedrooms === null) missing.push('beds unknown');
  if (filter.minSqft !== null && !resolveSize(sizeOf(entry))) missing.push('no size');
  if (filter.minGreatRoomSqft !== null && (entry.analysis?.biggestRoomSqft ?? null) === null) {
    missing.push('main room unmeasured');
  }
  for (const key of filter.amenities) {
    if (amenityPresent(key, entry.analysis) === null) {
      missing.push(`${AMENITIES.find((a) => a.key === key)?.label ?? key} unknown`);
    }
  }
  // The commonest unknown of the lot, and the one most worth saying. The travel cache only holds
  // pairings somebody has already looked up, so on a fresh sweep almost the whole pile is unmeasured
  // — a travel bar that dropped those would empty the screen and look like a hunt with nowhere to
  // live in it.
  //
  // The station is its own phrase because it is its own kind of missing. "Journey not measured" is
  // an instruction — open the flat and it will be — and the station distance is not something
  // opening anything will produce: the listing named no station, and that is as far as it goes.
  const unmeasured = filter.travel.filter((bar) => reach(entry, bar, travel, points) === 'unknown');
  if (unmeasured.some((bar) => bar.placeId === NEAREST_STATION)) missing.push('no station listed');
  if (unmeasured.some((bar) => bar.placeId !== NEAREST_STATION)) missing.push('journey not measured');
  return missing;
}

/** True when this flat clears the filter with a shrug rather than an answer — at least one bar it
 *  was measured against has no measurement. */
function unknownTo(
  entry: ShortlistEntry,
  filter: TriageFilter,
  travel?: TravelIndex,
  points?: PlacePoints,
): boolean {
  return unknownBars(entry, filter, travel, points).length > 0;
}

/** The hunt's own must-haves, expressed as a filter.
 *
 *  `TriageFilter` is a sitting's question — "show me the two-beds today" — and it is thrown away
 *  when the sitting ends. This is the standing one: what everybody in the hunt agreed on, on the
 *  Your Hunt page, and a flat under it is not a flat this hunt is going to take. It was already
 *  being said on every card (`flagsFor` draws each of these red) and nowhere acted on, so the pile
 *  and the badge beside the tab both counted flats already ruled out.
 *
 *  Three of the preferences and deliberately not the rest. `minBedrooms` and `minSqft` are floors —
 *  `flagsFor` flags being under either in red, in the hunt's own words ("you asked for 2+") — and an
 *  amenity marked `must` is the word "must" as somebody typed it. What is left out is everything the
 *  hunt stated as an aspiration rather than a bar: `targetSqft` is amber by design (a flat over the
 *  floor and under the target is one to go and look at), `greatRoomMinSqft` moves where a *good*
 *  mark is earned and flags no absence at all, and a `nice` amenity is the setting that exists
 *  precisely to not exclude anything.
 *
 *  The rent ceiling is not here either, and that is the one worth saying out loud: it lives in
 *  `prefs.search` as Rightmove's own query parameters, which is what the sweep is run with — so a
 *  flat over the hunt's budget did not come home from a sweep in the first place, and one that did
 *  arrived some other way and is a fact rather than a mistake.
 *
 *  The unknown rule still holds, because it is `matchesFilter` that applies this: a flat nobody has
 *  measured is not a small one. */
export function huntFloor(prefs: HuntPreferences): TriageFilter {
  const wants = Object.entries(prefs.amenities ?? {}) as [AmenityKey, AmenityWant | undefined][];
  return {
    ...NO_FILTER,
    minBedrooms: prefs.minBedrooms ?? null,
    minSqft: prefs.minSqft ?? null,
    amenities: wants.filter(([, want]) => want === 'must').map(([key]) => key),
  };
}

/** The pile split by that floor: what the hunt would consider, and what it has already ruled out.
 *
 *  Both halves, never just the first. A filter here removes rows from a screen whose whole job is
 *  that no row goes unlooked-at, so the count of what went is what lets triage say "18 hidden by
 *  your hunt's must-haves" and offer them back — the same bargain `unknowns` strikes above. */
export function splitByHuntFloor(
  entries: ShortlistEntry[],
  prefs: HuntPreferences,
): { above: ShortlistEntry[]; below: ShortlistEntry[] } {
  const floor = huntFloor(prefs);
  if (!filterIsOn(floor)) return { above: entries, below: [] };
  const above: ShortlistEntry[] = [];
  const below: ShortlistEntry[] = [];
  for (const entry of entries) (matchesFilter(entry, floor) ? above : below).push(entry);
  return { above, below };
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
    // Anything but a stored `true` is "don't mind", which is the direction that shows more flats
    // rather than fewer — the same safe failure every field here takes. A filter saved before this
    // field existed reads as off.
    hasFloorplan: source.hasFloorplan === true,
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
    // The nearest station is not one of the project's places and never will be, so it is not
    // something a project can stop having — it survives here on its own terms.
    if (t.placeId === NEAREST_STATION) return t.mode === CROW;
    const place = known.get(t.placeId);
    // And a bar whose place can no longer answer it goes the same way, for the same reason: a
    // postcode removed from a place leaves its transit bars reading `unknown` for every flat in the
    // hunt, so the pile is unfiltered and the control says otherwise. The picker would not offer
    // that combination, but a filter restored from storage was never offered anything.
    return place !== undefined && barModesFor(place).includes(t.mode);
  });
  return travel.length === filter.travel.length ? filter : { ...filter, travel };
}
