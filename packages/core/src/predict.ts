/** Verdict score — a classical-ML pass that learns a project's taste from its own verdicts and
 *  predicts P(yes) for any flat. It complements the vision pass in `analysis.ts`: that reads the
 *  photos, this reads the pattern in what the project has already said yes and no to.
 *
 *  Deliberately hand-rolled logistic regression, not a library: it must be Deno-clean (it runs in
 *  the `predict` Edge Function *and*, one day, the extension panel), and on a few hundred rows × a
 *  couple of dozen features a batch gradient step is the whole of the math. No `node:` imports, no
 *  `import.meta.env`, no `Math.random`/`Date.now` — the fit is deterministic (zero init), so the
 *  same verdicts always produce the same model, which is what makes `check:predict` reproducible.
 *
 *  The model that comes out is JSON — weights, the feature spec that standardized them, and the
 *  metrics — so it serialises straight into `project_model` and scores back the same way.
 *
 *  What it learns from is wider than the verdicts alone, and that is the substance of v2: the flat's
 *  size is resolved the way every other surface resolves it, the outdoor space is a quantity rather
 *  than a flag, and the hunt's own answers on the Your Hunt page enter twice — as features (does
 *  this flat clear your bar, how many of your must-haves is it known to miss) and as the *centre* the
 *  weights are shrunk toward, instead of zero. `docs/verdict-model.md` is the study behind each of
 *  those, including the several things that sounded better and were not. */

import { AMENITIES, resolveSize, type HuntPreferences } from './facts';
import type { Analysis } from './types';

/** The MODEL VERSION. Bump when the feature builder or column set changes in a way that makes an
 *  old stored model score differently — a stored model carries the version it was trained under so
 *  a surface can notice it is stale rather than silently mix a v1 spec with a v2 scorer.
 *
 *  v2: `best_sqft` via `resolveSize` (was a raw column), `log1p_outdoor`, `biggest_room_sqft`,
 *  `price_band_dist` and the four preference columns; missing indicators narrowed to the
 *  size-derived columns; and the prior means below. */
export const MODEL_VERSION = 2;

/** How a rating becomes a 0/1 target. Kept as data because which one carries more signal is an
 *  empirical question (`check:predict` reports both); the winner ships as the default and the
 *  loser stays a one-line switch. `maybe` is dropped under `love-vs-no` and folded into the
 *  positive class under `lovemaybe-vs-no`. */
export type LabelMode = 'love-vs-no' | 'lovemaybe-vs-no';

/** The mode that ships. It trains on a cleaner target — `maybe` is genuinely intermediate, and the
 *  scores bear that out (mean P(yes) 0.04 / 0.24 / 0.38 across no / maybe / love) — and it is the
 *  mode the feature and prior work below was tuned on. A one-line change if a project's
 *  `check:predict` ever says otherwise. */
export const DEFAULT_LABEL_MODE: LabelMode = 'love-vs-no';

/** Everything the feature builder reads about one flat, already normalised out of the DB row or
 *  the extension's `Listing`/`Analysis`. Nulls are honest "we don't know", never zero — a flat
 *  with no floor area is not a flat of zero square feet. */
export interface PredictInput {
  /** Rightmove's own text, e.g. "£4,800 pcm" / "£1,100 pw" — parsed to a monthly number. */
  price: string | null;
  bedrooms: number | null;
  bathrooms: number | null;
  /** Rightmove's floor area and where it came from. Not read directly: it is one candidate into
   *  `resolveSize`, which prefers a legible floorplan over a number typed into prose. */
  listedSqft: number | null;
  listedSource: 'sizings' | 'description' | null;
  /** The property's own point. Distance to a hub is a different question from routing a journey,
   *  which starts at the postcode — see the note on `min_hub_km` below. */
  lat: number | null;
  lon: number | null;
  /** Nearest station, in miles (Rightmove's unit). */
  nearestStationMiles: number | null;
  furnishType: string | null;
  /** The vision pass's read of the photos and floorplan, whole. Whole rather than flattened
   *  because the amenity columns are computed by `AMENITIES`, whose `present` predicates take this
   *  shape — the same predicates the panel's flags use, so a flat cannot be "missing a must-have"
   *  on one screen and not on another. */
  analysis: Analysis | null;
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
  'ppsf_best',
  'bedrooms',
  'bathrooms',
  'best_sqft',
  'min_hub_km',
  'mean_hub_km',
  'nearest_station_mi',
  'light_ordinal',
  'has_outdoor',
  'has_dishwasher',
  'in_unit_laundry',
  'has_bathtub',
  'furnished',
  'log1p_outdoor',
  'biggest_room_sqft',
  'price_band_dist',
  'meets_min_sqft',
  'meets_great_room',
  'unmet_musts',
  'unmet_nices',
] as const;

/** The columns that get a missing-indicator, and the only ones.
 *
 *  A missing size is a fact about the listing — the cheaper, smaller places omit it — so "we were
 *  not told" is worth a column of its own. A missing `natural_light` is a fact about *us*: that
 *  field arrived in a later version of the analysis prompt, so the flats lacking it are exactly the
 *  ones analysed before a particular day. On this project those were the original hand-curated
 *  shortlist, which was loved at 20% against 4% for everything swept up afterwards — so an
 *  indicator on them let the model read our deployment history as taste, worth an illusory 0.02
 *  AUC. Indicators everywhere scored below indicators here; so did indicators nowhere. */
const INDICATOR_COLUMNS = new Set(['best_sqft', 'ppsf_best', 'log1p_outdoor', 'biggest_room_sqft']);

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
 *  distance to the nearest neighbourhood is the single feature most likely to decide a verdict:
 *  among the flats that clear the obvious size and outdoor bars, it ranks them as well on its own
 *  as the whole model does. */
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

const LIGHT_ORDINAL = { low: 0, medium: 1, high: 2 } as const;

/** The middle of the hunt's stated price range, or null when it has not stated one. Distance from
 *  it is the feature; the *level* is not, because a search with a floor has already spent the
 *  cheap-is-good signal — everything in the pile is affordable, so price stops discriminating and
 *  measures 0.58 on its own. What is left is that the extremes of a band are chosen less often. */
function bandMidpoint(prefs: HuntPreferences | undefined): number | null {
  const min = Number(prefs?.search?.minPrice);
  const max = Number(prefs?.search?.maxPrice);
  const ok = (v: number) => Number.isFinite(v) && v > 0;
  if (!ok(min) && !ok(max)) return null;
  if (!ok(min)) return max;
  if (!ok(max)) return min;
  return (min + max) / 2;
}

/** How many amenities the hunt marked at this level a flat is *known* to lack.
 *
 *  Known, and only known: `present` answers true, false, or null, and a null is a photograph that
 *  did not show a bathtub rather than a flat without one. Counting unknowns as failures would
 *  penalise exactly the listings we know least about, which is the rule the triage filter already
 *  follows and for the same reason.
 *
 *  A count rather than one column per amenity, because the two score the same and a count is the
 *  same shape for every project — per-amenity columns would rename themselves whenever somebody
 *  ticked a different box, and the stored feature spec would be project-shaped. */
function unmetCount(
  analysis: Analysis | null,
  prefs: HuntPreferences | undefined,
  want: 'must' | 'nice',
): number {
  if (!analysis || !prefs?.amenities) return 0;
  let count = 0;
  for (const amenity of AMENITIES) {
    if (prefs.amenities[amenity.key] !== want) continue;
    if (amenity.present(analysis) === false) count++;
  }
  return count;
}

/** Whether a value clears a bar the hunt has set. Null when either side is unknown — a bar nobody
 *  set is not a bar everything passes, and a flat whose size we could not read has not failed it. */
function clears(value: number | null | undefined, bar: number | null | undefined): number | null {
  if (value == null || bar == null) return null;
  return value >= bar ? 1 : 0;
}

/** Raw named features for one flat — value or null (missing). No imputation or scaling here; that
 *  belongs to the fit, which learns the imputation constants from the training fold and stores
 *  them in the spec so scoring reproduces them exactly.
 *
 *  `prefs` is what the hunt said on the Your Hunt page. Absent is a hunt that has never opened it,
 *  and every column that depends on a bar it did not set comes out null for every flat — which
 *  `chooseColumns` then drops entirely, so an unset preference costs nothing and defaults nothing. */
export function featuresFor(
  input: PredictInput,
  hubs: HubPoint[],
  prefs?: HuntPreferences,
): Record<string, number | null> {
  const price = parseMonthlyPrice(input.price);
  const analysis = input.analysis ?? null;
  // The size every other surface shows: a legible floorplan first, then what Rightmove published as
  // data, then a number out of the description. Reading `floor_area_sqft` alone both lost a size
  // for a quarter of the flats and trusted the odd junk value — one listing states 1 sq ft against
  // a floorplan measured at 844.
  const sqft =
    resolveSize({
      floorplanSqft: analysis?.floorplanSqft,
      floorplanLegible: analysis?.floorplanLegible,
      listedSqft: input.listedSqft,
      listedSource: input.listedSource,
    })?.value ?? null;

  const points = hubs.filter((h): h is { lat: number; lon: number } => h.lat != null && h.lon != null);
  let minHub: number | null = null;
  let meanHub: number | null = null;
  if (input.lat != null && input.lon != null && points.length > 0) {
    const dists = points.map((h) => haversineKm(input.lat as number, input.lon as number, h.lat, h.lon));
    minHub = Math.min(...dists);
    meanHub = dists.reduce((a, b) => a + b, 0) / dists.length;
  }

  const bool = (b: boolean | null | undefined): number | null => (b == null ? null : b ? 1 : 0);
  const light = analysis?.naturalLight;
  const laundry = analysis?.laundry;
  const outdoorSqft = analysis?.outdoorSqft;
  const midpoint = bandMidpoint(prefs);

  return {
    price_pcm: price,
    ppsf_best: price != null && sqft != null && sqft > 0 ? price / sqft : null,
    bedrooms: input.bedrooms,
    bathrooms: input.bathrooms,
    best_sqft: sqft,
    min_hub_km: minHub,
    mean_hub_km: meanHub,
    nearest_station_mi: input.nearestStationMiles,
    light_ordinal: light == null ? null : LIGHT_ORDINAL[light],
    has_outdoor: bool(analysis?.hasOutdoorSpace),
    has_dishwasher: bool(analysis?.hasDishwasher),
    in_unit_laundry: laundry == null ? null : laundry === 'in-unit' ? 1 : 0,
    has_bathtub: bool(analysis?.hasBathtub),
    furnished: input.furnishType == null ? null : /unfurnished/i.test(input.furnishType) ? 0 : 1,
    // A balcony and a garden are not the same fact, which is all `has_outdoor` could say. Logged
    // because the difference between 20 and 60 sq ft matters and between 600 and 640 does not.
    log1p_outdoor: outdoorSqft != null && outdoorSqft >= 0 ? Math.log1p(outdoorSqft) : null,
    biggest_room_sqft: analysis?.biggestRoomSqft ?? null,
    price_band_dist: price != null && midpoint != null ? Math.abs(price - midpoint) : null,
    meets_min_sqft: clears(sqft, prefs?.minSqft),
    // The bar the great-room mark actually sits at, which is the aim when there is one and the
    // floor otherwise — the same `bigThreshold` the flag is drawn from.
    meets_great_room: clears(analysis?.biggestRoomSqft, prefs?.greatRoomMinSqft ?? prefs?.greatRoomFloorSqft),
    unmet_musts: unmetCount(analysis, prefs, 'must'),
    unmet_nices: unmetCount(analysis, prefs, 'nice'),
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
  /** The L2 strength and prior scale this model was fitted with — both chosen by cross-validation,
   *  not guessed, so a stored model records the pair that produced it. */
  hyperparams: { lambda: number; priorScale: number };
  /** Present on a fitted-and-scored model; absent on a bare fit. */
  metrics?: ModelMetrics;
  trainedAt?: string;
}

export interface ModelMetrics {
  n: number;
  positives: number;
  /** k-fold cross-validated accuracy and AUC at the chosen hyperparameters, and the majority-class
   *  baseline they must beat to be worth anything. These are what the UI shows so the score isn't
   *  magic. They are single-level CV (cheap enough to compute on every retrain); the harder
   *  nested-CV estimate that proves the whole approach lives in `check:predict`, not in the hot
   *  path. */
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

// ---------------------------------------------------------------------------------------------
// The prior.
//
// Ordinary L2 shrinks every weight toward zero, which is the belief that no feature matters until
// the data insists. On a hunt with 23 loves that belief is expensive, and it is also false: some of
// these features have a direction everybody already agrees on. So the weights are shrunk toward
// those signs instead — outdoor space and a bathtub upward, distance to a saved place downward, a
// must-have the flat misses sharply downward.
//
// The table is by column name and is the same for every hunt, which is worth being clear about,
// because the two halves of "the score reads the hunt's own preferences" are easy to run together.
// What the hunt said enters as *features* — `unmet_musts`, `unmet_nices`, `meets_min_sqft`,
// `meets_great_room` are each computed against that hunt's own answers, so they already say
// something different on every project. This table only says which way each of those columns should
// point before any verdict has been read, and "a flat that misses something you called a must-have
// is worse" does not vary by hunt. A prior conditioned on the preferences on top of features that
// already are would be saying it twice.
//
// This is worth about +0.04 AUC on this project's love-vs-no when positives are scarce, and it
// decays as verdicts accumulate — at 20 to 60 verdicts it is three times the size it is at 350,
// which is the shape you want from a prior. `scale` includes 0, so a hunt whose verdicts disagree
// with its own settings can overrule them entirely.
//
// `price_pcm` is deliberately 0 rather than negative. Cheaper is NOT better inside a band with a
// floor: the search has already excluded everything unaffordable, so what is left is quality-
// seeking, and raw price measures 0.58 on its own. Do not "fix" this to a negative.
// ---------------------------------------------------------------------------------------------

const PRIOR_MEANS: Record<string, number> = {
  price_pcm: 0,
  ppsf_best: -1,
  price_band_dist: -0.5,
  bedrooms: 0,
  bathrooms: 0,
  best_sqft: 1,
  biggest_room_sqft: 1,
  log1p_outdoor: 1,
  min_hub_km: -1,
  mean_hub_km: -1,
  nearest_station_mi: -1,
  light_ordinal: 1,
  has_outdoor: 2,
  has_dishwasher: 0.5,
  in_unit_laundry: 1,
  has_bathtub: 2,
  furnished: 0,
  meets_min_sqft: 1,
  meets_great_room: 1,
  unmet_musts: -2,
  unmet_nices: -0.5,
};

/** The prior mean for one column, at a given scale. A missing-indicator has no prior — whether an
 *  absent floor area predicts a yes or a no is exactly the sort of thing only the data knows. */
function priorFor(column: SpecColumn, scale: number): number {
  if (column.kind === 'missing') return 0;
  return (PRIOR_MEANS[column.source] ?? 0) * scale;
}

interface FitOptions {
  labelMode: LabelMode;
  /** L2 strength. Not applied to the bias. */
  lambda?: number;
  /** How far the prior means are pushed from zero. 0 is ordinary zero-mean L2. */
  priorScale?: number;
  learningRate?: number;
  /** A ceiling on the descent, not a budget to be spent — see `MAX_ITERATIONS`. */
  iterations?: number;
  /** Where to start the descent, in `columns` order.
   *
   *  The fit at a neighbouring λ on the same rows sits far nearer the answer than zero does, and
   *  the problem is convex, so starting there reaches the same optimum in a fraction of the steps.
   *  Only `selectHyperparams` passes this, and only along one fold's λ path, where the training
   *  rows — and therefore the column set — are identical from one fit to the next. */
  start?: { weights: number[]; bias: number };
}

/** Fit a logistic regression from raw feature rows and their 0/1 labels. Decides the column set
 *  from the data — a feature that is entirely missing or constant across the training rows carries
 *  no signal and is dropped, which is what keeps a project like D&A (whose `in_unit_laundry` reads
 *  `in-unit` on every flat that has one at all) from feeding a dead column into the model. */
export function fitModel(examples: Example[], options: FitOptions): Model {
  const {
    labelMode,
    lambda = 1,
    priorScale = 0,
    learningRate = 0.5,
    iterations = MAX_ITERATIONS,
    start,
  } = options;
  const columns = chooseColumns(examples.map((e) => e.raw));

  const X = examples.map((e) => rowFor(e.raw, columns));
  const y = examples.map((e) => e.label);
  const priors = columns.map((c) => priorFor(c, priorScale));
  // A start whose width disagrees with the columns is a caller bug — it means the rows changed
  // under the path — and quietly padding it with zeros would seed the descent with one column's
  // weight sitting in another column's slot. That fits, converges, and is wrong.
  if (start && start.weights.length !== columns.length) {
    throw new Error(`warm start has ${start.weights.length} weights for ${columns.length} columns`);
  }
  const { weights, bias } = gradientDescent(X, y, lambda, priors, learningRate, iterations, start);

  return {
    version: MODEL_VERSION,
    labelMode,
    columns,
    weights,
    bias,
    hyperparams: { lambda, priorScale },
  };
}

/** Decide which columns survive, and learn their standardisation constants. A value column is kept
 *  only if it varies (sd > 0) over the rows where it is present; a missing-indicator is added only
 *  for the size-derived columns, and only when the source is missing on some rows but not all
 *  (0 < missing < n) — a column that is always present, or always absent, has no indicator to give. */
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
    if (INDICATOR_COLUMNS.has(name) && missing > 0 && missing < n) {
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

/** How far the descent may go before it is made to stop.
 *
 *  It was the *number of steps every fit took*, and 800 at this step size reaches the plateau on
 *  standardised features. It is a ceiling now: `CONVERGED` below ends the loop as soon as the
 *  parameters stop moving, warm-started or not — the break is deliberately not gated on the warm
 *  start, because a cold fit that has stopped moving has equally stopped.
 *
 *  Which of the two actually ends a given descent is a question about the data, and it is measured
 *  rather than assumed. On the 379-row fixture the *ceiling* stops nearly every leg — 120 of 120
 *  warm ones in `love-vs-no` — because the labels carry real signal, the optimum sits far from the
 *  prior, and at this step size the last stretch of the path is still moving by more than a
 *  millionth at step 800. The tolerance earns its place at the other end of the range: the sparser
 *  the training set the earlier it fires, and at 23 examples, which `MIN_PER_CLASS` permits, a cold
 *  fit at λ=10 has settled by step 195.
 *
 *  So this saves a new hunt's retrain and not an established one's, which is the reverse of how it
 *  was first described here. Anything claiming a large speedup from the stopping rule was measured
 *  on data whose labels are independent of its features; there the optimum is the prior, and every
 *  fit converges almost at once. */
const MAX_ITERATIONS = 800;

/** When the parameters have stopped moving, measured as the largest change any single one of them
 *  made on the last step.
 *
 *  Small enough that stopping here is indistinguishable from running on: at 800 iterations the old
 *  fixed-budget fit already sat within 0.0002 of an 8000-iteration reference, so a step below a
 *  millionth is well inside the noise of the thing being measured. Movement is read *after* the
 *  sign projection rather than from the raw step, because a weight pinned at its constraint has
 *  genuinely stopped even while the gradient goes on pushing at it. */
const CONVERGED = 1e-6;

/** Batch gradient descent on the log-loss, with the weights pulled toward `priors` rather than
 *  toward zero (the bias is never penalised). Deterministic: fixed step, fixed starting point, and
 *  a convergence test on the parameters rather than on a random subsample — no randomness anywhere,
 *  so the fit is reproducible.
 *
 *  A weight is also projected onto the sign its prior asserts after each step. That is the part
 *  that does the work when positives are scarce: with 23 loves a single odd flat is enough to fit a
 *  negative coefficient to outdoor space, and a hunt that has written down "outdoor space: must
 *  have" has told us that coefficient's sign is not something to learn. A column with no prior
 *  (zero, or a missing-indicator) is left free in both directions. */
function gradientDescent(
  X: number[][],
  y: number[],
  lambda: number,
  priors: number[],
  lr: number,
  iterations: number,
  start?: { weights: number[]; bias: number },
): { weights: number[]; bias: number } {
  const n = X.length;
  const d = X[0]?.length ?? 0;

  // Flat typed arrays, allocated once. The arithmetic is unchanged — same operations in the same
  // order, so the same weights come out — but `check:predict` runs this loop about forty thousand
  // times over its nested leave-one-out, and the row-of-arrays form spent most of that in bounds
  // checks and in the per-iteration gradient allocation. Twenty seconds against twenty minutes.
  const flat = new Float64Array(n * d);
  for (let i = 0; i < n; i++) {
    const row = X[i] ?? [];
    for (let j = 0; j < d; j++) flat[i * d + j] = row[j] ?? 0;
  }
  const target = new Float64Array(n);
  for (let i = 0; i < n; i++) target[i] = y[i] ?? 0;
  const prior = new Float64Array(d);
  for (let j = 0; j < d; j++) prior[j] = priors[j] ?? 0;

  const w = new Float64Array(d);
  if (start) for (let j = 0; j < d; j++) w[j] = start.weights[j] ?? 0;
  const gradW = new Float64Array(d);
  let bias = start?.bias ?? 0;

  for (let it = 0; it < iterations; it++) {
    gradW.fill(0);
    let gradB = 0;
    for (let i = 0; i < n; i++) {
      const base = i * d;
      let z = bias;
      for (let j = 0; j < d; j++) z += w[j]! * flat[base + j]!;
      const err = 1 / (1 + Math.exp(-z)) - target[i]!;
      for (let j = 0; j < d; j++) gradW[j] = gradW[j]! + err * flat[base + j]!;
      gradB += err;
    }
    let moved = 0;
    for (let j = 0; j < d; j++) {
      const p = prior[j]!;
      const was = w[j]!;
      const stepped = was - lr * (gradW[j]! / n + (lambda * (was - p)) / n);
      w[j] = p > 0 ? Math.max(0, stepped) : p < 0 ? Math.min(0, stepped) : stepped;
      const step = Math.abs(w[j]! - was);
      if (step > moved) moved = step;
    }
    const biasStep = lr * (gradB / n);
    bias -= biasStep;
    if (Math.abs(biasStep) > moved) moved = Math.abs(biasStep);
    if (moved < CONVERGED) break;
  }
  return { weights: [...w], bias };
}

/** P(yes) in [0, 1] for one flat under a fitted model. Pure and synchronous — a surface computes
 *  it at render against the current weights, which is why no score is ever persisted (the model
 *  changes; the score would go stale the moment one more flat is rated).
 *
 *  `prefs` must be the same hunt's preferences the model was fitted with. They are not stored in
 *  the model because they are already a row of their own that every surface reads; what the model
 *  stores is the column list they produced, so a preference removed since training leaves a column
 *  that simply scores null-imputed from here on. */
export function score(
  model: Model,
  input: PredictInput,
  hubs: HubPoint[],
  prefs?: HuntPreferences,
): number {
  return scoreFeatures(model, featuresFor(input, hubs, prefs));
}

/** P(yes) from an already-built raw feature map. The inner form of `score`, shared with the
 *  cross-validation so tuning and serving score a row exactly the same way. */
export function scoreFeatures(model: Model, raw: Record<string, number | null>): number {
  return sigmoid(linear(model.weights, rowFor(raw, model.columns), model.bias));
}

// ---------------------------------------------------------------------------------------------
// Cross-validation and hyperparameter selection.
//
// Two hyperparameters are worth tuning. The L2 strength λ trades fitting this project's verdicts
// against generalising to the next flat, and the prior scale trades the hunt's stated preferences
// against what its verdicts actually show — both depend on how many verdicts there are and how
// noisy they are, which is exactly what cross-validation measures. Learning rate and iteration
// count are convergence settings, not model choices: fixed high enough to converge on the
// standardised features and left alone. We pick by mean cross-validated LOG-LOSS rather than
// accuracy or AUC, because on a project's worth of data a validation fold is a handful of rows, and
// log-loss reads a confident-and-wrong probability as the mistake it is where a hard 0/1 accuracy
// cannot tell 0.51 from 0.99.
// ---------------------------------------------------------------------------------------------

/** The λ values tried. Geometric, spanning "trust the data" to "trust almost nothing", so the CV
 *  can land on the right order of magnitude for a project of any size. It runs to 30 because 30 is
 *  what wins here: with a prior worth shrinking toward, the useful amount of shrinkage is larger
 *  than it was when shrinkage only ever meant "toward nothing". */
export const LAMBDA_GRID = [0.03, 0.1, 0.3, 1, 3, 10, 30];

/** How far to push the prior means. 0 is in the grid on purpose: it is ordinary zero-mean L2, so a
 *  hunt whose settings disagree with its own verdicts can discard them, and the model is never
 *  worse than v1's for having been offered a prior. */
export const PRIOR_SCALE_GRID = [0, 0.25, 0.5, 1];

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
 *  holds roughly the project's overall yes/no ratio. With ~23 positives, an unstratified split
 *  could hand a fold zero of them and make its validation meaningless. Deterministic (position
 *  order, no shuffle), so a given dataset always folds the same way. */
function stratifiedFolds(examples: Example[], folds: number): number[] {
  let pos = 0;
  let neg = 0;
  return examples.map((e) => (e.label === 1 ? pos++ : neg++) % folds);
}

/** Out-of-fold predictions for one (λ, scale): every row is predicted by a model that never saw it. */
function crossValScores(
  examples: Example[],
  lambda: number,
  priorScale: number,
  folds: number,
  base: FitOptions,
): Array<{ p: number; y: 0 | 1 }> {
  const assignment = stratifiedFolds(examples, folds);
  const scored: Array<{ p: number; y: 0 | 1 }> = [];
  for (let f = 0; f < folds; f++) {
    const train = examples.filter((_, i) => assignment[i] !== f);
    const val = examples.filter((_, i) => assignment[i] === f);
    if (train.length === 0 || val.length === 0) continue;
    const model = fitModel(train, { ...base, lambda, priorScale });
    for (const e of val) scored.push({ p: scoreFeatures(model, e.raw), y: e.label });
  }
  return scored;
}

export interface Hyperparams {
  lambda: number;
  priorScale: number;
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

/** Choose λ and the prior scale together, by k-fold cross-validated log-loss over the grids. The
 *  two interact — a stronger prior wants more shrinkage toward it — so searching them jointly is
 *  the only search that can find that. Ties go to the first pair in λ-major order.
 *
 *  The loops run fold-major, and that is the whole of why this is affordable. The 28 grid points
 *  times k folds are 140 fits, and fitting each from a standing start is 140 descents that have all
 *  been told nothing by the 139 others. Within one fold the training rows never change, so the
 *  solutions along the λ grid form a path: walk it from the strongest shrinkage down, hand each fit
 *  the answer to the last one, and every step after the first begins beside where it is going. The
 *  problem is convex and each fit still runs to `CONVERGED`, so this arrives at the same optimum as
 *  the cold search — it just stops taking hundreds of steps to re-derive what it already knew.
 *
 *  The prior scale is *not* walked: a different prior is a different objective, so each scale
 *  starts its own path from zero.
 *
 *  Scored into one bucket per pair and picked over afterwards, in the original λ-major order, so
 *  the tie rule is the one it has always been rather than the order the fits happened to run in. */
export function selectHyperparams(
  examples: Example[],
  base: FitOptions,
  folds = 5,
  grid = LAMBDA_GRID,
  scales = PRIOR_SCALE_GRID,
): Hyperparams {
  const k = clampFolds(examples, folds);
  const assignment = stratifiedFolds(examples, k);
  const key = (lambda: number, priorScale: number) => `${lambda}:${priorScale}`;
  const scored = new Map<string, Array<{ p: number; y: 0 | 1 }>>();
  for (const lambda of grid) for (const priorScale of scales) scored.set(key(lambda, priorScale), []);

  // Strongest shrinkage first. That solution sits nearest the prior and so is the cheapest of the
  // grid to reach from zero, which makes it the right end to start the path from.
  const path = [...grid].sort((a, b) => b - a);

  for (let f = 0; f < k; f++) {
    const train = examples.filter((_, i) => assignment[i] !== f);
    const val = examples.filter((_, i) => assignment[i] === f);
    if (train.length === 0 || val.length === 0) continue;
    for (const priorScale of scales) {
      let start: { weights: number[]; bias: number } | undefined;
      for (const lambda of path) {
        const model = fitModel(train, { ...base, lambda, priorScale, start });
        start = { weights: model.weights, bias: model.bias };
        const into = scored.get(key(lambda, priorScale))!;
        for (const e of val) into.push({ p: scoreFeatures(model, e.raw), y: e.label });
      }
    }
  }

  let best: Hyperparams | null = null;
  for (const lambda of grid) {
    for (const priorScale of scales) {
      const s = scored.get(key(lambda, priorScale))!;
      const cvLogLoss = logLoss(s);
      if (!best || cvLogLoss < best.cvLogLoss) {
        best = { lambda, priorScale, cvLogLoss, cvAuc: auc(s) };
      }
    }
  }
  // the grids are non-empty, so best is set; the fallback keeps the types honest.
  return best ?? { lambda: 1, priorScale: 0, cvLogLoss: Infinity, cvAuc: 0.5 };
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

/** Fit the model a project actually uses: pick the hyperparameters by cross-validation, fit on all
 *  of its verdicts with them, and attach the CV metrics the UI shows. This is the single entry
 *  point the `predict` Edge Function calls. Returns null when the project has too few verdicts to
 *  train — the caller renders that as guidance, not an error. */
export function fitProjectModel(examples: Example[], labelMode: LabelMode, folds = 5): Model | null {
  if (!trainable(examples)) return null;
  const base: FitOptions = { labelMode };
  const chosen = selectHyperparams(examples, base, folds);

  // One more CV pass at the chosen hyperparameters, for the metrics the UI reads. Reusing the
  // selection's scores would bias the number toward whichever pair won; a clean pass is honest and
  // still cheap.
  const cv = crossValScores(examples, chosen.lambda, chosen.priorScale, clampFolds(examples, folds), base);
  const positives = examples.filter((e) => e.label === 1).length;
  const model = fitModel(examples, { ...base, lambda: chosen.lambda, priorScale: chosen.priorScale });
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
