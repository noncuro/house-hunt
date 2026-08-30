/** Journeys, stations and postcodes — resolved here, and written to the shared caches only here.
 *
 *  This used to run in the extension's background worker, which had two problems and only one of
 *  them was obvious.
 *
 *  The obvious one is that a browser tab cannot do it. The worker reaches `api.tfl.gov.uk` through
 *  `host_permissions`, which a page on the website does not have, so the moment the app moved out
 *  of the extension the calls had to move somewhere both surfaces could reach.
 *
 *  The one that matters more: `travel_time`, `station_point` and `station_walk` are **global**
 *  tables, shared across every project by design — the whole point is that one project's lookup
 *  saves another's. Their write RPCs were granted to `authenticated`, and their validation is about
 *  plausibility rather than truth, because it can only be: a mode is checkable, a duration between
 *  0 and 86400 seconds is checkable, a coordinate on Earth is checkable, and whether the journey
 *  really takes 41 minutes was knowable only to whoever asked TfL. So any signed-in member of any
 *  project could write a wrong journey time or move a station, and every other project would read
 *  it as fact — permanently, with nothing detecting it and nothing expiring it. Moving the call
 *  here makes the service role the only writer and those three RPCs unreachable by a client.
 *
 *  Two things fall out that are worth having anyway. The TfL key stops shipping in the bundle,
 *  where it was public and the calls made with it were unattributable. And the pinned weekday-09:00
 *  basis is now enforced where the row is written rather than by convention in each caller — two
 *  flats measured on different evenings are only comparable if every row was computed the same way,
 *  and a convention is something one client can forget.
 *
 *  The client still decides *what* to ask about — which places, which stations — because that is
 *  project data it reads under RLS. This function decides what is cached, what is stale, what to
 *  call TfL for, and what the answer is.
 */
import { body, HttpError, requireEnv, rest, rpc, serve } from '../_shared/http.ts';
import { requireCaller, type Caller } from '../_shared/caller.ts';
import {
  implausibleWalk,
  journeyTime,
  NO_REASON_RECORDED,
  resolveStation,
  staleTravel,
  TflError,
  tooFarToWalk,
  TRAVEL_BASIS,
  walkTo,
  type StationInfo,
} from '../_shared/tfl.ts';
import { lookupPostcode, type Point } from '../_shared/postcode.ts';
import { TRAVEL_MODES, type JourneyOption, type TravelMode } from '../_shared/types.ts';
import { distanceMiles } from '../_shared/hubs.ts';

requireEnv({
  SUPABASE_URL: Deno.env.get('SUPABASE_URL'),
  SUPABASE_SERVICE_ROLE_KEY: Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),
});

/** Optional, and deliberately so. TfL answers unkeyed requests at a lower rate limit, so a missing
 *  key degrades rather than breaks — which is what you want on the day somebody rotates it.
 *
 *  The difference is worth more than "a lower rate limit" suggests, and it is *per minute*, not per
 *  hour: unkeyed is 50 requests a minute, keyed is 500. Both are far above what one person browsing
 *  does and the unkeyed one is not far above what the backfill below does, which is why the backfill
 *  is paced rather than trusted to stay small.
 *
 *  TfL issues a subscription two keys, primary and secondary, so one can be rotated while the other
 *  keeps serving. They are two credentials against **one** quota — alternating them buys no extra
 *  allowance — so the primary is what we send and the secondary is the standby a rotation swaps in.
 *  `TFL_APP_KEY` is still read last so a deployment set up before the pair existed keeps working. */
const TFL_APP_KEY =
  Deno.env.get('TFL_PRIMARY_KEY') ?? Deno.env.get('TFL_SECONDARY_KEY') ?? Deno.env.get('TFL_APP_KEY') ?? undefined;

/** A ceiling on concurrent TfL calls, with the rest queued behind them.
 *
 *  A single journeys request fans out to places×modes legs, and the grids on the website mount a
 *  card — each its own request — for the whole pile at once. Without a bound the function fires
 *  dozens of TfL calls in the same instant, which is both a herd on TfL and the fastest way to spend
 *  our own hourly cap in a burst. This is the one choke point every caller passes through — the
 *  extension, the website, every tab — so the queue lives here rather than in a client, where it
 *  would only pace that one client. It paces the calls; it does not lower the hourly total.
 *
 *  Module-level on purpose: a warm instance serves many invocations back to back, so the queue
 *  spans them and the bound is on this instance's outbound TfL concurrency rather than on any single
 *  request's fan-out. */
const MAX_TFL_CONCURRENCY = 6;

/** How many of those slots the backlog may hold at once.
 *
 *  The backfill goes through `withTflSlot` like everything else, so it queues fairly against TfL —
 *  but "fairly" is the problem when it has sixty legs to work and somebody has just opened a
 *  listing. Without a second, tighter bound of its own, a backfill run fills all six slots and the
 *  person waiting on a panel queues behind a batch job they cannot see. Two leaves four for whoever
 *  is actually looking at something.
 *
 *  Nested acquisition is always backfill-slot then TfL-slot and never the reverse, so there is no
 *  cycle to deadlock on. */
const MAX_BACKFILL_CONCURRENCY = 2;

/** A plain counting semaphore. Two of these exist and they behaved identically when each was
 *  written out by hand, which is the argument for the parameter.
 *
 *  The count is taken **synchronously**, at the moment the slot is granted. Incrementing it a
 *  microtask later — inside the `.then` that runs the work — is a bound that does not exist: the
 *  backfill hands sixty legs to this in one synchronous `map`, no microtask runs between them, so
 *  all sixty read `active === 0`, all sixty take the fast path, and sixty TfL calls leave at once
 *  under a comment promising two. It looked correct because it is correct for a caller that awaits
 *  between acquisitions, which is the one caller nobody writes. */
function semaphore(limit: number): <T>(run: () => Promise<T>) => Promise<T> {
  let active = 0;
  const waiting: Array<() => void> = [];
  /** Hand the slot to the next waiter rather than freeing it and letting them re-take it: between
   *  the decrement and a woken waiter's increment there is a microtask in which a fresh caller can
   *  slip past the limit and the waiter is left queued behind work that arrived after it. */
  const release = () => {
    const next = waiting.shift();
    if (next) next();
    else active--;
  };
  return <T>(run: () => Promise<T>): Promise<T> => {
    const queued = active >= limit;
    if (!queued) active++;
    const slot = queued ? new Promise<void>((resolve) => waiting.push(resolve)) : Promise.resolve();
    // `slot.then(run)` rather than calling `run()` here: it turns a synchronous throw inside `run`
    // into a rejection, so `finally` still runs and the slot is not lost for the life of the
    // instance — a leaked slot is a queue that quietly stops draining.
    return slot.then(run).finally(release);
  };
}

const withTflSlot = semaphore(MAX_TFL_CONCURRENCY);
const withBackfillSlot = semaphore(MAX_BACKFILL_CONCURRENCY);

/** What a caller may ask for in one call. Batched rather than one request per leg: a listing with
 *  five saved places and three modes is fifteen journeys, and fifteen round trips through a
 *  function cold-start is the difference between a panel that fills in and one you watch fill in. */
type Ask =
  | {
      kind: 'journeys';
      /** The listing's postcode. */
      origin: string;
      destinations: Array<{
        postcode: string;
        /** Coordinates where we have them. TfL's own geocoder resolved a terminated Heathrow
         *  postcode to a point in northwest London, so a known point beats the string. */
        lat?: number | null;
        lon?: number | null;
      }>;
      modes: TravelMode[];
      /** Ignore the cache and re-ask. The one button in the interface that costs real calls. */
      refresh?: boolean;
    }
  | { kind: 'stations'; postcode: string; names: string[] }
  | { kind: 'postcode'; postcode: string };

interface JourneyAnswer {
  destPostcode: string;
  mode: TravelMode;
  seconds: number;
  changes: number | null;
  options?: JourneyOption[];
  /** Present when this leg could not be answered. `transient: false` means TfL settled it — there
   *  is no such journey — and the negative has been cached; `true` means try again later. */
  error?: string;
  transient?: boolean;
  /** For the log line, and for `pnpm check:travel` to assert a second call costs nothing. */
  cached: boolean;
}

// ------------------------------------------------------------------------------------------------
// Rate limiting.
//
// The key is ours now rather than the caller's, so a caller who opens two hundred listings is
// spending our quota. `api_usage` already exists for the OpenAI spend cap and already has an index
// on (user_id, occurred_at); counting rows in it is enough here, because unlike the analysis cap
// this is about call volume rather than money — a journey costs nothing but TfL's goodwill.
// ------------------------------------------------------------------------------------------------

/** Per minute rather than per hour, which is a change of shape and not only of number.
 *
 *  The old cap was 600 an hour, justified as "roughly forty listings an hour with five places and
 *  three modes each, which is more than anybody browsing does". That stopped being true when Places
 *  became one screen over the whole pile: opening the table asks for every flat at once, so fifty
 *  flats with five places and three modes is 750 legs in one legitimate page load. The person who
 *  did nothing wrong then spent the *rest of the hour* refused, which is the failure — an hour-long
 *  window turns one honest burst into an hour of a broken-looking app.
 *
 *  What the cap is actually protecting is TfL, and TfL's own limit is per minute (500 keyed, 50
 *  unkeyed — see `TFL_APP_KEY`), so a per-minute window is the one that measures the thing being
 *  protected. 300 sits under the keyed allowance with room for the backfill alongside, absorbs any
 *  single page load whole, and still stops a loop dead: a runaway caller is refused within seconds
 *  and recovers a minute later rather than an hour later.
 *
 *  `MAX_TFL_CONCURRENCY` is what keeps a burst from arriving all at once; this is what bounds the
 *  total. The two are not substitutes and neither implies the other. */
const CALLS_PER_MINUTE = 300;

const RATE_WINDOW_MS = 60 * 1000;

async function checkRate(caller: Caller): Promise<void> {
  const since = new Date(Date.now() - RATE_WINDOW_MS).toISOString();
  const used = await rpc<number>('travel_calls_since', { p_user_id: caller.userId, p_since: since });
  if ((used ?? 0) >= CALLS_PER_MINUTE) {
    // A stated state, not a 500: the interface says how many and over what, and — unlike the hourly
    // version — waiting a moment is genuinely the fix, so saying so is not a brush-off.
    throw new HttpError(
      429,
      'rate-limited',
      `${used} travel lookups in the last minute, limit ${CALLS_PER_MINUTE} — try again in a minute`,
    );
  }
}

/** One row per request that actually made TfL calls, carrying how many. Cache hits are not
 *  recorded — they cost nothing and would drown the thing this exists to measure.
 *
 *  `input_tokens` holds the count. There are no tokens here and the cost is zero; the column is
 *  reused so this needed no schema change, and the meaning is written down on
 *  `travel_calls_since` and in the migration beside it. Failing to record must not fail the
 *  request: the answer is already correct and the caller has already spent the call. */
async function recordCalls(caller: Caller, made: number): Promise<void> {
  if (made <= 0) return;
  await rpc('record_api_usage', {
    p_project_id: caller.activeProjectId,
    p_user_id: caller.userId,
    p_model: 'tfl',
    p_input_tokens: made,
    p_cached_input_tokens: 0,
    p_output_tokens: 0,
    p_rightmove_id: null,
    p_kind: 'travel',
  }).catch((e) => console.warn('could not record travel usage:', e instanceof Error ? e.message : e));
}

// ------------------------------------------------------------------------------------------------
// The caches. Read directly, written through the same three RPCs as before — except that now the
// service role is the only thing holding execute on them.
// ------------------------------------------------------------------------------------------------

interface TravelRow {
  dest_postcode: string;
  mode: TravelMode;
  seconds: number | null;
  changes: number | null;
  journeys: JourneyOption[] | null;
  no_route: boolean;
  /** Why there is no number, where the row knows. Null on anything written before the column
   *  existed, which is honestly "no more than `no_route` says". */
  reason: string | null;
  basis: string | null;
  computed_at: string;
}

async function cachedJourneys(origin: string): Promise<Map<string, TravelRow>> {
  const rows = await rest<TravelRow[]>(
    `travel_time?origin_postcode=eq.${encodeURIComponent(origin)}` +
      '&select=dest_postcode,mode,seconds,changes,journeys,no_route,reason,basis,computed_at',
  );
  return new Map(rows.map((r) => [`${r.dest_postcode}:${r.mode}`, r]));
}

/** What asking TfL about one leg produced, before anybody decides what to do with it. */
interface LegOutcome {
  /** Null when there is no duration: TfL settled it, or we could not ask. */
  seconds: number | null;
  changes: number | null;
  options?: JourneyOption[];
  /** Present when the leg could not be answered with a duration. */
  error?: string;
  /** True when the question is settled — there is no such journey. False means try again later.
   *  Only meaningful alongside `error`.
   *
   *  Deliberately *not* "and it was cached". Whether the negative was stored is `cacheWriteFailure`
   *  below, and folding the two together makes a broken write look like an outage to whoever is
   *  waiting: a walk refused on distance would come back to the browser as `transient`, drawn as
   *  "TfL did not answer", naming TfL for a call nobody made. The two facts are read by different
   *  callers — this one decides what to tell the person, that one decides whether the backlog has
   *  finished with the leg — so they stay two fields. */
  settled: boolean;
  /** True once a request has actually left for TfL. A leg refused on distance never asks, and
   *  counting it as a call would spend a caller's per-minute allowance on the call we saved. */
  askedTfl: boolean;
  /** Set when the answer was right and storing it was not. */
  cacheWriteFailure?: string;
}

/** How far apart the two ends of a leg are in a straight line, or null where either could not be
 *  placed. Only the walking refusal reads it, and null there asks as it always did.
 *
 *  One function because the two callers differ only in where the coordinates come from — the
 *  backfill is handed both by `travel_gaps`, the interactive path looks the origin up — and a
 *  null-check written twice is a null-check that ends up written two different ways. */
function apartMiles(
  from: { lat: number | null; lon: number | null } | null,
  to: { lat?: number | null; lon?: number | null },
): number | null {
  if (from === null || from.lat === null || from.lon === null) return null;
  if (to.lat === null || to.lat === undefined || to.lon === null || to.lon === undefined) return null;
  return distanceMiles({ lat: from.lat, lon: from.lon }, { lat: to.lat, lon: to.lon });
}

/** One leg: ask TfL, cache whatever comes back, and report what happened.
 *
 *  Shared by the two things that need a journey — a caller asking about a listing they are looking
 *  at, and the backlog working through the ones nobody has opened. They differ entirely in what they
 *  do with the outcome, and not at all in how a leg is resolved, which is the half carrying the
 *  cache-write rules that took a deploy to get right. */
async function resolveLeg(
  origin: string,
  destPostcode: string,
  to: string,
  mode: TravelMode,
  /** How far apart the two ends are in a straight line, where both are known. Only the walking
   *  refusal below reads it; null means "we could not measure", which asks as it always did. */
  straightLineMiles: number | null = null,
): Promise<LegOutcome> {
  const outcome: LegOutcome = { seconds: null, changes: null, settled: false, askedTfl: false };
  try {
    // Settled without asking, and settled honestly — `tooFarToWalk` holds both the rule and the
    // sentence. Thrown as a non-transient `TflError` rather than handled separately so it goes down
    // the one path a settled negative already has: cached as `no_route`, counted as one, and shown
    // in its own words in the hover where the dash is.
    const refusal = tooFarToWalk(mode, straightLineMiles);
    if (refusal) throw new TflError(refusal, false);
    outcome.askedTfl = true;
    // No `now` argument: `journeyTime` pins transit to the next weekday 09:00 itself, and this is
    // the only place that calls it, so the basis is a property of the system rather than of whoever
    // asked (design D4). Through the queue so one request's fifteen legs, and a grid's worth of
    // requests at once, do not all hit TfL in the same instant.
    const journey = await withTflSlot(() => journeyTime(origin, to, mode, TFL_APP_KEY));
    // Transient, deliberately, so it goes out uncached and is reported in its own words: a walk
    // TfL's graph could not have measured honestly is a fault in the planner, not a fact about the
    // journey, and a no-route row would make a 17-minute detour into a dash that outlives the fix.
    const detour = implausibleWalk(mode, journey.seconds, straightLineMiles);
    if (detour) throw new TflError(detour, true);
    // A failed cache write must not turn a good answer into a permanent "no route", which is what
    // happened when this sat inside the catch. It must still be *loud*: a write that silently fails
    // means every lookup costs a fresh TfL call forever, and the only visible symptom is that
    // nothing is ever cached — which is exactly how the service role being refused by these RPCs
    // survived its first deploy.
    await rpc('cache_travel', {
      p_origin_postcode: origin,
      p_dest_postcode: destPostcode,
      p_mode: mode,
      p_seconds: journey.seconds,
      p_changes: journey.changes,
      p_no_route: false,
      p_journeys: journey.options ?? null,
      p_basis: TRAVEL_BASIS[mode],
    }).catch((e) => {
      outcome.cacheWriteFailure = `cache_travel ${origin} -> ${destPostcode} ${mode}: ${e}`;
    });
    outcome.seconds = journey.seconds;
    outcome.changes = journey.changes;
    outcome.options = journey.options;
    return outcome;
  } catch (e) {
    // Only a TflError carries a considered verdict on whether TfL settled the question. Anything
    // else — a parse failure, a bug here — is transient, because caching a negative is permanent and
    // being wrong about it is expensive.
    outcome.settled = e instanceof TflError && !e.transient;
    outcome.error = e instanceof Error ? e.message : String(e);
    if (outcome.settled) {
      await rpc('cache_travel', {
        p_origin_postcode: origin,
        p_dest_postcode: destPostcode,
        p_mode: mode,
        p_seconds: null,
        p_changes: null,
        p_no_route: true,
        p_journeys: null,
        p_basis: TRAVEL_BASIS[mode],
        // What settled it, in words, so the dash this becomes on screen says the true thing rather
        // than the one sentence every no-route row used to be given — which credits TfL for
        // verdicts, like the walking refusal above, that TfL was never asked for.
        p_reason: outcome.error,
      }).catch((err) => {
        outcome.cacheWriteFailure = `cache_travel no-route ${origin} -> ${destPostcode} ${mode}: ${err}`;
      });
    }
    return outcome;
  }
}

/** The cached row that answers this leg, or null when it has to be resolved.
 *
 *  Not every cached row answers the question now being asked. `staleTravel` holds the rules — a
 *  number measured on a different basis, a no-route old enough to be worth re-asking, a transit row
 *  from before the leg breakdown was stored — and each fills itself in on the next visit rather than
 *  needing a migration. Written once because two things now ask it: the leg itself, and whether the
 *  origin is worth placing at all. */
function answeredBy(cache: Map<string, TravelRow>, destPostcode: string, mode: TravelMode): TravelRow | null {
  const row = cache.get(`${destPostcode}:${mode}`);
  if (row === undefined) return null;
  return staleTravel(toCached(row), mode) === null ? row : null;
}

async function resolveJourneys(caller: Caller, ask: Extract<Ask, { kind: 'journeys' }>) {
  const origin = ask.origin.trim();
  if (!origin) throw new HttpError(400, 'bad-request', 'a journey needs an origin postcode');
  if (ask.destinations.length === 0) return { answers: [] as JourneyAnswer[] };

  const cache = ask.refresh ? new Map<string, TravelRow>() : await cachedJourneys(origin);

  // Where the flat is, for the walking refusal — which needs a point at each end, and gets the
  // origin as a postcode string, because a postcode is the right thing to route from and the wrong
  // thing to measure with. The backfill has the point handed to it by `travel_gaps`; here nobody
  // has asked for it, so it is looked up rather than taken off Rightmove's own map pin, which is
  // deliberately fuzzed.
  //
  // Only when a walking leg is actually going to be resolved. A grid on the website mounts one
  // request per flat and most of them are answered entirely from the cache, so placing the origin
  // unconditionally would add a postcodes.io round trip per flat to a page load that needed none.
  // A postcode that will not resolve leaves this null, and the leg is asked exactly as it was.
  const placingOrigin =
    ask.modes.includes('walking') &&
    ask.destinations.some((d) => answeredBy(cache, d.postcode, 'walking') === null);
  const originPoint = placingOrigin ? (await lookupPostcode(origin)).point : null;

  let made = 0;
  // Collected rather than thrown: the answers are already correct and the caller should get them.
  // Reported at the end, because "we resolved fifteen legs and cached none of them" is a broken
  // system that otherwise looks like a working one.
  const cacheWriteFailures: string[] = [];

  const answers = await Promise.all(
    ask.destinations.flatMap((destination) =>
      ask.modes.map(async (mode): Promise<JourneyAnswer> => {
        const row = answeredBy(cache, destination.postcode, mode);
        if (row) {
          if (row.no_route) {
            return {
              destPostcode: destination.postcode,
              mode,
              seconds: 0,
              changes: null,
              // The row's own words where it has them, and an admission where it does not: a row
              // written before reasons were stored knows no more, and saying so is the difference
              // between a dash somebody re-asks and one they believe.
              error: row.reason ?? NO_REASON_RECORDED,
              transient: false,
              cached: true,
            };
          }
          return {
            destPostcode: destination.postcode,
            mode,
            seconds: row.seconds ?? 0,
            changes: row.changes,
            options: row.journeys ?? undefined,
            cached: true,
          };
        }

        // Coordinates, not the postcode string, wherever we have them — see the type above.
        const to =
          destination.lat !== null && destination.lat !== undefined && destination.lon !== null && destination.lon !== undefined
            ? `${destination.lat},${destination.lon}`
            : destination.postcode;

        const leg = await resolveLeg(origin, destination.postcode, to, mode, apartMiles(originPoint, destination));
        // After the fact rather than before it, so a refusal is not billed as a call.
        if (leg.askedTfl) made++;
        if (leg.cacheWriteFailure) cacheWriteFailures.push(leg.cacheWriteFailure);
        if (leg.error) {
          return {
            destPostcode: destination.postcode,
            mode,
            seconds: 0,
            changes: null,
            error: leg.error,
            transient: !leg.settled,
            cached: false,
          };
        }
        return {
          destPostcode: destination.postcode,
          mode,
          seconds: leg.seconds ?? 0,
          changes: leg.changes,
          options: leg.options,
          cached: false,
        };
      }),
    ),
  );

  await recordCalls(caller, made);
  // Transient leg errors — TfL or postcodes.io unreachable, a parse failure — come back to the
  // caller inside a 200 and are invisible in the log otherwise: "15 from TfL" reads the same whether
  // all fifteen answered or all fifteen threw. A settled no-route carries `transient: false` and is
  // a real answer, not a fault, so it is not counted here.
  const brokenLegs = answers.filter((a) => a.error && a.transient);
  // Counted rather than subtracted: legs are now cached, asked, or settled without asking, and
  // "everything that was not a call was a cache hit" stopped being true the moment the third
  // category existed.
  const fromCache = answers.filter((a) => a.cached).length;
  const refused = answers.length - fromCache - made;
  console.log(
    `travel ${origin}: ${answers.length} legs, ${fromCache} cached, ${made} from TfL` +
      (refused > 0 ? `, ${refused} too far to walk` : '') +
      (brokenLegs.length > 0 ? `, ${brokenLegs.length} failed` : ''),
  );
  if (brokenLegs.length > 0) {
    const sample = brokenLegs.slice(0, 3).map((a) => `${a.destPostcode} ${a.mode}: ${a.error}`);
    const line = `${brokenLegs.length} of ${answers.length} travel legs failed for ${origin}:\n  ${sample.join('\n  ')}`;
    // Every attempted leg failing is an upstream outage, not a bad destination — say so loudly.
    if (made > 0 && brokenLegs.length >= made) console.error(`ALL TfL legs failed — upstream likely down. ${line}`);
    else console.warn(line);
  }
  if (cacheWriteFailures.length > 0) {
    console.error(
      `CACHE NOT WRITTEN for ${cacheWriteFailures.length} of ${answers.length} legs — every lookup ` +
        `will cost a TfL call until this is fixed:\n  ${cacheWriteFailures.join('\n  ')}`,
    );
  }
  return { answers, cacheWriteFailures: cacheWriteFailures.length };
}

/** Walking time to each nearby station, and the lines it carries.
 *
 *  Both lookups are cached and both caches are global, so a station in a neighbourhood anyone has
 *  searched before costs nothing. A station TfL has never heard of is cached as such — a null point
 *  is a real answer and stops us asking again. */
async function resolveStations(caller: Caller, ask: Extract<Ask, { kind: 'stations' }>) {
  const postcode = ask.postcode.trim();
  if (!postcode) throw new HttpError(400, 'bad-request', 'a station walk needs a postcode');

  const walkRows = await rest<Array<{ station_name: string; seconds: number }>>(
    `station_walk?postcode=eq.${encodeURIComponent(postcode)}&select=station_name,seconds`,
  );
  const knownWalks = new Map(walkRows.map((r) => [r.station_name, r.seconds]));

  const out: Record<string, { seconds?: number; lines: string[] }> = {};
  let made = 0;
  const failures: string[] = [];

  // Where the flat is, for the detour check on a walk — looked up once, and only if some station
  // needs a walk measured, for the reason `resolveJourneys` gives: most asks are answered from
  // the cache and owe postcodes.io nothing. A postcode that will not resolve leaves this null and
  // the walk is kept as it always was; the check needs a measurement and does not guess one.
  let originPoint: Promise<Point | null> | undefined;
  const placeOrigin = () =>
    (originPoint ??= lookupPostcode(postcode)
      .then((r) => r.point)
      // Rejecting here would throw from the `await` below, which runs *after* `walkTo` has spent a
      // TfL call and produced a number — discarding a good measurement, leaving the walk uncached,
      // and drawing the station with its line dots and no time. Null is what the comment above
      // promises; this is what makes it true.
      .catch((e: unknown) => {
        console.warn(
          `could not place ${postcode} for the walk detour check: ` +
            `${e instanceof Error ? e.message : e} — the walk is kept unchecked`,
        );
        return null;
      }));

  await Promise.all(
    ask.names.map(async (name) => {
      try {
        const points = await rest<Array<{ lat: number | null; lon: number | null; lines: string[] | null }>>(
          `station_point?name=eq.${encodeURIComponent(name)}&select=lat,lon,lines`,
        );
        let station: StationInfo | null;
        if (points.length > 0) {
          const p = points[0]!;
          station = p.lat === null || p.lon === null ? null : { lat: p.lat, lon: p.lon, lines: p.lines ?? [] };
        } else {
          made++;
          station = await withTflSlot(() => resolveStation(name, TFL_APP_KEY));
          await rpc('cache_station_point', {
            p_name: name,
            p_lat: station?.lat ?? null,
            p_lon: station?.lon ?? null,
            p_lines: station?.lines ?? [],
          });
        }
        if (!station) return; // TfL does not know it — omit rather than invent a number.

        // The lines as soon as the point resolves, the walk only if it succeeds. They used to be
        // written together, so a walk that threw took the line dots with it and a station that had
        // resolved perfectly rendered as though the cache had never heard of it — which is how an
        // origin postcode TfL would not route from was diagnosed by a database query instead of by
        // a glance at a row with dots and no time.
        const entry: { seconds?: number; lines: string[] } = { lines: station.lines };
        out[name] = entry;

        const known = knownWalks.get(name);
        if (known !== undefined) {
          entry.seconds = known;
          return;
        }

        made++;
        // A `let` loses its post-guard non-null narrowing inside a closure, so capture the
        // resolved station in a const before handing it to the queue.
        const at = station;
        const seconds = await withTflSlot(() => walkTo(postcode, at, TFL_APP_KEY));
        // Not cached and not shown: the straight-line distance beside the station stands in, which
        // is what a station with no walk already shows. See `implausibleWalk` for the ratio.
        const detour = implausibleWalk('walking', seconds, apartMiles(await placeOrigin(), at));
        if (detour) throw new TflError(detour, true);
        await rpc('cache_station_walk', { p_postcode: postcode, p_station_name: name, p_seconds: seconds });
        entry.seconds = seconds;
      } catch (e) {
        // A missing walk degrades one row; the straight-line distance is still shown. Logged as an
        // error rather than swallowed or warned, because "every station is missing its walk" is a
        // broken system that renders as a slightly sparser list.
        failures.push(`${name}: ${e instanceof Error ? e.message : e}`);
      }
    }),
  );

  await recordCalls(caller, made);
  if (failures.length > 0) {
    console.error(`${failures.length} of ${ask.names.length} stations failed:\n  ${failures.join('\n  ')}`);
  }
  return { walks: out, failures: failures.length };
}

/** Where a postcode is.
 *
 *  Not cached in the database, unlike the travel times: postcodes.io is free, keyless and instant,
 *  and a round trip to the database to avoid one would cost more than it saves. It is here rather
 *  than in the client only because a browser page cannot reach postcodes.io either. */
async function resolvePostcode(ask: Extract<Ask, { kind: 'postcode' }>) {
  const postcode = ask.postcode.trim();
  if (!postcode) throw new HttpError(400, 'bad-request', 'a lookup needs a postcode');
  const { point } = await lookupPostcode(postcode);
  return { point };
}

// ------------------------------------------------------------------------------------------------
// The backlog.
//
// Everything above answers a question somebody asked. This answers the ones nobody has: the journeys
// the hunt needs and has never had a reason to look up, which is every leg of every flat nobody has
// opened since the place was added. `travel_gaps` derives them (see the migration for why it is
// derived rather than enqueued); this works through as many as one run's budget allows and is called
// on a schedule, so the backlog drains on its own instead of waiting for somebody to click a flat.
// ------------------------------------------------------------------------------------------------

/** What one scheduled run may spend, in TfL calls.
 *
 *  Sized against the wall clock rather than the rate limit: two at a time at roughly a second each
 *  is about a minute of work, comfortably inside a function invocation, and at the every-15-minutes
 *  cadence the pg_cron job runs at (`20260816020000_travel_backfill_cron.sql`) it is ~240 legs an
 *  hour — a few thousand a
 *  day, which clears any backlog a household hunt can generate within a day of adding a place.
 *  Against TfL's 500-a-minute keyed allowance it is not close to anything. */
const DEFAULT_BACKFILL_CALLS = 60;

/** A ceiling on what a caller may ask for, because the budget is a parameter and a function
 *  invocation has a wall clock. A one-off catch-up run can ask for more than the default; it cannot
 *  ask for a number that will be killed halfway and report nothing. */
const MAX_BACKFILL_CALLS = 200;

/** The only thing the service role may ask for. Deliberately a separate type from `Ask`: a signed-in
 *  caller cannot reach this, and adding it to the union is how it would accidentally become
 *  reachable. */
interface SystemAsk {
  kind: 'backfill';
  /** Legs this run may draw. Clamped to `MAX_BACKFILL_CALLS`.
   *
   *  A ceiling on TfL calls rather than an allowance of them: it is passed straight to
   *  `travel_gaps` as a row limit, and a leg refused on distance uses one without calling anybody.
   *  So a run's real call count is this number minus its refusals, which the log line prints. */
  budget?: number;
}

interface Gap {
  origin_postcode: string;
  origin_lat: number | null;
  origin_lon: number | null;
  dest_postcode: string;
  dest_lat: number | null;
  dest_lon: number | null;
  mode: TravelMode;
  /** The whole outstanding count, carried on every row — see `travel_gaps`. */
  remaining: number;
}

/** Refuses a mode the migration names and we do not route: it would fall through `journeyTime`'s
 *  lookup to the planner's default and be cached as a transit number under whatever label the
 *  migration invented, so the rows are checked rather than trusted.
 *
 *  Only that direction. A run sees the modes it happens to draw, and a mode with no outstanding
 *  gaps returns no rows at all, so nothing here can tell that the migration is *missing* one we
 *  route — that half is `pnpm check:travel`, which compares the two texts. */
function checkModes(gaps: Gap[]): void {
  const unknown = [...new Set(gaps.map((g) => g.mode).filter((mode) => !TRAVEL_MODES.includes(mode)))];
  if (unknown.length > 0) {
    throw new HttpError(
      500,
      'bad-gap',
      `travel_gaps returned ${unknown.map((m) => `"${String(m)}"`).join(', ')}, which is not a mode we route — ` +
        'the migration and TRAVEL_MODES have diverged',
    );
  }
}

/** The one credential that means "this is the schedule", and the header it travels in.
 *
 *  It was the service-role key in `Authorization`, which worked and was the wrong secret: that key
 *  opens every table in the database, and the only thing the schedule may do with it is ask for
 *  `kind: 'backfill'`. One secret doing two jobs is also one neither purpose can rotate alone.
 *
 *  Its own header rather than `Authorization`, because that header and `apikey` belong to the
 *  gateway, which validates them as project keys and rejects a random string before this function is
 *  reached. The schedule sends the *publishable* key in both — safe, since every table here is
 *  `to authenticated` and `anon` holds nothing — and this token is what the function decides on.
 *
 *  SETUP.md has the rest, including why tying this to the platform's own service key turned out to
 *  be a way of failing silently. */
const BACKFILL_TOKEN = Deno.env.get('TRAVEL_BACKFILL_TOKEN');
const BACKFILL_HEADER = 'x-backfill-token';

/** Is this the scheduled backfill calling, rather than a person?
 *
 *  Constant-time so a wrong guess leaks nothing about how much of it was right; the cost is a loop
 *  over a few dozen characters. An unset token is not a wildcard — with nothing to compare against
 *  this answers no, and the caller falls through to `requireCaller` and is refused as a person
 *  would be. */
function isBackfill(request: Request): boolean {
  const token = request.headers.get(BACKFILL_HEADER);
  if (token === null || !BACKFILL_TOKEN) return false;
  if (token.length !== BACKFILL_TOKEN.length) return false;
  let differences = 0;
  for (let at = 0; at < token.length; at++) differences |= token.charCodeAt(at) ^ BACKFILL_TOKEN.charCodeAt(at);
  return differences === 0;
}

/** Work the backlog down by one run's budget.
 *
 *  Failures are recorded rather than thrown: one unroutable pair must not end a run that has
 *  fifty-nine good legs left in it, and it must not be tried again immediately either, which is what
 *  `record_travel_failure` is for.
 *
 *  Nothing here is written to `api_usage`. That table is the per-user hourly allowance, and a
 *  scheduled job is not a user — charging it to somebody would spend the allowance of whoever
 *  happened to be named, and charging it to nobody needs a row that means nothing. The bound on this
 *  path is its budget times its cadence, which is fixed in advance and stronger than a counter read
 *  after the fact. */
async function runBackfill(ask: SystemAsk) {
  const asked = Number(ask.budget);
  const budget = Number.isFinite(asked) && asked > 0 ? Math.min(Math.floor(asked), MAX_BACKFILL_CALLS) : DEFAULT_BACKFILL_CALLS;

  const gaps = await rpc<Gap[]>('travel_gaps', { p_limit: budget });
  // `remaining` is identical on every row; an empty backlog has no rows to carry it.
  const outstanding = gaps[0]?.remaining ?? 0;
  if (gaps.length === 0) {
    console.log('travel backfill: nothing outstanding');
    return { attempted: 0, routed: 0, noRoute: 0, failed: 0, outstanding: 0 };
  }
  checkModes(gaps);

  let routed = 0;
  let noRoute = 0;
  let refused = 0;
  const failures: string[] = [];
  const cacheWriteFailures: string[] = [];

  await Promise.all(
    gaps.map((gap) =>
      withBackfillSlot(async () => {
        // Coordinates where the place has them, for the same reason the interactive path prefers
        // them: TfL's geocoder resolved a terminated postcode to a point in the wrong part of London.
        const to = gap.dest_lat !== null && gap.dest_lon !== null ? `${gap.dest_lat},${gap.dest_lon}` : gap.dest_postcode;
        const apart = apartMiles({ lat: gap.origin_lat, lon: gap.origin_lon }, { lat: gap.dest_lat, lon: gap.dest_lon });
        const leg = await resolveLeg(gap.origin_postcode, gap.dest_postcode, to, gap.mode, apart);
        if (leg.cacheWriteFailure) cacheWriteFailures.push(leg.cacheWriteFailure);

        // Unfinished, and it is the *storing* that decides that rather than the answer. A leg whose
        // answer was not written leaves no row however good the answer was, so `travel_gaps` derives
        // it again on the next run and on every run after it — and counting it as done here is what
        // turned a broken write into a leg the backlog re-answered forever, logging it each time and
        // clearing the backoff it should have been recording. Backing off is also what stops one
        // broken write spending the whole budget on the same handful of legs.
        const unfinished = leg.cacheWriteFailure ?? (leg.error && !leg.settled ? leg.error : undefined);
        if (unfinished) {
          failures.push(`${gap.origin_postcode} -> ${gap.dest_postcode} ${gap.mode}: ${unfinished}`);
          await rpc('record_travel_failure', {
            p_origin_postcode: gap.origin_postcode,
            p_dest_postcode: gap.dest_postcode,
            p_mode: gap.mode,
            p_error: unfinished,
          }).catch((e) => {
            // A backoff that cannot be written means this pair returns in the next run and fails
            // again — wasteful rather than wrong, and invisible unless it is said out loud.
            console.error(`could not record travel failure for ${gap.origin_postcode} -> ${gap.dest_postcode}: ${e}`);
          });
          return;
        }

        // Answered, one way or another: a duration, TfL settling that there is no such journey, or
        // the leg refused here before anybody was asked. All three are cached, so all three leave
        // the gap set, and any backoff standing against the pair has served its purpose.
        //
        // The refusals are counted apart from TfL's verdicts because they are not TfL's verdicts —
        // the same objection the reason column exists to answer, and the number that says whether a
        // run's budget is going on journeys or on legs it declined to ask about.
        if (!leg.settled) routed++;
        else if (leg.askedTfl) noRoute++;
        else refused++;
        // Unconditionally, though the delete is usually a no-op: the gap row was read before the
        // call and cannot say what happened during it. Two overlapping runs can draw the same leg,
        // and if one fails and writes a backoff while the other succeeds, skipping the clear on the
        // stale snapshot leaves a backoff row standing over a cached answer — suppressing the leg
        // later, for a failure that was already overtaken.
        await rpc('clear_travel_failure', {
          p_origin_postcode: gap.origin_postcode,
          p_dest_postcode: gap.dest_postcode,
          p_mode: gap.mode,
        }).catch((e) => {
          console.warn(`could not clear travel backoff for ${gap.origin_postcode} -> ${gap.dest_postcode}: ${e}`);
        });
      }),
    ),
  );

  console.log(
    `travel backfill: ${gaps.length} attempted, ${routed} routed, ${noRoute} no-route, ` +
      `${refused} too far to walk, ${failures.length} failed, ${outstanding} outstanding before this run`,
  );
  if (failures.length > 0) {
    const line = `${failures.length} of ${gaps.length} backfilled legs failed:\n  ${failures.slice(0, 5).join('\n  ')}`;
    // Every leg failing is an outage, not a set of bad postcodes — the distinction is the whole
    // difference between "wait" and "go and look".
    if (failures.length >= gaps.length) console.error(`ALL backfilled legs failed — upstream likely down. ${line}`);
    else console.warn(line);
  }
  if (cacheWriteFailures.length > 0) {
    console.error(
      `CACHE NOT WRITTEN for ${cacheWriteFailures.length} of ${gaps.length} backfilled legs — they will ` +
        `come back as gaps every run until this is fixed:\n  ${cacheWriteFailures.join('\n  ')}`,
    );
  }

  return { attempted: gaps.length, routed, noRoute, failed: failures.length, outstanding };
}

function toCached(row: TravelRow) {
  return {
    destPostcode: row.dest_postcode,
    mode: row.mode,
    seconds: row.seconds,
    changes: row.changes,
    options: row.journeys,
    noRoute: row.no_route,
    reason: row.reason,
    basis: row.basis,
    computedAt: row.computed_at,
  };
}


serve(async (request) => {
  // The scheduled backfill first, and settled from the header alone before anything is read or any
  // round trip is made. Deliberately ahead of `requireCaller`: it is the only caller that is not a
  // person, it holds no session and has no hourly allowance to check, and leaving the order below
  // untouched means an unauthenticated request still gets its 401 before its body is parsed.
  if (isBackfill(request)) {
    // `body` is a cast and nothing more, so a JSON `null` or a bare string would reach the field
    // access below as a TypeError and leave through the 500 path — a broken request reported as a
    // broken server, which is the one distinction the reply convention exists to keep.
    const ask = (await body<SystemAsk>(request)) as SystemAsk | null;
    if (typeof ask !== 'object' || ask === null || ask.kind !== 'backfill') {
      throw new HttpError(400, 'bad-request', `the backfill token asks for backfill, not ${String((ask as SystemAsk | null)?.kind)}`);
    }
    return await runBackfill(ask);
  }

  const caller = await requireCaller(request);
  await checkRate(caller);
  const ask = await body<Ask>(request);

  switch (ask.kind) {
    case 'journeys':
      return await resolveJourneys(caller, ask);
    case 'stations':
      return await resolveStations(caller, ask);
    case 'postcode':
      return await resolvePostcode(ask);
    default:
      throw new HttpError(400, 'bad-request', `unknown kind ${String((ask as { kind?: unknown }).kind)}`);
  }
});
