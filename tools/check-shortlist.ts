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
import { agentTally, groupOf, withoutOffMarket } from '../packages/core/src/shortlist';
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
//
// Asserted on the *hiding* path — `show: true` returns the input array untouched, so asserting
// against that would pass whatever the branch that does the work did to the entries it kept.
check(
  'the verdicts that survive hiding are unchanged',
  withoutOffMarket(entries, gone, false).map((e) => groupOf(e.verdicts)),
  ['excited', 'unrated'],
);
check(
  'and they are the same objects, not copies',
  withoutOffMarket(entries, gone, false).every((e, i) => e === [entries[0], entries[2]][i]),
  true,
);
// Nothing is lost by hiding: the flat is still there to be shown again, with everything it had.
check('the hidden flat is intact when it comes back', withoutOffMarket(entries, gone, true)[1], entries[1]);

// --------------------------------------------------------------------------------------------- //
// Who is marketing the pile.

/** Only the four fields the tally reads; the rest of a ShortlistEntry is irrelevant to it. */
const marketed = (company: string | null, branch: string | null, phone: string | null) =>
  ({ agentCompany: company, agentBranch: branch, agentPhone: phone }) as never;

const pile = [
  marketed('Dexters', 'Dexters, Clapham High Street', '020 1111 1111'),
  marketed('Dexters', 'Dexters, Balham', '020 2222 2222'),
  marketed('Dexters', 'Dexters, Clapham High Street', '020 1111 1111'),
  marketed('Foxtons', 'Foxtons, Islington', '020 3333 3333'),
  marketed(null, null, null),
];

check('the commonest agent comes first', agentTally(pile).map((a) => [a.company, a.count]), [
  ['Dexters', 3],
  ['Foxtons', 1],
]);
// The point of grouping on the company: three flats from two Dexters offices is one agent to ring,
// and branch-grouping would have reported it as two.
check('branches of one company are one row', agentTally(pile)[0].branches, [
  'Dexters, Clapham High Street',
  'Dexters, Balham',
]);
check('and a repeated branch is listed once', agentTally(pile)[0].branches.length, 2);
check('the first number seen is the one offered', agentTally(pile)[0].phone, '020 1111 1111');
// A flat whose agent was never read is not an agent called "". It is left out entirely, and the
// screen states the shortfall separately — a blank row would read as a flat sold by nobody.
check('a flat with no agent is not a row', agentTally(pile).length, 2);
check('nothing marketed is no rows at all', agentTally([]), []);
// Two agents on the same count must not swap places between renders.
check(
  'a tie is broken alphabetically, not by chance',
  agentTally([marketed('Savills', null, null), marketed('Portico', null, null)]).map((a) => a.company),
  ['Portico', 'Savills'],
);
// Rightmove pads these — `companyTradingName` arrives as "Oyster Properties " — and an untrimmed
// key would report one agent twice.
check(
  'a padded name is the same agent',
  agentTally([marketed('Oyster Properties ', null, null), marketed('Oyster Properties', null, null)])
    .map((a) => [a.company, a.count]),
  [['Oyster Properties', 2]],
);

if (failures > 0) { console.error(`\n${failures} failing`); process.exit(1); }
console.log('\nall ok');
