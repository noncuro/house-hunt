/** Cases for the fact-resolution logic: which source wins, what counts as a conflict, and how
 *  a listing date reads back as elapsed time. These are pure functions, so they are cheap to
 *  pin down — and both are places where being quietly wrong looks exactly like being right. */
import { claimLabel, relativeUpdate, resolveReading } from '../src/lib/facts';

let failures = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) return console.log(`  ok   ${name}`);
  failures++;
  console.log(`  FAIL ${name}\n       expected ${e}\n       got      ${a}`);
}

console.log('resolveReading');
check(
  'prefers the first source that has a value',
  resolveReading([{ source: 'floorplan', value: null }, { source: 'listing', value: 700 }], 0.03),
  { value: 700, source: 'listing', conflicts: [] },
);
// The verified real case: the plan said 1105 where Rightmove's sizings said 1044.
check(
  'flags a real size disagreement',
  resolveReading([{ source: 'floorplan', value: 1105 }, { source: 'listing', value: 1044 }], 0.03),
  { value: 1105, source: 'floorplan', conflicts: [{ source: 'listing', value: 1044 }] },
);
check(
  'treats sq ft / m² rounding as agreement',
  resolveReading([{ source: 'floorplan', value: 1105 }, { source: 'listing', value: 1100 }], 0.03),
  { value: 1105, source: 'floorplan', conflicts: [] },
);
check(
  'counts disagree on any difference at all',
  resolveReading([{ source: 'listing', value: 2 }, { source: 'floorplan', value: 3 }]),
  { value: 2, source: 'listing', conflicts: [{ source: 'floorplan', value: 3 }] },
);
check('nothing to show', resolveReading([{ source: 'listing', value: null }]), null);
check(
  'zero is a value, not a gap',
  resolveReading([{ source: 'floorplan', value: 0 }, { source: 'listing', value: 5 }]),
  { value: 0, source: 'floorplan', conflicts: [{ source: 'listing', value: 5 }] },
);
// A negative area or count is impossible, and it is not merely useless: it flips the sign of the
// disagreement ratio, so every conflict compares as under tolerance and none is ever flagged.
// Both halves are pinned — that the impossible value is skipped, and that the conflict against
// the value chosen instead is still found.
check(
  'a negative reading is skipped, not chosen',
  resolveReading([{ source: 'floorplan', value: -900 }, { source: 'listing', value: 1000 }]),
  { value: 1000, source: 'listing', conflicts: [] },
);
check(
  'and a negative never silences a real conflict',
  resolveReading(
    [
      { source: 'floorplan', value: -900 },
      { source: 'listing', value: 1000 },
      { source: 'description', value: 400 },
    ],
    0.03,
  ),
  { value: 1000, source: 'listing', conflicts: [{ source: 'description', value: 400 }] },
);

console.log('relativeUpdate');
const now = new Date(2026, 7, 9); // 9 Aug 2026, local — the function compares calendar days
check('today', relativeUpdate('Added on 09/08/2026', now), 'Added today');
check('yesterday', relativeUpdate('Reduced on 08/08/2026', now), 'Reduced yesterday');
check('days', relativeUpdate('Reduced on 31/07/2026', now), 'Reduced 9 days ago');
check('rounds to weeks past a fortnight', relativeUpdate('Added on 20/07/2026', now), 'Added 3 weeks ago');
check('months once weeks stop meaning much', relativeUpdate('Added on 01/05/2026', now), 'Added 3 months ago');
check('leaves an already-relative phrase alone', relativeUpdate('Reduced today', now), 'Reduced today');
check('leaves an unparseable phrase alone', relativeUpdate('Reduced yesterday', now), 'Reduced yesterday');
check('a future date is not made up into "-3 days ago"', relativeUpdate('Added on 12/08/2026', now), 'Added on 12/08/2026');

console.log('claimLabel');
check('a confident absence is stated flatly', claimLabel('bathtub-absent', 'high'), 'no bathtub');
check('a medium read hedges', claimLabel('bathtub-absent', 'medium'), 'bath possibly missing');
check('a low read says it could not tell', claimLabel('bathtub-absent', 'low'), 'bath unclear from photos');
check('a present bath hedges the same way', claimLabel('bathtub-present', 'low'), 'possible bathtub');
check('rooms hedge too', claimLabel('rooms-small', 'medium'), 'rooms look small');
// Analyses predating the confidence field return null, and those were mostly floorplan reads.
check('no confidence reads as high', claimLabel('outdoor-absent', null), 'no outdoor space');

if (failures > 0) { console.error(`\n${failures} failing`); process.exit(1); }
console.log('\nall ok');
