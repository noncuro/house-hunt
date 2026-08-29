/** Cases for what a cached travel time means and when it stops meaning it.
 *
 *  This is the file that decides whether to believe a number already in the database, so getting
 *  it wrong is silent in both directions: too strict and every page load re-asks TfL for
 *  everything, too loose and a commute measured at midnight during engineering works is shown
 *  forever as the answer. Neither looks like a bug on screen.
 *
 *  It also pins the one fact about travel that is stated twice: the set of modes we route, written
 *  once as `TRAVEL_MODES` and once as an `array[...]` inside `travel_gaps`, with no way to share a
 *  constant across the SQL boundary. The backfill's runtime check can only catch half of a
 *  divergence — it sees the modes a run happens to return, and a mode with no outstanding gaps
 *  legitimately returns nothing — so a mode added here and forgotten in the migration is never
 *  backfilled, forever, with every check green. Comparing the two texts is the only way to see it. */
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { NO_ROUTE_RETRY_DAYS, TRAVEL_BASIS, nextWeekdayMorning, staleTravel, stationCore, stationMatches, tooFarToWalk } from '../packages/core/src/tfl';
import { distanceMiles } from '../packages/core/src/hubs';
import { TRAVEL_MODES, WALKING_LIMIT_MILES, WALKING_LIMIT_SECONDS } from '../packages/core/src/types';

let failures = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) return console.log(`  ok   ${name}`);
  failures++;
  console.log(`  FAIL ${name}\n       expected ${e}\n       got      ${a}`);
}

function usable(name: string, actual: string | null) {
  if (actual === null) return console.log(`  ok   ${name}`);
  failures++;
  console.log(`  FAIL ${name}\n       expected the row to be usable\n       got      "${actual}"`);
}

function refetched(name: string, actual: string | null) {
  if (actual !== null) return console.log(`  ok   ${name} (${actual})`);
  failures++;
  console.log(`  FAIL ${name}\n       expected a reason to refetch, got none`);
}

function asked(name: string, actual: string | null) {
  if (actual === null) return console.log(`  ok   ${name}`);
  failures++;
  console.log(`  FAIL ${name}\n       expected the leg to be asked\n       got a refusal: "${actual}"`);
}

function refused(name: string, actual: string | null) {
  if (actual !== null) return console.log(`  ok   ${name} (${actual})`);
  failures++;
  console.log(`  FAIL ${name}\n       expected a refusal, got none`);
}

const NOW = new Date('2026-08-09T12:00:00Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000).toISOString();

const row = (over: Partial<Parameters<typeof staleTravel>[0]> = {}) => ({
  basis: TRAVEL_BASIS.transit,
  noRoute: false,
  options: [{ minutes: 20 }],
  computedAt: daysAgo(1),
  ...over,
});

console.log('nextWeekdayMorning');
// A Wednesday at 08:00 — nine o'clock has not happened yet, so it is today.
check('before nine on a weekday is today', nextWeekdayMorning(new Date('2026-08-12T08:00:00')), {
  date: '20260812',
  time: '0900',
});
// The same Wednesday at 10:00. TfL will not plan a journey in the past, so it has to roll forward.
check('after nine rolls to tomorrow', nextWeekdayMorning(new Date('2026-08-12T10:00:00')), {
  date: '20260813',
  time: '0900',
});
// Friday afternoon: Saturday and Sunday are both skipped. This is the case that matters, because
// a weekend timetable is a materially different journey and it is when house-hunting happens.
check('friday afternoon skips the weekend', nextWeekdayMorning(new Date('2026-08-14T15:00:00')), {
  date: '20260817',
  time: '0900',
});
check('saturday skips to monday', nextWeekdayMorning(new Date('2026-08-15T08:00:00')), {
  date: '20260817',
  time: '0900',
});
check('sunday skips to monday', nextWeekdayMorning(new Date('2026-08-16T08:00:00')), {
  date: '20260817',
  time: '0900',
});
// Exactly nine is "not in the future", so it must roll forward rather than ask TfL to plan a
// journey departing at the very instant of the request.
check('exactly nine rolls forward', nextWeekdayMorning(new Date('2026-08-12T09:00:00')), {
  date: '20260813',
  time: '0900',
});

console.log('staleTravel');
usable('a current transit row is used', staleTravel(row(), 'transit', NOW));
// Every row written before basis tracking. All 63 transit rows in the database were like this,
// and each corrects itself on the next visit — which is the whole point of storing the basis
// rather than running a migration.
refetched(
  'a row with no basis is refetched',
  staleTravel(row({ basis: null }), 'transit', NOW),
);
refetched(
  'a row measured on a different basis is refetched',
  staleTravel(row({ basis: 'weekday-1800' }), 'transit', NOW),
);
// Walking does not depend on the timetable, so it must NOT be invalidated when the transit basis
// changes. Getting this wrong would triple the cost of every basis change for no gain.
usable('a walking row is unaffected by the transit basis', staleTravel(
  { basis: TRAVEL_BASIS.walking, noRoute: false, computedAt: daysAgo(200) },
  'walking',
  NOW,
));
// A transit row from before the leg breakdown was stored has a duration and no route, and a hit
// is never revisited — so the hover showing which lines you ride stayed empty forever.
refetched(
  'a transit row with no legs is refetched',
  staleTravel(row({ options: undefined }), 'transit', NOW),
);
// ...but a no-route row legitimately has no legs, and re-asking it every load is exactly the
// expensive failure the negative cache exists to prevent.
usable(
  'a recent no-route row is not refetched for missing legs',
  staleTravel(row({ noRoute: true, options: undefined }), 'transit', NOW),
);
// Negatives are the one cached answer that can become false with nothing about the flat changing.
refetched(
  'an old no-route row is re-asked',
  staleTravel(
    row({ noRoute: true, options: undefined, computedAt: daysAgo(NO_ROUTE_RETRY_DAYS + 1) }),
    'transit',
    NOW,
  ),
);
usable(
  'a no-route row just inside the window is kept',
  staleTravel(
    row({ noRoute: true, options: undefined, computedAt: daysAgo(NO_ROUTE_RETRY_DAYS - 1) }),
    'transit',
    NOW,
  ),
);
// An unparseable timestamp gives NaN, and every comparison against NaN is false. Wrong in the
// cheap direction on purpose: the row is kept rather than refetched on every single load.
usable(
  'an unreadable timestamp keeps the row rather than thrashing',
  staleTravel(row({ noRoute: true, options: undefined, computedAt: 'not a date' }), 'transit', NOW),
);

console.log('tooFarToWalk');
/* The one refusal in this system that is made without asking anybody.
 *
 * A straight line is a lower bound on any real route, so refusing on it is a claim about *every*
 * walk between the two points — and it is allowed to be wrong in one direction only. Refusing a
 * walk TfL would also have called over the hour costs nothing, because every view draws an
 * over-the-hour walk as a dash whatever number comes back; refusing one TfL would have called
 * under it hides a trip somebody could actually make, which is this idea's own failure mode
 * inverted and looks exactly like a place with no route to it.
 *
 * So the distance is pinned here as a number, not only as a comparison. It is derived from an
 * assumed pace, and a pace nudged down one line of `types.ts` silently starts refusing journeys
 * that exist — a boundary in the wrong place still looks like a boundary. */
check('the limit is five miles', WALKING_LIMIT_MILES, 5);
// Redundant against the line above today, and deliberately so: that one pins this year's number and
// would be *updated* by anybody changing it, which is no check at all against the change that
// matters. This one pins the property instead, against a figure that is not the one under test —
// four miles an hour is a brisk walk and already faster than the pedestrian speeds journey planners
// route at — so a pace quietly lowered back towards a typical walker fails here even after the
// number above has been dutifully corrected to match.
check(
  'the limit is no shorter than a brisk walker covers in the hour',
  WALKING_LIMIT_MILES >= 4 * (WALKING_LIMIT_SECONDS / 3600),
  true,
);

// The boundary itself. Exactly on the limit is the last distance that could be walked inside the
// hour, so it is asked; the refusal starts past it.
asked('a walk exactly on the limit is asked', tooFarToWalk('walking', WALKING_LIMIT_MILES));
refused('a walk past the limit is not', tooFarToWalk('walking', WALKING_LIMIT_MILES + 0.01));
// Only walking. A cycle or a train across London is an ordinary journey, and refusing either on
// this distance would delete a column of real numbers.
asked('a cycle right across London is asked', tooFarToWalk('cycling', 20));
asked('and so is a train', tooFarToWalk('transit', 20));
// A refusal needs a measurement. Where one end could not be placed there is nothing to compare,
// and guessing is how a walkable leg gets cached as a dead end.
asked('a leg with nothing to measure is asked', tooFarToWalk('walking', null));
// The sentence is cached on the row and shown in the hover under the dash, so it has to say the
// distance rather than leave a bare "no journey" that reads as TfL's verdict.
check('the refusal says how far', tooFarToWalk('walking', 7.25)?.startsWith('7.3 miles'), true);

// And the whole chain the function actually runs: two points, a great-circle distance, a verdict.
const TRAFALGAR = { lat: 51.508, lon: -0.1281 };
const CANARY_WHARF = { lat: 51.5054, lon: -0.0235 };
const HEATHROW_T5 = { lat: 51.47, lon: -0.49 };
asked(
  'central London to Canary Wharf is a walk worth asking about',
  tooFarToWalk('walking', distanceMiles(TRAFALGAR, CANARY_WHARF)),
);
refused(
  'central London to Heathrow is not',
  tooFarToWalk('walking', distanceMiles(TRAFALGAR, HEATHROW_T5)),
);

/** The modes `travel_gaps` unnests, or a sentence saying why they could not be read.
 *
 *  Deliberately fussy about finding exactly one literal in exactly one place. Taking the first
 *  `unnest(array[...])` in the file would let a fragment in a comment, or a second query that
 *  happened to unnest something else, answer on behalf of the real one — and a check that compares
 *  the wrong array passes while the modes diverge, which is worse than not checking at all. So
 *  comments go first, the search is scoped to the body of the function that matters, and anything
 *  other than a single match is reported rather than resolved.
 *
 *  Stripping comments with a regex would misread a `--` inside a string literal, and the migration
 *  has none. If one ever appears the truncation removes the `unnest` with it and this returns "no
 *  literal", which is the loud direction. */
function modesInTravelGaps(sql: string): { modes: string[] } | { problem: string } {
  const uncommented = sql.replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, '');
  const body = /create\s+(?:or\s+replace\s+)?function\s+public\.travel_gaps\b[\s\S]*?\$\$([\s\S]*?)\$\$/i
    .exec(uncommented)?.[1];
  if (body === undefined) return { problem: 'no `create function public.travel_gaps ... $$ ... $$` body — did it move or change quoting?' };

  const literals = [...body.matchAll(/unnest\(\s*array\s*\[([^\]]*)\]/gi)].map((m) => m[1]!);
  if (literals.length === 0) return { problem: 'the travel_gaps body unnests no array — where did the mode list go?' };
  if (literals.length > 1) {
    return { problem: `the travel_gaps body unnests ${literals.length} arrays, so which one is the mode list is a guess: ${literals.map((l) => `array[${l.trim()}]`).join(' and ')}` };
  }
  return { modes: [...literals[0]!.matchAll(/'([^']*)'/g)].map((m) => m[1]!).sort() };
}

/** `check` against whichever half of that union came back, so a parse problem reads as a failure
 *  rather than as a comparison nobody made. */
function modes(name: string, sql: string, expected: string[] | string) {
  const found = modesInTravelGaps(sql);
  check(name, 'modes' in found ? found.modes : found.problem, expected);
}

/** The migration that *currently* defines `travel_gaps`, found rather than named.
 *
 *  Migrations are applied in filename order and each `create function` supersedes the one before,
 *  so the definition that runs is the one in the last file to write it. Naming that file by hand
 *  is a check that goes stale silently: the next migration to redefine the function leaves this
 *  reading a definition the database no longer has, green, about SQL that no longer runs — which
 *  is precisely the failure the mode comparison exists to catch, one level up. */
function latestTravelGapsMigration(): { path: string; sql: string } {
  const dir = resolve(import.meta.dirname, '..', 'supabase/migrations');
  const defines = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .filter((f) => /create\s+(?:or\s+replace\s+)?function\s+public\.travel_gaps\b/i.test(readFileSync(resolve(dir, f), 'utf8')));
  const last = defines.at(-1);
  if (last === undefined) throw new Error('no migration creates public.travel_gaps — did it move?');
  return { path: `supabase/migrations/${last}`, sql: readFileSync(resolve(dir, last), 'utf8') };
}

const { path: MIGRATION, sql: migration } = latestTravelGapsMigration();
console.log(`travel_gaps modes (${MIGRATION})`);
modes('the migration routes exactly the modes TRAVEL_MODES names', migration, [...TRAVEL_MODES].sort());

/** The migration with one edit made, refusing to make it ambiguously.
 *
 *  `String.replace` takes the first occurrence and says nothing about the rest, so a needle that
 *  turns up twice would quietly test a different edit than the case is named for — which is the
 *  same species of mistake as the parser bug these cases exist to pin. */
function edited(needle: string, replacement: string): string {
  const occurrences = migration.split(needle).length - 1;
  if (occurrences !== 1) {
    failures++;
    console.log(`  FAIL the case editing \`${needle.slice(0, 48)}…\` found ${occurrences} of it in ${MIGRATION}, not 1`);
  }
  return migration.replace(needle, replacement);
}

const UNNEST = "cross join unnest(array['walking', 'cycling', 'transit']) as m(mode)";

// ...and the parser that just said so, against the ways it could say it wrongly. A decoy in a
// comment is the one that matters: it is what a restructure leaves behind, and it is the case where
// the old parser answered from the wrong text and went green.
modes(
  'a decoy literal in a comment is not the mode list',
  edited('create function public.travel_gaps', `-- once written as ${UNNEST}\ncreate function public.travel_gaps`),
  [...TRAVEL_MODES].sort(),
);
modes(
  'a decoy literal outside the function is not the mode list',
  `select * from unnest(array['ferry']);\n${migration}`,
  [...TRAVEL_MODES].sort(),
);
modes(
  'two literals in the body are a question, not an answer',
  edited(UNNEST, `${UNNEST}, unnest(array['ferry']) as f(x)`),
  "the travel_gaps body unnests 2 arrays, so which one is the mode list is a guess: array['walking', 'cycling', 'transit'] and array['ferry']",
);
modes(
  'no literal at all is a failure rather than a skip',
  edited(UNNEST, 'cross join lateral routed_modes() as m(mode)'),
  'the travel_gaps body unnests no array — where did the mode list go?',
);
modes(
  'a renamed function is a failure rather than a skip',
  edited('create function public.travel_gaps', 'create function public.travel_backlog'),
  'no `create function public.travel_gaps ... $$ ... $$` body — did it move or change quoting?',
);

/* Which station a name means. TfL's search is fuzzy and ranks by relevance, so the guard against
 * being handed a different station is name equality once both sides are reduced — and every case
 * below is a real pair of spellings seen from Rightmove and from TfL's index. */
const same = (name: string, a: string, b: string) =>
  check(name, [stationCore(a), stationCore(b), stationCore(a) === stationCore(b)], [stationCore(a), stationCore(b), true]);

same('Rightmove\'s suffix and TfL\'s are the same station', 'Hampstead Underground Station', 'Hampstead');
same('a rail station and its bare name', 'Finchley Road & Frognal Station', 'Finchley Road & Frognal Rail Station');
same('an apostrophe is not part of the name', "King's Cross St. Pancras Underground Station", 'Kings Cross St Pancras');
same('two mode words at the end both go', 'Battersea Power Station Underground Station', 'Battersea Power Station');

check('West Hampstead is not Hampstead', stationCore('West Hampstead') === stationCore('Hampstead'), false);
check('Finchley Road is not Finchley Road & Frognal',
  stationCore('Finchley Road Underground Station') === stationCore('Finchley Road & Frognal Rail Station'), false);
// A name that is nothing but a mode word keeps it rather than reducing to the empty string, which
// would compare equal to every other reduced-away name.
check('a name made only of mode words survives', stationCore('Station'), 'station');


/* And which of TfL's answers count. The first attempt is the name off the listing and has to be
 * met exactly; the second has already dropped a word, so an answer that adds one back is what it
 * went looking for — but only on the end. */
const core2 = (a: string, b: string, extended: boolean) => stationMatches(stationCore(a), stationCore(b), extended);

check('the exact name is taken on the first attempt', core2('Hampstead Underground Station', 'Hampstead', false), true);
check('a longer name is refused on the first attempt', core2('Hampstead Heath Rail Station', 'Hampstead', false), false);
check('a shortened query accepts what it was shortened from',
  core2("King's Cross St. Pancras Underground Station", 'Kings Cross', true), true);
check('a word on the front is a different station, however shortened the query',
  core2('West Hampstead', 'Hampstead', true), false);
check('and not a bare substring either', core2('Old Hampstead Road', 'Hampstead', true), false);
check('a longer word is not the query plus a word', core2('Hampsteadish', 'Hampstead', true), false);


if (failures > 0) {
  console.error(`\n${failures} failing`);
  process.exit(1);
}
console.log('\nall ok');
