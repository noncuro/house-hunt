/** Retrain a project's verdict-score model. This is the "Rerun ratings" button.
 *
 *  Unlike `analyse`, this holds no secret and costs no third party — it is classical ML over the
 *  project's own verdicts, cheap enough to run on a button. It lives server-side anyway for one
 *  reason: `project_model` is a row every surface then trusts to score flats, so the thing that
 *  writes it must be the server and not a client that could hand-craft weights.
 *
 *  What it does NOT do is score anything. Scoring is pure arithmetic against the stored weights and
 *  happens on the surface that needs it — the triage list, the panel — at render, so a score is
 *  never persisted and never stale. This route's whole job is to produce the weights.
 *
 *  Why the fit runs here rather than on Supabase's Edge runtime: `docs/vercel-migration.md`.
 */
import {
  DEFAULT_LABEL_MODE,
  featuresFor,
  fitProjectModel,
  type Example,
  type HubPoint,
  type HuntPreferences,
  labelFor,
  type LabelMode,
  MIN_PER_CLASS,
  nearestStationMiles,
  type PredictInput,
} from '@house-hunt/core';
import { requireActiveProject } from '@/server/caller';
import { authedRoute, jsonBody } from '@/server/handler';
import { eq, HttpError, rest, rpc } from '@/server/supabase';

/** Node, not Edge. The Edge runtime here would reintroduce exactly the constraint this route was
 *  moved to escape, and the fit is CPU with no I/O to hide behind. */
export const runtime = 'nodejs';

/** Seconds. 300 is the Hobby maximum and also its default, so this is a statement of intent rather
 *  than a raise; on a paid plan it can go further. The fit at 600 examples takes under two seconds
 *  of CPU, so this is a ceiling for a project far larger than any real one, not a budget. */
export const maxDuration = 300;

/** Never prerendered, never cached: it reads what somebody has just rated and writes a row. */
export const dynamic = 'force-dynamic';

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
  floor_area_source: 'sizings' | 'description' | null;
  furnish_type: string | null;
  latitude: number | null;
  longitude: number | null;
  postcode_lat: number | null;
  postcode_lon: number | null;
  nearest_stations: Array<{ distance?: number; unit?: string }>;
}

/** The analysis columns the feature builder reads, in the camelCase shape `Analysis` uses — the
 *  amenity predicates in `facts.ts` are the same ones the panel's flags run, so they take that
 *  shape rather than the row's. */
interface AnalysisRow {
  rightmove_id: string;
  natural_light: 'low' | 'medium' | 'high' | null;
  has_outdoor_space: boolean | null;
  outdoor_sqft: number | null;
  has_dishwasher: boolean | null;
  laundry: 'in-unit' | 'in-building' | 'none' | null;
  has_bathtub: boolean | null;
  biggest_room_sqft: number | null;
  floorplan_sqft: number | null;
  floorplan_legible: boolean | null;
  is_house_share: boolean | null;
  sleeping_separation: 'separate' | 'practically-separate' | 'same-space' | null;
  utilities_included: boolean | null;
}

/** The analysis row as the feature builder wants it. Only the fields the builder and the amenity
 *  predicates read — a partial `Analysis`, which is all `featuresFor` asks for. */
function analysisOf(a: AnalysisRow | undefined): PredictInput['analysis'] {
  if (!a) return null;
  return {
    naturalLight: a.natural_light,
    hasOutdoorSpace: a.has_outdoor_space,
    outdoorSqft: a.outdoor_sqft,
    hasDishwasher: a.has_dishwasher,
    laundry: a.laundry,
    hasBathtub: a.has_bathtub,
    biggestRoomSqft: a.biggest_room_sqft,
    floorplanSqft: a.floorplan_sqft,
    floorplanLegible: a.floorplan_legible,
    isHouseShare: a.is_house_share,
    sleepingSeparation: a.sleeping_separation,
    utilitiesIncluded: a.utilities_included,
  } as PredictInput['analysis'];
}

function inputOf(p: PropertyRow, a: AnalysisRow | undefined): PredictInput {
  return {
    price: p.price,
    bedrooms: p.bedrooms,
    bathrooms: p.bathrooms,
    listedSqft: p.floor_area_sqft,
    listedSource: p.floor_area_source,
    // Prefer the postcode point (design: route from the postcode, not the pin); fall back to the pin.
    lat: p.postcode_lat ?? p.latitude,
    lon: p.postcode_lon ?? p.longitude,
    nearestStationMiles: nearestStationMiles(p.nearest_stations ?? []),
    furnishType: p.furnish_type,
    analysis: analysisOf(a),
  };
}

type Result =
  | { status: 'trained'; labelMode: LabelMode; nExamples: number; metrics: unknown }
  | { status: 'insufficient'; nExamples: number; positives: number; minPerClass: number }
  // The verdicts moved while this was fitting, so the write was refused — see the revision below.
  | { status: 'superseded' };

export const POST = authedRoute(async (request, caller): Promise<Result> => {
  const projectId = await requireActiveProject(caller);

  const { labelMode = DEFAULT_LABEL_MODE } = await jsonBody<{ labelMode?: LabelMode }>(request);
  if (labelMode !== 'love-vs-no' && labelMode !== 'lovemaybe-vs-no') {
    throw new HttpError(400, 'bad-request', `${labelMode} is not a label mode`);
  }

  // Read *before* the training rows, and handed back with the write: `set_project_model` refuses a
  // model whose revision is no longer the project's, so a slower retrain fitted on older verdicts
  // cannot land over a newer one. Reading it first rather than after means a verdict that changes
  // between this line and the read below is caught too — the write sees the newer revision and
  // says so, and the fit is redone rather than trusted. Issue #88.
  const revision = await rpc<string>('project_training_revision', { p_project_id: projectId });

  // The project's verdicts, minus the flats it has withheld from training (off the market, etc.).
  // Ordered because PostgREST promises no order without one, and everything downstream of this read
  // is positional: the id list below seeds the property fetch, and the fit deals rows into folds by
  // position. `updated_at` leads so that "the last rating seen" is a definition rather than an
  // accident, in case the one-row-per-flat key below ever widens again.
  const [verdicts, exclusions, hubs, settings] = await Promise.all([
    rest<VerdictRow[]>(
      `verdict?project_id=eq.${eq(projectId)}&select=rightmove_id,rating,updated_at&order=updated_at.asc,rightmove_id.asc`,
    ),
    rest<Array<{ rightmove_id: string }>>(`training_exclusion?project_id=eq.${eq(projectId)}&select=rightmove_id`),
    // `place`, not `project_hub`: the two tables are one since the `places_are_hubs` migration.
    // The model's distance feature reads every place with a coordinate, which is what the panel and
    // the shortlist already fixed a listing against — so the feature the model is scored on is the
    // one it was trained on.
    rest<HubPoint[]>(`place?project_id=eq.${eq(projectId)}&select=lat,lon`),
    // What the hunt said it wants. The model is fitted with these twice over — as the preference
    // columns and as the centre its weights are shrunk toward — so a hunt that has never opened
    // the page trains the same zero-mean model it always did, and one that has states its taste
    // before its verdicts are numerous enough to show it.
    rest<Array<{ preferences: HuntPreferences | null }>>(
      `project_setting?project_id=eq.${eq(projectId)}&select=preferences`,
    ),
  ]);
  const prefs = settings[0]?.preferences ?? undefined;

  const excluded = new Set(exclusions.map((e) => e.rightmove_id));
  // `verdict` is keyed (project_id, rightmove_id) since the multi-tenant migration dropped `person`,
  // so a flat has exactly one rating here and this map cannot actually collapse anything. It stays a
  // map rather than a list because it is also the filter — excluded flats and any non-numeric id are
  // dropped before the ids reach a PostgREST `in.()` — and because keeping the last-write-wins rule
  // means a key that widens back out degrades to "most recent" instead of "whichever row came last".
  const rating = new Map<string, VerdictRow['rating']>();
  for (const v of verdicts) {
    if (excluded.has(v.rightmove_id) || !/^\d+$/.test(v.rightmove_id)) continue;
    rating.set(v.rightmove_id, v.rating);
  }
  const ids = [...rating.keys()];

  if (ids.length === 0) {
    // Nothing left to learn from, so nothing may keep claiming to have learned. See the clear below.
    const cleared = await rpc<boolean>('clear_project_model', { p_project_id: projectId, p_revision: revision });
    if (!cleared) return { status: 'superseded' };
    return { status: 'insufficient', nExamples: 0, positives: 0, minPerClass: MIN_PER_CLASS };
  }

  const idList = ids.join(',');
  const [properties, analyses] = await Promise.all([
    // Ordered for the same reason: the fit walks `properties` to build its examples, and the
    // stratified folds deal rows out by position, so an unordered read would cross-validate a
    // different partition each time and hand back a different λ on unchanged data.
    rest<PropertyRow[]>(
      `property?rightmove_id=in.(${idList})&select=rightmove_id,price,bedrooms,bathrooms,floor_area_sqft,floor_area_source,furnish_type,latitude,longitude,postcode_lat,postcode_lon,nearest_stations&order=rightmove_id.asc`,
    ),
    rest<AnalysisRow[]>(
      `property_analysis?rightmove_id=in.(${idList})&select=rightmove_id,natural_light,has_outdoor_space,outdoor_sqft,has_dishwasher,laundry,has_bathtub,biggest_room_sqft,floorplan_sqft,floorplan_legible,is_house_share,sleeping_separation,utilities_included`,
    ),
  ]);

  const analysisById = new Map(analyses.map((a) => [a.rightmove_id, a]));
  const examples: Example[] = [];
  for (const p of properties) {
    const label = labelFor(rating.get(p.rightmove_id) as 'no' | 'maybe' | 'love', labelMode);
    if (label == null) continue; // a `maybe` dropped under love-vs-no
    examples.push({ raw: featuresFor(inputOf(p, analysisById.get(p.rightmove_id)), hubs, prefs), label });
  }

  const model = fitProjectModel(examples, labelMode);
  if (!model) {
    // The project's data no longer supports a model, so drop the one it used to support. Returning
    // `insufficient` while leaving the row would let every surface go on scoring against weights
    // fitted to verdicts that have since been excluded or re-rated — and the retrain meant to catch
    // that would be the very call that reported success at changing nothing.
    const cleared = await rpc<boolean>('clear_project_model', { p_project_id: projectId, p_revision: revision });
    if (!cleared) return { status: 'superseded' };
    const positives = examples.filter((e) => e.label === 1).length;
    return { status: 'insufficient', nExamples: examples.length, positives, minPerClass: MIN_PER_CLASS };
  }

  const written = await rpc<boolean>('set_project_model', {
    p_project_id: projectId,
    p_model: model,
    p_version: model.version,
    p_label_mode: labelMode,
    p_n_examples: examples.length,
    p_trained_by: caller.userId,
    p_revision: revision,
  });
  if (!written) return { status: 'superseded' };

  return { status: 'trained', labelMode, nExamples: examples.length, metrics: model.metrics };
});
