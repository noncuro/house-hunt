/** The messages a Rightmove content script sends the background worker, and the envelope they
 *  travel in.
 *
 *  Only the extension has this. The website holds no message layer at all — it calls the data
 *  layer in `@house-hunt/core/db` directly, which is most of what moving the app out of the
 *  extension bought. What is left here is what a script running inside somebody else's page
 *  needs, and it stays typed end to end because that is the part of this design that works. */
import type {
  HuntPreferences, Point, SearchCard, SweepCriteria } from '@house-hunt/core';
import type { HubSweep, PendingSighting, StoredModel, SweepKnowledge } from '@house-hunt/core/db';
import type {
  AnalysisRequest,
  AuthState,
  Headcount,
  Invite,
  InviteResult,
  LocationResult,
  PlacePatch,
  ProjectMember,
  ProjectSummary,
  RedeemResult,
  SignInResult,
  SpendSummary,
  AdminProject,
  AdminUser,
  UsageRow,
} from '@house-hunt/core';
import type {
  Analysis,
  ArchiveReason,
  Listing,
  Place,
  PropertyStage,
  Rating,
  Stage,
  TravelTime,
  Verdict,
} from '@house-hunt/core';

/** The shared vocabulary, re-exported.
 *
 *  These shapes moved to `@house-hunt/core` when the website was split out — a `ProjectSummary` is
 *  an answer rather than a message, and both surfaces need it. They are re-exported here because
 *  for a content script this module *is* the contract: one import covering both the shapes and the
 *  messages that carry them is what it had before, and there is no reason to make it two. */
export type {
  AdminProject,
  AdminUser,
  AnalysisRequest,
  AuthState,
  Headcount,
  Invite,
  InviteResult,
  LocationResult,
  ProjectMember,
  ProjectSummary,
  RedeemResult,
  SessionUser,
  SignInResult,
  SpendScope,
  SpendSummary,
  UsageRow,
} from '@house-hunt/core';
export { MIN_PASSWORD_LENGTH } from '@house-hunt/core';

// The messages themselves.
// ------------------------------------------------------------------------------------------------

/** The one place the content script and the background worker agree on. */
export type Request =
  // --- session -----------------------------------------------------------------------------
  | { type: 'auth:state' }
  | { type: 'auth:sign-in'; email: string; password: string }
  /** The one message a signed-out stranger can send that has any effect, so it is the one that has
   *  to be gated by something. That something is the code — checked in an Edge Function, against
   *  the address it was issued to, with the guess counted. */
  | { type: 'auth:redeem'; email: string; password: string; code: string }
  | { type: 'auth:sign-out' }
  | { type: 'profile:set-name'; displayName: string }
  // --- projects ----------------------------------------------------------------------------
  | { type: 'project:list' }
  | { type: 'project:set-active'; projectId: string }
  | { type: 'project:rename'; projectId: string; name: string }
  | { type: 'project:members'; projectId?: string }
  | { type: 'project:leave'; projectId: string }
  | { type: 'project:headcount'; projectId: string }
  // --- invites -----------------------------------------------------------------------------
  | { type: 'invite:list'; projectId?: string }
  | { type: 'invite:create'; email: string; projectId: string | null }
  | { type: 'invite:revoke'; inviteId: string }
  | { type: 'invite:resend'; inviteId: string }
  // --- listings and opinions ----------------------------------------------------------------
  | { type: 'listing:seen'; listing: Listing }
  /** This listing's page is gone, so drop the sightings that would keep sending a fill-in run back
   *  to it. Sent by the panel, which is the only thing that ever sees a withdrawn page. */
  | { type: 'listing:withdrawn'; rightmoveId: string }
  | { type: 'verdict:set'; rightmoveId: string; rating: Rating; note: string }
  | { type: 'verdicts:get'; rightmoveIds: string[] }
  /** Where a place has got to — reached out, viewing booked, archived with a reason. A different
   *  fact from the verdict and stored apart from it: an offer that falls through must not overwrite
   *  the rating the score is fitted on (`packages/core/src/stage.ts`). */
  | { type: 'stage:get'; rightmoveId: string }
  | {
      type: 'stage:set';
      rightmoveId: string;
      stage: Stage;
      archiveReason: ArchiveReason | null;
      note: string;
    }
  /** Off the market: withheld from the verdict-score model's training, the verdict itself untouched
   *  (design in the verdict-score migration). The panel needs both to read the current state and to
   *  set it — the website could do this already, the panel could not. */
  | { type: 'off-market:get'; rightmoveId: string }
  | { type: 'off-market:set'; rightmoveId: string; off: boolean; reason?: string }
  | { type: 'places:list' }
  | { type: 'places:add'; label: string; postcode: string }
  | { type: 'places:update'; id: string; patch: PlacePatch }
  | { type: 'places:remove'; id: string }
  | { type: 'travel:get'; postcode: string; refresh?: boolean }
  | { type: 'travel:cached'; postcodes: string[] }
  | { type: 'stations:walk'; postcode: string; stations: string[] }
  | { type: 'postcode:point'; postcode: string }
  | { type: 'analysis:get'; rightmoveId: string }
  | { type: 'analysis:request'; rightmoveId: string }
  /** The project's verdict-score model, for scoring the open listing on the panel. Read once per
   *  panel; scoring itself is pure arithmetic, done in the content script against these weights. */
  | { type: 'model:get' }
  // --- hubs --------------------------------------------------------------------------------
  | { type: 'places:resolve-location'; name: string }
  // --- spend -------------------------------------------------------------------------------
  | { type: 'spend:summary' }
  // --- admin -------------------------------------------------------------------------------
  | { type: 'admin:users' }
  | { type: 'admin:projects' }
  | { type: 'admin:invites' }
  | { type: 'admin:usage'; projectId?: string; userId?: string; since?: string }
  | { type: 'admin:set-user-cap'; userId: string; capUsd: number }
  | { type: 'admin:set-project-cap'; projectId: string; capUsd: number }
  | { type: 'admin:set-max-members'; projectId: string; maxMembers: number }
  /** Set somebody's password for them. There is no self-service reset, because a reset is an email
   *  and email is the dependency this design removed — so a forgotten password is a conversation
   *  with whoever runs the install, exactly like a lost invite code. */
  | { type: 'admin:set-password'; userId: string; password: string }
  // --- sweeping ------------------------------------------------------------------------------
  /** Record a search page's cards against a hub, and say what we already knew about each. One
   *  message rather than a write and then a read, because the panel needs both and the write
   *  has to have landed before the "safe to page on" tick can be honest. */
  | {
      type: 'sweep:record';
      /** What to file these sightings under. Normally a neighbourhood's name, resolved to a
       *  `project_hub` row in the active project (`hubId` short-circuits that when the caller
       *  already has it) — but for a search nobody has adopted it is simply the location Rightmove
       *  named, and no row is looked up at all. See `progress`. */
      hub: string;
      hubId?: string;
      cards: SearchCard[];
      /** Where in the sweep this page is. Carried with the cards rather than sent separately: a
       *  panel that recorded the last page and then failed to say so would leave the hub forever
       *  one page short of swept, with nothing on screen looking wrong.
       *
       *  Null for a search that is not one of this project's neighbourhoods. Those are recorded —
       *  the cards are the same cards, and the sightings are worth having — but there is nothing to
       *  be part-way through: sweep progress is pages-seen against a hub, and a search somebody ran
       *  once has no hub and no next time to compare against. */
      progress: null | {
        page: number;
        totalPages: number;
        resultCount: number;
        windowDays: number;
        locationIdentifier: string;
        /** The filters this page was served with, read off the tab's own URL. A sweep's progress
         *  is progress on one search — see `criteriaFingerprint`. */
        criteria: SweepCriteria;
      };
    }
  | { type: 'sweep:hubs' }
  /** This hunt's preferences, which the sweep panel needs for the Rightmove filters to search
   *  with. There is no default for those (see `RENTAL_SEARCH`), so a panel that could not ask
   *  would have to invent a price band or refuse to link. */
  | { type: 'settings:get' }
  | { type: 'sweep:pending' }
  /** Open a listing in a background tab. A content script can only `window.open`, which steals
   *  focus — unbearable when the paced opener does it a dozen times over several minutes. */
  | { type: 'tab:open'; url: string };

export interface ResponseMap {
  'auth:state': AuthState;
  'auth:sign-in': SignInResult;
  'auth:redeem': RedeemResult;
  'auth:sign-out': null;
  'profile:set-name': null;

  'project:list': ProjectSummary[];
  'project:set-active': AuthState;
  'project:rename': null;
  'project:members': ProjectMember[];
  'project:leave': AuthState;
  'project:headcount': Headcount;

  'invite:list': Invite[];
  'invite:create': InviteResult;
  'invite:revoke': null;
  'invite:resend': InviteResult;

  'listing:seen': null;
  'listing:withdrawn': null;
  'verdict:set': null;
  /** At most one verdict per property now: the project shares one rating (design D6). `person` is
   *  the display name of whoever set it — the author, not the owner of a private opinion — and it
   *  is shown alongside `updatedAt` so last-write-wins stays visible rather than silent. */
  'verdicts:get': Verdict[];
  /** Where this listing has got to for the active project, or null for one nobody has liked yet. */
  'stage:get': PropertyStage | null;
  'stage:set': null;
  /** Whether this listing is off the market for the active project. */
  'off-market:get': boolean;
  'off-market:set': null;
  'places:list': Place[];
  'places:add': Place;
  'places:update': Place;
  'places:remove': null;
  'travel:get': TravelTime[];
  /** Postcode -> the times already in the cache. Never calls TfL, so a gap stays a gap. */
  'travel:cached': Record<string, TravelTime[]>;
  /** Station name -> walking seconds and the lines serving it. Either half may be missing when
   *  TfL doesn't recognise the station. */
  'stations:walk': Record<string, { seconds?: number; lines: string[] }>;
  /** Where a postcode actually is. Null when postcodes.io doesn't know it — the panel says so
   *  rather than falling back to Rightmove's fuzzed pin, which would put the compass needle up to
   *  a few hundred yards out with nothing on screen looking wrong. */
  'postcode:point': Point | null;
  'analysis:get': Analysis | null;
  'analysis:request': AnalysisRequest;
  'model:get': StoredModel | null;

  'places:resolve-location': LocationResult;

  'spend:summary': SpendSummary;

  'admin:users': AdminUser[];
  'admin:projects': AdminProject[];
  'admin:invites': Invite[];
  'admin:usage': UsageRow[];
  'admin:set-user-cap': null;
  'admin:set-project-cap': null;
  'admin:set-max-members': null;
  'admin:set-password': null;

  /** `knowledge` is keyed by rightmove id; an id absent from it is one this project has never
   *  opened. `sweep` is this hub's progress after the page was counted, including whether that
   *  page completed the sweep. */
  'sweep:record': { knowledge: Record<string, SweepKnowledge>; sweep: HubSweep | null };
  'sweep:hubs': HubSweep[];
  'settings:get': HuntPreferences;
  'sweep:pending': PendingSighting[];
  'tab:open': null;
}

/** Errors travel as data rather than rejections, so both sides handle them the same way.
 *
 *  `unauthenticated` and `noProject` are flags on the failure rather than error strings, because
 *  every surface renders those two differently from a failure and matching on wording is how the
 *  difference gets lost (design D2, D13). */
export type Envelope<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; unauthenticated?: boolean; noProject?: boolean };

/** True when the worker refused because nobody is signed in. The panel shows one line inviting
 *  sign-in, the shortlist shows the sign-in view, and the search surfaces show nothing at all —
 *  a dimmed card asserts a verdict, and a verdict implies a project. */
export function isUnauthenticated<T>(reply: Envelope<T>): boolean {
  return !reply.ok && reply.unauthenticated === true;
}

/** True when the user is signed in but has no active project — the project picker's cue. */
export function isNoProject<T>(reply: Envelope<T>): boolean {
  return !reply.ok && reply.noProject === true;
}

export async function send<K extends Request['type']>(
  request: Extract<Request, { type: K }>,
): Promise<Envelope<ResponseMap[K]>> {
  try {
    const reply = (await chrome.runtime.sendMessage(request)) as Envelope<ResponseMap[K]> | undefined;
    // sendMessage resolves undefined when nothing answered — a dead service worker, or a
    // listener that threw before replying. Treating that as a valid response is how a broken
    // background quietly looks like "you have no places yet".
    if (!reply || typeof reply.ok !== 'boolean') {
      return { ok: false, error: `background did not answer ${request.type}` };
    }
    return reply;
  } catch (e) {
    return { ok: false, error: `extension background unreachable: ${describe(e)}` };
  }
}

export function describe(e: unknown): string {
  if (e instanceof Error) return e.message;
  return typeof e === 'string' ? e : JSON.stringify(e);
}

/** MAIN-world <-> isolated-world bridge. A MAIN-world script has no chrome.* APIs, so the only
 *  way across is postMessage. See RESEARCH.md §2.
 *
 *  The two sides handshake rather than relying on a single broadcast: the MAIN script runs at
 *  document_end but the panel runs at document_idle, so a lone broadcast is sent before anyone
 *  is listening and is lost. The panel asks, and MAIN answers from a cached result. */
export const PAGE_MESSAGE = 'rightmove-extension/listing';
export const PAGE_REQUEST = 'rightmove-extension/request';

export type PageMessage =
  | { source: typeof PAGE_MESSAGE; ok: true; listing: Listing }
  // `withdrawn` rather than a recognisable `error` string: this crosses a postMessage boundary, and
  // matching on wording is how the panel would come to show "Rightmove changed the page" the first
  // time somebody rephrased the sentence.
  | { source: typeof PAGE_MESSAGE; ok: false; error: string; withdrawn?: true };

export type PageRequest = { source: typeof PAGE_REQUEST };
