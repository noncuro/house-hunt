import { configureCore, startSessionHeartbeat } from '@/lib/auth';
import { webAppOrigin, webAppUrl } from '@/lib/web-app';
// What signing in means, and everything that reads the database with the result, is shared with the
// website. What keeping a session alive in a service worker means is not, and stays above.
import { accessToken, requireSession, signIn, signOut, Unauthenticated } from '@house-hunt/core/db';
// Journeys, station walks and postcode lookups are resolved by the `travel` Edge Function now, not
// here. The worker used to call TfL directly through host permissions a browser tab does not have —
// and, more to the point, that made every client a writer of caches every project reads.
import { locatePostcode, requestStationWalks, travelTimes } from '@house-hunt/core/db';
import {
  describe,
  type AnalysisRequest,
  type Envelope,
  type Request,
  type ResponseMap,
} from '@/lib/messages';
import {
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
  cachedTravelTimes,
  createInvite,
  forgetActiveProject,
  forgetSightings,
  getAnalysis,
  getProjectModel,
  getProjectSettings,
  getSweepKnowledge,
  headcount,
  leaveProject,
  listHubSweeps,
  listInvites,
  listMembers,
  listOffMarket,
  NoActiveProject,
  pendingSightings,
  readAuthState,
  getStages,
  getVerdicts,
  listPlaces,
  recordSweepPage,
  recordProperty,
  redeemInvite,
  recordSightings,
  removePlace,
  updatePlace,
  renameProject,
  resendInvite,
  resolveLocation,
  revokeInvite,
  setActiveProject,
  setDisplayName,
  setOffMarket,
  setStage,
  setVerdict,
  spendSummary,
} from '@house-hunt/core/db';
import { logWarn } from '@house-hunt/core';

/** The analysis runs on the website's server, not on anyone's laptop.
 *
 *  It used to be a local Node process holding the OpenAI key, which meant a listing was only ever
 *  analysed while one laptop was awake with a terminal open — the other person's laptop could read
 *  every result and produce none. Then a Supabase Edge Function, and now a route on the site.
 *  See `apps/web/src/app/api/analyse/route.ts`.
 *
 *  Built here rather than through `callRoute` because this call reads a shape of its own: five
 *  statuses that each become a different `AnalysisRequest`, including two that arrive on a non-2xx.
 *  `callRoute` throws on those, which would collapse "capped" into a failure. */
const ANALYSIS_ROUTE = `${webAppOrigin()}/api/analyse`;

/** A sweep fill-in tab is disposable: it exists so a listing loads far enough for the content
 *  script to record it and cache its travel times, not to be read. Left open, a run of a few
 *  hundred listings buries the browser under a few hundred Rightmove tabs — so each one is closed
 *  a short while after it opens.
 *
 *  Half a minute is Chrome's alarm floor and comfortably past a listing settling: the opener paces
 *  new tabs at ~12s for exactly that reason (see `OPEN_INTERVAL_MS` in packages/ui), so by the time
 *  this fires the page has loaded, extracted and cached, and the analysis it kicked off runs on the
 *  server regardless of whether the tab is still here.
 *
 *  An alarm rather than `setTimeout` for the same reason the session heartbeat is one: Chrome can
 *  evict this worker between opening the tab and closing it, and a timer dies with the worker while
 *  an alarm wakes it. A dropped timer would leak exactly the tab this is meant to reap. */
const SWEEP_TAB_TTL_MINUTES = 0.5;
/** A search page opened by the unattended sweep gets longer. The run finds out that the page was
 *  recorded by reading `hub_sweep` back, and waits up to a minute for it (`RECORD_TIMEOUT_MS` on
 *  the website); a tab reaped at thirty seconds mid-load would turn a slow page into a run that
 *  stops and reports a page that "never recorded". Ninety seconds outlives that wait. */
const SEARCH_TAB_TTL_MINUTES = 1.5;
const CLOSE_SWEEP_TAB_ALARM = 'close-sweep-tab:';
/** What `tab:open` agrees to open — a listing, or a rental search page, and nothing else.
 *  Anchored on the host and the path, with the id delimited, so neither a URL that merely
 *  *mentions* a listing in its query nor `/properties/123anything` passes. */
const LISTING_URL = /^https:\/\/www\.rightmove\.co\.uk\/properties\/\d+(?:[/?#]|$)/;
const SEARCH_URL = /^https:\/\/www\.rightmove\.co\.uk\/property-to-rent\/find\.html\?/;


export default defineBackground(() => {
  // Hand core the client, the refresh policy and somewhere to log, before anything reads the
  // database. Core throws rather than constructing a default if this is missed, because a default
  // would persist the session somewhere it will not be found again — which looks exactly like
  // being signed out (design D2, D8).
  configureCore();

  // The session refreshes itself even when nobody is using the extension, so an install left alone
  // for a week does not come back asking to sign in (design D2).
  startSessionHeartbeat();

  // Clicking the toolbar icon opens the website, reusing the tab if it is already open rather than
  // stacking up copies of the same page. It used to open `shortlist.html` inside the extension —
  // an address nobody could be sent, which is most of why the app moved out (design D5).
  chrome.action.onClicked.addListener(() => {
    void (async () => {
      const url = webAppUrl();
      // Matched on the origin rather than the exact URL, because the app puts the flat you were
      // looking at in the hash and every screen is a tab within one page. Without the wildcard a
      // second click on a tab already sitting on `#card-88023648` would open a third copy.
      const [existing] = await chrome.tabs.query({ url: `${url}/*` });
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

  // Reap the sweep tabs opened above once their listing has had time to settle. Registered here so
  // it is back in place when an alarm wakes a torn-down worker. Other alarms (the session
  // heartbeat) share this event and are left alone — hence the name check.
  // If the user clicks into a sweep tab while its reap is pending, it is one they are reading — cancel
  // the reap so it is never closed out from under them, and stays cancelled even after they move on to
  // another tab. Clearing an alarm that does not exist is a no-op, so this is safe for every other tab
  // activation too, and the alarm's own persistence means an evicted worker still honours it.
  chrome.tabs.onActivated.addListener((info) => {
    void chrome.alarms.clear(`${CLOSE_SWEEP_TAB_ALARM}${info.tabId}`);
  });

  chrome.alarms.onAlarm.addListener((alarm) => {
    if (!alarm.name.startsWith(CLOSE_SWEEP_TAB_ALARM)) return;
    const tabId = Number(alarm.name.slice(CLOSE_SWEEP_TAB_ALARM.length));
    if (!Number.isInteger(tabId)) return;
    void (async () => {
      try {
        // Opened in the background and meant to stay there. If the user has since clicked into it to
        // actually read the listing, leave it — closing a tab someone is reading is the opposite of
        // the "does not steal focus" the background open promised.
        const tab = await chrome.tabs.get(tabId);
        if (tab.active) return;
        await chrome.tabs.remove(tabId);
      } catch {
        // Already gone — the user closed it, or it never opened. Nothing to reap.
      }
    })();
  });
});

/** Being signed out and having no project are states with their own rendering everywhere, not
 *  failures — so they travel as flags rather than as error strings a view has to match on. A
 *  panel that shows a stack trace where it should say "sign in" is the fail-loudly rule inverted:
 *  loud about the wrong thing. */
function refusal(e: unknown): Envelope<never> {
  if (e instanceof Unauthenticated) {
    return { ok: false, unauthenticated: true, error: 'sign in to the house hunt' };
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
      // Invites are consumed inside `authState()` now, on every read rather than only at this
      // moment — a comment on this spot once claimed consumption happened when nothing did it, and
      // then the sign-in-only version left anybody already signed in waiting forever. The read
      // below is therefore also the consume.
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

    case 'listing:withdrawn': {
      await forgetSightings(request.rightmoveId);
      // And say so about the flat itself, not only about the sighting. Forgetting the sighting takes
      // it off the fill-in worklist, which is the right answer for something nobody has opened — but
      // a listing already on the shortlist keeps its row, its verdict and its place in the funnel,
      // and nothing anywhere would have recorded that it is gone. That matters twice: the shortlist
      // goes on showing it as a live option, and the model goes on training on a "love" for a flat
      // that is no longer available, which is the definition of a label that cannot be acted on.
      //
      // Off the market, not archived. Archiving carries a reason — lost it, walked away — and that
      // is somebody's account of what happened, not a background tab's to write. This records the
      // fact and leaves the story to them — which means not writing over one they have already
      // written. A listing somebody excluded as "lost it" keeps that sentence; this only records
      // the fact for one nobody had excluded yet.
      const excluded = await listOffMarket();
      if (!excluded.includes(request.rightmoveId)) {
        await setOffMarket(request.rightmoveId, true, 'Withdrawn from Rightmove');
      }
      return null;
    }

    case 'analysis:get':
      await requireSession();
      return await getAnalysis(request.rightmoveId);

    case 'analysis:request':
      return await requestAnalysis(request.rightmoveId);

    case 'model:get':
      await requireSession();
      return await getProjectModel();

    case 'verdict:set':
      await setVerdict(request.rightmoveId, request.rating, request.note);
      return null;

    case 'verdicts:get':
      return await getVerdicts(request.rightmoveIds);

    case 'stage:get':
      return (await getStages([request.rightmoveId]))[0] ?? null;

    case 'stage:set':
      await setStage(request.rightmoveId, request.stage, request.archiveReason, request.note);
      return null;

    case 'off-market:get': {
      // A plain membership check against the project's off-market set — cheaper to reason about than
      // a bespoke single-id query, and the set is small.
      const off = await listOffMarket();
      return off.includes(request.rightmoveId);
    }

    case 'off-market:set':
      await setOffMarket(request.rightmoveId, request.off, request.reason ?? '');
      return null;

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
      return await requestStationWalks(request.postcode, request.stations);

    case 'postcode:point':
      return await locatePostcode(request.postcode);

    case 'places:update':
      return await updatePlace(request.id, request.patch);

    case 'places:resolve-location':
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
      // Only a real neighbourhood has progress to record. A one-off search still writes its
      // sightings above — that is the half that finds flats — but `hub_sweep` is keyed on a
      // `project_hub` row, and inventing one for a search nobody has adopted would put a
      // neighbourhood in the list that nobody chose.
      const sweep = request.progress
        ? await recordSweepPage(request.hub, request.progress, request.hubId)
        : null;
      const knowledge = await getSweepKnowledge(request.cards.map((c) => c.rightmoveId));
      return { knowledge: Object.fromEntries(knowledge), sweep };
    }

    case 'sweep:hubs':
      return await listHubSweeps();

    case 'settings:get':
      await requireSession();
      return await getProjectSettings();

    case 'sweep:pending':
      return await pendingSightings();

    case 'tab:open': {
      // Rightmove only. The URL comes from a content script, and a content script is running in a
      // page whose scripts we do not control; a worker that opened whatever it was handed would
      // be a redirector for anything that got a message into it.
      //
      // Two shapes and no more: a listing, and a rental search (`find.html`, the one page the sweep
      // panel runs on). The second is what lets the website's unattended sweep page through a
      // neighbourhood's results the way a person would — each page is a real navigation in a real
      // background tab, recorded by the same panel that records a page you opened yourself. Nothing
      // here fetches a search; see the standing rule in AGENTS.md.
      const isSearch = SEARCH_URL.test(request.url);
      if (!isSearch && !LISTING_URL.test(request.url)) {
        throw new Error(`refusing to open ${request.url} — only Rightmove listings and rental searches`);
      }
      const tab = await chrome.tabs.create({ url: request.url, active: false });
      // Schedule its own closing. Keyed by tab id so each tab reaps exactly itself, and only when the
      // tab actually opened (a create with no id is nothing to close). A failure to schedule must not
      // fail the open — the tab has already loaded and is doing its job; the worst case is one tab
      // that outlives its window, which is far better than killing a working tab or stopping the run.
      if (tab.id !== undefined) {
        await chrome.alarms
          .create(`${CLOSE_SWEEP_TAB_ALARM}${tab.id}`, {
            delayInMinutes: isSearch ? SEARCH_TAB_TTL_MINUTES : SWEEP_TAB_TTL_MINUTES,
          })
          .catch((e) => logWarn('sweep', 'could not schedule the tab to close', { error: describe(e) }));
      }
      return null;
    }
  }
}

/** Ask the website to analyse this listing's photos.
 *
 *  The bearer is the user's access token. The route verifies its caller, checks the project's
 *  membership and its `project_property` link, and charges the call against both caps (design D10).
 *  The publishable key that used to ride along is gone with the Edge Function: PostgREST wanted an
 *  `apikey` header and a route does not read one.
 *
 *  A refusal is a state rather than a failure. "capped" in particular has to reach the panel
 *  intact — "the monthly analysis budget is used up" is a sentence a person can act on, and a
 *  generic error in its place gets the page reloaded until the month turns over. */
async function requestAnalysis(rightmoveId: string): Promise<AnalysisRequest> {
  const token = await accessToken();
  if (!token) throw new Unauthenticated();

  try {
    const response = await fetch(ANALYSIS_ROUTE, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
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
    // A refusal the function answers 200 to: the listing's last analysis failed, and it is either
    // waiting out its backoff or has spent its attempts. Without this it fell through to `queued`
    // below and the panel waited for a result that was never coming.
    if (status === 'failed') {
      const message = typeof body?.error === 'string' ? body.error : 'the analysis failed';
      logWarn('analysis', `${rightmoveId} has a failed analysis`, { message });
      return { status: 'failed', message };
    }

    if (!response.ok) {
      // Worth recording rather than swallowing: this is the difference between "the analysis is
      // still running" and "it will never arrive", and the panel used to report both as neither.
      const message = typeof body?.error === 'string' ? body.error : `HTTP ${response.status}`;
      logWarn('analysis', `the analyse route refused ${rightmoveId}`, { status: response.status, message });
      return { status: 'failed', message };
    }
    return { status: 'queued' };
  } catch (e) {
    logWarn('analysis', 'could not reach the analyse route', { rightmoveId, error: describe(e) });
    return { status: 'failed', message: describe(e) };
  }
}
