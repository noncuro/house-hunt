import { configureCore, ensureSession, startSessionHeartbeat } from '@/lib/auth';
// What signing in means, and everything that reads the database with the result, is shared with the
// website. What keeping a session alive in a service worker means is not, and stays above.
import { accessToken, requireSession, signIn, signOut, Unauthenticated } from '@house-hunt/core/db';
// Journeys, station walks and postcode lookups are resolved by the `travel` Edge Function now, not
// here. The worker used to call TfL directly through host permissions a browser tab does not have —
// and, more to the point, that made every client a writer of caches every project reads.
import { locatePostcode, stationWalks, travelTimes } from '@house-hunt/core/db';
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
  consumeInvites,
  createInvite,
  forgetActiveProject,
  getAnalysis,
  getCachedTravelFor,
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
} from '@house-hunt/core/db';
import { logWarn } from '@house-hunt/core';
import { } from '@house-hunt/core';
import { staleTravel } from '@house-hunt/core';
import { type Place, type TravelTime } from '@house-hunt/core';

/** The analysis runs on Supabase, not on anyone's laptop.
 *
 *  It used to be a local Node process holding the OpenAI key, which meant a listing was only ever
 *  analysed while one laptop was awake with a terminal open — the other person's laptop could read
 *  every result and produce none. It is now an Edge Function on the same project as the database.
 *  See supabase/functions/analyse/. */
const ANALYSIS_FUNCTION = `${import.meta.env.WXT_SUPABASE_URL}/functions/v1/analyse`;

const SHORTLIST_PAGE = 'shortlist.html';

export default defineBackground(() => {
  // Hand core the client, the refresh policy and somewhere to log, before anything reads the
  // database. Core throws rather than constructing a default if this is missed, because a default
  // would persist the session somewhere it will not be found again — which looks exactly like
  // being signed out (design D2, D8).
  configureCore();

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
