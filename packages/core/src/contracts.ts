// ------------------------------------------------------------------------------------------------
// The vocabulary both surfaces speak.
//
// These live here rather than in `types.ts` because they are answers rather than rows: a
// `ProjectSummary` is what the data layer hands a view, and `db/supabase.ts` stays the only file
// that knows what a database row looks like. A view imports from here and never from the client
// (design D2, D8, and `tools/check-one-client.ts`).
//
// They used to live in the extension's `lib/messages.ts`, beside the `chrome.runtime` envelope
// that carried them, from when the only way a view could reach the database was to ask the
// background worker. The website reaches it directly, so the shapes outlived the transport.

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

/** What can be changed about a place *after* it exists: whether the hunt sweeps around it, how
 *  far, and how often. The label and the postcode are what the place is, and changing either means
 *  resolving a coordinate again — that is `addPlace`'s job, not a patch's. */
export interface PlacePatch {
  locationIdentifier?: string | null;
  displayLocationIdentifier?: string | null;
  sweepRadiusMiles?: number | null;
  maxDaysSinceAdded?: number | null;
}

/** One resolution of a place's name to the identifier Rightmove searches it by.
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
