import {
  accessToken,
  ensureSession,
  requireSession,
  signIn,
  signOut,
  startSessionHeartbeat,
  Unauthenticated,
} from '@/lib/auth';
import {
  describe,
  type AnalysisRequest,
  type AuthState,
  type Envelope,
  type Request,
  type ResponseMap,
} from '@/lib/messages';
import {
  addHub,
  addPlace,
  adminProjects,
  adminSetMaxMembers,
  adminSetPassword,
  adminSetProjectCap,
  adminSetUserCap,
  adminUsage,
  adminUsers,
  authState,
  activeProjectId,
  backfillPlaceCoords,
  cacheStationPoint,
  cacheStationWalk,
  cacheTravel,
  consumeInvites,
  createInvite,
  forgetActiveProject,
  getAnalysis,
  getCachedTravel,
  getCachedTravelFor,
  getStationPoint,
  getStationWalks,
  getShortlist,
  getSweepKnowledge,
  headcount,
  leaveProject,
  listHubs,
  listHubSweeps,
  listInvites,
  listMembers,
  NoActiveProject,
  pendingSightings,
  locateProperties,
  getVerdicts,
  listPlaces,
  recordSweepPage,
  recordProperty,
  redeemInvite,
  recordSightings,
  removeHub,
  removePlace,
  renameProject,
  resendInvite,
  resolveLocation,
  revokeInvite,
  setActiveProject,
  setDisplayName,
  setVerdict,
  spendSummary,
  updateHub,
} from '@/lib/supabase';
import { logInfo, logWarn } from '@/lib/log';
import { lookupPostcode, type Point } from '@/lib/postcode';
import { journeyTime, resolveStation, staleTravel, TflError, walkTo } from '@/lib/tfl';
import { TRAVEL_MODES, type Place, type TravelTime } from '@/lib/types';

/** The analysis runs on Supabase, not on anyone's laptop.
 *
 *  It used to be a local Node process holding the OpenAI key, which meant a listing was only ever
 *  analysed while one laptop was awake with a terminal open — the other person's laptop could read
 *  every result and produce none. It is now an Edge Function on the same project as the database.
 *  See supabase/functions/analyse/. */
const ANALYSIS_FUNCTION = `${import.meta.env.WXT_SUPABASE_URL}/functions/v1/analyse`;

const SHORTLIST_PAGE = 'shortlist.html';

export default defineBackground(() => {
  // The session refreshes itself even when nobody is using the extension, so an install left alone
  // for a week does not come back asking to sign in (design D2).
  startSessionHeartbeat();

  // Clicking the toolbar icon opens the shortlist, reusing the tab if it is already open rather
  // than stacking up copies of the same page.
  chrome.action.onClicked.addListener(() => {
    void (async () => {
      const url = chrome.runtime.getURL(SHORTLIST_PAGE);
      const [existing] = await chrome.tabs.query({ url });
      if (existing?.id !== undefined) {
        await chrome.tabs.update(existing.id, { active: true });
        if (existing.windowId !== undefined) await chrome.windows.update(existing.windowId, { focused: true });
        return;
      }
      await chrome.tabs.create({ url });
    })();
  });

  chrome.runtime.onMessage.addListener((request: Request, _sender, sendResponse) => {
    handle(request)
      .then((data) => sendResponse({ ok: true, data } satisfies Envelope<unknown>))
      .catch((e) => sendResponse(refusal(e)));
    return true; // keep the channel open for the async reply
  });
});

/** Being signed out and having no project are states with their own rendering everywhere, not
 *  failures — so they travel as flags rather than as error strings a view has to match on. A
 *  panel that shows a stack trace where it should say "sign in" is the fail-loudly rule inverted:
 *  loud about the wrong thing. */
function refusal(e: unknown): Envelope<never> {
  if (e instanceof Unauthenticated) {
    return { ok: false, unauthenticated: true, error: 'sign in to the house hunt extension' };
  }
  if (e instanceof NoActiveProject) {
    return { ok: false, noProject: true, error: e.message };
  }
  return { ok: false, error: describe(e) };
}

async function handle(request: Request): Promise<ResponseMap[Request['type']]> {
  switch (request.type) {
    // --- session ---------------------------------------------------------------------------
    case 'auth:state':
      return await readAuthState();

    case 'auth:sign-in': {
      const result = await signIn(request.email, request.password);
      if (result.status !== 'signed-in') return result;
      // Consume the invite HERE, and before reading the state. This line is the whole invite flow:
      // without it a newly invited person signs in and lands in no project forever. A comment on
      // this spot used to claim consumption happened, and nothing did it.
      //
      // It runs on EVERY sign-in and not only the first, which is what makes an invite into a
      // second house hunt work: somebody who already has an account is never sent a code, they just
      // sign in, and this is the line that notices they were asked somewhere new.
      await consumeInvites();
      forgetActiveProject();
      return { status: 'signed-in', state: await readAuthState() };
    }

    // Redeeming does not sign anybody in — it creates the account and stops. The page then sends
    // `auth:sign-in`, which is the same path everybody else takes, so there is exactly one place in
    // this system where a session begins and one place where invites are consumed.
    case 'auth:redeem':
      return await redeemInvite(request.email, request.password, request.code);

    case 'auth:sign-out':
      await signOut();
      forgetActiveProject();
      return null;

    case 'profile:set-name':
      await setDisplayName(request.displayName);
      return null;

    // --- projects --------------------------------------------------------------------------
    case 'project:list': {
      const state = await authState();
      return state.status === 'signed-in' ? state.projects : [];
    }

    case 'project:set-active':
      await setActiveProject(request.projectId);
      return await readAuthState();

    case 'project:rename':
      await renameProject(request.projectId, request.name);
      return null;

    case 'project:members':
      return await listMembers(request.projectId ?? (await activeProjectId()));

    case 'project:leave':
      await leaveProject(request.projectId);
      return await readAuthState();

    case 'project:headcount':
      return await headcount(request.projectId);

    // --- invites ---------------------------------------------------------------------------
    case 'invite:list':
      return await listInvites(request.projectId);

    case 'invite:create':
      return await createInvite(request.email, request.projectId);

    case 'invite:revoke':
      await revokeInvite(request.inviteId);
      return null;

    case 'invite:resend':
      return await resendInvite(request.inviteId);

    // --- listings --------------------------------------------------------------------------
    case 'listing:seen':
      await recordProperty(request.listing);
      // The property row has to exist before the analyser can read its image URLs, so this is
      // deliberately after the upsert. Fire-and-forget: the panel polls for the result.
      void requestAnalysis(request.listing.rightmoveId);
      return null;

    case 'analysis:get':
      await requireSession();
      return await getAnalysis(request.rightmoveId);

    case 'analysis:request':
      return await requestAnalysis(request.rightmoveId);

    case 'verdict:set':
      await setVerdict(request.rightmoveId, request.rating, request.note);
      return null;

    case 'verdicts:get':
      return await getVerdicts(request.rightmoveIds);

    case 'places:list':
      return await listPlaces();

    case 'places:add':
      return await addPlace(request.label, request.postcode);

    case 'places:remove':
      await removePlace(request.id);
      return null;

    case 'travel:get':
      return await travelTimes(request.postcode, request.refresh ?? false);

    case 'travel:cached':
      return await cachedTravelTimes(request.postcodes);

    case 'stations:walk':
      return await stationWalks(request.postcode, request.stations);

    case 'postcode:point':
      return await locatePostcode(request.postcode);

    case 'shortlist:get':
      return await getShortlist();

    case 'properties:locate':
      return await locateProperties();

    // --- hubs ------------------------------------------------------------------------------
    case 'hubs:list':
      return await listHubs();

    case 'hubs:add':
      return await addHub(request.hub);

    case 'hubs:update':
      return await updateHub(request.id, request.patch);

    case 'hubs:remove':
      await removeHub(request.id);
      return null;

    case 'hubs:resolve-location':
      return await resolveLocation(request.name);

    // --- spend and admin ---------------------------------------------------------------------
    case 'spend:summary':
      return await spendSummary();

    case 'admin:users':
      await requireSession();
      return await adminUsers();

    case 'admin:projects':
      await requireSession();
      return await adminProjects();

    case 'admin:invites':
      await requireSession();
      return await listInvites();

    case 'admin:usage':
      await requireSession();
      return await adminUsage(request);

    case 'admin:set-user-cap':
      await adminSetUserCap(request.userId, request.capUsd);
      return null;

    case 'admin:set-project-cap':
      await adminSetProjectCap(request.projectId, request.capUsd);
      return null;

    case 'admin:set-max-members':
      await adminSetMaxMembers(request.projectId, request.maxMembers);
      return null;

    case 'admin:set-password':
      await adminSetPassword(request.userId, request.password);
      return null;

    // --- sweeping ----------------------------------------------------------------------------
    case 'sweep:record': {
      // The write goes first and is awaited. The panel turns "safe to page on" green off the back
      // of this reply, so replying before the rows have landed would be a tick that means nothing.
      await recordSightings(request.hub, request.cards);
      // Recording the page and marking progress on it are one act, so they are one round trip.
      // Split apart, a panel that recorded the last page and then failed to say so would leave a
      // hub permanently one page short of swept, with nothing on screen looking wrong.
      const sweep = await recordSweepPage(request.hub, request.progress, request.hubId);
      const knowledge = await getSweepKnowledge(request.cards.map((c) => c.rightmoveId));
      return { knowledge: Object.fromEntries(knowledge), sweep };
    }

    case 'sweep:hubs':
      return await listHubSweeps();

    case 'sweep:pending':
      return await pendingSightings();

    case 'tab:open':
      // Rightmove only. The URL comes from a content script, and a content script is running in a
      // page whose scripts we do not control; a worker that opened whatever it was handed would
      // be a redirector for anything that got a message into it.
      if (!/^https:\/\/www\.rightmove\.co\.uk\/properties\/\d+/.test(request.url)) {
        throw new Error(`refusing to open ${request.url} — only Rightmove listings`);
      }
      await chrome.tabs.create({ url: request.url, active: false });
      return null;
  }
}

/** The only handler that answers rather than refusing when there is no session: every surface asks
 *  this first to decide what to render, and answering it with `unauthenticated` would make the
 *  sign-in view unreachable. */
async function readAuthState(): Promise<AuthState> {
  const session = await ensureSession();
  if (!session) return { status: 'signed-out' };
  return await authState();
}

/** What the cache already knows for a set of postcodes — no TfL calls, ever.
 *
 *  The compare table shows one row per property and a column per place, so it needs a number for
 *  every pairing at once. Read-through would be the obvious thing and the wrong one: opening the
 *  table would fire a journey-planner request for every gap, which is both slow and the sort of
 *  traffic that gets you rate-limited. A gap comes back absent and the table prints "—". Open the
 *  place itself, or its card, and the read-through path fills it in.
 *
 *  The cache is keyed on the destination's postcode now rather than on a place id (design D5), so
 *  the places are loaded to map back. Two places at one postcode share a row and both read it,
 *  which is the point of re-keying. */
async function cachedTravelTimes(postcodes: string[]): Promise<Record<string, TravelTime[]>> {
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

/** Lookups already running, by postcode, so two askers share one set of API calls.
 *
 *  The panel and the shortlist both ask on load, and the sweep's paced opener puts several tabs
 *  on the same flat's postcode within seconds of each other. Each asker read the same empty cache
 *  and fired its own identical journey-planner requests — which is how you earn a 429, and how
 *  two writes race for the same cache row. The second asker now awaits the first one's answer.
 *
 *  Keyed on postcode alone rather than postcode-and-refresh: a refresh in flight is doing strictly
 *  more work than a plain read, so joining it is right. The entry is removed in a `finally` so a
 *  failure cannot leave a rejected promise cached and break every later request for that postcode. */
const travelInFlight = new Map<string, Promise<TravelTime[]>>();

function travelTimes(postcode: string, refresh: boolean): Promise<TravelTime[]> {
  const running = refresh ? undefined : travelInFlight.get(postcode);
  if (running) return running;

  const work = computeTravelTimes(postcode, refresh).finally(() => {
    if (travelInFlight.get(postcode) === work) travelInFlight.delete(postcode);
  });
  travelInFlight.set(postcode, work);
  return work;
}

/** Read-through cache, every place in every mode. Travel time from a postcode to a fixed place
 *  doesn't change, and the cache is shared across every project, so each journey costs its API
 *  calls once for everybody. */
async function computeTravelTimes(postcode: string, refresh: boolean): Promise<TravelTime[]> {
  const started = Date.now();

  // The places list and the cached times are independent reads; doing them in sequence was
  // half the time the panel spent on "Working…" even when every number was already cached.
  const [rawPlaces, cachedRows] = await Promise.all([listPlaces(), getCachedTravel(postcode)]);
  if (rawPlaces.length === 0) return [];

  // Backfill coordinates for places added before we resolved them at entry.
  const places = await Promise.all(rawPlaces.map(backfillPlaceCoords));
  const cached = new Map(cachedRows.map((c) => [`${c.destPostcode}:${c.mode}`, c] as const));
  const appKey = import.meta.env.WXT_TFL_APP_KEY;

  const wanted = places.flatMap((place) => TRAVEL_MODES.map((mode) => ({ place, mode })));
  let hits = 0;

  const results = await Promise.all(
    wanted.map(async ({ place, mode }): Promise<TravelTime> => {
      const row = refresh ? undefined : cached.get(`${place.postcode}:${mode}`);
      // Not every cached row is an answer to the question we are now asking. `staleTravel` holds
      // the rules — a number measured on a different basis, a no-route old enough to be worth
      // re-asking, a transit row from before we stored the leg breakdown — and each one fills
      // itself in on the next visit rather than needing a migration.
      const stale = row === undefined ? null : staleTravel(row, mode);
      const hit = stale === null ? row : undefined;
      if (stale !== null) logInfo('travel', `refetching ${place.label} by ${mode}: ${stale}`, { postcode });
      if (hit) {
        hits++;
        if (hit.noRoute) {
          return {
            placeId: place.id,
            mode,
            seconds: 0,
            changes: null,
            error: 'TfL found no journey for this mode',
            transient: false,
          };
        }
        return {
          placeId: place.id,
          mode,
          seconds: hit.seconds ?? 0,
          changes: hit.changes,
          options: hit.options ?? undefined,
        };
      }

      // Coordinates, not the postcode string — TfL's own geocoder resolved a terminated
      // Heathrow postcode to a point in northwest London.
      const destination =
        place.lat !== null && place.lon !== null ? `${place.lat},${place.lon}` : place.postcode;

      let journey;
      try {
        journey = await journeyTime(postcode, destination, mode, appKey);
      } catch (e) {
        // Only a TflError carries a considered verdict on whether TfL settled the question.
        // Anything else — a parse failure, a bug in our own code — is treated as transient,
        // because caching a negative is permanent and being wrong about it is expensive.
        const settled = e instanceof TflError && !e.transient;
        if (settled) await cacheTravel(postcode, place.postcode, mode, null, null, true).catch(() => {});
        logWarn('travel', `${place.label} by ${mode} failed`, {
          postcode,
          transient: !settled,
          error: describe(e),
        });
        return { placeId: place.id, mode, seconds: 0, changes: null, error: describe(e), transient: !settled };
      }

      // Caching is a side effect, and a failed write must not turn a good answer into a
      // permanent "no route" — which is what happened when this sat inside the catch above.
      await cacheTravel(postcode, place.postcode, mode, journey.seconds, journey.changes, false, journey.options).catch(
        (e) => logWarn('travel', 'could not cache a good answer', { postcode, error: describe(e) }),
      );
      return {
        placeId: place.id,
        mode,
        seconds: journey.seconds,
        changes: journey.changes,
        options: journey.options,
      };
    }),
  );

  logInfo('travel', `${postcode}: ${results.length} legs in ${Date.now() - started}ms`, {
    cacheHits: hits,
    lookups: results.length - hits,
    failed: results.filter((r) => r.error).length,
    refresh,
  });
  return results;
}

/** Where a postcode is, for the panel's hub compass.
 *
 *  The panel cannot do this itself: a content script's fetch carries the page's origin, and the
 *  host permissions that make postcodes.io reachable belong to the worker. It is not cached in
 *  Supabase like the travel times are, because a postcode lookup is free, keyless and instant,
 *  and a round trip to the database to avoid one would cost more than it saves. The in-memory map
 *  is only there to spare the second and third listing in the same street a repeat call; it dies
 *  with the worker, which is fine.
 *
 *  Rightmove's own latitude and longitude are deliberately not the fallback. They are fuzzed
 *  (`pinType: "APPROXIMATE_POINT"`), and a fuzzed origin a few hundred yards out swings a bearing
 *  taken from a hub half a mile away by tens of degrees — a compass needle that is confidently
 *  pointing at the wrong half of the neighbourhood. Null, and the panel says it has no location. */
const postcodePoints = new Map<string, Point | null>();

async function locatePostcode(postcode: string): Promise<Point | null> {
  const known = postcodePoints.get(postcode);
  if (known !== undefined) return known;

  const { point } = await lookupPostcode(postcode);
  postcodePoints.set(postcode, point);
  return point;
}

/** Walking time from the listing to each nearby station. Rightmove gives straight-line miles,
 *  which flatters stations across a river or a railway. Both lookups are cached, so a station in
 *  a neighbourhood anyone has searched before costs nothing. */
async function stationWalks(
  postcode: string,
  stations: string[],
): Promise<Record<string, { seconds?: number; lines: string[] }>> {
  await requireSession();
  const appKey = import.meta.env.WXT_TFL_APP_KEY;
  const cachedWalks = await getStationWalks(postcode);
  const out: Record<string, { seconds?: number; lines: string[] }> = {};

  await Promise.all(
    stations.map(async (name) => {
      try {
        // Coordinates and lines are resolved once per station, ever, and shared between every
        // install — so only a station nobody has seen costs anything.
        let station = await getStationPoint(name);
        if (station === undefined) {
          station = await resolveStation(name, appKey);
          await cacheStationPoint(name, station);
        }
        if (!station) return; // TfL doesn't know it — omit rather than invent a number

        const cached = cachedWalks.get(name);
        if (cached !== undefined) {
          out[name] = { seconds: cached, lines: station.lines };
          return;
        }

        const seconds = await walkTo(postcode, station, appKey);
        await cacheStationWalk(postcode, name, seconds);
        out[name] = { seconds, lines: station.lines };
      } catch {
        // A missing walk time degrades one row; the straight-line distance is still shown.
      }
    }),
  );
  return out;
}

/** Ask the Edge Function to analyse this listing's photos.
 *
 *  The bearer is the user's access token, not the publishable key: the function verifies its
 *  caller, checks the project's membership and its `project_property` link, and charges the call
 *  against both caps (design D10). The key identifies the project and authorises nothing.
 *
 *  A refusal is a state rather than a failure. "capped" in particular has to reach the panel
 *  intact — "the monthly analysis budget is used up" is a sentence a person can act on, and a
 *  generic error in its place gets the page reloaded until the month turns over. */
async function requestAnalysis(rightmoveId: string): Promise<AnalysisRequest> {
  const token = await accessToken();
  if (!token) throw new Unauthenticated();

  try {
    const response = await fetch(ANALYSIS_FUNCTION, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: import.meta.env.WXT_SUPABASE_PUBLISHABLE_KEY,
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ rightmoveId }),
    });

    const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    const status = typeof body?.status === 'string' ? body.status : null;

    if (status === 'capped') {
      return {
        status: 'capped',
        scope: body?.scope === 'user' ? 'user' : 'project',
        spentUsd: Number(body?.spent ?? body?.spent_usd ?? 0),
        capUsd: Number(body?.cap ?? body?.cap_usd ?? 0),
        resetsAt: String(body?.resets_at ?? body?.resetsAt ?? ''),
      };
    }
    // `cached` is somebody else's analysis served for free, `analysed` is this call's — either way
    // there is a result to read now. `in-progress` is a claim somebody else holds; the panel polls.
    if (status === 'cached' || status === 'analysed') return { status: 'cached' };
    if (status === 'in-progress') return { status: 'queued' };

    if (!response.ok) {
      // Worth recording rather than swallowing: this is the difference between "the analysis is
      // still running" and "it will never arrive", and the panel used to report both as neither.
      const message = typeof body?.error === 'string' ? body.error : `HTTP ${response.status}`;
      logWarn('analysis', `the analyse function refused ${rightmoveId}`, { status: response.status, message });
      return { status: 'failed', message };
    }
    return { status: 'queued' };
  } catch (e) {
    logWarn('analysis', 'could not reach the analyse function', { rightmoveId, error: describe(e) });
    return { status: 'failed', message: describe(e) };
  }
}
