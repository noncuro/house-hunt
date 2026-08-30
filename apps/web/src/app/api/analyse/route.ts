/** The photo analysis, running on the website's own server.
 *
 *  This is the only part of the extension that could not be serverless from the start: the OpenAI
 *  key cannot ship inside a Chrome extension, because anyone holding the bundle could spend it.
 *  It lived in `server/index.ts`, a local Node process — which meant analysis only happened when
 *  one laptop was awake with a terminal open — then in a Supabase Edge Function, and now here.
 *
 *  All the real work is in `packages/core/src/analysis.ts`, imported rather than copied. That copy
 *  is what this move deletes: `analysis.ts` and `png.ts` were written against `fetch` and
 *  Compression Streams with no `node:` imports so a Deno function could hold generated duplicates
 *  of them, and a route in this app imports the originals.
 *
 *  **Five gates, in this order (design D10):**
 *
 *    1. a real session — `authedRoute` resolves the caller from the JWT, and an absent or expired
 *       one is a 401;
 *    2. an active project, and membership of it;
 *    3. a `project_property` link for this listing, so the route cannot be driven to analyse
 *       arbitrary listing ids — only ones the caller's own project has opened;
 *    4. the spend caps, checked inside `claim_analysis` while it holds the budget locks;
 *    5. only then the claim, the OpenAI call, the usage row and the analysis.
 *
 *  The service role does the writes. The JWT is identity, not authority: `property_analysis` and
 *  `api_usage` are deliberately writable by nobody else (design D4).
 *
 *  Two variables have to be on the Vercel project: `OPENAI_API_KEY`, and optionally
 *  `ANALYSIS_ESTIMATE_USD`. Both are read per request rather than at module scope, so a missing key
 *  fails the request that needed it instead of the build of the whole website.
 */
import { analyseListing, type ParsedAnalysis } from '@house-hunt/core/analysis';

import { requireActiveProject } from '@/server/caller';
import { authedRoute, jsonBody, preflightRoute } from '@/server/handler';
import { eq, HttpError, rest, rpc } from '@/server/supabase';

export const runtime = 'nodejs';

/** Twenty to forty photographs through a vision model, in one call. The default 10s would fail
 *  every listing; this is the platform's ceiling and the analysis is what it is for. */
export const maxDuration = 300;

export const dynamic = 'force-dynamic';

/** What a call reserves against both caps before it is made, because what it will cost is not
 *  knowable until it has been. Comfortably above a typical listing; the overshoot the caps accept
 *  is the amount by which one completed call exceeds this, and nothing more (design D9). Settable
 *  without shipping anything: it is an environment variable on the Vercel project. */
const DEFAULT_ESTIMATE_USD = 0.1;

function openAiKey(): string {
  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    throw new Error(
      'OPENAI_API_KEY is not set on this deployment — add it to the Vercel project environment ' +
        '(Settings → Environment Variables). It is the key this route spends, so nothing can be ' +
        'analysed without it.',
    );
  }
  return key;
}

function estimateUsd(): number {
  const raw = process.env.ANALYSIS_ESTIMATE_USD;
  const value = raw === undefined || raw === '' ? DEFAULT_ESTIMATE_USD : Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`ANALYSIS_ESTIMATE_USD is ${raw} — a reservation of nothing bounds nothing`);
  }
  return value;
}

/** What `claim_analysis` answers. Three refusals with three different renderings, which is why it
 *  returns jsonb and not the boolean it used to. */
type Claim =
  // `claimed_at` identifies this claim, and is what a failure has to be recorded against: a run that
  // overshot the stale timeout no longer owns the row, and must not write over the run that took it.
  | { status: 'claimed'; claimed_at: string }
  | { status: 'busy' }
  | { status: 'capped'; scope: 'project' | 'user'; spent: number; reserved: number; cap: number; resets_at: string };

type Result =
  | { status: 'cached' | 'analysed' | 'in-progress' }
  | { status: 'capped'; scope: 'project' | 'user'; spent: number; cap: number; resets_at: string }
  | { status: 'failed'; error: string };

export const POST = authedRoute(async (request, caller) => {
  const projectId = await requireActiveProject(caller);

  const { rightmoveId } = await jsonBody<{ rightmoveId?: string }>(request);
  // Rightmove ids are numeric. Checking that here keeps the id out of a PostgREST filter it could
  // otherwise alter, since these are interpolated into the query string below.
  if (!rightmoveId || !/^\d+$/.test(rightmoveId)) {
    throw new HttpError(400, 'bad-request', 'a numeric rightmoveId is required');
  }

  // Gate 3. The link is the project's own record of having opened this listing. Without it the
  // route is an OpenAI proxy that will read the photos of any listing id a caller can type.
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

export const OPTIONS = preflightRoute();

/** Analyse once, ever, and only if the budget allows it.
 *
 *  The claim is atomic in the database, so two laptops opening the same listing at the same moment
 *  cannot both pay OpenAI for it — exactly one wins and the other is told to wait. The cap check
 *  lives in the same call because the listing lock alone never serialised anything that mattered:
 *  requests for *different* listings do not contend, so a paced sweep near the cap would have five
 *  transactions read the same under-cap total and all proceed. `claim_analysis` locks the project
 *  and then the caller, counts spend plus live reservations, and only then claims (design D9). */
async function analyse(rightmoveId: string, projectId: string, userId: string): Promise<Result> {
  const apiKey = openAiKey();
  const claim = await rpc<Claim>('claim_analysis', {
    p_rightmove_id: rightmoveId,
    p_project_id: projectId,
    p_user_id: userId,
    p_estimate_usd: estimateUsd(),
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
    const rows = await rest<Array<{ status: string; error: string | null }>>(
      `property_analysis?rightmove_id=eq.${eq(rightmoveId)}&select=status,error`,
    );
    const held = rows[0];
    if (held?.status === 'running') return { status: 'in-progress' };
    // A refused claim over a failed row is new, and it is not a cache hit. It used to be
    // unreachable — `claim_analysis` re-took every failed row, so a failure was always claimed —
    // and now that a row can be waiting out its backoff or have spent its attempts, `cached` would
    // draw a flat with no analysis as though it had one. That is the blank that looks like data.
    if (held?.status === 'failed') {
      return { status: 'failed', error: held.error ?? 'the analysis failed and has not been retried yet' };
    }
    return { status: 'cached' };
  }

  try {
    const rows = await rest<
      Array<{ image_urls: string[]; floorplan_urls: string[]; description: string | null }>
    >(`property?rightmove_id=eq.${eq(rightmoveId)}&select=image_urls,floorplan_urls,description`);
    const property = rows[0];
    if (!property) throw new Error(`property ${rightmoveId} is not in the database yet`);

    const { model, imageCount, parsed, usage } = await analyseListing({
      apiKey,
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
    //
    // Through the RPC rather than a patch, because the count has to be `attempts + 1` computed in
    // the same statement that writes it. Reading it here and writing it back would drop increments
    // exactly when two runs fail the same listing at once, which is when a listing is failing hard
    // — and a count that never climbs is a ceiling that is never reached.
    //
    // Under this run's own claim, so that a run slow enough to have been taken over releases
    // nothing: the row belongs to whoever took it, and freeing a live claim would drain a
    // reservation that is still being spent against.
    await rpc('record_analysis_failure', {
      p_rightmove_id: rightmoveId,
      p_claimed_at: claim.claimed_at,
      p_error: e instanceof Error ? e.message : String(e),
    });
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
 *  carries `input_tokens_details.cached_tokens`, which is what makes the cached rate applicable.
 *  Read here rather than widened there, because that module's `usage` is the part of the response
 *  the analysis row stores and this is the part the billing needs. */
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
 *  attachment exists, every failure simply reports no usage, which is what the route did before
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
    sleeping_separation: p.amenities.sleeping_area.separation,
    sleeping_separation_confidence: p.amenities.sleeping_area.confidence,
    utilities_included: p.amenities.utilities_included.present,
    utilities_confidence: p.amenities.utilities_included.confidence,
    natural_light: p.light.level,
    natural_light_confidence: p.light.confidence,
    summary: p.summary,
    captions: p.images,
    raw: p,
  };
}
