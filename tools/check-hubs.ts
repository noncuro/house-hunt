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
  initialBearing,
  locationLookupFor,
  nearestHub,
} from '../packages/core/src/hubs';
import type { Place } from '../packages/core/src/types';

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
console.log('hubsFromProject — one list, two jobs');
// Places and neighbourhoods are one table now. The tie-break survives as what a row *does*: a place
// the hunt searches around beats one it only measures to. Duncan Terrace is 0.24 mi from Angel, so
// even an office on the same street loses — "0.3 mi NW of Work" says how far the commute is and
// nothing about where the flat is.
const place = (over: Partial<Place>): Place => ({
  id: over.label ?? 'id',
  label: 'Somewhere',
  postcode: null,
  lat: null,
  lon: null,
  locationIdentifier: null,
  displayLocationIdentifier: null,
  sweepRadiusMiles: null,
  maxDaysSinceAdded: null,
  ...over,
});

/** A place the hunt sweeps around: both halves of the identifier and a radius. */
const swept = (over: Partial<Place>): Place =>
  place({
    locationIdentifier: 'STATION^1',
    displayLocationIdentifier: 'Somewhere.html',
    sweepRadiusMiles: 1,
    ...over,
  });

const SEARCHED = SEED_HUBS.map((h) => swept({ label: h.name, lat: h.lat, lon: h.lon }));

const nearbyOffice = place({ label: 'Work', lat: 51.535, lon: -0.1045 });
check(
  'a nearer destination still loses to somewhere we search',
  nearestHub(duncanTerrace, hubsFromProject([...SEARCHED, nearbyOffice]))?.hub.name,
  'Angel',
);

// The case destinations were added for: somewhere near the office and near nothing we are searching.
// Marylebone is over a mile from all five, so without the office there is no answer at all.
const marylebone = { lat: 51.5185, lon: -0.1515 };
check('with nothing searched in range, there is no fix', nearestHub(marylebone, FIVE)?.hub.name, undefined);
const officeInTown = place({ label: 'Work', lat: 51.5165, lon: -0.1445 });
check(
  'a destination answers when nothing searched does',
  nearestHub(marylebone, hubsFromProject([...SEARCHED, officeInTown]))?.hub.name,
  'Work',
);
// ...and a distant one never does, however much we care about it.
const heathrow = place({ label: 'Heathrow', lat: 51.4706, lon: -0.4619 });
check(
  'a far-off destination does not displace anything',
  nearestHub(duncanTerrace, hubsFromProject([...SEARCHED, heathrow]))?.hub.name,
  'Angel',
);
// The window between ticking "search around" and the lookup coming back. A radius is the statement
// of intent, so it is a neighbourhood from that moment — asked `isSwept` instead it would read as
// somewhere we only commute to, and the compass would demote it for as long as the resolve took.
const justTicked = place({ label: 'Freshly ticked', lat: 51.535, lon: -0.1045, sweepRadiusMiles: 1 });
check(
  'a place with a radius but no identifier yet is a neighbourhood',
  hubsFromProject([justTicked])[0]?.fromPlace,
  false,
);
check(
  'and one with an identifier but no radius is somewhere we only travel to',
  hubsFromProject([
    place({ label: 'Work', lat: 51.535, lon: -0.1045, locationIdentifier: 'STATION^1', displayLocationIdentifier: 'w.html' }),
  ])[0]?.fromPlace,
  true,
);
// A place saved before addPlace resolved postcodes has no coordinates, and so does a neighbourhood
// that was dropped but kept for its sweep history. Guessing a point would rotate every bearing
// computed from it with nothing on screen looking wrong, which is the failure this file exists to
// catch.
check(
  'a place with no coordinates is skipped, not guessed at',
  hubsFromProject([...SEARCHED, place({ label: 'Nowhere' })]).length,
  SEARCHED.length,
);

const projectRows = [
  ...SEARCHED,
  // The real shape of the dropped hubs: a name, sweep history, and no place on the map.
  swept({ label: "King's Cross" }),
  swept({ label: 'Highbury & Islington' }),
];

check('the five searched rows come back', hubsFromProject(projectRows).length, 5);
check(
  'one with no coordinates is skipped, not placed',
  hubsFromProject(projectRows).map((h) => h.name).includes("King's Cross"),
  false,
);
check(
  'and the coordinates that do come back are the seeded ones, unrounded',
  hubsFromProject(projectRows).find((h) => h.name === 'Angel'),
  { name: 'Angel', lat: ANGEL.lat, lon: ANGEL.lon, fromPlace: false },
);
// The same fix, computed from database rows rather than from the constant. If these two ever
// disagree, every bearing in the extension moved and nothing said so.
check(
  'a fix from project rows is the fix from the constant',
  nearestHub(duncanTerrace, hubsFromProject(projectRows))?.hub.name,
  nearestHub(duncanTerrace, FIVE)?.hub.name,
);
// Nothing at all is a real state — a new project before it has added anywhere — and it must answer
// "nothing nearby", not throw and not fall back to somebody else's London.
check('a project with no places places nothing', nearestHub(duncanTerrace, hubsFromProject([])), null);
check(
  'and a lone destination still answers',
  nearestHub(duncanTerrace, hubsFromProject([nearbyOffice]))?.hub.name,
  'Work',
);

// What gets sent to Rightmove when somebody looks up the area to sweep around a place.
//
// This is the quietly-wrong computation the whole file exists for, in its purest form: every answer
// below is a plausible string, and the wrong one comes back from Rightmove as a real identifier for
// a real town with real flats in it. "Work" resolves to REGION^1486, Worksop, 130 miles from the
// EC1V office it names — a sweep that looks like it worked.
console.log('\nwhat Rightmove is asked about a place');
check(
  'a place with a postcode is looked up by the postcode, never by its nickname',
  locationLookupFor(place({ label: 'Work', postcode: 'EC1V 1JN' })),
  'EC1V 1JN',
);
check(
  'a place with no postcode falls back to the label, which is all there is',
  locationLookupFor(place({ label: 'Hampstead', postcode: null })),
  'Hampstead',
);
// The `postcode` column takes coordinates pasted from Google Maps as well as postcodes. Rightmove
// can do nothing with a pair of decimals, and `toSlug` would hand it `51-5283--0-0913` — which is
// not a 404, it is whatever that fuzzy-matches to.
check(
  'a pasted lat,lon is not a postcode, so the label is asked instead',
  locationLookupFor(place({ label: 'The gym', postcode: '51.5283, -0.09131' })),
  'The gym',
);
check(
  'a negative lat,lon with no spaces is caught too',
  locationLookupFor(place({ label: 'Airbnb', postcode: '-33.8688,151.2093' })),
  'Airbnb',
);
// A postcode is not rejected for looking unusual: Rightmove is the judge of what it knows, and
// this must not become a second, stricter opinion about what a UK postcode is.
check(
  'an outcode on its own is still a postcode and still asked',
  locationLookupFor(place({ label: 'Somewhere', postcode: 'EC1V' })),
  'EC1V',
);

if (failures > 0) { console.error(`\n${failures} failing`); process.exit(1); }
console.log('\nall ok');
