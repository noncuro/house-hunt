/** Retrain a project's verdict-score model. This is the "Rerun ratings" button.
 *
 *  Unlike `analyse`, this holds no secret and costs no third party — it is classical ML over the
 *  project's own verdicts, cheap enough to run on a button. It lives server-side anyway for one
 *  reason: `project_model` is a row every surface then trusts to score flats, so the thing that
 *  writes it must be the server and not a client that could hand-craft weights. The function reads
 *  the project's verdicts (which it may, as the service role), fits the model in `packages/core`,
 *  and writes the one row through `set_project_model`, whose only permitted caller is this role.
 *
 *  What it does NOT do is score anything. Scoring is pure arithmetic against the stored weights and
 *  happens on the surface that needs it — the triage list, the panel — at render, so a score is
 *  never persisted and never stale. This function's whole job is to produce the weights.
 */
import { requireActiveProject, requireCaller } from '../_shared/caller.ts';
import { body, eq, HttpError, requireEnv, rest, rpc, SERVICE_KEY, serve, SUPABASE_URL } from '../_shared/http.ts';
import {
  DEFAULT_LABEL_MODE,
  featuresFor,
  fitProjectModel,
  labelFor,
  MIN_PER_CLASS,
  type Example,
  type HubPoint,
  type LabelMode,
  type PredictInput,
} from '../_shared/predict.ts';

interface VerdictRow {
  rightmove_id: string;
  rating: 'no' | 'maybe' | 'love';
  updated_at: string;
}
interface PropertyRow {
  rightmove_id: string;
  price: string | null;
  bedrooms: number | null;
  bathrooms: number | null;
  floor_area_sqft: number | null;
  furnish_type: string | null;
  latitude: number | null;
  longitude: number | null;
  postcode_lat: number | null;
  postcode_lon: number | null;
  nearest_stations: Array<{ distance?: number; unit?: string }>;
}
interface AnalysisRow {
  rightmove_id: string;
  natural_light: 'low' | 'medium' | 'high' | null;
  has_outdoor_space: boolean | null;
  has_dishwasher: boolean | null;
  laundry: 'in-unit' | 'in-building' | 'none' | null;
  has_bathtub: boolean | null;
}

/** Smallest nearest-station distance, in miles. Rightmove gives miles, but a stray kilometre unit
 *  would otherwise read as a much closer station, so convert rather than trust. */
function nearestStationMiles(stations: PropertyRow['nearest_stations']): number | null {
  const miles = (stations ?? [])
    .filter((s) => typeof s.distance === 'number')
    .map((s) => (s.unit === 'km' ? (s.distance as number) * 0.621371 : (s.distance as number)));
  return miles.length ? Math.min(...miles) : null;
}

function inputOf(p: PropertyRow, a: AnalysisRow | undefined): PredictInput {
  return {
    price: p.price,
    bedrooms: p.bedrooms,
    bathrooms: p.bathrooms,
    floorAreaSqft: p.floor_area_sqft,
    // Prefer the postcode point (design: route from the postcode, not the pin); fall back to the pin.
    lat: p.postcode_lat ?? p.latitude,
    lon: p.postcode_lon ?? p.longitude,
    nearestStationMiles: nearestStationMiles(p.nearest_stations),
    furnishType: p.furnish_type,
    naturalLight: a?.natural_light ?? null,
    hasOutdoorSpace: a?.has_outdoor_space ?? null,
    hasDishwasher: a?.has_dishwasher ?? null,
    laundry: a?.laundry ?? null,
    hasBathtub: a?.has_bathtub ?? null,
  };
}

type Result =
  | { status: 'trained'; labelMode: LabelMode; nExamples: number; metrics: unknown }
  | { status: 'insufficient'; nExamples: number; positives: number; minPerClass: number };

serve(async (request): Promise<Result> => {
  requireEnv({ SUPABASE_URL, SERVICE_KEY });
  const caller = await requireCaller(request);
  const projectId = await requireActiveProject(caller);

  const { labelMode = DEFAULT_LABEL_MODE } = await body<{ labelMode?: LabelMode }>(request);
  if (labelMode !== 'love-vs-no' && labelMode !== 'lovemaybe-vs-no') {
    throw new HttpError(400, 'bad-request', `${labelMode} is not a label mode`);
  }

  // The project's verdicts, minus the flats it has withheld from training (off the market, etc.).
  // Ordered, because "the last rating seen" below is only a definition if the rows arrive in a
  // defined order. PostgREST makes no promise without one, so two retrains over identical data
  // could otherwise collapse a twice-rated flat differently and produce two different models —
  // which is exactly the determinism the prediction engine claims for itself.
  const [verdicts, exclusions, hubs] = await Promise.all([
    rest<VerdictRow[]>(
      `verdict?project_id=eq.${eq(projectId)}&select=rightmove_id,rating,updated_at&order=updated_at.asc,rightmove_id.asc`,
    ),
    rest<Array<{ rightmove_id: string }>>(`training_exclusion?project_id=eq.${eq(projectId)}&select=rightmove_id`),
    rest<HubPoint[]>(`project_hub?project_id=eq.${eq(projectId)}&select=lat,lon`),
  ]);

  const excluded = new Set(exclusions.map((e) => e.rightmove_id));
  // A verdict is one row per person, but on this data it is effectively one per flat; collapse to
  // the MOST RECENT rating per id either way (the order above is what makes that true), and drop
  // excluded flats and any non-numeric id before it reaches a PostgREST `in.()` filter.
  const rating = new Map<string, VerdictRow['rating']>();
  for (const v of verdicts) {
    if (excluded.has(v.rightmove_id) || !/^\d+$/.test(v.rightmove_id)) continue;
    rating.set(v.rightmove_id, v.rating);
  }
  const ids = [...rating.keys()];

  if (ids.length === 0) {
    return { status: 'insufficient', nExamples: 0, positives: 0, minPerClass: MIN_PER_CLASS };
  }

  const idList = ids.join(',');
  const [properties, analyses] = await Promise.all([
    // Ordered for the same reason: the fit walks `properties` to build its examples, and the
    // stratified folds deal rows out by position, so an unordered read would cross-validate a
    // different partition each time and hand back a different λ on unchanged data.
    rest<PropertyRow[]>(
      `property?rightmove_id=in.(${idList})&select=rightmove_id,price,bedrooms,bathrooms,floor_area_sqft,furnish_type,latitude,longitude,postcode_lat,postcode_lon,nearest_stations&order=rightmove_id.asc`,
    ),
    rest<AnalysisRow[]>(
      `property_analysis?rightmove_id=in.(${idList})&select=rightmove_id,natural_light,has_outdoor_space,has_dishwasher,laundry,has_bathtub`,
    ),
  ]);

  const analysisById = new Map(analyses.map((a) => [a.rightmove_id, a]));
  const examples: Example[] = [];
  for (const p of properties) {
    const label = labelFor(rating.get(p.rightmove_id) as 'no' | 'maybe' | 'love', labelMode);
    if (label == null) continue; // a `maybe` dropped under love-vs-no
    examples.push({ raw: featuresFor(inputOf(p, analysisById.get(p.rightmove_id)), hubs), label });
  }

  const model = fitProjectModel(examples, labelMode);
  if (!model) {
    const positives = examples.filter((e) => e.label === 1).length;
    return { status: 'insufficient', nExamples: examples.length, positives, minPerClass: MIN_PER_CLASS };
  }

  await rpc('set_project_model', {
    p_project_id: projectId,
    p_model: model,
    p_version: model.version,
    p_label_mode: labelMode,
    p_n_examples: examples.length,
    p_trained_by: caller.userId,
  });

  return { status: 'trained', labelMode, nExamples: examples.length, metrics: model.metrics };
});
