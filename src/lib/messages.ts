import type { Point } from './postcode';
import type { SearchCard } from './search-page';
import type { HubSweep, PendingSighting, ShortlistEntry, SweepKnowledge } from './supabase';
import type { Analysis, Listing, Place, Rating, TravelTime, Verdict } from './types';

// ------------------------------------------------------------------------------------------------
// The shapes that cross the wire.
//
// These live here rather than in `types.ts` because they are the contract between the worker and
// every view, and `lib/supabase.ts` is the only file allowed to know what a database row looks
// like. A view imports from here and never from the client (design D2, and `tools/check-one-client.ts`).
// ------------------------------------------------------------------------------------------------

/** Who is signed in. `displayName` is what a verdict is attributed to; it falls back to the email
 *  address rather than to a blank, because "— , 2h ago" reads as a bug. */
export interface SessionUser {
  id: string;
  email: string;
  displayName: string;
  isAdmin: boolean;
  monthlyCapUsd: number;
}

export interface ProjectSummary {
  id: string;
  name: string;
  role: 'member' | 'owner';
  monthlyCapUsd: number;
  maxMembers: number;
}

/** The one answer every surface starts from.
 *
 *  `signed-in` with a null `activeProject` is a real state, not an oversight: it is what you are
 *  in between an invite being consumed and a project being chosen, and D13 says the shortlist
 *  shows the project picker there rather than an empty shortlist that looks broken. */
export type AuthState =
  | { status: 'signed-out' }
  | {
      status: 'signed-in';
      user: SessionUser;
      projects: ProjectSummary[];
      activeProject: ProjectSummary | null;
    };

/** Ten characters, the one password rule this system has.
 *
 *  It lives here, in the worker-to-view contract, rather than in `lib/auth.ts`, because the sign-in
 *  form has to state the rule before somebody submits and a view may not import a value out of
 *  `lib/auth.ts` — that module constructs the one Supabase client, and `pnpm check:one-client` is
 *  what keeps it to one context. The rule is enforced for real in
 *  `supabase/functions/password/index.ts`, which cannot import from the bundle at all, so that copy
 *  is kept in step by hand. If you change one, change both.
 */
export const MIN_PASSWORD_LENGTH = 10;

/** The worker's answer to "sign me in". `signed-in` carries the state so the page does not have to
 *  ask a second time — the invite is consumed between the two, and a second round trip is a window
 *  in which the shortlist renders "you are in no house hunt" at somebody who just joined one. */
export type SignInResult =
  | { status: 'signed-in'; state: AuthState }
  | { status: 'wrong-credentials' }
  | { status: 'not-confirmed' }
  | { status: 'rate-limited'; message: string }
  | { status: 'failed'; message: string };

/** Turning an invite code into an account. Every one of these wants a different next action from
 *  the reader, which is why none of them is an error string: `no-such-code` means look at the code
 *  again, `already-registered` means stop redeeming and sign in, `rate-limited` means stop typing,
 *  `password-too-short` means the only one of the four that is about the field they are in. */
export type RedeemResult =
  | { status: 'redeemed' }
  | { status: 'no-such-code' }
  | { status: 'already-registered' }
  | { status: 'password-too-short'; minimum: number }
  | { status: 'rate-limited'; retryAfterSeconds: number }
  | { status: 'failed'; message: string };

export interface ProjectMember {
  userId: string;
  email: string;
  displayName: string;
  role: 'member' | 'owner';
  joinedAt: string;
  /** True for the signed-in user's own row, so the view can say "you" and offer Leave. */
  isYou: boolean;
}

/** Members plus pending, non-expired invites, against the ceiling. Read *before* the invite field
 *  is submitted so a full project is a stated state rather than a failed insert (design D7). */
export interface Headcount {
  members: number;
  pending: number;
  maxMembers: number;
}

export interface Invite {
  id: string;
  email: string;
  /** Null for a platform invite: consuming it creates a fresh project for the invitee. */
  projectId: string | null;
  projectName: string | null;
  status: 'pending' | 'accepted' | 'revoked';
  /** Derived, not stored: an invite past its date confers nothing and must not read as pending. */
  expired: boolean;
  expiresAt: string;
  createdAt: string;
  acceptedAt: string | null;
}

export type InviteResult =
  /** `code` is the plaintext invite code, and this is the only time it exists anywhere outside the
   *  invitee's phone: the database holds a hash of it and there is no way to read one back. Show
   *  it, let it be copied, and say that resending is what replaces a lost one. */
  | { status: 'invited'; invite: Invite; userExisted: boolean; code: string }
  | { status: 'at-capacity'; headcount: Headcount }
  | { status: 'already-a-member' }
  | { status: 'already-invited' }
  /** Everything the function refused for a reason worth reading: not an admin, not in that
   *  project, no such project. Named rather than thrown, so the view prints the sentence. */
  | { status: 'refused'; reason: string };

/** A neighbourhood a project searches around. A row with no `locationIdentifier` answers only
 *  "what is this listing near"; one with it is also swept. A row with no point answers neither and
 *  must be skipped rather than defaulted — a guessed coordinate silently rotates every bearing
 *  computed from it (design D11). */
export interface ProjectHub {
  id: string;
  name: string;
  lat: number | null;
  lon: number | null;
  locationIdentifier: string | null;
  displayLocationIdentifier: string | null;
  maxDaysSinceAdded: number | null;
  /** Deliberately absent: `lastSweptAt` belongs to the hub's `HubSweep` row, which is the only
   *  thing that also knows which pages the claim rests on. A field here could only ever be null,
   *  and a null that looks like "never swept" is exactly how a window gets widened or narrowed
   *  wrongly. Read `hubs:sweeps`. */
  sortOrder: number;
}

export interface HubDraft {
  name: string;
  /** Either a postcode to resolve, or a point already known. One of the two is required. */
  postcode?: string;
  lat?: number;
  lon?: number;
  locationIdentifier?: string;
  displayLocationIdentifier?: string;
  maxDaysSinceAdded?: number;
}

/** One resolution of a neighbourhood name to the identifier Rightmove searches it by.
 *
 *  This is the single hand-run lookup `pnpm find:locations` performs today, moved behind an Edge
 *  Function so adding a hub does not need a terminal. It stays inside the standing no-crawl rule
 *  for the same reasons that script does: one request, because one person is adding one hub, never
 *  in the background and never enumerating. */
export type LocationResult =
  | {
      status: 'resolved';
      /** The SEO path segment the identifier was read out of, so a wrong one is traceable. */
      slug: string;
      locationIdentifier: string;
      displayLocationIdentifier: string;
      displayName: string;
      /** Rightmove's own centre for this search. A second, independent answer to "where is this":
       *  compare it against the postcodes.io or TfL coordinate before saving the hub. Two sources
       *  agreeing is the verification — an identifier on its own is a number somebody wrote down,
       *  and a hub placed wrong silently rotates every bearing computed from it. */
      centroid: { lat: number; lon: number } | null;
    }
  | { status: 'not-found'; slug: string }
  | { status: 'rate-limited'; used: number; limit: number; retryAfterSeconds: number }
  | { status: 'failed'; message: string };

/** Month-to-date spend against both caps. Both are checked, so the binding one is whichever is
 *  hit first; the view shows both rather than picking (design D9). */
export interface SpendScope {
  spentUsd: number;
  capUsd: number;
  /** When the month rolls over, in Europe/London — the boundary every other date here uses. */
  resetsAt: string;
}

export interface SpendSummary {
  project: SpendScope;
  user: SpendScope;
}

/** What happened when we asked for a listing to be analysed. `capped` is a state the panel renders
 *  as "the monthly analysis budget is used up, back on the 1st", never as an error. */
export type AnalysisRequest =
  | { status: 'queued' }
  | { status: 'cached' }
  | { status: 'capped'; scope: 'project' | 'user'; spentUsd: number; capUsd: number; resetsAt: string }
  | { status: 'failed'; message: string };

export interface AdminUser {
  id: string;
  email: string;
  displayName: string;
  isAdmin: boolean;
  monthlyCapUsd: number;
  createdAt: string;
  lastSeenAt: string | null;
  projects: Array<{ id: string; name: string }>;
  spentThisMonthUsd: number;
}

export interface AdminProject {
  id: string;
  name: string;
  memberCount: number;
  propertyCount: number;
  monthlyCapUsd: number;
  maxMembers: number;
  createdAt: string;
  spentThisMonthUsd: number;
}

export interface UsageRow {
  id: string;
  occurredAt: string;
  projectId: string | null;
  userId: string | null;
  kind: string;
  model: string;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  costUsd: number;
  rightmoveId: string | null;
}

// ------------------------------------------------------------------------------------------------
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
