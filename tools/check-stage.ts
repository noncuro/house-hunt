/** The funnel: the ordering, the counting and the filtering the shortlist is read through.
 *
 *  What this pins is the one thing about the funnel that is invisible when it is wrong. A stage is
 *  a string, and a table sorted on the wrong string still looks sorted — alphabetically, "archived"
 *  comes first and "viewing_booked" comes after "viewed", so a funnel column sorted by name reads
 *  as a funnel with the dead flats at the top and a viewing after the visit it was booked for.
 *  Every case below asserts the funnel's own order instead.
 *
 *  The other half is the separation the whole feature rests on: a stage never carries a rating, and
 *  a rating never appears in a count of stages. That is asserted here as a shape — `funnelCounts`
 *  is handed entries whose ratings disagree with their stages, and must not notice. */
import {
  ARCHIVE_REASONS,
  FILTER_LABEL,
  FIRST_STAGE,
  STAGES,
  STAGE_FILTERS,
  archiveMeta,
  funnelCounts,
  matchesStage,
  stageMeta,
  stageRank,
  stageSentence,
  type PropertyStage,
  type Stage,
  type StageFilter,
} from '../packages/core/src/stage';

let failures = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) return console.log(`  ok   ${name}`);
  failures++;
  console.log(`  FAIL ${name}\n       expected ${e}\n       got      ${a}`);
}

function stageAt(stage: Stage, archiveReason: PropertyStage['archiveReason'] = null): PropertyStage {
  return {
    rightmoveId: '1',
    stage,
    archiveReason,
    note: '',
    person: 'someone',
    updatedAt: '2026-08-13T09:00:00.000Z',
  };
}

// ------------------------------------------------------------------------------------------- //
console.log('\nthe order is the funnel, not the alphabet');

// Spelled out rather than derived from STAGES, which is the list under test: reordering the steps
// has to fail here rather than silently agree with itself.
const ORDER: Stage[] = ['shortlisted', 'enquired', 'viewing_booked', 'viewed', 'offer_made', 'archived'];
check('the steps run from shortlisted to archived', STAGES.map((s) => s.value), ORDER);
check(
  'ranks ascend with progress',
  ORDER.map((s) => stageRank(s)),
  [0, 1, 2, 3, 4, 5],
);
// The case a name sort gets wrong, stated on its own because it is the one anybody would eyeball
// and accept: alphabetically `viewed` follows `viewing_booked`, which puts the viewing after the
// visit.
check('a booked viewing comes before the viewing', stageRank('viewing_booked') < stageRank('viewed'), true);
check('archiving is the end of the road', stageRank('archived'), STAGES.length - 1);
// A row this build cannot place must sink rather than lead: sorting an unknown stage to the top
// would push every flat you *can* place off the first screen of the table.
check('a stage from a newer build sorts last', stageRank('teleported' as Stage), STAGES.length);
check('and reads as itself rather than as a blank', stageMeta('teleported' as Stage).label, 'teleported');
check('liking a place enters it at the first step', FIRST_STAGE, ORDER[0]);

// ------------------------------------------------------------------------------------------- //
console.log('\nan archive says why');

check(
  'the reason is part of the sentence',
  stageSentence(stageAt('archived', 'offer_rejected')),
  'Archived — our offer was rejected',
);
check('and nothing else carries one', stageSentence(stageAt('viewed')), 'Viewed');
check(
  'every reason has words of its own',
  ARCHIVE_REASONS.map((r) => archiveMeta(r.value).label === r.label),
  ARCHIVE_REASONS.map(() => true),
);

// ------------------------------------------------------------------------------------------- //
console.log('\nthe filter, including the pile outside the funnel');

// The ratings here contradict the stages on purpose. A place archived because somebody outbid you
// is still loved, and a place shortlisted is only liked — if any of this ever consulted a verdict,
// these counts would come out differently.
const shortlist = [
  { rating: 'love', stage: stageAt('archived', 'offer_rejected') },
  { rating: 'maybe', stage: stageAt('shortlisted') },
  { rating: 'love', stage: stageAt('viewed') },
  { rating: 'love', stage: stageAt('viewed') },
  { rating: 'no', stage: null },
  { rating: null, stage: null },
];

const counts = funnelCounts(shortlist);
check('everything is counted once', counts.all, shortlist.length);
check('two viewed', counts.viewed, 2);
check('one archived', counts.archived, 1);
check('an empty step is a zero, not an absence', counts.enquired, 0);
check('and the pile nobody has liked is countable too', counts.none, 2);
check(
  'every filter the bar draws has a count and a label',
  STAGE_FILTERS.filter((f) => typeof counts[f] !== 'number' || !FILTER_LABEL[f]),
  [],
);

check(
  'filtering to a step keeps exactly that step',
  shortlist.filter((e) => matchesStage(e.stage, 'viewed')).length,
  2,
);
check(
  '"not in the funnel" is the flats with no stage at all',
  shortlist.filter((e) => matchesStage(e.stage, 'none')).length,
  2,
);
check('and "everything" keeps everything', shortlist.filter((e) => matchesStage(e.stage, 'all')).length, 6);
// `none` and `all` are not stages, and a filter that treated them as one would silently show an
// empty shortlist rather than the pile it names.
check(
  'the two piles that are not steps are not mistaken for one',
  (['all', 'none'] as StageFilter[]).map((f) => matchesStage(stageAt('viewed'), f)),
  [true, false],
);

if (failures > 0) { console.error(`\n${failures} failing`); process.exit(1); }
console.log('\nall ok');
