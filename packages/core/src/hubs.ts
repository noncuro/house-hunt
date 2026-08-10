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

import type { ProjectHub } from './contracts';
import type { Point } from './postcode';

export interface Hub {
  name: string;
  lat: number;
  lon: number;
  /** True for a hub derived from a saved place rather than from the search itself. It is the
   *  tie-break in `nearestHub`: a real neighbourhood always outranks a place, however much closer
   *  the place is. See `hubsWithPlaces` for why. */
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
    // This one was supplied by hand; the page confirms it, displayName "Hampstead Station, London".
    rightmove: { locationIdentifier: 'STATION^4187', displayLocationIdentifier: 'Hampstead-Station.html' },
  },
  {
    name: 'Primrose Hill',
    lat: 51.54086,
    lon: -0.15772,
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
    // displayName "Belsize Park Station, London"; polygon centroid 51.55024, -0.16442.
    rightmove: { locationIdentifier: 'STATION^824', displayLocationIdentifier: 'Belsize-Park-Station.html' },
  },
  {
    name: 'Angel',
    lat: 51.531788,
    lon: -0.105919,
    // displayName "Angel Station, London"; polygon centroid 51.53249, -0.10573.
    rightmove: { locationIdentifier: 'STATION^245', displayLocationIdentifier: 'Angel-Station.html' },
  },
  {
    name: 'Old Street',
    lat: 51.526065,
    lon: -0.088193,
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

/** The hubs a listing can be *near*, from a project's rows.
 *
 *  A row with no coordinate is skipped rather than defaulted. That is not an edge case invented
 *  for the type system: King's Cross and Highbury & Islington were hubs, were dropped, and the
 *  migration deliberately keeps coordinate-less rows for them so their real `hub_sweep` history is
 *  not thrown away. Giving one a plausible point would rotate every bearing computed from it and
 *  nothing on screen would look wrong — the same rule `hubsWithPlaces` already applies to a place
 *  whose postcode was never resolved. */
export function hubsFromProject(hubs: ProjectHub[]): Hub[] {
  return hubs.flatMap((h) => (h.lat === null || h.lon === null ? [] : [{ name: h.name, lat: h.lat, lon: h.lon }]));
}

/** The hubs a project can *go looking through*: the ones carrying a Rightmove location identifier.
 *
 *  A hub with no identifier is not a broken hub, it is a hub that only names things, so it is left
 *  out here rather than shown as a dead link. The sweep view still lists it, and says why. */
export function sweepableHubs(hubs: ProjectHub[]): ProjectHub[] {
  return hubs.filter((h) => h.locationIdentifier !== null);
}

/** The `SweepHub` a `project_hub` row stands for. `rightmove` is null unless *both* halves of the
 *  identifier are present: a `locationIdentifier` with no SEO path would build a URL missing the
 *  parameter Rightmove echoes back into its own search box, and half an identifier is not a
 *  verified one. */
export function toSweepHub(hub: ProjectHub): SweepHub {
  const verified = hub.locationIdentifier !== null && hub.displayLocationIdentifier !== null;
  return {
    name: hub.name,
    rightmove: verified
      ? {
          locationIdentifier: hub.locationIdentifier!,
          displayLocationIdentifier: hub.displayLocationIdentifier!,
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

/** Saved places count as hubs too.
 *
 *  The answer to "should Work be a hub?" was yes, and it is obviously right: "0.2 mi N of
 *  Work" fixes a flat better than "0.6 mi E of Old Street" ever could, because the office is a
 *  place you have stood in and the station is one you have passed through. Anything already worth
 *  measuring travel time to is a landmark you can picture.
 *
 *  A place never displaces a neighbourhood, though, which is a correction to how this first
 *  shipped. Nearest-wins put "0.3 mi NW of Work" on a flat that a Chrome audit then could not
 *  place on a map at all: the office is somewhere you have stood, but it is not somewhere the
 *  flat *is*, and the name is the one part of the label a reader takes at face value. So a named
 *  hub inside the range always wins, and a place answers only when no hub does — which is exactly
 *  the case the places were added for, a flat near the office and near nothing we are searching.
 *  Places outside the range — Heathrow, the in-laws — never win at all, and cost one distance
 *  calculation to rule out.
 *
 *  A place with no resolved coordinates is skipped rather than guessed at: `addPlace` resolves the
 *  postcode on the way in, but rows saved before that did not, and a hub in the wrong location
 *  rotates every bearing computed from it with nothing on screen looking wrong.
 *
 *  `hubs` is the project's neighbourhoods, already filtered by `hubsFromProject`. It defaults to
 *  empty rather than to any list this file holds: an omitted list costs you the neighbourhood
 *  names, which is visible on every card at once, whereas a defaulted one would put another
 *  project's neighbourhood on your flat and read as a fact. */
export function hubsWithPlaces(
  places: Array<{ label: string; lat: number | null; lon: number | null }>,
  hubs: Hub[] = [],
): Hub[] {
  const fromPlaces = places.flatMap((p) =>
    p.lat === null || p.lon === null ? [] : [{ name: p.label, lat: p.lat, lon: p.lon, fromPlace: true }],
  );
  return [...hubs, ...fromPlaces];
}
