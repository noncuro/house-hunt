/** The photo analysis, running on Supabase rather than on somebody's laptop.
 *
 *  This is the only part of the extension that could not be serverless from the start: the OpenAI
 *  key cannot ship inside a Chrome extension, because anyone holding the bundle could spend it.
 *  It lived in `server/index.ts`, a local Node process — which meant analysis only happened when
 *  one laptop was awake with a terminal open. The other person's laptop could read every result
 *  and produce none.
 *
 *  All the real work is in `../_shared/analysis.ts` and `../_shared/png.ts`, copied verbatim from
 *  `src/lib/`. Both were written against `fetch` and Compression Streams with no `node:` imports
 *  precisely so this move would be a wrapper swap, and it was.
 *
 *  Deploy:
 *    supabase functions deploy analyse --project-ref <ref>
 *    supabase secrets set OPENAI_API_KEY=... --project-ref <ref>
 *
 *  **`--no-verify-jwt` is gone, and the old defence with it.** That defence was: the function
 *  accepts a rightmove_id and nothing else, and only analyses a property row that already exists,
 *  so the worst a stranger with the URL can do is make us re-analyse a flat once. It was adequate
 *  for a two-laptop tool with one key holder. It is not adequate now, because the ceiling on cost
 *  was "however many listings anyone inserts" and nothing measured it. Five gates replace it, in
 *  this order (design D10):
 *
 *    1. a real session — the caller is resolved from the JWT, and an absent or expired one is a 401;
 *    2. an active project, and membership of it;
 *    3. a `project_property` link for this listing, so the function cannot be driven to analyse
 *       arbitrary listing ids — only ones the caller's own project has opened;
 *    4. the spend caps, checked inside `claim_analysis` while it holds the budget locks;
 *    5. only then the claim, the OpenAI call, the usage row and the analysis.
 *
 *  The service-role client stays, and is used for the writes. The JWT is identity, not authority:
 *  `property_analysis` and `api_usage` are deliberately writable by nobody else (design D4).
 */
import { analyseListing, type ParsedAnalysis } from '../_shared/analysis.ts';
import { requireActiveProject, requireCaller } from '../_shared/caller.ts';
import {
  body,
  eq,
  HttpError,
  requireEnv,
  rest,
  rpc,
  SERVICE_KEY,
  serve,
  SUPABASE_URL,
} from '../_shared/http.ts';

// `SUPABASE_URL` and `SERVICE_KEY` come from the platform, which sets them on every function. This
// one is a secret we set: `supabase secrets set OPENAI_API_KEY=...`.
const OPENAI_API_KEY = Deno.env.get('OPENAI_API_KEY');

/** What a call reserves against both caps before it is made, because what it will cost is not
 *  knowable until it has been. Comfortably above a typical listing; the overshoot the caps accept
 *  is the amount by which one completed call exceeds this, and nothing more (design D9). Settable
 *  without a deploy of the extension: `supabase secrets set ANALYSIS_ESTIMATE_USD=...`. */
const ESTIMATE_USD = Number(Deno.env.get('ANALYSIS_ESTIMATE_USD') ?? '0.10');

/** What `claim_analysis` answers. Three refusals with three different renderings, which is why it
 *  returns jsonb and not the boolean it used to. */
type Claim =
  | { status: 'claimed' }
  | { status: 'busy' }
  | { status: 'capped'; scope: 'project' | 'user'; spent: number; reserved: number; cap: number; resets_at: string };

type Result =
  | { status: 'cached' | 'analysed' | 'in-progress' }
  | { status: 'capped'; scope: 'project' | 'user'; spent: number; cap: number; resets_at: string };

serve(async (request) => {
  requireEnv({ OPENAI_API_KEY, SUPABASE_URL, SERVICE_KEY });
  if (!Number.isFinite(ESTIMATE_USD) || ESTIMATE_USD <= 0) {
    throw new Error(`ANALYSIS_ESTIMATE_USD is ${ESTIMATE_USD} — a reservation of nothing bounds nothing`);
  }

  const caller = await requireCaller(request);
  const projectId = await requireActiveProject(caller);

  const { rightmoveId } = await body<{ rightmoveId?: string }>(request);
  // Rightmove ids are numeric. Checking that here keeps the id out of a PostgREST filter it could
  // otherwise alter, since these are interpolated into the query string below.
  if (!rightmoveId || !/^\d+$/.test(rightmoveId)) {
    throw new HttpError(400, 'bad-request', 'a numeric rightmoveId is required');
  }

  // Gate 3. The link is the project's own record of having opened this listing. Without it the
  // function is an OpenAI proxy that will read the photos of any listing id a caller can type.
  const linked = await rest<Array<{ rightmove_id: string }>>(
    `project_property?project_id=eq.${eq(projectId)}&rightmove_id=eq.${eq(rightmoveId)}&select=rightmove_id`,
  );
  if (linked.length === 0) {
    throw new HttpError(
      403,
      'listing-not-linked',
      `listing ${rightmoveId} is not linked to project ${projectId} — open it first`,
    );
  }

  return await analyse(rightmoveId, projectId, caller.userId);
});

/** Analyse once, ever, and only if the budget allows it.
 *
 *  The claim is atomic in the database, so two laptops opening the same listing at the same moment
 *  cannot both pay OpenAI for it — exactly one wins and the other is told to wait. The cap check
 *  lives in the same call because the listing lock alone never serialised anything that mattered:
 *  requests for *different* listings do not contend, so a paced sweep near the cap would have five
 *  transactions read the same under-cap total and all proceed. `claim_analysis` locks the project
 *  and then the caller, counts spend plus live reservations, and only then claims (design D9). */
async function analyse(rightmoveId: string, projectId: string, userId: string): Promise<Result> {
  const claim = await rpc<Claim>('claim_analysis', {
    p_rightmove_id: rightmoveId,
    p_project_id: projectId,
    p_user_id: userId,
    p_estimate_usd: ESTIMATE_USD,
  });

  // Not an error. "The monthly analysis budget is used up, back on the 1st" is a sentence the panel
  // renders; a 500 is a sentence nobody can act on.
  if (claim.status === 'capped') {
    console.log(
      `capped on ${claim.scope}: $${claim.spent} spent + $${claim.reserved} reserved against $${claim.cap}`,
    );
    return {
      status: 'capped',
      scope: claim.scope,
      spent: Number(claim.spent),
      cap: Number(claim.cap),
      resets_at: claim.resets_at,
    };
  }

  if (claim.status === 'busy') {
    const rows = await rest<Array<{ status: string }>>(
      `property_analysis?rightmove_id=eq.${eq(rightmoveId)}&select=status`,
    );
    return { status: rows[0]?.status === 'running' ? 'in-progress' : 'cached' };
  }

  try {
    const rows = await rest<
      Array<{ image_urls: string[]; floorplan_urls: string[]; description: string | null }>
    >(`property?rightmove_id=eq.${eq(rightmoveId)}&select=image_urls,floorplan_urls,description`);
    const property = rows[0];
    if (!property) throw new Error(`property ${rightmoveId} is not in the database yet`);

    const { model, imageCount, parsed, usage } = await analyseListing({
      apiKey: OPENAI_API_KEY!,
      imageUrls: property.image_urls ?? [],
      floorplanUrls: property.floorplan_urls ?? [],
      description: property.description ?? null,
    });

    // Usage before the analysis row, deliberately. Either order can be interrupted; this one fails
    // towards "we know what we spent and have no answer to show for it", which the stale-claim path
    // already recovers from. The other fails towards an analysis nobody was charged for, which is
    // the state the caps cannot see and therefore must not be reachable.
    const cost = await record(projectId, userId, rightmoveId, model, usage);
    await patch(rightmoveId, { ...row(model, imageCount, parsed, usage), status: 'done' });

    console.log(
      `analysed ${rightmoveId}: floorplan=${parsed.floorplan.present}/${parsed.floorplan.legible ? 'legible' : 'unreadable'} ` +
        `sqft=${parsed.floorplan.total_sqft} cost=$${cost.toFixed(4)}`,
    );
    return { status: 'analysed' };
  } catch (e) {
    // Tokens OpenAI billed have to be billed against a cap whether or not we got an answer out of
    // them, so a failure that carried a usage block is recorded before the claim is released.
    const failed = failure(e);
    if (failed) await record(projectId, userId, rightmoveId, failed.model, failed.usage);

    // Release the claim — which is also what drains the reservation — or one bad run would block
    // this listing, and hold budget against it, until the stale timeout.
    await patch(rightmoveId, { status: 'failed', error: e instanceof Error ? e.message : String(e) });
    throw e;
  }
}

/** OpenAI's Responses API reports cached prompt tokens as a *subset* of `input_tokens`, so the two
 *  rates are applied to the cached count and to what is left. Charging the full count at the full
 *  rate and the cached count again at the cached rate would bill the same tokens twice; charging
 *  the full count at the full rate alone — which the deleted `cost()` did — overstates a cached
 *  prompt by about an order of magnitude.
 *
 *  There is no local price table any more. `record_api_usage` prices from `model_price`, so a
 *  repricing is an insert rather than a deploy, and the cost it stores is never recomputed. */
async function record(
  projectId: string,
  userId: string,
  rightmoveId: string,
  model: string,
  usage: Usage | undefined,
): Promise<number> {
  const total = usage?.input_tokens ?? 0;
  const cached = Math.min(usage?.input_tokens_details?.cached_tokens ?? 0, total);
  return Number(
    await rpc<number>('record_api_usage', {
      p_project_id: projectId,
      p_user_id: userId,
      p_model: model,
      p_input_tokens: total - cached,
      p_cached_input_tokens: cached,
      p_output_tokens: usage?.output_tokens ?? 0,
      p_rightmove_id: rightmoveId,
      p_kind: 'analysis',
    }),
  );
}

/** `analysis.ts` types `usage` as the two counts it writes onto the analysis row; the response also
 *  carries `input_tokens_details.cached_tokens`, which is what makes the cached rate applicable. It
 *  is read here rather than in the shared module because that module is a generated copy of
 *  `src/lib/` and must not be hand-edited. */
interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  input_tokens_details?: { cached_tokens?: number };
}

/** What a failure knows about what it already spent.
 *
 *  A request that never reached OpenAI, or that OpenAI rejected outright, cost nothing and returns
 *  nothing here. A response that arrived and then failed validation did cost money, and
 *  `analyseListing` attaches its `model` and `usage` to the error it throws so that money can be
 *  recorded. Duck-typed rather than instance-checked so this keeps working either way: before that
 *  attachment exists, every failure simply reports no usage, which is what the function did before
 *  the caps existed. */
function failure(e: unknown): { model: string; usage: Usage } | null {
  if (typeof e !== 'object' || e === null) return null;
  const carried = e as { model?: unknown; usage?: unknown };
  if (typeof carried.model !== 'string' || typeof carried.usage !== 'object' || carried.usage === null) {
    return null;
  }
  return { model: carried.model, usage: carried.usage as Usage };
}

async function patch(rightmoveId: string, values: Record<string, unknown>): Promise<void> {
  await rest(`property_analysis?rightmove_id=eq.${eq(rightmoveId)}`, { method: 'PATCH', body: values });
}

function row(model: string, imageCount: number, p: ParsedAnalysis, usage: Usage | undefined) {
  return {
    model,
    image_count: imageCount,
    analysed_at: new Date().toISOString(),
    input_tokens: usage?.input_tokens ?? null,
    output_tokens: usage?.output_tokens ?? null,
    has_floorplan: p.floorplan.present,
    floorplan_legible: p.floorplan.legible,
    floorplan_sqft: p.floorplan.total_sqft,
    floorplan_sqft_source: p.floorplan.source,
    floorplan_confidence: p.floorplan.confidence,
    bedrooms: p.bedrooms,
    bathrooms: p.bathrooms,
    biggest_room_label: p.biggest_room.label,
    biggest_room_sqft: p.biggest_room.sqft,
    biggest_room_confidence: p.biggest_room.confidence,
    has_bathtub: p.bathtub.present,
    bathtub_confidence: p.bathtub.confidence,
    has_outdoor_space: p.outdoor.present,
    outdoor_kind: p.outdoor.kind,
    outdoor_sqft: p.outdoor.sqft,
    outdoor_is_estimate: p.outdoor.is_estimate,
    outdoor_confidence: p.outdoor.confidence,
    is_house_share: p.amenities.house_share.present,
    house_share_confidence: p.amenities.house_share.confidence,
    laundry: p.amenities.laundry.where,
    laundry_confidence: p.amenities.laundry.confidence,
    has_dishwasher: p.amenities.dishwasher.present,
    dishwasher_confidence: p.amenities.dishwasher.confidence,
    bed_in_kitchen: p.amenities.bed_in_kitchen.present,
    bed_in_kitchen_confidence: p.amenities.bed_in_kitchen.confidence,
    utilities_included: p.amenities.utilities_included.present,
    utilities_confidence: p.amenities.utilities_included.confidence,
    natural_light: p.light.level,
    natural_light_confidence: p.light.confidence,
    summary: p.summary,
    captions: p.images,
    raw: p,
  };
}
