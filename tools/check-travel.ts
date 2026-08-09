/** Cases for what a cached travel time means and when it stops meaning it.
 *
 *  This is the file that decides whether to believe a number already in the database, so getting
 *  it wrong is silent in both directions: too strict and every page load re-asks TfL for
 *  everything, too loose and a commute measured at midnight during engineering works is shown
 *  forever as the answer. Neither looks like a bug on screen. */
import { NO_ROUTE_RETRY_DAYS, TRAVEL_BASIS, nextWeekdayMorning, staleTravel } from '../src/lib/tfl';

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

if (failures > 0) {
  console.error(`\n${failures} failing`);
  process.exit(1);
}
console.log('\nall ok');
