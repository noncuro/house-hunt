/** Cases for the fact-resolution logic: which source wins, what counts as a conflict, and how
 *  a listing date reads back as elapsed time. These are pure functions, so they are cheap to
 *  pin down — and both are places where being quietly wrong looks exactly like being right. */
import {
  addressBesidePostcode,
  claimLabel,
  flagsFor,
  relativeUpdate,
  resolveReading,
} from '../packages/core/src/facts';
import { galleryFor } from '../packages/core/src/shortlist';
import type { Analysis } from '../packages/core/src/types';

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

// ------------------------------------------------------------------------------------------- //
console.log('\namenity flags follow what the hunt actually said');

/** An analysis with everything unknown but the one field a case is about. */
function analysis(fields: Partial<Analysis>): Analysis {
  return {
    model: 'test', analysedAt: '', imageCount: 0,
    hasFloorplan: true, floorplanLegible: null, floorplanSqft: null, floorplanSqftSource: null,
    floorplanConfidence: null, bedrooms: null, bathrooms: null,
    biggestRoomLabel: null, biggestRoomSqft: null, biggestRoomConfidence: null,
    hasBathtub: null, bathtubConfidence: null,
    hasOutdoorSpace: null, outdoorKind: null, outdoorSqft: null, outdoorIsEstimate: null,
    outdoorConfidence: null, isHouseShare: null, houseShareConfidence: null,
    laundry: null, laundryConfidence: null, hasDishwasher: null, dishwasherConfidence: null,
    sleepingSeparation: null, sleepingSeparationConfidence: null, utilitiesIncluded: null, utilitiesConfidence: null,
    naturalLight: null, naturalLightConfidence: null, summary: null,
    ...fields,
  };
}

const noBath = { analysis: analysis({ hasBathtub: false }), floorplanUrl: 'plan.png' };
const keys = (prefs?: Parameters<typeof flagsFor>[1]) => keysOf(flagsFor(noBath, prefs));
const keysOf = (flags: ReturnType<typeof flagsFor>) => flags.map((f) => f.key);

// The complaint this exists for: the Your Hunt page offers "Don't mind" and it used to do nothing,
// so a hunt that had said it did not care still got "no bathtub" on every panel.
check('an amenity nobody minds is not flagged', keys({ amenities: {} }).includes('bathtub'), false);
check(
  'and neither is one on a hunt that has set no preferences at all',
  keys(undefined).includes('bathtub'),
  false,
);
check('"nice to have" brings it back', keys({ amenities: { bathtub: 'nice' } }).includes('bathtub'), true);
check('so does "must have"', keys({ amenities: { bathtub: 'must' } }).includes('bathtub'), true);
check(
  'and a must-have absence is red',
  flagsFor(noBath, { amenities: { bathtub: 'must' } }).find((f) => f.key === 'bathtub')?.severity,
  'red',
);
// Saying you want a bathtub must not silence everything else you did not mention.
check(
  'one preference does not turn the others on',
  keys({ amenities: { bathtub: 'must' } }).includes('outdoor'),
  false,
);
// A studio is one room on the plan and can still be two in practice. The boolean this replaced
// could not tell those apart, and called both of them a bed in the kitchen.
const mezzanine = { analysis: analysis({ sleepingSeparation: 'practically-separate' }), floorplanUrl: 'plan.png' };
const bedsit = { analysis: analysis({ sleepingSeparation: 'same-space' }), floorplanUrl: 'plan.png' };
const minds = { amenities: { separateSleeping: 'must' as const } };
check(
  'a mezzanine studio is not held against a hunt that wants the kitchen out of the bedroom',
  flagsFor(mezzanine, minds).find((f) => f.key === 'sleeping')?.severity,
  'good',
);
check(
  'and one open room is, in red, because they said it was a must',
  flagsFor(bedsit, minds).find((f) => f.key === 'sleeping')?.severity,
  'red',
);
check(
  'a hunt that has not said it minds hears nothing either way',
  keysOf(flagsFor(bedsit, undefined)).includes('sleeping'),
  false,
);
check(
  'and a real bedroom is never remarked on — the bedroom count already said that',
  keysOf(
    flagsFor({ analysis: analysis({ sleepingSeparation: 'separate-room' }), floorplanUrl: 'plan.png' }, minds),
  ).includes('sleeping'),
  false,
);

// A house share stopped being everybody's dealbreaker and became a preference like the rest: some
// hunts are looking for a room in a share.
const share = { analysis: analysis({ isHouseShare: true }), floorplanUrl: 'plan.png' };
check(
  'a house share is flagged for a hunt that wants the whole property',
  flagsFor(share, { amenities: { wholeProperty: 'must' } }).find((f) => f.key === 'share')?.severity,
  'red',
);
check('and not for one that never said', keysOf(flagsFor(share, undefined)).includes('share'), false);

// Laundry has three answers, and a hunt's bar sits at one of the two that are not "none".
const communal = { analysis: analysis({ laundry: 'in-building' }), floorplanUrl: 'plan.png' };
check(
  'a machine in the basement satisfies a hunt that only needs one in the building',
  flagsFor(communal, { amenities: { anyLaundry: 'must' } }).find((f) => f.key === 'laundry')?.severity,
  'yellow',
);
check(
  'and fails one that wants it in the flat',
  flagsFor(communal, { amenities: { inUnitLaundry: 'must' } }).find((f) => f.key === 'laundry')?.severity,
  'red',
);

// The bedroom bar, judged on the model's count off the floorplan rather than the agent's typing.
check(
  'a studio is under a one-bedroom bar, and says so in those words',
  flagsFor({ analysis: analysis({ bedrooms: 0 }), floorplanUrl: 'plan.png' }, { minBedrooms: 1 }).find(
    (f) => f.key === 'bedrooms',
  )?.text,
  'studio — you asked for 1+',
);
check(
  'the floorplan beats the listing when the two disagree',
  keysOf(
    flagsFor({ analysis: analysis({ bedrooms: 1 }), bedrooms: 2, floorplanUrl: 'plan.png' }, { minBedrooms: 2 }),
  ).includes('bedrooms'),
  true,
);
check(
  'and a count nobody has clears the bar, like every other unknown',
  keysOf(
    flagsFor({ analysis: analysis({ bedrooms: null }), floorplanUrl: 'plan.png' }, { minBedrooms: 3 }),
  ).includes('bedrooms'),
  false,
);

// The flags that are not a matter of taste stay regardless — a missing floorplan is missing
// whatever anybody prefers.
check(
  'a missing floorplan is not a preference',
  flagsFor({ analysis: analysis({ hasFloorplan: false }), floorplanUrl: null }, undefined).map((f) => f.key),
  ['floorplan'],
);

// The whole-flat bar. Absent means no opinion — the commonest state, and the one where a red flag
// would be an invention rather than a judgement.
const small = { analysis: null, floorplanUrl: null, size: { listedSqft: 400, listedSource: 'sizings' as const } };
const sizeKeys = (source: Parameters<typeof flagsFor>[0], prefs?: Parameters<typeof flagsFor>[1]) =>
  flagsFor(source, prefs)
    .map((f) => f.key)
    .filter((k) => k === 'size');
check('no bar, no size flag', sizeKeys(small, {}), []);
check(
  'under the bar is red',
  flagsFor(small, { minSqft: 600 }).find((f) => f.key === 'size')?.severity,
  'red',
);
check(
  'at the bar is not under it',
  sizeKeys({ ...small, size: { listedSqft: 600, listedSource: 'sizings' } }, { minSqft: 600 }),
  [],
);
// An unmeasured flat is not a small one — the same rule triage's filters follow.
check(
  'no measurement, no size flag',
  sizeKeys({ analysis: null, floorplanUrl: null }, { minSqft: 600 }),
  [],
);
// The floor and the target are two answers, and the band between them is the amber one: a flat you
// would take, at a size you did not ask for.
check(
  'between the floor and the target is amber',
  flagsFor(small, { minSqft: 300, targetSqft: 600 }).find((f) => f.key === 'size')?.severity,
  'yellow',
);
// One flag, not two. Under the floor is under the target as well, and the worse reading is the
// only one worth showing.
check(
  'under both is said once, in red',
  flagsFor(small, { minSqft: 500, targetSqft: 600 })
    .filter((f) => f.key === 'size')
    .map((f) => f.severity),
  ['red'],
);
check(
  'at the target is not under it',
  sizeKeys({ ...small, size: { listedSqft: 600, listedSource: 'sizings' } }, { minSqft: 300, targetSqft: 600 }),
  [],
);

console.log('galleryFor');
// The floorplan leads and is not repeated further down the set.
check(
  'the floorplan is first, and only once',
  galleryFor({ floorplanUrl: 'plan.jpg', imageUrls: ['a.jpg', 'plan.jpg', 'b.jpg'] }),
  ['plan.jpg', 'a.jpg', 'b.jpg'],
);
// Rightmove repeats the hero shot at the end of the set often enough, and the URL is what every
// view keys its thumbnails on — two identical keys is a React warning and a thumbnail that can go
// missing.
check(
  'a photo listed twice appears once',
  galleryFor({ floorplanUrl: null, imageUrls: ['a.jpg', 'b.jpg', 'a.jpg'] }),
  ['a.jpg', 'b.jpg'],
);
check(
  'and the first occurrence keeps its place',
  galleryFor({ floorplanUrl: null, imageUrls: ['a.jpg', 'b.jpg', 'a.jpg', 'c.jpg'] })[1],
  'b.jpg',
);
check('no floorplan is not a blank first frame', galleryFor({ imageUrls: ['a.jpg'] }), ['a.jpg']);

console.log('addressBesidePostcode');
check(
  'the trailing outward code goes, since the postcode beside it says the same',
  addressBesidePostcode('Pond Street, Hampstead, NW3', 'NW3 2NW'),
  'Pond Street, Hampstead',
);
// The real one that prompted this: the district filed twice inside the address itself.
check(
  'every repeat of it goes, not only the last',
  addressBesidePostcode('Greencroft Gardens, NW6, South Hampstead, London, NW6', 'NW6 1HX'),
  'Greencroft Gardens, South Hampstead, London',
);
check(
  'a different district is a disagreement, and stays on screen',
  addressBesidePostcode('Pond Street, Hampstead, NW3', 'N1 7RB'),
  'Pond Street, Hampstead, NW3',
);
check(
  'no postcode, nothing to trim against',
  addressBesidePostcode('Pond Street, Hampstead, NW3', null),
  'Pond Street, Hampstead, NW3',
);
// Trimming this one to nothing would leave the card with a blank where the address goes, which is
// worse than saying the district twice.
check(
  'an address that is only its district is left alone',
  addressBesidePostcode('NW3', 'NW3 2NW'),
  'NW3',
);

console.log('flag wording');
// The number is the difference between a bedsit and a 440 sq ft reception, and "small rooms" alone
// covers both.
check(
  'a small main room says how small',
  flagsFor({ analysis: analysis({ biggestRoomSqft: 320, biggestRoomConfidence: 'high' }), floorplanUrl: 'p.png' })
    .find((f) => f.key === 'rooms')?.text,
  'small rooms · 320 sq ft',
);
// The severity says how much it matters; the words used to say it a second time.
check(
  'a must-have absence is not also spelled out in words',
  flagsFor(noBath, { amenities: { bathtub: 'must' } }).find((f) => f.key === 'bathtub')?.text,
  'no bathtub',
);
check(
  'and neither is one the defaults had nothing to say about',
  flagsFor({ analysis: analysis({ hasDishwasher: false }), floorplanUrl: 'p.png' }, {
    amenities: { dishwasher: 'must' },
  }).find((f) => f.key === 'dishwasher')?.text,
  'no dishwasher',
);

if (failures > 0) { console.error(`\n${failures} failing`); process.exit(1); }
console.log('\nall ok');
