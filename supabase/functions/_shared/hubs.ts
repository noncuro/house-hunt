// GENERATED — do not edit. Copied from packages/core/src/ by tools/sync-edge-function.ts.
// Edit the original and run `pnpm sync:function`.

/** The neighbourhoods a project is actually searching, and where a listing sits relative to them.
 *
 *  A postcode tells you nothing about a place you don't already know, and "0.3 miles to Angel
 *  station" tells you how far without telling you which way — the difference between a flat on
 *  the Upper Street side and one across the City Road roundabout. So every listing is fixed
 *  against the nearest of a handful of named hubs: how far, and in which direction from that hub
 *  you would walk to reach it.
 *
 *  **Hubs used to be hardcoded, and are now project data** (`project_hub`, design D11). The old
 *  argument for constants — that they *are* the search, and a table would let the two laptops
 *  disagree about where "Angel" is — held only while there was one search. A second project
 *  hunting in Manchester cannot be shown Hampstead, so the list moved into the database and this
 *  file kept the arithmetic. Nothing here reads a hub list of its own: every function that needs
 *  one is handed one, because the alternative is a default that quietly answers for the wrong
 *  project.
 *
 *  `SEED_HUBS` below is the exception and is not that list. It is a copy of what the migration
 *  seeded, kept for the hand-run development tools and pinned by the checks. No surface reads it.
 *
 *  Coordinates come from TfL's own StopPoint API (`api.tfl.gov.uk/StopPoint/Search/<name>`,
 *  mode `tube`), which is the same source the walking times already use, so a hub and a station
 *  can't end up in two different places. Each one was then reverse-geocoded through postcodes.io
 *  and checked against the ward it landed in — a hub in the wrong place silently rotates every
 *  bearing computed from it, and nothing on screen would look wrong:
 *
 *    Hampstead            NW3 1QE  Hampstead Town, Camden        13m
 *    Belsize Park         NW3 4QS  Belsize, Camden               28m
 *    Angel                EC1V 7JL St Peter's & Canalside, Isl.  12m
 *    Old Street           EC1V 2NR Bunhill, Islington            31m
 *
 *  Old Street is a TfL "hub" record — the whole interchange rather than one ticket hall — which
 *  is what we want here, since the hub stands for the neighbourhood and not for a particular
 *  entrance.
 *
 *  Primrose Hill is the exception, and had to be, because its station closed in 1992 and TfL has
 *  no record of it. It is anchored on the village rather than the park: NW1 8XD on Regent's Park
 *  Road, which postcodes.io puts at 51.54086, -0.15772 in the Primrose Hill ward of Camden. The
 *  park summit would have been the wrong point — it is where you go for the view, not where the
 *  flats and the coffee are, and a hub is only useful if it names somewhere you can picture
 *  standing. Sense check: Belsize Park comes out 0.72 mi NNW, Hampstead 1.36 mi NW.
 *
 *  Highbury & Islington and King's Cross were both hubs briefly and were dropped — the search
 *  moved north-west. Their coordinates are in the git history if they come back. */

import type { Place } from './types.ts';
import type { Point } from './postcode.ts';

export interface Hub {
  name: string;
  lat: number;
  lon: number;
  /** True for a place we only measure against, false for one we search around. It is the tie-break
   *  in `nearestHub`: somewhere this hunt is actually looking always outranks somewhere it merely
   *  commutes to, however much closer the second is. See `hubsFromProject` for why.
   *
   *  It was `fromPlace` while neighbourhoods and places were two tables. They are one now, so the
   *  distinction is what a row *does* rather than which list it came from — which is the honest
   *  version of the same rule. */
  fromPlace?: boolean;
}

/** How a hub is spelled in a Rightmove search URL.
 *
 *  None of these were guessed, and none were lifted from a URL someone had pasted. Each was read
 *  back out of Rightmove's own page: fetch `/property-to-rent/<slug>.html` once and
 *  `__NEXT_DATA__.props.pageProps.searchResults.location` reports the `locationType` and `id`
 *  the site itself resolved that slug to, along with a polygon whose centroid can be checked
 *  against the `lat`/`lon` we already hold. `tools/find-locations.ts` is that lookup
 *  (`pnpm find:locations`), and it
 *  is a development-time thing run once per hub — nothing in the extension resolves a location
 *  at runtime. A wrong identifier here is a sweep that quietly searches a different
 *  neighbourhood and reports no new listings, which is the failure mode that looks like success.
 *
 *  `searchLocation`, the human-readable half of the URL, is not stored: on all five it is the
 *  `displayLocationIdentifier` with the hyphens turned back into spaces. */
export interface RightmoveLocation {
  /** `<locationType>^<id>`, e.g. `STATION^4187`. */
  locationIdentifier: string;
  /** The SEO path segment, e.g. `Hampstead-Station.html`. */
  displayLocationIdentifier: string;
}

/** A hub we sweep Rightmove for: a name to show and the way to ask Rightmove for it.
 *
 *  The two questions `AGENTS.md` keeps apart are now two *readings of one table* rather than two
 *  lists. "What can a listing be near" is `hubsFromProject`, which needs a coordinate and does not
 *  care about an identifier; "what do we go looking through" is `sweepableHubs`, which needs an
 *  identifier and does not care about a coordinate. A row can answer one, both or neither. Read
 *  the one that matches your question, and note that neither is a superset of the other:
 *
 *    - Heathrow as a saved place answers the first and must never answer the second.
 *    - A neighbourhood added by name, whose identifier resolved before anyone typed a postcode,
 *      answers the second and must never answer the first — a bearing from a guessed coordinate
 *      is wrong with nothing on screen looking wrong.
 *
 *  Deliberately *not* an extension of `Hub`: requiring `lat`/`lon` here would force a coordinate
 *  onto a row that has none, which is precisely the defaulting design D15 forbids. */
export interface SweepHub {
  name: string;
  /** Miles to search around. Null is not a default of any kind — it means this place is not a
   *  sweep centre, and `sweepSearchUrl` refuses rather than picking a radius. */
  radiusMiles: number | null;
  /** Null means we could not verify an identifier, and the sweep view is written to say so rather
   *  than build a URL that searches somewhere else. A wrong identifier returns a page full of
   *  plausible flats in the wrong neighbourhood and reports nothing new, which is the failure that
   *  looks exactly like success. */
  rightmove: RightmoveLocation | null;
}

/** A hub as the migration seeded it: a point *and* an identifier, both verified.
 *
 *  Only `SEED_HUBS` has this shape. A row read out of `project_hub` may be missing either half,
 *  which is why the runtime types above do not insist on both. */
export interface SeedHub extends Hub {
  rightmove: RightmoveLocation | null;
  /** One mile, on all five, because that is the radius every sweep URL this project ever built
   *  used. It is a property of a place now (`place.sweep_radius_miles`); here it pins what the
   *  constants meant so `pnpm check:sweep` still compares like with like. */
  radiusMiles: number;
}

/** The original five, as `20260809220000_project_scope.sql` seeded them into the first project.
 *
 *  **This is not the hub list any surface reads.** It is here for two jobs that are not the
 *  extension: the hand-run development lookups (`pnpm find:locations`, `pnpm fixture:search`) that
 *  need a neighbourhood to ask Rightmove about before any database is involved, and the checks,
 *  which pin the bearings and the search URL to fixed points. `pnpm check:sweep` asserts that the
 *  seeded rows resolve to byte-identical search URLs, so a drift between this copy and the
 *  migration is a failing check rather than a sweep of the wrong neighbourhood.
 *
 *  Anything in `src/entrypoints/` or `src/components/` reading this is a bug: it would show
 *  Hampstead to a project searching Manchester. */
export const SEED_HUBS: SeedHub[] = [
  {
    name: 'Hampstead',
    lat: 51.556239,
    lon: -0.177464,
    radiusMiles: 1,
    // This one was supplied by hand; the page confirms it, displayName "Hampstead Station, London".
    rightmove: { locationIdentifier: 'STATION^4187', displayLocationIdentifier: 'Hampstead-Station.html' },
  },
  {
    name: 'Primrose Hill',
    lat: 51.54086,
    lon: -0.15772,
    radiusMiles: 1,
    // A REGION rather than a STATION, for the same reason the coordinate above needed its own
    // source: there has been no Primrose Hill station since 1992, so Rightmove files it as an
    // area. displayName "Primrose Hill, North West London". Its polygon's centroid is 51.53868,
    // -0.15574 — 0.17 miles from the NW1 8XD anchor above, and in the same Camden ward. That is
    // the loosest agreement of the five, and it should be: the other four are checking a station
    // against a circle drawn around that station, whereas this is a village anchor against the
    // centre of a whole neighbourhood polygon.
    rightmove: { locationIdentifier: 'REGION^87390', displayLocationIdentifier: 'Primrose-Hill.html' },
  },
  {
    name: 'Belsize Park',
    lat: 51.550311,
    lon: -0.164648,
    radiusMiles: 1,
    // displayName "Belsize Park Station, London"; polygon centroid 51.55024, -0.16442.
    rightmove: { locationIdentifier: 'STATION^824', displayLocationIdentifier: 'Belsize-Park-Station.html' },
  },
  {
    name: 'Angel',
    lat: 51.531788,
    lon: -0.105919,
    radiusMiles: 1,
    // displayName "Angel Station, London"; polygon centroid 51.53249, -0.10573.
    rightmove: { locationIdentifier: 'STATION^245', displayLocationIdentifier: 'Angel-Station.html' },
  },
  {
    name: 'Old Street',
    lat: 51.526065,
    lon: -0.088193,
    radiusMiles: 1,
    // displayName "Old Street Station, London"; polygon centroid 51.52554, -0.08757.
    rightmove: { locationIdentifier: 'STATION^6881', displayLocationIdentifier: 'Old-Street-Station.html' },
  },
];

/** @deprecated The compile-time hub lists are gone (design D11). No surface reads this any more —
 *  the last two (`src/components/Hub.tsx` and `src/entrypoints/sweep.content/Sweep.tsx`) moved to
 *  project data, and its sibling `HUBS` went with them. What is left is the development tools
 *  `find-locations.ts` and `fixture-search.ts`, which may legitimately keep reading `SEED_HUBS`
 *  under its own name. Delete this once they do. */
export const SWEEP_HUBS: SeedHub[] = SEED_HUBS;

/** The places a listing can be fixed against, from a project's rows.
 *
 *  A row with no coordinate is skipped rather than defaulted. That is not an edge case invented
 *  for the type system: a place saved before postcodes were resolved on entry has none, and a
 *  neighbourhood that was dropped keeps its `hub_sweep` history without its point. Giving one a
 *  plausible coordinate would rotate every bearing computed from it and nothing on screen would
 *  look wrong.
 *
 *  Somewhere the hunt sweeps around outranks somewhere it only measures to — see `Hub.fromPlace`
 *  and `nearestHub`. "0.3 mi NW of Work" tells you how long the commute is and nothing whatever
 *  about where the flat is, and where the flat is, is the entire question the compass answers.
 *
 *  The radius alone is what says which is which, and deliberately not `isSwept`. That answers a
 *  different question — whether a Rightmove URL can safely be built — and wants both halves of an
 *  identifier as well. A place somebody has just ticked a radius onto, whose lookup has not come
 *  back, is a neighbourhood; asked the other question it reads as somewhere we only commute to, and
 *  the compass demotes it for as long as the resolve takes. `sweepableHubs` below already states the
 *  rule this now follows: a radius is the statement of intent. */
export function hubsFromProject(places: Place[]): Hub[] {
  return places.flatMap((p) =>
    p.lat === null || p.lon === null
      ? []
      : [{ name: p.label, lat: p.lat, lon: p.lon, fromPlace: p.sweepRadiusMiles === null }],
  );
}

/** Whether this place is one the hunt goes looking around. Both halves of the identifier and a
 *  radius: a `locationIdentifier` with no SEO path builds a URL missing the parameter Rightmove
 *  echoes into its own search box, and half an identifier is not a verified one. */
export function isSwept(place: Place): boolean {
  return (
    place.locationIdentifier !== null &&
    place.displayLocationIdentifier !== null &&
    place.sweepRadiusMiles !== null
  );
}

/** The places a journey can actually be timed to: the ones with a postcode.
 *
 *  Routing is postcode to postcode (see `TRAVEL_BASIS` in tfl.ts), so a place without one has no
 *  journey — which is the normal state for somewhere the hunt searches around rather than commutes
 *  to, and for every neighbourhood the `places_are_hubs` migration folded in.
 *
 *  It matters that the travel views ask for this rather than iterating every place. They read an
 *  absent row as "no route", which is TfL saying the journey is impossible — so listing a
 *  postcode-less place would put a red "no route to Hampstead" on every listing in the hunt, a
 *  confident claim about a journey nobody asked for. */
export function travelDestinations<T extends { postcode: string | null }>(places: T[]): T[] {
  return places.filter((p) => p.postcode !== null);
}

/** The places a straight line can be drawn to, and where they are.
 *
 *  The complement of the rule above rather than a second copy of it: routing needs a postcode
 *  because that is what TfL is asked with, and measuring on the map needs a coordinate because that
 *  is what a distance is between. A neighbourhood folded in from the old hub list has the second and
 *  not the first, which is why the travel picker stopped offering it and why it can be offered again
 *  for a bar measured in miles. */
export function placePoints(places: Place[]): Record<string, Point> {
  const points: Record<string, Point> = {};
  for (const place of places) {
    if (place.lat !== null && place.lon !== null) points[place.id] = { lat: place.lat, lon: place.lon };
  }
  return points;
}

/** The places a project goes looking through — everywhere somebody has said to search around,
 *  whether or not Rightmove's own name for it has been resolved yet.
 *
 *  A radius is the statement of intent, so a place with one belongs on the sweep list even with no
 *  identifier: that is a place whose resolve has not been run or did not work, and it needs a row
 *  saying so. Filtering on the identifier instead made it vanish between ticking the box and the
 *  lookup coming back — no link, no error, no row, which reads as the tick having done nothing.
 *
 *  `sweepSearchUrl` still refuses to build a URL for it. The list is what to show; the URL is what
 *  is safe to open, and they are different questions. */
export function sweepableHubs(places: Place[]): Place[] {
  return places.filter((p) => p.sweepRadiusMiles !== null || p.locationIdentifier !== null);
}

/** The `SweepHub` a `place` row stands for. `rightmove` is null unless the place is fully
 *  searchable — see `isSwept`. */
export function toSweepHub(place: Place): SweepHub {
  return {
    name: place.label,
    radiusMiles: place.sweepRadiusMiles,
    rightmove: isSwept(place)
      ? {
          locationIdentifier: place.locationIdentifier!,
          displayLocationIdentifier: place.displayLocationIdentifier!,
        }
      : null,
  };
}

/** Past this, naming a hub is worse than saying nothing: a mile and a half from Angel is not
 *  Angel, and printing the name anyway is how a place in Hackney reads as one we were looking
 *  for. The threshold is set at a mile. */
export const HUB_RANGE_MILES = 1;

export const NO_HUB_NEARBY = 'no hub within a mile';

/** Mean Earth radius in miles. Rightmove quotes station distances in miles and we think in
 *  them, so nothing here ever touches kilometres. */
const EARTH_RADIUS_MILES = 3958.7613;

const toRadians = (degrees: number) => (degrees * Math.PI) / 180;
const toDegrees = (radians: number) => (radians * 180) / Math.PI;

/** Great-circle distance. Over the few miles this is ever asked about, a flat-earth approximation
 *  would agree to well under the rounding — haversine is used because it is the formula that is
 *  obviously right, not because the curvature matters at this scale. */
export function distanceMiles(from: Point, to: Point): number {
  const dLat = toRadians(to.lat - from.lat);
  const dLon = toRadians(to.lon - from.lon);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(from.lat)) * Math.cos(toRadians(to.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_MILES * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Initial bearing from one point to another, in degrees clockwise from true north.
 *
 *  The `cos(lat)` term is the whole reason this is not `atan2(dLon, dLat)`: at London's latitude
 *  a degree of longitude is about 62% of a degree of latitude, so the naive version tilts every
 *  east-west bearing towards the pole. It is also exactly the kind of error nobody spots, because
 *  a needle pointing NE instead of ENE still looks like a needle. */
export function initialBearing(from: Point, to: Point): number {
  const lat1 = toRadians(from.lat);
  const lat2 = toRadians(to.lat);
  const dLon = toRadians(to.lon - from.lon);
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return (toDegrees(Math.atan2(y, x)) + 360) % 360;
}

const POINTS = [
  'N', 'NNE', 'NE', 'ENE',
  'E', 'ESE', 'SE', 'SSE',
  'S', 'SSW', 'SW', 'WSW',
  'W', 'WNW', 'NW', 'NNW',
];

/** The bearing as something you can say out loud. Sixteen points rather than eight: within a mile
 *  of a hub, "north-east" covers 45 degrees of arc, which is a different half of the
 *  neighbourhood at each edge. */
export function compassPoint(bearing: number): string {
  const normalised = ((bearing % 360) + 360) % 360;
  return POINTS[Math.round(normalised / 22.5) % 16]!;
}

/** Where a listing sits relative to the hub it belongs to. The bearing runs hub -> listing, which
 *  is the direction you would set off in from the station, not the direction you would look back. */
export interface HubFix {
  hub: Hub;
  miles: number;
  bearing: number;
  compass: string;
}

/** The nearest hub, or null when the listing is outside all of them.
 *
 *  Null is a real answer and the views say so plainly. Falling back to "the closest hub anyway"
 *  would put a name like "Angel" on somewhere two miles into Hackney, and a name is the one part
 *  of this a reader takes at face value. */
export function nearestHub(
  point: Point,
  /** Required, and deliberately not defaulted to any list this file knows. A default here would be
   *  one project's neighbourhoods answering for another's listing, silently. */
  hubs: Hub[],
  rangeMiles: number = HUB_RANGE_MILES,
): HubFix | null {
  const fix = (hub: Hub, miles: number): HubFix => {
    const bearing = initialBearing(hub, point);
    return { hub, miles, bearing, compass: compassPoint(bearing) };
  };

  let named: HubFix | null = null;
  let place: HubFix | null = null;

  for (const hub of hubs) {
    const miles = distanceMiles(hub, point);
    if (miles > rangeMiles) continue;
    const best = hub.fromPlace ? place : named;
    if (best && best.miles <= miles) continue;
    if (hub.fromPlace) place = fix(hub, miles);
    else named = fix(hub, miles);
  }

  // A neighbourhood beats a place outright, even a much nearer one. "0.3 mi NW of Work" tells
  // you how far the commute is and nothing whatever about where the flat is — and where the
  // flat is, is the entire question the compass exists to answer.
  return named ?? place;
}

/** "0.4 mi NE of Angel" — the one sentence both views print.
 *
 *  Standing on top of the station rounds to "0.0 mi", which reads as a missing number rather than
 *  as being there already, so anything inside a tenth of a mile is worded instead of measured. */
export function hubLabel(fix: HubFix): string {
  if (fix.miles < 0.05) return `at ${fix.hub.name}`;
  return `${fix.miles.toFixed(1)} mi ${fix.compass} of ${fix.hub.name}`;
}
