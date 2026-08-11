/** Does the verdict score actually carry signal, or is it dressing up the majority class?
 *
 *  This is the check the whole feature was built behind: before any button or sort control, prove
 *  that a logistic regression fit on a real project's verdicts predicts a held-out flat better
 *  than guessing "no" every time. It runs on a frozen fixture of the Daniel & Ashley project (49
 *  rated flats, generated once from prod by `tools/export-predict-fixture.ts` — no PII, ids and
 *  numbers only), for both label modes.
 *
 *  The estimate is NESTED cross-validation, which is the honest way to score a model that tunes a
 *  hyperparameter. Outer loop: leave-one-out — hold out one flat, predict it with a model that
 *  never saw it. Inner loop: on the other n−1 flats, choose λ by k-fold cross-validated log-loss
 *  (`selectLambda`), then fit with it. Because λ is chosen inside the outer fold, the held-out
 *  flat is untouched by tuning, so the number below is what the model would really do on the next
 *  listing — not the optimistic figure you get from tuning and testing on the same data.
 *
 *  It fails if the model does not clear the majority-class baseline by a real margin. The fit is
 *  deterministic, so these numbers are stable run to run.
 *
 *    pnpm check:predict
 */
import { readFileSync } from 'node:fs';
import {
  auc,
  featuresFor,
  fitModel,
  scoreFeatures,
  selectLambda,
  labelFor,
  type Example,
  type HubPoint,
  type LabelMode,
  type PredictInput,
} from '../packages/core/src/predict';

interface FixtureRow {
  rightmove_id: string;
  rating: 'no' | 'maybe' | 'love';
  price: string | null;
  bedrooms: number | null;
  bathrooms: number | null;
  floor_area_sqft: number | null;
  furnish_type: string | null;
  lat: number | null;
  lon: number | null;
  nearest_station_dist: number | null;
  natural_light: 'low' | 'medium' | 'high' | null;
  has_outdoor_space: boolean | null;
  has_dishwasher: boolean | null;
  laundry: 'in-unit' | 'in-building' | 'none' | null;
  has_bathtub: boolean | null;
}

interface Fixture {
  hubs: HubPoint[];
  rows: FixtureRow[];
}

function inputOf(r: FixtureRow): PredictInput {
  return {
    price: r.price,
    bedrooms: r.bedrooms,
    bathrooms: r.bathrooms,
    floorAreaSqft: r.floor_area_sqft,
    lat: r.lat,
    lon: r.lon,
    nearestStationMiles: r.nearest_station_dist,
    furnishType: r.furnish_type,
    naturalLight: r.natural_light,
    hasOutdoorSpace: r.has_outdoor_space,
    hasDishwasher: r.has_dishwasher,
    laundry: r.laundry,
    hasBathtub: r.has_bathtub,
  };
}

/** Nested leave-one-out: for each row, select λ by inner k-fold CV on the rest, fit, predict. */
function nestedLoo(fixture: Fixture, mode: LabelMode) {
  const labelled: Example[] = fixture.rows
    .map((r) => ({ raw: featuresFor(inputOf(r), fixture.hubs), label: labelFor(r.rating, mode) }))
    .filter((e): e is Example => e.label != null);

  const scored: Array<{ p: number; y: 0 | 1 }> = [];
  const lambdas: number[] = [];
  for (let i = 0; i < labelled.length; i++) {
    const held = labelled[i]!;
    const train = labelled.filter((_, j) => j !== i);
    const chosen = selectLambda(train, { labelMode: mode });
    lambdas.push(chosen.lambda);
    const model = fitModel(train, { labelMode: mode, lambda: chosen.lambda });
    scored.push({ p: scoreFeatures(model, held.raw), y: held.label });
  }

  const positives = labelled.filter((e) => e.label === 1).length;
  const baseline = Math.max(positives, labelled.length - positives) / labelled.length;
  const accuracy = scored.filter((s) => (s.p >= 0.5 ? 1 : 0) === s.y).length / scored.length;
  // What λ the production fit lands on, given the whole project.
  const prod = selectLambda(labelled, { labelMode: mode });
  return { n: labelled.length, positives, baseline, accuracy, auc: auc(scored), lambdas, prod };
}

function lambdaHistogram(lambdas: number[]): string {
  const counts = new Map<number, number>();
  for (const l of lambdas) counts.set(l, (counts.get(l) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => a[0] - b[0]).map(([l, c]) => `${l}×${c}`).join(' ');
}

const path = process.argv[2] ?? '.fixtures/predict-daniel-ashley.json';
const fixture: Fixture = JSON.parse(readFileSync(path, 'utf8'));

let failures = 0;
function expect(name: string, ok: boolean, detail: string) {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `\n       ${detail}`}`);
  if (!ok) failures++;
}

console.log(`verdict score — nested leave-one-out on ${path}\n`);
for (const mode of ['love-vs-no', 'lovemaybe-vs-no'] as LabelMode[]) {
  const r = nestedLoo(fixture, mode);
  console.log(
    `  ${mode}: n=${r.n} pos=${r.positives}  baseline=${r.baseline.toFixed(3)}  ` +
      `accuracy=${r.accuracy.toFixed(3)}  auc=${r.auc.toFixed(3)}`,
  );
  console.log(`    λ chosen per fold: ${lambdaHistogram(r.lambdas)}   production λ=${r.prod.lambda} (cv log-loss ${r.prod.cvLogLoss.toFixed(3)})`);
  // The bar: rank a held-out yes above a held-out no clearly more often than chance. AUC is the
  // honest measure under this imbalance; 0.70 is a real margin over the 0.50 coin-flip.
  expect(`${mode} — AUC beats chance`, r.auc >= 0.7, `AUC ${r.auc.toFixed(3)} < 0.70`);
  // And it must not be worse than always saying "no".
  expect(`${mode} — accuracy >= baseline`, r.accuracy >= r.baseline - 1e-9, `accuracy ${r.accuracy.toFixed(3)} < baseline ${r.baseline.toFixed(3)}`);
}

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
