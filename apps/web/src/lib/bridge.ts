'use client';

import {
  BRIDGE,
  isBridgeResponse,
  type BridgeAsk,
  type BridgeReply,
  type BridgeRequest,
} from '@house-hunt/core';

/** Talking to the extension, if there is one.
 *
 *  A `window.postMessage` into the extension's content script and back — see `bridge.ts` in core for
 *  the contract and for why credentials rather than a session cross it.
 *
 *  **Silence means "not installed".** There is no way to ask Chrome whether an extension is there,
 *  and no reply is exactly what an absent one produces, so every call has a deadline. That makes the
 *  timeout part of the protocol rather than a safety net: it is how `hello` gets its answer in the
 *  common case where the reader has never installed anything. */
async function ask(message: BridgeAsk, deadlineMs: number): Promise<BridgeReply | null> {
  if (typeof window === 'undefined') return null;

  const id = crypto.randomUUID();
  const request: BridgeRequest = { source: BRIDGE, id, ask: message };

  return await new Promise<BridgeReply | null>((resolve) => {
    const timer = window.setTimeout(() => finish(null), deadlineMs);

    function finish(reply: BridgeReply | null) {
      window.clearTimeout(timer);
      window.removeEventListener('message', onMessage);
      resolve(reply);
    }

    function onMessage(event: MessageEvent) {
      // Same three checks the content script makes, in the same order and for the same reasons. The
      // id match is the one that is specific to this side: two `hello`s can be in flight — the page
      // asks on load and again after signing out — and without it the first reply settles both.
      if (event.source !== window) return;
      if (event.origin !== window.location.origin) return;
      if (!isBridgeResponse(event.data) || event.data.id !== id) return;
      finish(event.data.reply);
    }

    window.addEventListener('message', onMessage);
    window.postMessage(request, window.location.origin);
  });
}

/** What the extension is, from here: absent, present and signed out, or present and signed in. */
export type ExtensionState =
  | { status: 'absent' }
  /** `version` is the installed extension's manifest version (null from a build too old to report
   *  it). The caller compares it against what the site ships to decide whether to nudge a
   *  re-download — see `extensionBehind`. */
  | { status: 'signed-out'; version: string | null }
  | { status: 'signed-in'; email: string; version: string | null }
  /** Present, and something went wrong asking it. Kept apart from `absent` because the two want
   *  opposite copy: one says "install it", and saying that to somebody who already has it installed
   *  is how a real fault gets ignored. */
  | { status: 'broken'; message: string };

/** Half a second. An installed extension answers this in single-digit milliseconds — the content
 *  script is already running and the worker wakes on the message — so anything near the deadline is
 *  a machine under load rather than a slow extension, and being wrong here only means offering an
 *  install link to somebody who has it. */
const HELLO_MS = 500;

export async function helloExtension(): Promise<ExtensionState> {
  const reply = await ask({ kind: 'hello' }, HELLO_MS);
  if (!reply) return { status: 'absent' };
  if (reply.kind === 'error') return { status: 'broken', message: reply.message };
  if (reply.kind !== 'hello') return { status: 'broken', message: `unexpected ${reply.kind} reply` };
  // `?? null` because a build too old to know this handshake omits `version` entirely — that
  // arrives as `undefined`, which must become the null that `extensionBehind` reads as "stale".
  return reply.signedIn && reply.email
    ? { status: 'signed-in', email: reply.email, version: reply.version ?? null }
    : { status: 'signed-out', version: reply.version ?? null };
}

/** Hand the credentials over, once.
 *
 *  Called with the two values still in the sign-in form's local variables, and they are not stored
 *  anywhere on this side — not in `localStorage`, not in React state that outlives the submission.
 *
 *  A generous deadline, because this is a real password sign-in against Supabase on the other side
 *  and the caller is already showing "signing in". Returns null when nothing answered, which the
 *  caller treats as "no extension" and not as a failure: signing in on the website has already
 *  succeeded by the time this is called, and the extension is the optional half. */
export function signInExtension(email: string, password: string): Promise<BridgeReply | null> {
  return ask({ kind: 'sign-in', email, password }, 20_000);
}

/** Sign the extension out too. Without this the overlay keeps working on Rightmove after you
 *  thought you had left — which you would only find out on somebody else's laptop. */
export function signOutExtension(): Promise<BridgeReply | null> {
  return ask({ kind: 'sign-out' }, 5_000);
}

/** Five seconds. The worker may be asleep — a background service worker is evicted between asks —
 *  so this covers a cold start plus the `chrome.tabs.create` call, which is otherwise immediate.
 *  Longer than `hello`, because a timeout here stops a run rather than mislabelling an install. */
const OPEN_TAB_MS = 5_000;

/** Open one Rightmove listing in a background tab, through the extension.
 *
 *  The website has no `chrome.tabs.create`, and a paced run of `window.open` from a timer is
 *  throttled by the browser to the first tab — which is the whole reason a fill-in run on the web is
 *  only offered when the extension is here. Every listing that run opens comes through this. Returns
 *  null when nothing answered: the caller has already established the extension is present, so a null
 *  mid-run means it has gone, and the run stops rather than pressing on blindly. */
export function openTabExtension(url: string): Promise<BridgeReply | null> {
  return ask({ kind: 'open-tab', url }, OPEN_TAB_MS);
}
