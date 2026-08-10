/** The messages a Rightmove content script sends the background worker, and the envelope they
 *  travel in.
 *
 *  Only the extension has this. The website holds no message layer at all — it calls the data
 *  layer in `@house-hunt/core/db` directly, which is most of what moving the app out of the
 *  extension bought. What is left here is what a script running inside somebody else's page
 *  needs, and it stays typed end to end because that is the part of this design that works. */
import type { Point, SearchCard } from '@house-hunt/core';
import type { HubSweep, PendingSighting, ShortlistEntry, SweepKnowledge } from '@house-hunt/core/db';
import type {
  AnalysisRequest,
  AuthState,
  Headcount,
  Invite,
  InviteResult,
  LocationResult,
  ProjectHub,
  HubDraft,
  ProjectMember,
  ProjectSummary,
  RedeemResult,
  SignInResult,
  SpendSummary,
  AdminProject,
  AdminUser,
  UsageRow,
} from '@house-hunt/core';
import type { Analysis, Listing, Place, Rating, StationInfo, TravelTime, Verdict } from '@house-hunt/core';

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
  HubDraft,
  Invite,
  InviteResult,
  LocationResult,
  ProjectHub,
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
  | { type: 'verdict:set'; rightmoveId: string; rating: Rating; note: string }
  | { type: 'verdicts:get'; rightmoveIds: string[] }
  | { type: 'places:list' }
  | { type: 'places:add'; label: string; postcode: string }
  | { type: 'places:remove'; id: string }
  | { type: 'travel:get'; postcode: string; refresh?: boolean }
  | { type: 'travel:cached'; postcodes: string[] }
  | { type: 'stations:walk'; postcode: string; stations: string[] }
  | { type: 'postcode:point'; postcode: string }
  | { type: 'analysis:get'; rightmoveId: string }
  | { type: 'analysis:request'; rightmoveId: string }
  | { type: 'shortlist:get' }
  | { type: 'properties:locate' }
  // --- hubs --------------------------------------------------------------------------------
  | { type: 'hubs:list' }
  | { type: 'hubs:add'; hub: HubDraft }
  | { type: 'hubs:update'; id: string; patch: Partial<HubDraft> }
  | { type: 'hubs:remove'; id: string }
  | { type: 'hubs:resolve-location'; name: string }
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
      /** The hub's name, as the search page was opened under. Resolved to a `project_hub` row in
       *  the active project; `hubId` short-circuits that when the caller already has it. */
      hub: string;
      hubId?: string;
      cards: SearchCard[];
      /** Where in the sweep this page is. Carried with the cards rather than sent separately: a
       *  panel that recorded the last page and then failed to say so would leave the hub forever
       *  one page short of swept, with nothing on screen looking wrong. */
      progress: {
        page: number;
        totalPages: number;
        resultCount: number;
        windowDays: number;
        locationIdentifier: string;
      };
    }
  | { type: 'sweep:hubs' }
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
  'verdict:set': null;
  /** At most one verdict per property now: the project shares one rating (design D6). `person` is
   *  the display name of whoever set it — the author, not the owner of a private opinion — and it
   *  is shown alongside `updatedAt` so last-write-wins stays visible rather than silent. */
  'verdicts:get': Verdict[];
  'places:list': Place[];
  'places:add': Place;
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
  'shortlist:get': ShortlistEntry[];
  'properties:locate': number;

  'hubs:list': ProjectHub[];
  'hubs:add': ProjectHub;
  'hubs:update': ProjectHub;
  'hubs:remove': null;
  'hubs:resolve-location': LocationResult;

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
  | { source: typeof PAGE_MESSAGE; ok: false; error: string };

export type PageRequest = { source: typeof PAGE_REQUEST };
