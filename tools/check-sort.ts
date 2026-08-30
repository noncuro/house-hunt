/** The order triage works in.
 *
 *  A sorted pile looks sorted whatever it is sorted by, which is the whole reason this exists. Every
 *  case here is one where a wrong answer is still a plausible-looking list: a flat we have no price
 *  for arriving first under "cheapest", a place sort silently ranking two hundred flats as equally
 *  unmeasured, a model sort applied with no model. None of those look like a bug on screen — they
 *  look like a hunt where the cheap flats happen to be the ones nobody measured.
 *
 *  `sortForTriage` is reached through the web app's own `score.ts`, not through a copy, so the thing
 *  under test is the thing the screen calls. That is why `readTravel` had to stop living in a React
 *  file: a check cannot import the renderer, and a sort that could not be run was a sort nothing
 *  could pin. */
import { placeIdOf, placeSort, sortForTriage, type SortMode } from '../apps/web/src/lib/score';
import type { ShortlistEntry } from '../packages/core/src/db/supabase';
import type { TravelTime } from '../packages/core/src/types';

let failures = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) return console.log(`  ok   ${name}`);
  failures++;
  console.log(`  FAIL ${name}\n       expected ${e}\n       got      ${a}`);
}

/** Only the fields a sort reads. Everything else on a shortlist row is irrelevant here and saying
 *  so is the point — a sort that started reading something else would stop compiling. */
function flat(id: string, fields: Partial<ShortlistEntry> = {}): ShortlistEntry {
  return {
    rightmoveId: id,
    postcode: `${id} 1AA`,
    price: null,
    bedrooms: null,
    floorAreaSqft: null,
    floorAreaSource: null,
    nearestStations: [],
    analysis: null,
    ...fields,
  } as ShortlistEntry;
}

const order = (entries: ShortlistEntry[], mode: SortMode, travel?: Record<string, TravelTime[]>) =>
  sortForTriage(entries, null, mode, travel).map((e) => e.rightmoveId);

function journey(placeId: string, seconds: number, mode: TravelTime['mode'] = 'transit'): TravelTime {
  return { placeId, mode, seconds, error: null, transient: false } as TravelTime;
}

// --------------------------------------------------------------------------------------------- //
console.log('the sort leaves the pile alone when it cannot rank it');

check('default never reorders', order([flat('c'), flat('a'), flat('b')], 'default'), ['c', 'a', 'b']);
check(
  'a model sort with no model leaves the order it was given',
  order([flat('c'), flat('a')], 'yes'),
  ['c', 'a'],
);
// Not the same as ranking everything as unmeasured, which is what reading an absent cache as an
// empty one would do — that answer reorders the pile against a number nobody has, and looks
// identical on screen to a sort that worked.
check(
  'a place sort with no travel cache at all leaves the order it was given',
  order([flat('c'), flat('a')], placeSort('work')),
  ['c', 'a'],
);

// --------------------------------------------------------------------------------------------- //
console.log('\nand what it cannot measure sinks, whichever end you asked for');

check(
  'no price is not the cheapest',
  order([flat('none'), flat('dear', { price: '£3,000 pcm' }), flat('cheap', { price: '£1,000 pcm' })], 'cheapest'),
  ['cheap', 'dear', 'none'],
);
// `floorAreaSource` as well as the number, because `resolveSize` refuses a figure with no
// provenance — a size with nothing saying where it came from is not a size this app will show.
const sized = (id: string, sqft: number) =>
  flat(id, { floorAreaSqft: sqft, floorAreaSource: 'sizings' });
check(
  'no floor area is not the biggest',
  order([flat('none'), sized('small', 400), sized('big', 900)], 'biggest'),
  ['big', 'small', 'none'],
);
// The unit travels with the number: `nearestStationMiles` converts kilometres and refuses a
// distance with no unit at all, so a fixture that omitted it would be measuring nothing.
const atStation = (id: string, distance: number, unit = 'miles') =>
  flat(id, { nearestStations: [{ name: 'A station', types: ['LONDON_UNDERGROUND'], distance, unit }] });
check(
  'a flat with no stations listed is not the nearest to one',
  order([flat('none'), atStation('far', 1.4), atStation('near', 0.2)], 'station'),
  ['near', 'far', 'none'],
);
check(
  'kilometres are compared against miles rather than as though they were miles',
  order([atStation('mi', 0.9), atStation('km', 1.2, 'km')], 'station'),
  ['km', 'mi'],
);

// --------------------------------------------------------------------------------------------- //
console.log('\nand a place sort orders by the journey the screen shows');

const cache: Record<string, TravelTime[]> = {
  'near 1AA': [journey('work', 600)],
  'far 1AA': [journey('work', 2400)],
  // Two places, and the sort must read the one it was asked for. A flat twenty minutes from the
  // park and two hours from work sorts by work when work is the question — reading whichever row
  // came back first would put it at the top and look entirely reasonable.
  'mixed 1AA': [journey('park', 1200), journey('work', 7200)],
  // Rows for another place only: this flat has no journey to work at all, which is not a journey of
  // zero seconds.
  'other 1AA': [journey('park', 60)],
};
check(
  'quickest to a place, with a flat measured only to somewhere else sinking',
  order([flat('mixed'), flat('other'), flat('far'), flat('near')], placeSort('work'), cache),
  ['near', 'far', 'mixed', 'other'],
);

// A walk of over an hour is not a way of getting anywhere — `readTravel` discards it, and the sort
// has to agree, because the compare table's column and the card's caption already do. A sort that
// ranked this flat as a 70-minute journey would put it above a genuine 80-minute train while every
// other surface showed it as having no route at all.
const walking: Record<string, TravelTime[]> = {
  'walk 1AA': [journey('work', 70 * 60, 'walking')],
  'train 1AA': [journey('work', 80 * 60)],
};
check(
  'an unrealistic walk is not a journey, here as everywhere else',
  order([flat('walk'), flat('train')], placeSort('work'), walking),
  ['train', 'walk'],
);

// A row `staleTravel` marked is still ranked on its number, and the screen says so on the row
// rather than the sort hiding it. Pinned because the opposite is the tempting fix and it is wrong
// in a way nothing would show: sinking these would push the flats measured longest ago to the
// bottom of a pile that exists to be worked through, which is the objection AGENTS.md already
// makes to a filter dropping a flat for a number we do not have. `cachedTravelTimes` says
// "Marked, not dropped" about the same rows for the same reason. The disclosure is Triage's
// `sortedBy` line, which appends "not comparable, open to refresh".
const stale: Record<string, TravelTime[]> = {
  'old 1AA': [{ ...journey('work', 10 * 60), stale: 'measured on basis "unknown", not "weekday-am"' }],
  'new 1AA': [journey('work', 20 * 60)],
};
check(
  'a stale journey ranks on its number rather than sinking',
  order([flat('new'), flat('old')], placeSort('work'), stale),
  ['old', 'new'],
);

// --------------------------------------------------------------------------------------------- //
console.log('\nand the place a mode names survives a round trip');

check('placeIdOf reads back what placeSort wrote', placeIdOf(placeSort('a-place-id')), 'a-place-id');
// The ids are uuids in production and a fixed union would have been wrong; what must not happen is
// a fixed mode being read as a place because its name happens to contain the separator.
check('a fixed sort names no place', placeIdOf('cheapest'), null);
check('a place id containing a colon survives', placeIdOf(placeSort('a:b')), 'a:b');

// --------------------------------------------------------------------------------------------- //
console.log(failures === 0 ? '\nall good' : `\n${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
