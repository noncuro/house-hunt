/** Cases for the hub fix: how far a listing is from a neighbourhood, and which way.
 *
 *  Bearings and distances are the archetypal quietly-wrong computation — a needle 30 degrees out
 *  still looks like a needle, and a mile reported as 0.6 still looks like a number. So the pairs
 *  here are real ones with an answer you can check against a map: Belsize Park really is
 *  southeast of Hampstead, and Angel really is a little under a mile east-southeast of nothing
 *  else in the list but Old Street. */
import {
  SEED_HUBS,
  compassPoint,
  distanceMiles,
  hubLabel,
  hubsFromProject,
  hubsWithPlaces,
  initialBearing,
  nearestHub,
} from '../src/lib/hubs';
import type { ProjectHub } from '../src/lib/messages';

let failures = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) return console.log(`  ok   ${name}`);
  failures++;
  console.log(`  FAIL ${name}\n       expected ${e}\n       got      ${a}`);
}

/** Distances and bearings are floats, so they are checked to the precision anything is shown at:
 *  a tenth of a mile, and a tenth of a degree. */
function near(name: string, actual: number, expected: number, tolerance: number) {
  if (Math.abs(actual - expected) <= tolerance) return console.log(`  ok   ${name}`);
  failures++;
  console.log(`  FAIL ${name}\n       expected ${expected} ±${tolerance}\n       got      ${actual}`);
}

/** The five come from `SEED_HUBS` rather than from a list this file writes down, because the whole
 *  point of these cases is that the coordinates are the *real* ones. Hubs are project rows now
 *  (design D11), so every call below passes its hub list explicitly — there is no default any more,
 *  deliberately: a default would be one project's neighbourhoods answering for another's listing. */
const hub = (name: string) => {
  const found = SEED_HUBS.find((h) => h.name === name);
  if (!found) throw new Error(`no hub called ${name} — the seed list changed`);
  return found;
};

/** `SEED_HUBS` as the plain `Hub[]` every fix is computed against. */
const FIVE = SEED_HUBS.map((h) => ({ name: h.name, lat: h.lat, lon: h.lon }));

const HAMPSTEAD = hub('Hampstead');
const BELSIZE = hub('Belsize Park');
const PRIMROSE = hub('Primrose Hill');
const ANGEL = hub('Angel');
const OLD_STREET = hub('Old Street');

/** Highbury & Islington was a hub and was dropped when the search moved north-west. It stays here
 *  as a fixed point two-thirds of a mile north of Angel, because the range boundary is the most
 *  valuable case in this file and it happens to sit almost exactly on it. */
const HIGHBURY = { lat: 51.546269, lon: -0.103538 };

console.log('distanceMiles');
// Two stops on the Northern line, and about a fifteen-minute walk.
near('Hampstead to Belsize Park', distanceMiles(HAMPSTEAD, BELSIZE), 0.69, 0.02);
near('Angel to Old Street', distanceMiles(ANGEL, OLD_STREET), 0.86, 0.02);
// Primrose Hill has no station of its own, so it is anchored on the village. These two numbers
// are the check that it landed in the right place rather than on the park summit or in Chalk Farm.
near('Primrose Hill to Belsize Park', distanceMiles(PRIMROSE, BELSIZE), 0.72, 0.02);
near('Primrose Hill to Hampstead', distanceMiles(PRIMROSE, HAMPSTEAD), 1.36, 0.02);
check('a point is no distance from itself', distanceMiles(ANGEL, ANGEL), 0);

console.log('initialBearing');
// Belsize Park is downhill and southeast of Hampstead; the reverse must not read the same way,
// which is the mistake a symmetric distance function invites.
near('Belsize Park is SE of Hampstead', initialBearing(HAMPSTEAD, BELSIZE), 126.6, 0.5);
near('Hampstead is NW of Belsize Park', initialBearing(BELSIZE, HAMPSTEAD), 306.7, 0.5);
near('Old Street is ESE of Angel', initialBearing(ANGEL, OLD_STREET), 117.4, 0.5);
near('Highbury is due north of Angel', initialBearing(ANGEL, HIGHBURY), 5.8, 0.5);
// Belsize Park is up and to the left of Primrose Hill, not straight up — the reverse of the
// Hampstead pair above, and a second check that the village anchor is where it should be.
near('Belsize Park is NNW of Primrose Hill', initialBearing(PRIMROSE, BELSIZE), 335.5, 0.5);
// The cos(latitude) term, isolated: equal deltas in degrees are not equal deltas on the ground.
// Without it this would come back as a flat 45.
near(
  'equal lat/lon deltas do not read as 45 degrees',
  initialBearing(ANGEL, { lat: ANGEL.lat + 0.01, lon: ANGEL.lon + 0.01 }),
  31.9,
  0.5,
);

console.log('compassPoint');
check('north', compassPoint(0), 'N');
check('rounds up into the next point', compassPoint(11.3), 'NNE');
check('east', compassPoint(90), 'E');
check('southwest', compassPoint(225), 'SW');
check('wraps back round to north', compassPoint(359), 'N');
check('a negative bearing is still a bearing', compassPoint(-10), 'N');

console.log('nearestHub');
// Duncan Terrace, a couple of minutes up from Angel station.
const duncanTerrace = { lat: 51.535236, lon: -0.104594 };
const atAngel = nearestHub(duncanTerrace, FIVE);
check('picks Angel over Old Street, which is further', atAngel?.hub.name, 'Angel');
near('and says how far', atAngel?.miles ?? -1, 0.24, 0.02);
check('and which way from the station', atAngel?.compass, 'NNE');
check('read as one sentence', atAngel ? hubLabel(atAngel) : null, '0.2 mi NNE of Angel');

// Hackney Central is two miles from Old Street. Naming it anyway is exactly the failure the
// range is there to prevent — it is not a neighbourhood we are searching.
check('nothing within a mile is nothing', nearestHub({ lat: 51.547, lon: -0.0558 }, FIVE), null);
check('and Clapham Junction is not any of them', nearestHub({ lat: 51.4643, lon: -0.1705 }, FIVE), null);

// Highbury & Islington is 1.01 miles from Angel — just outside. The boundary is a real case and
// not a hypothetical one, so it is pinned here rather than assumed. It is also the argument for
// widening the range if a flat between the two ever reads "no hub within a mile".
check(
  'a hub 1.01 miles away is out of range',
  nearestHub({ lat: HIGHBURY.lat, lon: HIGHBURY.lon }, [ANGEL]),
  null,
);
check(
  'and is in range once the range is widened',
  nearestHub({ lat: HIGHBURY.lat, lon: HIGHBURY.lon }, [ANGEL], 1.5)?.compass,
  'N',
);

console.log('hubLabel');
check('standing on the station is not "0.0 mi"', hubLabel(nearestHub(ANGEL, FIVE)!), 'at Angel');
check(
  'a walk away is measured',
  hubLabel(nearestHub({ lat: OLD_STREET.lat + 0.004, lon: OLD_STREET.lon }, FIVE)!),
  '0.3 mi N of Old Street',
);
console.log('hubsWithPlaces');
// A saved place answers where a neighbourhood cannot, and never where one can. Duncan Terrace is
// 0.24 mi from Angel, so even an office on the same street loses: "0.3 mi NW of Work" says how
// far the commute is and nothing about where the flat is.
const nearbyOffice = { label: 'Work', lat: 51.535, lon: -0.1045 };
const withWork = nearestHub(duncanTerrace, hubsWithPlaces([nearbyOffice], FIVE));
check('a nearer saved place still loses to a neighbourhood', withWork?.hub.name, 'Angel');

// The case places were added for: somewhere near the office and near nothing we are searching.
// Marylebone is over a mile from all five hubs, so without the place there is no answer at all.
const marylebone = { lat: 51.5185, lon: -0.1515 };
check('with no hub in range, the label is the hub-less one', nearestHub(marylebone, FIVE)?.hub.name, undefined);
const officeInTown = { label: 'Work', lat: 51.5165, lon: -0.1445 };
check(
  'a place answers when no neighbourhood does',
  nearestHub(marylebone, hubsWithPlaces([officeInTown], FIVE))?.hub.name,
  'Work',
);
// ...and a distant one never does, however much we care about it.
const heathrow = { label: 'Heathrow', lat: 51.4706, lon: -0.4619 };
check(
  'a far-off place does not displace anything',
  nearestHub(duncanTerrace, hubsWithPlaces([heathrow], FIVE))?.hub.name,
  'Angel',
);
// A place saved before addPlace resolved postcodes has no coordinates. Guessing would rotate
// every bearing computed from it with nothing on screen looking wrong.
check(
  'a place with no coordinates is skipped, not guessed at',
  hubsWithPlaces([{ label: 'Nowhere', lat: null, lon: null }], FIVE).length,
  FIVE.length,
);


console.log('hubsFromProject');
// Hubs are `project_hub` rows now, and two of the rows the migration keeps have no coordinates:
// King's Cross and Highbury & Islington were hubs, were dropped, and their hub_sweep history is
// carried by a coordinate-less row rather than deleted. Defaulting a point onto one of those would
// rotate every bearing computed from it and nothing on screen would look wrong, which is the
// failure this file exists to catch.
const row = (over: Partial<ProjectHub>): ProjectHub => ({
  id: over.name ?? 'id',
  name: 'Somewhere',
  lat: null,
  lon: null,
  locationIdentifier: null,
  displayLocationIdentifier: null,
  maxDaysSinceAdded: null,
  sortOrder: 0,
  ...over,
});

const projectRows = [
  ...SEED_HUBS.map((h) => row({ name: h.name, lat: h.lat, lon: h.lon })),
  // The real shape of the dropped hubs: a name, sweep history, and no place on the map.
  row({ name: "King's Cross" }),
  row({ name: 'Highbury & Islington' }),
];

check('the five seeded rows come back as hubs', hubsFromProject(projectRows).length, 5);
check(
  'a hub with no coordinates is skipped, not placed',
  hubsFromProject(projectRows).map((h) => h.name).includes("King's Cross"),
  false,
);
check(
  'and the coordinates that do come back are the seeded ones, unrounded',
  hubsFromProject(projectRows).find((h) => h.name === 'Angel'),
  { name: 'Angel', lat: ANGEL.lat, lon: ANGEL.lon },
);
// The same fix, computed from database rows rather than from the constant. If these two ever
// disagree, every bearing in the extension moved and nothing said so.
check(
  'a fix from project rows is the fix from the constant',
  nearestHub(duncanTerrace, hubsFromProject(projectRows)),
  nearestHub(duncanTerrace, FIVE),
);
// Nothing at all is a real state — a new project before it has added a neighbourhood — and it must
// answer "no hub", not throw and not fall back to somebody else's London.
check('a project with no hubs places nothing', nearestHub(duncanTerrace, hubsFromProject([])), null);
check('and its saved places still answer', nearestHub(duncanTerrace, hubsWithPlaces([nearbyOffice], []))?.hub.name, 'Work');

if (failures > 0) { console.error(`\n${failures} failing`); process.exit(1); }
console.log('\nall ok');
