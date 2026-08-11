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
 *  null when there is no number to read, so a blank price stays missing rather than becoming 0. */
export function parseMonthlyPrice(price: string | null): number | null {
  if (!price) return null;
  const digits = price.replace(/[^0-9.]/g, '');
  if (!digits) return null;
  const value = Number(digits);
  if (!Number.isFinite(value) || value <= 0) return null;
  return /\bpw\b|per week/i.test(price) ? (value * 52) / 12 : value;
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
  /** Present on a fitted-and-scored model; absent on a bare fit. */
  metrics?: ModelMetrics;
  trainedAt?: string;
}

export interface ModelMetrics {
  n: number;
  positives: number;
  /** Leave-one-out accuracy and AUC, and the majority-class baseline it must beat to be worth it. */
  looAccuracy: number;
  looAuc: number;
  baseline: number;
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
export function fitModel(
  examples: Array<{ raw: Record<string, number | null>; label: 0 | 1 }>,
  options: FitOptions,
): Model {
  const { labelMode, lambda = 1, learningRate = 0.3, iterations = 3000 } = options;
  const columns = chooseColumns(examples.map((e) => e.raw));

  const X = examples.map((e) => rowFor(e.raw, columns));
  const y = examples.map((e) => e.label);
  const { weights, bias } = gradientDescent(X, y, lambda, learningRate, iterations);

  return { version: MODEL_VERSION, labelMode, columns, weights, bias };
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
  const weights: number[] = new Array(d).fill(0);
  let bias = 0;

  for (let it = 0; it < iterations; it++) {
    const gradW: number[] = new Array(d).fill(0);
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
  const raw = featuresFor(input, hubs);
  const x = rowFor(raw, model.columns);
  return sigmoid(linear(model.weights, x, model.bias));
}

/** Map a rating to a 0/1 label under a mode, or null to drop the row (a `maybe` under love-vs-no).
 *  A single door for the two harness runs and the real fit, so they can never label differently. */
export function labelFor(rating: 'no' | 'maybe' | 'love', mode: LabelMode): 0 | 1 | null {
  if (rating === 'no') return 0;
  if (rating === 'love') return 1;
  return mode === 'lovemaybe-vs-no' ? 1 : null;
}
