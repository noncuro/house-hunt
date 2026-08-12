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
  journeyTime,
  resolveStation,
  staleTravel,
  TflError,
  TRAVEL_BASIS,
  walkTo,
  type StationInfo,
} from '../_shared/tfl.ts';
import { lookupPostcode } from '../_shared/postcode.ts';
import type { JourneyOption, TravelMode } from '../_shared/types.ts';

requireEnv({
  SUPABASE_URL: Deno.env.get('SUPABASE_URL'),
  SUPABASE_SERVICE_ROLE_KEY: Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),
});

/** Optional, and deliberately so. TfL answers unkeyed requests at a lower rate limit, so a missing
 *  key degrades rather than breaks — which is what you want on the day somebody rotates it. */
const TFL_APP_KEY = Deno.env.get('TFL_APP_KEY') ?? undefined;

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

/** Roughly forty listings an hour with five places and three modes each, which is more than anybody
 *  browsing does and far less than a loop would. */
const CALLS_PER_HOUR = 600;

async function checkRate(caller: Caller): Promise<void> {
  const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const used = await rpc<number>('travel_calls_since', { p_user_id: caller.userId, p_since: since });
  if ((used ?? 0) >= CALLS_PER_HOUR) {
    // A stated state, not a 500: the interface says "too many lookups in the last hour" and the
    // person stops, rather than reloading into the same wall.
    throw new HttpError(429, 'rate-limited', `${used} travel lookups in the last hour, limit ${CALLS_PER_HOUR}`);
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
  basis: string | null;
  computed_at: string;
}

async function cachedJourneys(origin: string): Promise<Map<string, TravelRow>> {
  const rows = await rest<TravelRow[]>(
    `travel_time?origin_postcode=eq.${encodeURIComponent(origin)}` +
      '&select=dest_postcode,mode,seconds,changes,journeys,no_route,basis,computed_at',
  );
  return new Map(rows.map((r) => [`${r.dest_postcode}:${r.mode}`, r]));
}

async function resolveJourneys(caller: Caller, ask: Extract<Ask, { kind: 'journeys' }>) {
  const origin = ask.origin.trim();
  if (!origin) throw new HttpError(400, 'bad-request', 'a journey needs an origin postcode');
  if (ask.destinations.length === 0) return { answers: [] as JourneyAnswer[] };

  const cache = ask.refresh ? new Map<string, TravelRow>() : await cachedJourneys(origin);
  let made = 0;
  // Collected rather than thrown: the answers are already correct and the caller should get them.
  // Reported at the end, because "we resolved fifteen legs and cached none of them" is a broken
  // system that otherwise looks like a working one.
  const cacheWriteFailures: string[] = [];

  const answers = await Promise.all(
    ask.destinations.flatMap((destination) =>
      ask.modes.map(async (mode): Promise<JourneyAnswer> => {
        const row = cache.get(`${destination.postcode}:${mode}`);
        // Not every cached row answers the question now being asked. `staleTravel` holds the rules
        // — a number measured on a different basis, a no-route old enough to be worth re-asking, a
        // transit row from before the leg breakdown was stored — and each fills itself in on the
        // next visit rather than needing a migration.
        const stale = row === undefined ? null : staleTravel(toCached(row), mode);
        if (row && stale === null) {
          if (row.no_route) {
            return {
              destPostcode: destination.postcode,
              mode,
              seconds: 0,
              changes: null,
              error: 'TfL found no journey for this mode',
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

        made++;
        try {
          // No `now` argument: `journeyTime` pins transit to the next weekday 09:00 itself, and
          // this is the only place that calls it, so the basis is a property of the system rather
          // than of whoever asked (design D4).
          const journey = await journeyTime(origin, to, mode, TFL_APP_KEY);
          // A failed cache write must not turn a good answer into a permanent "no route", which is
          // what happened when this sat inside the catch. It must still be *loud*: a write that
          // silently fails means every lookup costs a fresh TfL call forever, and the only visible
          // symptom is that nothing is ever cached — which is exactly how the service role being
          // refused by these RPCs survived its first deploy.
          await rpc('cache_travel', {
            p_origin_postcode: origin,
            p_dest_postcode: destination.postcode,
            p_mode: mode,
            p_seconds: journey.seconds,
            p_changes: journey.changes,
            p_no_route: false,
            p_journeys: journey.options ?? null,
            p_basis: TRAVEL_BASIS[mode],
          }).catch((e) => {
            cacheWriteFailures.push(`cache_travel ${origin} -> ${destination.postcode} ${mode}: ${e}`);
          });
          return {
            destPostcode: destination.postcode,
            mode,
            seconds: journey.seconds,
            changes: journey.changes,
            options: journey.options,
            cached: false,
          };
        } catch (e) {
          // Only a TflError carries a considered verdict on whether TfL settled the question.
          // Anything else — a parse failure, a bug here — is transient, because caching a negative
          // is permanent and being wrong about it is expensive.
          const settled = e instanceof TflError && !e.transient;
          if (settled) {
            await rpc('cache_travel', {
              p_origin_postcode: origin,
              p_dest_postcode: destination.postcode,
              p_mode: mode,
              p_seconds: null,
              p_changes: null,
              p_no_route: true,
              p_journeys: null,
              p_basis: TRAVEL_BASIS[mode],
            }).catch((e) => {
              cacheWriteFailures.push(`cache_travel no-route ${origin} -> ${destination.postcode} ${mode}: ${e}`);
            });
          }
          return {
            destPostcode: destination.postcode,
            mode,
            seconds: 0,
            changes: null,
            error: e instanceof Error ? e.message : String(e),
            transient: !settled,
            cached: false,
          };
        }
      }),
    ),
  );

  await recordCalls(caller, made);
  // Transient leg errors — TfL or postcodes.io unreachable, a parse failure — come back to the
  // caller inside a 200 and are invisible in the log otherwise: "15 from TfL" reads the same whether
  // all fifteen answered or all fifteen threw. A settled no-route carries `transient: false` and is
  // a real answer, not a fault, so it is not counted here.
  const brokenLegs = answers.filter((a) => a.error && a.transient);
  console.log(
    `travel ${origin}: ${answers.length} legs, ${answers.length - made} cached, ${made} from TfL` +
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
          station = await resolveStation(name, TFL_APP_KEY);
          await rpc('cache_station_point', {
            p_name: name,
            p_lat: station?.lat ?? null,
            p_lon: station?.lon ?? null,
            p_lines: station?.lines ?? [],
          });
        }
        if (!station) return; // TfL does not know it — omit rather than invent a number.

        const known = knownWalks.get(name);
        if (known !== undefined) {
          out[name] = { seconds: known, lines: station.lines };
          return;
        }

        made++;
        const seconds = await walkTo(postcode, station, TFL_APP_KEY);
        await rpc('cache_station_walk', { p_postcode: postcode, p_station_name: name, p_seconds: seconds });
        out[name] = { seconds, lines: station.lines };
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

function toCached(row: TravelRow) {
  return {
    destPostcode: row.dest_postcode,
    mode: row.mode,
    seconds: row.seconds,
    changes: row.changes,
    options: row.journeys,
    noRoute: row.no_route,
    basis: row.basis,
    computedAt: row.computed_at,
  };
}


serve(async (request) => {
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
