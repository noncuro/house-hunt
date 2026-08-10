import type { SignInOutcome } from './db/session';

/** The whole conversation between the website and the extension.
 *
 *  Three messages, and deliberately no more (design D3). Nothing about a flat, a verdict or a
 *  project crosses this — both surfaces read the database directly, and the bridge exists solely to
 *  keep two sessions in step.
 *
 *  **Why two sessions rather than one shared.** Supabase rotates the refresh token on every use and
 *  revokes the family when a spent one is presented. Two holders of one token diverge the first time
 *  either refreshes, and the loser is signed out with nothing on screen explaining why, days later.
 *  So the extension never receives a session. It receives an email and a password, once, and signs
 *  *itself* in — which is the same thing as being signed in on a phone and a laptop.
 *
 *  **Which means the credentials cross a `window.postMessage` on the website's origin**, where any
 *  script running on that origin can read them. Today the only scripts there are ours, and the
 *  website's Content-Security-Policy (`script-src 'self'`) is what keeps it that way. That policy is
 *  load-bearing for this file, not hygiene.
 *
 *  Addressed by origin, never by extension id. The unpacked build and the store build have different
 *  ids — the id is a hash of the manifest key and the store build omits the key on purpose — so a
 *  website that knew an id would work with one of the two installs and silently not the other. */
export const BRIDGE = 'house-hunt/bridge';

export type BridgeAsk =
  /** "Is an extension installed, and is it signed in?" Silence is the answer for *not installed*:
   *  there is nothing to reply with, so the caller times out and says so. */
  | { kind: 'hello' }
  /** Held in a local variable on the website for exactly the length of this call, and never
   *  stored — not in `localStorage`, not in a React state that outlives the form. */
  | { kind: 'sign-in'; email: string; password: string }
  /** Signing out on the website signs the extension out too. Without it the overlay keeps working
   *  on Rightmove after you thought you had left, which is the sort of thing you only discover on
   *  someone else's laptop. */
  | { kind: 'sign-out' };

/** What the extension made of it.
 *
 *  `sign-in` answers with the *outcome* alone — signed in, wrong credentials, rate limited — and not
 *  with the resulting auth state, even though the extension has one by then. The website already
 *  knows which house hunts this person is in; it asked its own database a moment ago. Sending them
 *  back across would be the first project data on a bridge whose whole justification is that none
 *  travels on it. */
export type BridgeReply =
  | { kind: 'hello'; signedIn: boolean; email: string | null }
  | { kind: 'sign-in'; outcome: SignInOutcome }
  | { kind: 'sign-out' }
  /** The worker refused or was unreachable. Distinct from a named sign-in refusal, which is an
   *  answer rather than a failure. */
  | { kind: 'error'; message: string };

export interface BridgeRequest {
  source: typeof BRIDGE;
  /** Matches a reply to its question. Two `hello`s can be in flight — the page asks on load and
   *  again after signing out — and without this the first reply would settle both. */
  id: string;
  ask: BridgeAsk;
}

export interface BridgeResponse {
  source: typeof BRIDGE;
  id: string;
  reply: BridgeReply;
}

export function isBridgeRequest(value: unknown): value is BridgeRequest {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Partial<BridgeRequest>;
  return v.source === BRIDGE && typeof v.id === 'string' && typeof v.ask === 'object' && v.ask !== null;
}

export function isBridgeResponse(value: unknown): value is BridgeResponse {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Partial<BridgeResponse>;
  return v.source === BRIDGE && typeof v.id === 'string' && typeof v.reply === 'object' && v.reply !== null;
}
