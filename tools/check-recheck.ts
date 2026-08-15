/** Which flats get reopened, in what order, and what counts as a price having moved.
 *
 *  Both halves are invisible when wrong. A re-check run that quietly skips the wrong flats looks
 *  exactly like one that had less to do — the button says a smaller number and nothing says why —
 *  and a price change read backwards puts "↓ was £2,700" on a flat that went *up*, which is the one
 *  error here that would actively cost somebody money.
 *
 *  The ordering matters for a reason that is easy to lose: a run of a hundred tabs is one people
 *  interrupt, so what it does first is what it does at all.
 */
import {
  RECHECK_AFTER_DAYS,
  latestChange,
  recheckTargets,
  type PricePoint,
} from '../packages/core/src/recheck';
import type { ShortlistEntry } from '../packages/core/src/db/supabase';
import type { PropertyStage, Rating } from '../packages/core/src/index';

let failures = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) return console.log(`  ok   ${name}`);
  failures++;
  console.log(`  FAIL ${name}\n       expected ${e}\n       got      ${a}`);
}

const NOW = new Date('2026-08-15T12:00:00Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000).toISOString();

function flat(fields: {
  id: string;
  seen: string;
  rating?: Rating;
  stage?: PropertyStage['stage'];
}): ShortlistEntry {
  return {
    rightmoveId: fields.id, url: '', displayAddress: `Flat ${fields.id}`, postcode: null,
    price: null, bedrooms: null, bathrooms: null, floorAreaSqft: null, floorAreaSource: null,
    floorplanUrl: null, imageUrls: [], furnishType: null, listingUpdate: null,
    nearestStations: [], lastSeenAt: fields.seen, lat: null, lon: null, exactLocation: false,
    verdicts: fields.rating ? ([{ rating: fields.rating }] as any) : [],
    stage: fields.stage ? ({ stage: fields.stage } as PropertyStage) : null,
    analysis: null,
  };
}

const ids = (entries: ShortlistEntry[]) => recheckTargets(entries, NOW).map((t) => t.rightmoveId);

// ------------------------------------------------------------------------------------------- //
console.log('\nwhat gets reopened');

check(
  'a flat read today is left alone',
  ids([flat({ id: 'fresh', seen: daysAgo(0) })]),
  [],
);
check(
  `and one read ${RECHECK_AFTER_DAYS + 1} days ago is not`,
  ids([flat({ id: 'stale', seen: daysAgo(RECHECK_AFTER_DAYS + 1) })]),
  ['stale'],
);
// Archived is a decision already made — spending six seconds of tab to find out that a flat you are
// not pursuing has gone is the definition of a wasted tab.
check(
  'archived is skipped however stale',
  ids([flat({ id: 'gone', seen: daysAgo(90), stage: 'archived' })]),
  [],
);
// ...but every other stage is still live, including one at the far end of the funnel: a flat you
// have made an offer on is exactly the one where you want to know it has been withdrawn.
check(
  'a flat with an offer in is still re-checked',
  ids([flat({ id: 'offer', seen: daysAgo(10), stage: 'offer_made' })]),
  ['offer'],
);
// A rejection is a verdict, not a stage. Rejected at £3,100 is worth revisiting at £2,700, and
// finding that is the whole point.
check(
  'a flat rated "not our place" is still re-checked, and goes last',
  ids([
    flat({ id: 'no', seen: daysAgo(30), rating: 'no' }),
    flat({ id: 'unrated', seen: daysAgo(30) }),
  ]),
  ['unrated', 'no'],
);
// An unreadable timestamp is not a recent one — the rows with something odd about them are the ones
// most worth a look, and treating the date as fresh would exclude them silently and for good.
check(
  'a timestamp we cannot parse is re-checked',
  ids([flat({ id: 'odd', seen: 'not a date' })]),
  ['odd',],
);

// ------------------------------------------------------------------------------------------- //
console.log('\nand in what order — a run that stops halfway must have done the right half');

check(
  'love, then maybe, then unrated, then rejected',
  ids([
    flat({ id: 'no', seen: daysAgo(30), rating: 'no' }),
    flat({ id: 'unrated', seen: daysAgo(30) }),
    flat({ id: 'love', seen: daysAgo(30), rating: 'love' }),
    flat({ id: 'maybe', seen: daysAgo(30), rating: 'maybe' }),
  ]),
  ['love', 'maybe', 'unrated', 'no'],
);
// Within one rating, the one we know least about. Note this is *not* the top-level sort: a love
// read a week ago still goes before a rejection read two months ago.
check(
  'then least recently read first',
  ids([
    flat({ id: 'recent-love', seen: daysAgo(4), rating: 'love' }),
    flat({ id: 'ancient-no', seen: daysAgo(200), rating: 'no' }),
    flat({ id: 'old-love', seen: daysAgo(40), rating: 'love' }),
  ]),
  ['old-love', 'recent-love', 'ancient-no'],
);

// ------------------------------------------------------------------------------------------- //
console.log('\nand what counts as the price having moved');

const at = (n: number, price: string): PricePoint => ({ price, seenAt: daysAgo(n) });

check('one sighting is not a change', latestChange([at(10, '£3,000 pcm')]), null);
check('no sightings at all is not a change', latestChange([]), null);
check(
  'a reduction reads as one',
  latestChange([at(20, '£3,100 pcm'), at(2, '£2,850 pcm')])?.direction,
  'down',
);
check(
  'and a rise as one',
  latestChange([at(20, '£2,850 pcm'), at(2, '£3,100 pcm')])?.direction,
  'up',
);
// Out of order in, newest-first out — the database returns these newest first and a caller must not
// have to remember to re-sort them.
check(
  'the rows may arrive in any order',
  latestChange([at(2, '£2,850 pcm'), at(20, '£3,100 pcm')]),
  { from: '£3,100 pcm', to: '£2,850 pcm', at: daysAgo(2), direction: 'down' },
);
// Only the last move. A flat reduced twice reports the second one, not the whole run.
check(
  'the most recent move is the one reported',
  latestChange([at(30, '£3,300 pcm'), at(20, '£3,100 pcm'), at(2, '£2,850 pcm')])?.from,
  '£3,100 pcm',
);
// The case a string comparison gets wrong: the same rent re-expressed weekly is not a rise. The
// figures are parsed to monthly before the direction is decided, which is what catches it.
check(
  'a rent restated per week is not an increase',
  latestChange([at(20, '£3,000 pcm'), at(2, '£692 pw')])?.direction,
  'down',
);
// And the honest answer when neither figure parses: something moved, and we cannot say which way.
check(
  'an unreadable price is a change with no direction',
  latestChange([at(20, 'POA'), at(2, 'Ask agent')])?.direction,
  'unknown',
);

if (failures > 0) { console.error(`\n${failures} failing`); process.exit(1); }
console.log('\nall ok');
