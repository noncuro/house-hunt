/** What the shortlist draws, and what it leaves out.
 *
 *  One rule, and it is invisible when it is wrong in either direction. Flats marked off the market
 *  must not be drawn among the ones you can still act on — that is the bug this was written for,
 *  a hunt whose loved pile went on offering places that had been gone for a fortnight. And the
 *  hiding must be *only* hiding: the verdict and the stage are two other facts, and a mark that
 *  quietly rewrote either would teach the score model that a flat you loved and lost was a flat you
 *  never liked. Nothing on screen would say so.
 *
 *  The third case is the one that reads as a feature working. `null` is the set not having loaded,
 *  which is not an empty set: hiding on a fact we do not have yet blanks flats for the first frame
 *  of every load and, after a failed read, leaves a shortlist quietly missing things. */
import { groupOf, withoutOffMarket } from '../packages/core/src/shortlist';
import type { Verdict } from '../packages/core/src/types';

let failures = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) return console.log(`  ok   ${name}`);
  failures++;
  console.log(`  FAIL ${name}\n       expected ${e}\n       got      ${a}`);
}

const loved: Verdict[] = [
  { rightmoveId: '0', person: 'a', rating: 'love', note: '', updatedAt: '2026-08-01T00:00:00Z' },
];
const entries = [
  { rightmoveId: '1', verdicts: loved },
  { rightmoveId: '2', verdicts: loved },
  { rightmoveId: '3', verdicts: [] as Verdict[] },
];
const gone = new Set(['2']);
const ids = (list: { rightmoveId: string }[]) => list.map((e) => e.rightmoveId);

check('a flat off the market is not drawn', ids(withoutOffMarket(entries, gone, false)), ['1', '3']);
check('and is drawn again when asked for', ids(withoutOffMarket(entries, gone, true)), ['1', '2', '3']);
check('nothing off the market changes nothing', ids(withoutOffMarket(entries, new Set(), false)), ['1', '2', '3']);
check('and not knowing yet hides nothing', ids(withoutOffMarket(entries, null, false)), ['1', '2', '3']);

// The point of the whole design: hiding is a decision one view makes about what to draw, not a
// write. A verdict that came back different from this would be the score model learning the
// opposite of what happened.
check(
  'the verdict is untouched by hiding',
  withoutOffMarket(entries, gone, true).map((e) => groupOf(e.verdicts)),
  ['excited', 'excited', 'unrated'],
);
check('and the entries themselves are the same objects', withoutOffMarket(entries, gone, true)[1] === entries[1], true);

if (failures > 0) { console.error(`\n${failures} failing`); process.exit(1); }
console.log('\nall ok');
