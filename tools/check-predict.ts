/** Does the verdict score actually carry signal, or is it dressing up the majority class?
 *
 *  This is the check the whole feature was built behind: before any button or sort control, prove
 *  that a logistic regression fit on a real project's verdicts predicts a held-out flat better
 *  than guessing "no" every time. It runs on a frozen fixture of one real project (generated from
 *  prod by `tools/export-predict-fixture.ts` — no PII: ids, numbers, and the hunt's own stated
 *  preferences, which have been a model input since v2), for both label modes.
 *
 *  The estimate is NESTED cross-validation, which is the honest way to score a model that tunes its
 *  hyperparameters. Outer loop: hold out a stratified fold and predict it with a model that never
 *  saw it. Inner loop: on the rest, choose the L2 strength and the prior scale by k-fold
 *  cross-validated log-loss (`selectHyperparams`), then fit with them. Because the tuning happens
 *  inside the outer fold, the held-out flats are untouched by it, so the number below is what the
 *  model would really do on the next listing — not the optimistic figure you get from tuning and
 *  testing on the same data.
 *
 *  It fails if the model does not clear the majority-class baseline by a real margin. The fit is
 *  deterministic, so these numbers are stable run to run.
 *
 *    pnpm check:predict
 */
import { existsSync, readFileSync } from 'node:fs';
import {
  auc,
  featuresFor,
  fitModel,
  scoreFeatures,
  selectHyperparams,
  labelFor,
  type Example,
  type HubPoint,
  type LabelMode,
  type PredictInput,
} from '../packages/core/src/predict';
import type { HuntPreferences } from '../packages/core/src/facts';

interface FixtureRow {
  rightmove_id: string;
  rating: 'no' | 'maybe' | 'love';
  price: string | null;
  bedrooms: number | null;
  bathrooms: number | null;
  floor_area_sqft: number | null;
  floor_area_source: 'sizings' | 'description' | null;
  furnish_type: string | null;
  lat: number | null;
  lon: number | null;
  nearest_station_dist: number | null;
  natural_light: 'low' | 'medium' | 'high' | null;
  has_outdoor_space: boolean | null;
  has_dishwasher: boolean | null;
  laundry: 'in-unit' | 'in-building' | 'none' | null;
  has_bathtub: boolean | null;
  outdoor_sqft: number | null;
  biggest_room_sqft: number | null;
  floorplan_sqft: number | null;
  floorplan_legible: boolean | null;
  is_house_share: boolean | null;
  sleeping_separation: 'separate' | 'practically-separate' | 'same-space' | null;
  utilities_included: boolean | null;
}

interface Fixture {
  hubs: HubPoint[];
  /** What the hunt was looking for when the fixture was frozen. A model input since v2. */
  preferences?: HuntPreferences | null;
  rows: FixtureRow[];
}

function inputOf(r: FixtureRow): PredictInput {
  return {
    price: r.price,
    bedrooms: r.bedrooms,
    bathrooms: r.bathrooms,
    listedSqft: r.floor_area_sqft,
    listedSource: r.floor_area_source,
    lat: r.lat,
    lon: r.lon,
    nearestStationMiles: r.nearest_station_dist,
    furnishType: r.furnish_type,
    analysis: {
      naturalLight: r.natural_light,
      hasOutdoorSpace: r.has_outdoor_space,
      outdoorSqft: r.outdoor_sqft,
      hasDishwasher: r.has_dishwasher,
      laundry: r.laundry,
      hasBathtub: r.has_bathtub,
      biggestRoomSqft: r.biggest_room_sqft,
      floorplanSqft: r.floorplan_sqft,
      floorplanLegible: r.floorplan_legible,
      isHouseShare: r.is_house_share,
      sleepingSeparation: r.sleeping_separation,
      utilitiesIncluded: r.utilities_included,
    } as PredictInput['analysis'],
  };
}

/** How many outer folds the estimate below uses.
 *
 *  It was leave-one-out when this check was written and the fixture held 49 flats. It holds 379
 *  now, and v2 searches a two-dimensional grid where v1 searched a line, so leave-one-out became
 *  354 × 28 × k fits — about twelve minutes a mode, in a check that belongs in `check:all`.
 *  Stratified 10-fold answers the same question for the same reason: every flat is still predicted
 *  by a model that never saw it, and the hyperparameters are still chosen inside the fold, so the
 *  number is still what the model would do on the next listing. It trains on 90% of the data rather
 *  than 99%, which if anything makes it read slightly low. */
const OUTER_FOLDS = 10;

/** Nested cross-validation: hold out a fold, choose the hyperparameters by inner k-fold CV on the
 *  rest, fit with them, predict the fold. Because the tuning happens inside the outer fold, the
 *  held-out flats are untouched by it. */
function nestedCv(fixture: Fixture, mode: LabelMode) {
  const labelled: Example[] = fixture.rows
    .map((r) => ({
      raw: featuresFor(inputOf(r), fixture.hubs, fixture.preferences ?? undefined),
      label: labelFor(r.rating, mode),
    }))
    .filter((e): e is Example => e.label != null);

  // Stratified by dealing each class round-robin, so every fold holds roughly the project's own
  // yes/no ratio. With 23 loves an unstratified split can hand a fold none of them.
  let pos = 0;
  let neg = 0;
  const assignment = labelled.map((e) => (e.label === 1 ? pos++ : neg++) % OUTER_FOLDS);

  const scored: Array<{ p: number; y: 0 | 1 }> = [];
  const lambdas: number[] = [];
  const scales: number[] = [];
  for (let f = 0; f < OUTER_FOLDS; f++) {
    const train = labelled.filter((_, i) => assignment[i] !== f);
    const held = labelled.filter((_, i) => assignment[i] === f);
    if (train.length === 0 || held.length === 0) continue;
    const chosen = selectHyperparams(train, { labelMode: mode });
    lambdas.push(chosen.lambda);
    scales.push(chosen.priorScale);
    const model = fitModel(train, { labelMode: mode, lambda: chosen.lambda, priorScale: chosen.priorScale });
    for (const e of held) scored.push({ p: scoreFeatures(model, e.raw), y: e.label });
  }

  const positives = labelled.filter((e) => e.label === 1).length;
  const baseline = Math.max(positives, labelled.length - positives) / labelled.length;
  const accuracy = scored.filter((s) => (s.p >= 0.5 ? 1 : 0) === s.y).length / scored.length;
  // What λ the production fit lands on, given the whole project.
  const prod = selectHyperparams(labelled, { labelMode: mode });
  return { n: labelled.length, positives, baseline, accuracy, auc: auc(scored), lambdas, scales, prod };
}

function histogram(values: number[]): string {
  const counts = new Map<number, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => a[0] - b[0]).map(([v, c]) => `${v}×${c}`).join(' ');
}

// Neutral on purpose: this file is committed, so its name is in the repo, and the repo carries no
// real names. Which project it came from is deployment data.
const DEFAULT_FIXTURE = '.fixtures/predict-project.json';
const given = process.argv[2];
const path = given ?? DEFAULT_FIXTURE;

// The fixture is a frozen read of one real project, and `.fixtures/` is not committed, so a clean
// checkout may not have it. Say so and stand down rather than failing `check:all` for a file that
// was never expected to be there — but only for the default path. A fixture named on the command
// line was named deliberately, and its absence is an error, not a circumstance.
if (!existsSync(path)) {
  if (given) throw new Error(`no fixture at ${path}`);
  console.log(
    `verdict score — SKIPPED, no fixture at ${DEFAULT_FIXTURE}\n` +
      '  This proves nothing; it only declines to fail. Generate one with:\n' +
      `    tsx tools/export-predict-fixture.ts <project_id> > ${DEFAULT_FIXTURE}`,
  );
  process.exit(0);
}

const fixture: Fixture = JSON.parse(readFileSync(path, 'utf8'));

let failures = 0;
function expect(name: string, ok: boolean, detail: string) {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `\n       ${detail}`}`);
  if (!ok) failures++;
}

/** The AUC each mode has to keep clearing.
 *
 *  Above the coin-flip bar below, and deliberately above what v1 scored on this same fixture
 *  (0.844 and 0.856): most of what v2 gained is a feature builder reading a size where v1 read a
 *  null, and the way that breaks is silently — a renamed analysis column, a `resolveSize` that
 *  starts returning null, preferences that stop being passed — none of which throws. Every one of
 *  those lands the model back near v1, and nothing else in the repo would notice.
 *
 *  Set with headroom under the measured 0.952 / 0.924, because these move a little whenever the
 *  fixture is regenerated with more verdicts. Raise them if they ever start reading as slack. */
const AUC_FLOOR: Record<LabelMode, number> = { 'love-vs-no': 0.9, 'lovemaybe-vs-no': 0.88 };

console.log(`verdict score — nested ${OUTER_FOLDS}-fold cross-validation on ${path}\n`);
for (const mode of ['love-vs-no', 'lovemaybe-vs-no'] as LabelMode[]) {
  const r = nestedCv(fixture, mode);
  console.log(
    `  ${mode}: n=${r.n} pos=${r.positives}  baseline=${r.baseline.toFixed(3)}  ` +
      `accuracy=${r.accuracy.toFixed(3)}  auc=${r.auc.toFixed(3)}`,
  );
  console.log(`    λ per fold: ${histogram(r.lambdas)}   prior scale per fold: ${histogram(r.scales)}`);
  console.log(`    production λ=${r.prod.lambda} scale=${r.prod.priorScale} (cv log-loss ${r.prod.cvLogLoss.toFixed(3)})`);
  // The bar: rank a held-out yes above a held-out no clearly more often than chance. AUC is the
  // honest measure under this imbalance; 0.70 is a real margin over the 0.50 coin-flip.
  expect(`${mode} — AUC beats chance`, r.auc >= 0.7, `AUC ${r.auc.toFixed(3)} < 0.70`);
  // And it must BEAT always saying "no", by at least one more correct held-out prediction. Merely
  // matching the baseline is what a model that answers "no" to everything scores, and a high AUC
  // does not rule that out: ranking can be perfect while every probability sits below 0.5.
  const minAccuracy = r.baseline + 1 / r.n;
  expect(
    `${mode} — accuracy beats baseline`,
    r.accuracy >= minAccuracy - 1e-9,
    `accuracy ${r.accuracy.toFixed(3)} < required ${minAccuracy.toFixed(3)} (baseline ${r.baseline.toFixed(3)} + one flat)`,
  );
  // And it must not quietly slide back to what it scored before it read the hunt's preferences and
  // the floorplan's size. See AUC_FLOOR.
  const floor = AUC_FLOOR[mode];
  expect(
    `${mode} — AUC holds its v2 floor`,
    r.auc >= floor,
    `AUC ${r.auc.toFixed(3)} < ${floor} — v1 scored 0.844/0.856 here, so this is the shape of a ` +
      'feature that stopped arriving: check resolveSize, the analysis columns, and that preferences reach featuresFor',
  );
}

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
