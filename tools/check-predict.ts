/** Does the verdict score actually carry signal, or is it dressing up the majority class?
 *
 *  This is the check the whole feature was built behind: before any button or sort control, prove
 *  that a logistic regression fit on a real project's verdicts predicts a held-out flat better
 *  than guessing "no" every time. It runs leave-one-out cross-validation on a frozen fixture of
 *  the Daniel & Ashley project (49 rated flats, generated once from prod by
 *  `tools/export-predict-fixture.ts` — no PII, ids and numbers only), for both label modes, and
 *  fails if the model does not clear the majority-class baseline by a real margin.
 *
 *  Leave-one-out, not k-fold, because n is ~44 and every held-out flat matters: train on all but
 *  one, predict the one, repeat. The fit is deterministic, so this number is stable run to run.
 *
 *    pnpm check:predict
 */
import { readFileSync } from 'node:fs';
import {
  featuresFor,
  fitModel,
  score,
  labelFor,
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

/** AUC by the rank-sum (Mann–Whitney) identity: the probability a random positive outscores a
 *  random negative. Robust to the class imbalance here (far more nos than loves), which raw
 *  accuracy is not. */
function auc(scored: Array<{ p: number; y: 0 | 1 }>): number {
  const pos = scored.filter((s) => s.y === 1).map((s) => s.p);
  const neg = scored.filter((s) => s.y === 0).map((s) => s.p);
  if (pos.length === 0 || neg.length === 0) return 0.5;
  let wins = 0;
  for (const p of pos) for (const n of neg) wins += p > n ? 1 : p === n ? 0.5 : 0;
  return wins / (pos.length * neg.length);
}

/** Leave-one-out over the labelled rows: for each row, fit on the other n−1 and predict it. */
function leaveOneOut(fixture: Fixture, mode: LabelMode) {
  const labelled = fixture.rows
    .map((r) => ({ raw: featuresFor(inputOf(r), fixture.hubs), input: inputOf(r), y: labelFor(r.rating, mode) }))
    .filter((e): e is { raw: Record<string, number | null>; input: PredictInput; y: 0 | 1 } => e.y != null);

  const scored: Array<{ p: number; y: 0 | 1 }> = [];
  for (let i = 0; i < labelled.length; i++) {
    const train = labelled.filter((_, j) => j !== i).map((e) => ({ raw: e.raw, label: e.y }));
    const model = fitModel(train, { labelMode: mode });
    scored.push({ p: score(model, labelled[i].input, fixture.hubs), y: labelled[i].y });
  }

  const positives = labelled.filter((e) => e.y === 1).length;
  const majority = Math.max(positives, labelled.length - positives) / labelled.length;
  const accuracy = scored.filter((s) => (s.p >= 0.5 ? 1 : 0) === s.y).length / scored.length;
  return { n: labelled.length, positives, baseline: majority, accuracy, auc: auc(scored) };
}

const path = process.argv[2] ?? '.fixtures/predict-daniel-ashley.json';
const fixture: Fixture = JSON.parse(readFileSync(path, 'utf8'));

let failures = 0;
function expect(name: string, ok: boolean, detail: string) {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `\n       ${detail}`}`);
  if (!ok) failures++;
}

console.log(`verdict score — leave-one-out on ${path}\n`);
for (const mode of ['love-vs-no', 'lovemaybe-vs-no'] as LabelMode[]) {
  const r = leaveOneOut(fixture, mode);
  console.log(
    `  ${mode}: n=${r.n} pos=${r.positives}  baseline=${r.baseline.toFixed(3)}  ` +
      `accuracy=${r.accuracy.toFixed(3)}  auc=${r.auc.toFixed(3)}`,
  );
  // The bar: the model must rank a held-out yes above a held-out no clearly more often than chance.
  // AUC is the honest measure under this imbalance; 0.70 is a real margin over the 0.50 coin-flip.
  expect(`${mode} — AUC beats chance`, r.auc >= 0.7, `AUC ${r.auc.toFixed(3)} < 0.70`);
  // And it must not be worse than always saying "no".
  expect(`${mode} — accuracy >= baseline`, r.accuracy >= r.baseline - 1e-9, `accuracy ${r.accuracy.toFixed(3)} < baseline ${r.baseline.toFixed(3)}`);
}

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
