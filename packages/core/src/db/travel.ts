import { FunctionsHttpError } from '@supabase/supabase-js';
import { db } from './client';
import { accessToken } from './session';
import { Unauthenticated } from './session';
import { getCachedTravelFor, listPlaces, backfillPlaceCoords } from './supabase';
import { TRAVEL_MODES, type Place, type TravelMode, type TravelTime, type JourneyOption } from '../types';
import { staleTravel } from '../tfl';
import type { Point } from '../postcode';
import { logInfo, logWarn } from '../log';

/** Asking the `travel` Edge Function.
 *
 *  Every journey, station walk and postcode lookup goes through here, from both surfaces. It used
 *  to be a loop in the extension's background worker calling TfL directly, which a browser tab
 *  cannot do — and, more to the point, which made every signed-in client a writer of caches every
 *  project reads. See the header on `supabase/functions/travel/index.ts` for why that mattered more
 *  than the CORS problem did.
 *
 *  What is left on this side is the part that is genuinely the client's: which places this project
 *  saved, and mapping an answer about a postcode back onto the place it belongs to. The function
 *  decides what is cached, what is stale, and what the number is. */

interface JourneyAnswer {
  destPostcode: string;
  mode: TravelMode;
  seconds: number;
  changes: number | null;
  options?: JourneyOption[];
  error?: string;
  transient?: boolean;
  cached: boolean;
}

async function ask<T>(payload: Record<string, unknown>): Promise<T> {
  const token = await accessToken();
  if (!token) throw new Unauthenticated();

  // `functions.invoke` rather than a hand-rolled fetch: it already knows the project URL and sends
  // the publishable key alongside the bearer, and getting either wrong is a 401 that reads like a
  // session problem.
  const { data, error } = await db().functions.invoke('travel', {
    body: payload,
    headers: { Authorization: `Bearer ${token}` },
  });
  if (error) {
    throw await describeInvokeError(error, payload);
  }
  return data as T;
}

/** Turn a `functions.invoke` failure into an error a human can act on.
 *
 *  The function answers every refusal it has a story for with `{ code, error }` as JSON and a real
 *  status — 429 rate-limited, 401 unauthenticated, 500 failed. supabase-js collapses all of that to
 *  a single `FunctionsHttpError` whose message is the literal string "Edge Function returned a
 *  non-2xx status code" and hangs the actual `Response` off `.context`, unread. Rendered as-is that
 *  string fits every failure and points at none — which is what the panel was showing. Read the body
 *  back so the surface names the code, and log it, since a 500 here is the one thing no client cache
 *  papers over. */
async function describeInvokeError(error: unknown, payload: Record<string, unknown>): Promise<Error> {
  if (error instanceof FunctionsHttpError) {
    const res = error.context as Response;
    let code: string | undefined;
    let detail: string | undefined;
    try {
      const parsed = (await res.clone().json()) as { code?: string; error?: string };
      code = parsed.code;
      detail = parsed.error;
    } catch {
      // A non-JSON body (a gateway 502, say) has no code; the status still tells the story.
    }
    const label = [code, detail].filter(Boolean).join(': ') || 'the travel service refused';
    logWarn('travel', `invoke failed (${res.status})`, { kind: payload.kind, code, status: res.status, detail });
    return new Error(label);
  }
  logWarn('travel', 'invoke failed', { kind: payload.kind, error: error instanceof Error ? error.message : String(error) });
  return error instanceof Error ? error : new Error(String(error));
}

/** Lookups already running, by postcode, so two askers share one set of calls.
 *
 *  The panel and the shortlist both ask on load, and the sweep's paced opener puts several tabs on
 *  the same flat's postcode within seconds of each other. Each asker read the same empty cache and
 *  fired its own identical journey requests — which is how you earn a 429, and how two writes race
 *  for the same cache row.
 *
 *  Keyed on postcode alone rather than postcode-and-refresh: a refresh in flight is doing strictly
 *  more work than a plain read, so joining it is right. The entry is removed in a `finally` so a
 *  failure cannot leave a rejected promise cached and break every later request for that postcode.
 *
 *  This lived in the extension's background worker and moved here with the rest: a website with
 *  the compare table and a listing open in two tabs asks the same question twice just as readily. */
const inFlight = new Map<string, Promise<TravelTime[]>>();

/** Every saved place, by every mode, for one listing.
 *
 *  `refresh` skips the cache. It is the one control in the interface that costs real calls, which
 *  is why it is a parameter rather than the default. */
export function travelTimes(postcode: string, refresh = false): Promise<TravelTime[]> {
  const running = refresh ? undefined : inFlight.get(postcode);
  if (running) return running;

  const work = computeTravelTimes(postcode, refresh).finally(() => {
    if (inFlight.get(postcode) === work) inFlight.delete(postcode);
  });
  inFlight.set(postcode, work);
  return work;
}

async function computeTravelTimes(postcode: string, refresh: boolean): Promise<TravelTime[]> {
  const started = Date.now();

  const raw = await listPlaces();
  if (raw.length === 0) return [];

  // Coordinates for places added before we resolved them at entry. Kept client-side because it
  // writes to `place`, which is project data under RLS — the function has no business deciding
  // which project a place belongs to.
  const places: Place[] = await Promise.all(raw.map(backfillPlaceCoords));

  const { answers } = await ask<{ answers: JourneyAnswer[] }>({
    kind: 'journeys',
    origin: postcode,
    destinations: places.map((p) => ({ postcode: p.postcode, lat: p.lat, lon: p.lon })),
    modes: TRAVEL_MODES,
    refresh,
  });

  // Answers come back keyed on postcode, because a journey between two postcodes is a fact about
  // London and the cache is shared across projects. Two places at the same postcode — the office
  // and a colleague's desk — therefore share an answer, which is correct.
  const byKey = new Map(answers.map((a) => [`${a.destPostcode}:${a.mode}`, a]));

  const times: TravelTime[] = [];
  for (const place of places) {
    for (const mode of TRAVEL_MODES) {
      const answer = byKey.get(`${place.postcode}:${mode}`);
      if (!answer) {
        // The function answered without this leg. Say so rather than rendering a zero, which reads
        // as "no time at all".
        times.push({
          placeId: place.id,
          mode,
          seconds: 0,
          changes: null,
          error: 'the travel service did not answer for this place',
          transient: true,
        });
        continue;
      }
      times.push({
        placeId: place.id,
        mode,
        seconds: answer.seconds,
        changes: answer.changes,
        options: answer.options,
        ...(answer.error ? { error: answer.error, transient: answer.transient ?? false } : {}),
      });
    }
  }

  const cached = answers.filter((a) => a.cached).length;
  logInfo('travel', `${postcode}: ${times.length} legs in ${Date.now() - started}ms`, {
    cacheHits: cached,
    lookups: answers.length - cached,
    failed: times.filter((t) => t.error).length,
    refresh,
  });
  return times;
}

/** Walking time to each nearby station, and the lines it carries. */
export async function stationWalks(
  postcode: string,
  stations: string[],
): Promise<Record<string, { seconds?: number; lines: string[] }>> {
  if (stations.length === 0) return {};
  try {
    const { walks } = await ask<{ walks: Record<string, { seconds?: number; lines: string[] }> }>({
      kind: 'stations',
      postcode,
      names: stations,
    });
    return walks;
  } catch (e) {
    // A missing walk degrades one row of a list; the straight-line distance is still shown. Taking
    // a panel down over it would be the wrong trade.
    logWarn('travel', 'station walks failed', { postcode, error: e instanceof Error ? e.message : String(e) });
    return {};
  }
}

/** Where a postcode is, for the hub compass.
 *
 *  Memoised per process. The lookup is free and instant at the far end, but the round trip through
 *  a function is not, and the second and third listing in the same street ask the same question.
 *  The map dies with the process, which is fine — it is a cache, not a store.
 *
 *  Rightmove's own latitude and longitude are deliberately not the fallback. They are fuzzed
 *  (`pinType: "APPROXIMATE_POINT"`), and a fuzzed origin a few hundred yards out swings a bearing
 *  taken from a hub half a mile away by tens of degrees — a compass needle confidently pointing at
 *  the wrong half of the neighbourhood. Null, and the surface says it has no location. */
const points = new Map<string, Point | null>();

export async function locatePostcode(postcode: string): Promise<Point | null> {
  const known = points.get(postcode);
  if (known !== undefined) return known;

  const { point } = await ask<{ point: Point | null }>({ kind: 'postcode', postcode });
  points.set(postcode, point);
  return point;
}

/** Where each of many postcodes is — the read behind the map and the property/place coordinate
 *  backfill.
 *
 *  Through the function, not `postcodes.io` directly: the website's CSP allows `connect-src` to
 *  Supabase alone, so a browser fetch to postcodes.io is refused before it leaves the page — which
 *  is the same reason the single lookup and the journeys all route through here. The extension could
 *  reach it directly, but one path that works on both surfaces beats two that each work on one.
 *
 *  One postcode at a time rather than postcodes.io's hundred-per-call batch, because the function
 *  exposes the single `postcode` kind and looping it reuses the per-process memo above — so the
 *  second property on a street costs nothing. Bounded so a project with a hundred un-located rows
 *  does not open a hundred requests in the same tick. An unresolved postcode is simply absent from
 *  the map, exactly as the direct bulk lookup left it. */
export async function locatePostcodes(postcodes: string[]): Promise<Map<string, Point>> {
  const unique = [...new Set(postcodes)];
  const found = new Map<string, Point>();
  const CONCURRENCY = 6;
  for (let at = 0; at < unique.length; at += CONCURRENCY) {
    const batch = unique.slice(at, at + CONCURRENCY);
    const located = await Promise.all(batch.map(async (pc) => [pc, await locatePostcode(pc)] as const));
    for (const [pc, point] of located) if (point) found.set(pc, point);
  }
  return found;
}

/** What the cache already knows for a set of postcodes — no TfL calls, ever.
 *
 *  The compare table shows one row per property and a column per place, so it needs a number for
 *  every pairing at once. Read-through would be the obvious thing and the wrong one: opening the
 *  table would fire a journey-planner request for every gap, which is both slow and the sort of
 *  traffic that gets you rate-limited. A gap comes back absent and the table prints "—". Open the
 *  place itself, or its card, and `travelTimes` fills it in.
 *
 *  The cache is keyed on the destination's postcode rather than on a place id (design D5), so the
 *  places are loaded to map back. Two places at one postcode share a row and both read it, which is
 *  the point of re-keying. */
export async function cachedTravelTimes(postcodes: string[]): Promise<Record<string, TravelTime[]>> {
  const [places, by] = await Promise.all([listPlaces(), getCachedTravelFor(postcodes)]);
  const placesAt = destinationIndex(places);

  const out: Record<string, TravelTime[]> = {};
  for (const [postcode, rows] of by) {
    out[postcode] = rows.flatMap((r) => {
      const ids = placesAt.get(r.destPostcode) ?? [];
      // Marked, not dropped. Dropping every row measured before transit was pinned to a weekday
      // morning would blank the table's whole transit column until each listing was reopened,
      // and a blank teaches less than a number with a caveat on it.
      const stale = staleTravel(r, r.mode) ?? undefined;
      return ids.map((placeId) =>
        r.noRoute
          ? {
              placeId,
              mode: r.mode,
              seconds: 0,
              changes: null,
              error: 'TfL found no journey for this mode',
              transient: false,
              stale,
            }
          : {
              placeId,
              mode: r.mode,
              seconds: r.seconds ?? 0,
              changes: r.changes,
              options: r.options ?? undefined,
              stale,
            },
      );
    });
  }
  return out;
}

/** Postcode -> the places at it. A list rather than a single id: two places can share a postcode,
 *  and picking one of them would leave the other's column permanently blank. */
function destinationIndex(places: Place[]): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const place of places) {
    const list = index.get(place.postcode) ?? [];
    list.push(place.id);
    index.set(place.postcode, list);
  }
  return index;
}
