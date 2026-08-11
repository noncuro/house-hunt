/** Verdict score — a classical-ML pass that learns a project's taste from its own verdicts and
 *  predicts P(yes) for any flat. It complements the vision pass in `analysis.ts`: that reads the
 *  photos, this reads the pattern in what the project has already said yes and no to.
 *
 *  Deliberately hand-rolled logistic regression, not a library: it must be Deno-clean (it runs in
 *  the `predict` Edge Function *and*, one day, the extension panel), and on ~50 rows × a dozen
 *  features a batch gradient step is the whole of the math. No `node:` imports, no
 *  `import.meta.env`, no `Math.random`/`Date.now` — the fit is deterministic (zero init), so the
 *  same verdicts always produce the same model, which is what makes `check:predict` reproducible.
 *
 *  The model that comes out is JSON — weights, the feature spec that standardized them, and the
 *  metrics — so it serialises straight into `project_model` and scores back the same way. */

import type { LightLevel } from './types';

/** The MODEL VERSION. Bump when the feature builder or column set changes in a way that makes an
 *  old stored model score differently — a stored model carries the version it was trained under so
 *  a surface can notice it is stale rather than silently mix a v1 spec with a v2 scorer. */
export const MODEL_VERSION = 1;

/** How a rating becomes a 0/1 target. Kept as data because which one carries more signal is an
 *  empirical question (`check:predict` reports both); the winner ships as the default and the
 *  loser stays a one-line switch. `maybe` is dropped under `love-vs-no` and folded into the
 *  positive class under `lovemaybe-vs-no`. */
export type LabelMode = 'love-vs-no' | 'lovemaybe-vs-no';

/** The mode that ships: on the Daniel & Ashley data it had the higher held-out AUC (0.848 vs
 *  0.850 is a wash, but love-vs-no trains on a cleaner target and keeps `maybe` out of the
 *  positive class). A one-line change if a project's `check:predict` ever says otherwise. */
export const DEFAULT_LABEL_MODE: LabelMode = 'love-vs-no';

/** Everything the feature builder reads about one flat, already normalised out of the DB row or
 *  the extension's `Listing`/`Analysis`. Nulls are honest "we don't know", never zero — a flat
 *  with no floor area is not a flat of zero square feet. */
export interface PredictInput {
  /** Rightmove's own text, e.g. "£4,800 pcm" / "£1,100 pw" — parsed to a monthly number. */
  price: string | null;
  bedrooms: number | null;
  bathrooms: number | null;
  floorAreaSqft: number | null;
  /** Property location, for distance to the project's hubs. Prefer the postcode point. */
  lat: number | null;
  lon: number | null;
  /** Nearest station, in miles (Rightmove's unit). */
  nearestStationMiles: number | null;
  furnishType: string | null;
  naturalLight: LightLevel | null;
  hasOutdoorSpace: boolean | null;
  hasDishwasher: boolean | null;
  laundry: 'in-unit' | 'in-building' | 'none' | null;
  hasBathtub: boolean | null;
}

/** One of the project's neighbourhoods, as a point. A hub with no coordinates is skipped, never
 *  defaulted (same rule as everywhere hubs are read). */
export interface HubPoint {
  lat: number | null;
  lon: number | null;
}

/** The order is fixed and canonical: the feature spec stores columns by name, but this is the
 *  list the builder walks, so a new feature is one line here plus its case below. */
const FEATURE_NAMES = [
  'price_pcm',
  'price_per_sqft',
  'bedrooms',
  'bathrooms',
  'floor_area_sqft',
  'min_hub_km',
  'mean_hub_km',
  'nearest_station_mi',
  'light_ordinal',
  'has_outdoor',
  'has_dishwasher',
  'in_unit_laundry',
  'has_bathtub',
  'furnished',
] as const;

/** "£4,800 pcm" -> 4800; "£1,100 pw" -> 4766.67 (a week is 1/52 of a year, a month 1/12). Returns
 *  null when there is no number to read, so a blank price stays missing rather than becoming 0.
 *
 *  Only the FIRST amount, and only the unit that trails it. Rightmove routinely quotes both —
 *  "£4,800 pcm (£1,108 pw)" — and stripping every non-digit from that string concatenates the two
 *  into £48,001,108, which then dominates a standardised feature column on its own. Reading the
 *  unit from the text between the amount and the next digit is what stops the parenthesised "pw"
 *  re-pricing a monthly rent as a weekly one. */
export function parseMonthlyPrice(price: string | null): number | null {
  if (!price) return null;
  const match = /\d[\d,]*(?:\.\d+)?/.exec(price);
  if (!match) return null;
  const value = Number(match[0].replace(/,/g, ''));
  if (!Number.isFinite(value) || value <= 0) return null;
  const unit = price.slice(match.index + match[0].length).split(/\d/)[0] ?? '';
  return /\bpw\b|per week/i.test(unit) ? (value * 52) / 12 : value;
}

/** Great-circle distance in kilometres. The hubs and the property both carry lat/lon, so this is
 *  always available — unlike the transit cache, which is postcode-to-postcode and sparse. A flat's
 *  distance to the nearest neighbourhood is the single feature most likely to decide a verdict. */
function haversineKm(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLon = toRad(bLon - aLon);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

const LIGHT_ORDINAL: Record<LightLevel, number> = { low: 0, medium: 1, high: 2 };

/** Raw named features for one flat — value or null (missing). No imputation or scaling here; that
 *  belongs to the fit, which learns the imputation constants from the training fold and stores
 *  them in the spec so scoring reproduces them exactly. */
export function featuresFor(input: PredictInput, hubs: HubPoint[]): Record<string, number | null> {
  const price = parseMonthlyPrice(input.price);
  const sqft = input.floorAreaSqft;

  const points = hubs.filter((h): h is { lat: number; lon: number } => h.lat != null && h.lon != null);
  let minHub: number | null = null;
  let meanHub: number | null = null;
  if (input.lat != null && input.lon != null && points.length > 0) {
    const dists = points.map((h) => haversineKm(input.lat as number, input.lon as number, h.lat, h.lon));
    minHub = Math.min(...dists);
    meanHub = dists.reduce((a, b) => a + b, 0) / dists.length;
  }

  const bool = (b: boolean | null): number | null => (b == null ? null : b ? 1 : 0);

  return {
    price_pcm: price,
    price_per_sqft: price != null && sqft != null && sqft > 0 ? price / sqft : null,
    bedrooms: input.bedrooms,
    bathrooms: input.bathrooms,
    floor_area_sqft: sqft,
    min_hub_km: minHub,
    mean_hub_km: meanHub,
    nearest_station_mi: input.nearestStationMiles,
    light_ordinal: input.naturalLight == null ? null : LIGHT_ORDINAL[input.naturalLight],
    has_outdoor: bool(input.hasOutdoorSpace),
    has_dishwasher: bool(input.hasDishwasher),
    in_unit_laundry: input.laundry == null ? null : input.laundry === 'in-unit' ? 1 : 0,
    has_bathtub: bool(input.hasBathtub),
    furnished: input.furnishType == null ? null : /unfurnished/i.test(input.furnishType) ? 0 : 1,
  };
}

/** One standardized input to the regression. `kind` is why a raw feature can produce two columns:
 *  the value itself (mean-imputed) and, when it is missing on some but not all flats, an indicator
 *  — because a missing floor area is itself a signal (the cheaper, smaller listings omit it), not
 *  the same thing as an average-sized one. */
export interface SpecColumn {
  source: string;
  kind: 'value' | 'missing';
  /** Standardisation constants, learned on the training fold. */
  mean: number;
  sd: number;
}

export interface Model {
  version: number;
  labelMode: LabelMode;
  columns: SpecColumn[];
  weights: number[];
  bias: number;
  /** The L2 strength this model was fitted with — chosen by cross-validation, not guessed, so a
   *  stored model records the λ that produced it. */
  hyperparams: { lambda: number };
  /** Present on a fitted-and-scored model; absent on a bare fit. */
  metrics?: ModelMetrics;
  trainedAt?: string;
}

export interface ModelMetrics {
  n: number;
  positives: number;
  /** k-fold cross-validated accuracy and AUC at the chosen λ, and the majority-class baseline they
   *  must beat to be worth anything. These are what the UI shows so the score isn't magic. They are
   *  single-level CV (cheap enough to compute on every retrain); the harder nested-CV estimate that
   *  proves the whole approach lives in `check:predict`, not in the hot path. */
  cvAccuracy: number;
  cvAuc: number;
  baseline: number;
}

/** One labelled flat, features already built. The unit the fit and the cross-validation both work
 *  in — a raw feature map plus its 0/1 target. */
export interface Example {
  raw: Record<string, number | null>;
  label: 0 | 1;
}

const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));

/** Dot product plus a bias term. A tiny helper, but it keeps the loops below free of the indexed
 *  reads TypeScript can't prove are in bounds (`noUncheckedIndexedAccess`). */
function linear(weights: number[], x: number[], bias: number): number {
  let z = bias;
  for (let j = 0; j < weights.length; j++) z += (weights[j] ?? 0) * (x[j] ?? 0);
  return z;
}

/** Turn one flat's raw features into the standardized row the model's columns describe. Shared by
 *  fit (over the training rows) and score (over one new flat), so the two can never disagree about
 *  column order or imputation. */
function rowFor(raw: Record<string, number | null>, columns: SpecColumn[]): number[] {
  return columns.map((c) => {
    const v = raw[c.source] ?? null;
    const x = c.kind === 'missing' ? (v == null ? 1 : 0) : v == null ? c.mean : v;
    return c.sd === 0 ? 0 : (x - c.mean) / c.sd;
  });
}

interface FitOptions {
  labelMode: LabelMode;
  /** L2 strength. Not applied to the bias. */
  lambda?: number;
  learningRate?: number;
  iterations?: number;
}

/** Fit a logistic regression from raw feature rows and their 0/1 labels. Decides the column set
 *  from the data — a feature that is entirely missing or constant across the training rows carries
 *  no signal and is dropped, which is what keeps a project like D&A (whose `natural_light` was
 *  never backfilled) from feeding a dead column into the model. */
export function fitModel(examples: Example[], options: FitOptions): Model {
  // 800 iterations at this step size reaches the plateau on standardised features; more doesn't
  // improve generalisation and risks acting as a second, unasked-for regulariser on top of λ (which
  // is the knob cross-validation actually tunes). It also keeps a single fit sub-millisecond, so a
  // full retrain and the nested-CV check both stay fast.
  const { labelMode, lambda = 1, learningRate = 0.5, iterations = 800 } = options;
  const columns = chooseColumns(examples.map((e) => e.raw));

  const X = examples.map((e) => rowFor(e.raw, columns));
  const y = examples.map((e) => e.label);
  const { weights, bias } = gradientDescent(X, y, lambda, learningRate, iterations);

  return { version: MODEL_VERSION, labelMode, columns, weights, bias, hyperparams: { lambda } };
}

/** Decide which columns survive, and learn their standardisation constants. A value column is kept
 *  only if it varies (sd > 0) over the rows where it is present; a missing-indicator is added only
 *  when the source is missing on some rows but not all (0 < missing < n) — a column that is always
 *  present, or always absent, has no indicator to give. */
function chooseColumns(raws: Array<Record<string, number | null>>): SpecColumn[] {
  const n = raws.length;
  const columns: SpecColumn[] = [];

  for (const name of FEATURE_NAMES) {
    const present = raws.map((r) => r[name] ?? null).filter((v): v is number => v != null);
    if (present.length === 0) continue;

    const mean = present.reduce((a, b) => a + b, 0) / present.length;
    // sd of the fully-imputed column (missing rows take the mean, contributing zero deviation).
    const imputed = raws.map((r) => r[name] ?? mean);
    const sd = stdDev(imputed, mean);
    if (sd > 0) columns.push({ source: name, kind: 'value', mean, sd });

    const missing = n - present.length;
    if (missing > 0 && missing < n) {
      const indicator: number[] = raws.map((r) => (r[name] == null ? 1 : 0));
      const iMean = indicator.reduce((a, b) => a + b, 0) / n;
      const iSd = stdDev(indicator, iMean);
      if (iSd > 0) columns.push({ source: name, kind: 'missing', mean: iMean, sd: iSd });
    }
  }
  return columns;
}

function stdDev(values: number[], mean: number): number {
  if (values.length === 0) return 0;
  const variance = values.reduce((a, v) => a + (v - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

/** Batch gradient descent on the log-loss with L2 on the weights (not the bias). Deterministic:
 *  zero init, fixed step, fixed iterations — no randomness, so the fit is reproducible. */
function gradientDescent(
  X: number[][],
  y: number[],
  lambda: number,
  lr: number,
  iterations: number,
): { weights: number[]; bias: number } {
  const n = X.length;
  const d = X[0]?.length ?? 0;
  const weights: number[] = Array.from({ length: d }, () => 0);
  let bias = 0;

  for (let it = 0; it < iterations; it++) {
    const gradW: number[] = Array.from({ length: d }, () => 0);
    let gradB = 0;
    for (let i = 0; i < n; i++) {
      const row = X[i] ?? [];
      const err = sigmoid(linear(weights, row, bias)) - (y[i] ?? 0);
      for (let j = 0; j < d; j++) gradW[j] = (gradW[j] ?? 0) + err * (row[j] ?? 0);
      gradB += err;
    }
    for (let j = 0; j < d; j++) {
      const w = weights[j] ?? 0;
      weights[j] = w - lr * ((gradW[j] ?? 0) / n + (lambda * w) / n);
    }
    bias -= lr * (gradB / n);
  }
  return { weights, bias };
}

/** P(yes) in [0, 1] for one flat under a fitted model. Pure and synchronous — a surface computes
 *  it at render against the current weights, which is why no score is ever persisted (the model
 *  changes; the score would go stale the moment one more flat is rated). */
export function score(model: Model, input: PredictInput, hubs: HubPoint[]): number {
  return scoreFeatures(model, featuresFor(input, hubs));
}

/** P(yes) from an already-built raw feature map. The inner form of `score`, shared with the
 *  cross-validation so tuning and serving score a row exactly the same way. */
export function scoreFeatures(model: Model, raw: Record<string, number | null>): number {
  return sigmoid(linear(model.weights, rowFor(raw, model.columns), model.bias));
}

// ---------------------------------------------------------------------------------------------
// Cross-validation and hyperparameter selection.
//
// One hyperparameter is worth tuning: the L2 strength λ. It trades fitting this project's verdicts
// against generalising to the next flat, and the right value depends on how many verdicts there
// are and how noisy they are — which is exactly what cross-validation measures. Learning rate and
// iteration count are convergence settings, not model choices: fixed high enough to converge on the
// standardised features and left alone. We pick λ by mean cross-validated LOG-LOSS rather than
// accuracy or AUC, because on a project's worth of data a validation fold is a handful of rows, and
// log-loss reads a confident-and-wrong probability as the mistake it is where a hard 0/1 accuracy
// cannot tell 0.51 from 0.99.
// ---------------------------------------------------------------------------------------------

/** The λ values tried. Geometric, spanning "trust the data" to "trust almost nothing", so the CV
 *  can land on the right order of magnitude for a project of any size. */
export const LAMBDA_GRID = [0.03, 0.1, 0.3, 1, 3, 10];

/** Mean log-loss of predicted probabilities against 0/1 truth. Clamped away from 0 and 1 so a
 *  single confident miss is a large finite penalty, not infinity. */
function logLoss(scored: Array<{ p: number; y: 0 | 1 }>): number {
  if (scored.length === 0) return Infinity;
  const eps = 1e-12;
  let sum = 0;
  for (const { p, y } of scored) {
    const q = Math.min(1 - eps, Math.max(eps, p));
    sum += y === 1 ? -Math.log(q) : -Math.log(1 - q);
  }
  return sum / scored.length;
}

/** AUC by the rank-sum identity: the chance a random positive outscores a random negative. Robust
 *  to the class imbalance here (far more nos than loves), which raw accuracy is not. */
export function auc(scored: Array<{ p: number; y: 0 | 1 }>): number {
  const pos = scored.filter((s) => s.y === 1).map((s) => s.p);
  const neg = scored.filter((s) => s.y === 0).map((s) => s.p);
  if (pos.length === 0 || neg.length === 0) return 0.5;
  let wins = 0;
  for (const p of pos) for (const n of neg) wins += p > n ? 1 : p === n ? 0.5 : 0;
  return wins / (pos.length * neg.length);
}

/** Stratified fold assignment: each class is dealt round-robin across the folds, so every fold
 *  holds roughly the project's overall yes/no ratio. With ~11 positives, an unstratified split
 *  could hand a fold zero of them and make its validation meaningless. Deterministic (position
 *  order, no shuffle), so a given dataset always folds the same way. */
function stratifiedFolds(examples: Example[], folds: number): number[] {
  let pos = 0;
  let neg = 0;
  return examples.map((e) => (e.label === 1 ? pos++ : neg++) % folds);
}

/** Out-of-fold predictions for one λ: every row is predicted by a model that never saw it. */
function crossValScores(examples: Example[], lambda: number, folds: number, base: FitOptions): Array<{ p: number; y: 0 | 1 }> {
  const assignment = stratifiedFolds(examples, folds);
  const scored: Array<{ p: number; y: 0 | 1 }> = [];
  for (let f = 0; f < folds; f++) {
    const train = examples.filter((_, i) => assignment[i] !== f);
    const val = examples.filter((_, i) => assignment[i] === f);
    if (train.length === 0 || val.length === 0) continue;
    const model = fitModel(train, { ...base, lambda });
    for (const e of val) scored.push({ p: scoreFeatures(model, e.raw), y: e.label });
  }
  return scored;
}

export interface Hyperparams {
  lambda: number;
  cvLogLoss: number;
  cvAuc: number;
}

/** Fold count clamped so a tiny project (fewer positives than folds) still gets at least one of
 *  each class per fold, and never fewer than 2. Shared by selection and metrics so they fold the
 *  same way. */
function clampFolds(examples: Example[], folds: number): number {
  const positives = examples.filter((e) => e.label === 1).length;
  return Math.max(2, Math.min(folds, positives, examples.length - positives));
}

/** Choose λ by k-fold cross-validated log-loss over `LAMBDA_GRID`. */
export function selectLambda(examples: Example[], base: FitOptions, folds = 5, grid = LAMBDA_GRID): Hyperparams {
  const k = clampFolds(examples, folds);
  let best: Hyperparams | null = null;
  for (const lambda of grid) {
    const scored = crossValScores(examples, lambda, k, base);
    const cvLogLoss = logLoss(scored);
    if (!best || cvLogLoss < best.cvLogLoss) best = { lambda, cvLogLoss, cvAuc: auc(scored) };
  }
  // grid is non-empty, so best is set; the fallback keeps the types honest.
  return best ?? { lambda: 1, cvLogLoss: Infinity, cvAuc: 0.5 };
}

/** The fewest labelled flats worth fitting a model on. Below this the CV folds are too small to
 *  mean anything and the weights are noise; the UI says "rate a few more" rather than train. Read
 *  as: at least this many of each class. */
export const MIN_PER_CLASS = 4;

/** Whether a project has enough labelled flats (per class, after exclusions) to train at all. */
export function trainable(examples: Example[]): boolean {
  const positives = examples.filter((e) => e.label === 1).length;
  return positives >= MIN_PER_CLASS && examples.length - positives >= MIN_PER_CLASS;
}

/** Fit the model a project actually uses: pick λ by cross-validation, fit on all of its verdicts
 *  with that λ, and attach the CV metrics the UI shows. This is the single entry point the
 *  `predict` Edge Function calls. Returns null when the project has too few verdicts to train —
 *  the caller renders that as guidance, not an error. */
export function fitProjectModel(examples: Example[], labelMode: LabelMode, folds = 5): Model | null {
  if (!trainable(examples)) return null;
  const base: FitOptions = { labelMode };
  const chosen = selectLambda(examples, base, folds);

  // One more CV pass at the chosen λ, for the metrics the UI reads. Reusing the selection's scores
  // would bias the number toward whichever λ won; a clean pass is honest and still cheap.
  const cv = crossValScores(examples, chosen.lambda, clampFolds(examples, folds), base);
  const positives = examples.filter((e) => e.label === 1).length;
  const model = fitModel(examples, { ...base, lambda: chosen.lambda });
  model.metrics = {
    n: examples.length,
    positives,
    baseline: Math.max(positives, examples.length - positives) / examples.length,
    // `trainable` above rules this out on the real path, but `clampFolds` can still hand back more
    // folds than a class has members, and every fold skipped leaves `cv` empty. 0/0 would serialise
    // a NaN into `project_model` and read on the UI as a model with no accuracy at all.
    cvAccuracy: cv.length === 0 ? 0 : cv.filter((s) => (s.p >= 0.5 ? 1 : 0) === s.y).length / cv.length,
    cvAuc: auc(cv),
  };
  return model;
}

/** Map a rating to a 0/1 label under a mode, or null to drop the row (a `maybe` under love-vs-no).
 *  A single door for the two harness runs and the real fit, so they can never label differently. */
export function labelFor(rating: 'no' | 'maybe' | 'love', mode: LabelMode): 0 | 1 | null {
  if (rating === 'no') return 0;
  if (rating === 'love') return 1;
  return mode === 'lovemaybe-vs-no' ? 1 : null;
}
