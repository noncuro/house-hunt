/** Cases for the validation the vision model's answer goes through before anyone reads it.
 *
 *  Worth pinning because this is the one place in the extension where a wrong value is
 *  indistinguishable from a right one at the point of use: the panel prints "1,082 sq ft" the same
 *  way whether the model read it off a plan or invented it, and the compare table sorts on it. The
 *  rule these cases encode is that an impossible number becomes an absent one — "unknown" is a
 *  thing the UI can say honestly, and "-40 sq ft" is not.
 *
 *    pnpm check:analysis
 */
import { validateAnalysis } from '../packages/core/src/analysis';

let failures = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) return console.log(`  ok   ${name}`);
  failures++;
  console.log(`  FAIL ${name}\n       expected ${e}\n       got      ${a}`);
}

function throws(name: string, run: () => unknown, pattern: RegExp) {
  try {
    run();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (pattern.test(message)) return console.log(`  ok   ${name}`);
    failures++;
    return console.log(`  FAIL ${name}\n       expected /${pattern.source}/\n       got      ${message}`);
  }
  failures++;
  console.log(`  FAIL ${name}\n       expected a throw, got none`);
}

/** A well-formed analysis of a real-shaped listing, which each case then breaks in one place. Every
 *  field is present because the model is asked for all of them under a strict schema — the cases
 *  are about values that are impossible, not fields that are missing. */
function good(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    images: [{ index: 0, is_floorplan: true, room: null, caption: 'A floorplan.' }],
    floorplan: { present: true, legible: true, total_sqft: 1082, source: 'stated', confidence: 'high' },
    bedrooms: 2,
    bathrooms: 2,
    biggest_room: { label: 'reception', sqft: 240, confidence: 'medium' },
    bathtub: { present: true, confidence: 'high' },
    outdoor: { present: true, kind: 'terrace', sqft: 120, is_estimate: true, confidence: 'low' },
    amenities: {
      house_share: { present: false, confidence: 'high' },
      laundry: { where: 'in-unit', confidence: 'medium' },
      dishwasher: { present: true, confidence: 'high' },
      sleeping_area: { separation: 'separate-room', confidence: 'high' },
      utilities_included: { present: null, confidence: 'low' },
    },
    light: { level: 'high', confidence: 'medium' },
    summary: 'A two-bedroom flat.',
    ...overrides,
  };
}

// Warnings are the point — a dropped value must be visible rather than silent — but they would
// bury the case names, so they are collected and counted instead of printed.
const warnings: string[] = [];
console.warn = (message: string) => void warnings.push(message);

function run(input: Record<string, unknown>) {
  warnings.length = 0;
  return validateAnalysis(input);
}

console.log('a good analysis is passed through');
check('every field survives', run(good()), {
  images: [{ index: 0, is_floorplan: true, room: null, caption: 'A floorplan.' }],
  floorplan: { present: true, legible: true, total_sqft: 1082, source: 'stated', confidence: 'high' },
  bedrooms: 2,
  bathrooms: 2,
  biggest_room: { label: 'reception', sqft: 240, confidence: 'medium' },
  bathtub: { present: true, confidence: 'high' },
  outdoor: { present: true, kind: 'terrace', sqft: 120, is_estimate: true, confidence: 'low' },
  amenities: {
    house_share: { present: false, confidence: 'high' },
    laundry: { where: 'in-unit', confidence: 'medium' },
    dishwasher: { present: true, confidence: 'high' },
    sleeping_area: { separation: 'separate-room', confidence: 'high' },
    utilities_included: { present: null, confidence: 'low' },
  },
  light: { level: 'high', confidence: 'medium' },
  summary: 'A two-bedroom flat.',
});
check('and nothing is warned about', warnings.length, 0);

console.log('measurements that cannot be true');
// The schema says "integer", which admits all three of these. Strict structured-output mode has no
// `minimum`, so this is the only place they can be caught.
check(
  'zero square feet is not an area',
  run(good({ floorplan: { present: true, legible: true, total_sqft: 0, source: 'stated', confidence: 'high' } }))
    .floorplan.total_sqft,
  null,
);
check(
  'a negative area is dropped',
  run(good({ floorplan: { present: true, legible: true, total_sqft: -40, source: 'stated', confidence: 'high' } }))
    .floorplan.total_sqft,
  null,
);
check(
  'a fraction of a square foot is dropped',
  run(good({ floorplan: { present: true, legible: true, total_sqft: 10.5, source: 'stated', confidence: 'high' } }))
    .floorplan.total_sqft,
  null,
);
// The order-of-magnitude misread: "10500" off a plan that says "1050". A reader cannot spot it,
// because it arrives looking exactly like a number the model got right.
check(
  'an area no London flat has is dropped',
  run(good({ floorplan: { present: true, legible: true, total_sqft: 900000, source: 'stated', confidence: 'high' } }))
    .floorplan.total_sqft,
  null,
);
check('dropping a value says so', warnings.length, 1);
check('a negative bedroom count is dropped', run(good({ bedrooms: -1 })).bedrooms, null);
// Zero, on the other hand, is a studio — a real answer, and not to be confused with "unknown".
check('zero bedrooms is a studio, not a gap', run(good({ bedrooms: 0 })).bedrooms, 0);
check('a bedroom count no flat has is dropped', run(good({ bathrooms: 400 })).bathrooms, null);
// Gardens get a looser ceiling than floors, because a garden really can dwarf the house.
check(
  'a large garden is believed where a large flat would not be',
  run(good({ outdoor: { present: true, kind: 'garden', sqft: 40000, is_estimate: true, confidence: 'low' } }))
    .outdoor.sqft,
  40000,
);

console.log('claims that contradict each other');
// The review's headline case. An unreadable plan is a useful answer on its own — it tells the
// reader the listing was not assessed — but it cannot also have yielded a total.
const illegible = run(
  good({ floorplan: { present: true, legible: false, total_sqft: 1082, source: 'stated', confidence: 'low' } }),
);
check('an illegible plan carries no measurement', illegible.floorplan.total_sqft, null);
// And the provenance goes with it: "stated" with nothing stated makes that column mean nothing.
check('and its source falls back to none', illegible.floorplan.source, 'none');
check('the drop is warned about', warnings.length, 1);

check(
  'a plan that is not present cannot have been legible',
  run(good({ floorplan: { present: false, legible: true, total_sqft: null, source: 'none', confidence: 'low' } }))
    .floorplan.legible,
  false,
);
// A number with source "none" came from nowhere the model will name, which is not provenance.
check(
  'a measurement with no source is dropped',
  run(good({ floorplan: { present: true, legible: true, total_sqft: 800, source: 'none', confidence: 'high' } }))
    .floorplan.total_sqft,
  null,
);
// Not in the review, but the same species: the largest room cannot be larger than the whole flat.
check(
  'the biggest room cannot exceed the whole floor area',
  run(good({ biggest_room: { label: 'reception', sqft: 2000, confidence: 'high' } })).biggest_room.sqft,
  null,
);
check(
  'a room the size of the flat is allowed — studios exist',
  run(good({ biggest_room: { label: 'studio room', sqft: 1082, confidence: 'high' } })).biggest_room.sqft,
  1082,
);

// "No outdoor space, 120 sq ft of it" is the shape of contradiction that reads as precision.
const noOutdoor = run(
  good({ outdoor: { present: false, kind: 'terrace', sqft: 120, is_estimate: true, confidence: 'medium' } }),
);
check('no outdoor space means no outdoor area', noOutdoor.outdoor.sqft, null);
check('and no kind of outdoor space either', noOutdoor.outdoor.kind, null);
// "I could not tell" must survive as null rather than collapsing into "no".
check(
  'an unknown answer stays unknown',
  run(good({ outdoor: { present: null, kind: null, sqft: null, is_estimate: true, confidence: 'low' } }))
    .outdoor.present,
  null,
);

console.log('junk in the fields the schema was supposed to constrain');
check(
  'a confidence outside the enum reads as low',
  run(good({ bathtub: { present: true, confidence: 'pretty sure' } })).bathtub.confidence,
  'low',
);
check(
  'a source outside the enum reads as none',
  run(good({ floorplan: { present: true, legible: true, total_sqft: 900, source: 'guessed', confidence: 'high' } }))
    .floorplan.source,
  'none',
);
check('an empty kind is an absent kind, not an empty label', run(good({ outdoor: { present: true, kind: '  ', sqft: null, is_estimate: true, confidence: 'low' } })).outdoor.kind, null);
check('a malformed caption entry is dropped on its own', run(good({ images: [{ index: 0, is_floorplan: true, room: null, caption: 'ok' }, { room: 'kitchen' }] })).images.length, 1);
check('captions that are not an array cost only the captions', run(good({ images: 'none' })).images, []);

console.log('shape breakage fails loudly instead');
// A missing section is a broken contract, not a bad reading. Throwing means the caller writes no
// row and can retry; a half-built row would sit in the database looking like a finished analysis.
throws('a missing floorplan object throws', () => validateAnalysis(good({ floorplan: undefined })), /floorplan/);
throws('a missing outdoor object throws', () => validateAnalysis(good({ outdoor: null })), /outdoor/);

console.log('the amenities and the light rating');
// The one field here that is not a boolean, and the one where a default would itself be a claim:
// "none" invented out of nothing says the flat cannot wash clothes, and "in-building" invented
// out of nothing is a claim about a building nobody looked at.
check(
  'an unrecognised laundry answer becomes unknown, not a guess',
  run(amend(good(), 'amenities', { laundry: { where: 'utility room', confidence: 'high' } })).amenities.laundry.where,
  null,
);
check('warned about it', warnings.length, 1);
check(
  'a null laundry answer is unknown and passes quietly',
  run(amend(good(), 'amenities', { laundry: { where: null, confidence: 'low' } })).amenities.laundry.where,
  null,
);
check('and said nothing', warnings.length, 0);
check(
  'a house-share answer that is not a boolean becomes unknown',
  run(amend(good(), 'amenities', { house_share: { present: 'yes', confidence: 'high' } })).amenities.house_share
    .present,
  null,
);
check(
  'an unrecognised light level becomes unknown rather than medium',
  run(good({ light: { level: 'bright', confidence: 'high' } })).light.level,
  null,
);
check(
  'a null light level passes quietly',
  run(good({ light: { level: null, confidence: 'low' } })).light.level,
  null,
);
check('and said nothing', warnings.length, 0);
check(
  'an unrecognised light confidence falls back to low',
  run(good({ light: { level: 'high', confidence: 'certain' } })).light.confidence,
  'low',
);
// The same rule as light, and for the same reason: a defaulted value here would itself be a claim.
// Defaulting to "same-space" calls every studio nobody could read a bedsit; defaulting to
// "separate-room" says the hob is not at the foot of the bed when nobody has looked.
check(
  'an unrecognised separation becomes unknown rather than a guess',
  run(amend(good(), 'amenities', { sleeping_area: { separation: 'sort of', confidence: 'high' } })).amenities
    .sleeping_area.separation,
  null,
);
check(
  'a null separation passes quietly',
  run(amend(good(), 'amenities', { sleeping_area: { separation: null, confidence: 'low' } })).amenities.sleeping_area
    .separation,
  null,
);
check('and said nothing about it', warnings.length, 0);
check(
  'an unrecognised separation confidence falls back to low',
  run(amend(good(), 'amenities', { sleeping_area: { separation: 'same-space', confidence: 'certain' } })).amenities
    .sleeping_area.confidence,
  'low',
);
throws('a missing amenities object throws', () => validateAnalysis(good({ amenities: null })), /amenities/);
throws(
  'a missing sleeping_area throws — it is the studio question and a blank is not an answer',
  () => validateAnalysis(amend(good(), 'amenities', { sleeping_area: null })),
  /sleeping_area/,
);
throws('a missing light object throws', () => validateAnalysis(good({ light: null })), /light/);
throws(
  'a missing amenity inside it throws too — half a row is worse than none',
  () => validateAnalysis(amend(good(), 'amenities', { dishwasher: null })),
  /dishwasher/,
);

/** Override one key inside a nested section, leaving its siblings alone. */
function amend(base: Record<string, unknown>, section: string, patch: Record<string, unknown>) {
  return { ...base, [section]: { ...(base[section] as Record<string, unknown>), ...patch } };
}
throws('a non-object throws', () => validateAnalysis('nope'), /not a JSON object/);
throws('an array throws', () => validateAnalysis([]), /not a JSON object/);

if (failures > 0) {
  console.error(`\n${failures} failing`);
  process.exit(1);
}
console.log('\nall ok');
