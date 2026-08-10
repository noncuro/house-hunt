import {
  BRIDGE,
  isBridgeRequest,
  type BridgeReply,
  type BridgeResponse,
} from '@house-hunt/core';
import { describe, send } from '@/lib/messages';
import { webAppOrigin } from '@/lib/web-app';

/** The only thing this extension runs on the website: a relay for three messages (design D3).
 *
 *  The website cannot talk to the background worker itself — a page has no `chrome.runtime` — and it
 *  must not be handed one, since `externally_connectable` would let any page that knows the id ask
 *  the worker things. So this sits in the isolated world on the website's origin, listens for three
 *  named asks, and forwards them.
 *
 *  Injected by origin rather than reachable by extension id. The unpacked build and the store build
 *  have different ids, so a website that addressed one would silently not reach the other.
 *
 *  What it will not do is as much of the design as what it will. It carries no flat, no verdict and
 *  no project: both surfaces read the database directly, and this exists only to keep two sessions
 *  in step. It never sends anything unprompted, so nothing leaves the extension except in answer to
 *  a question the page asked. */
export default defineContentScript({
  // Replaced with `WXT_WEB_APP_URL`'s origin by the `build:manifestGenerated` hook in
  // wxt.config.ts, which throws if this exact string is not here. It cannot be read from the
  // environment on this line: WXT evaluates this file to write the manifest in a pass where
  // `import.meta.env` is undefined, so doing the obvious thing yields a script matching
  // `undefined/*` — which builds cleanly and matches nothing.
  matches: ['https://replaced-at-build-time.invalid/*'],
  runAt: 'document_start',

  main() {
    window.addEventListener('message', (event) => {
      // Three checks, and each one matters. `event.source !== window` rejects anything posted from
      // an iframe or an opener; the origin check rejects a page that somehow ran here under another
      // origin; and the shape check is what stops every unrelated `postMessage` on the page — and
      // there are many — from being read as a request.
      if (event.source !== window) return;
      if (event.origin !== webAppOrigin()) return;
      if (!isBridgeRequest(event.data)) return;

      const { id, ask } = event.data;
      void answer(ask)
        .catch((e): BridgeReply => ({ kind: 'error', message: describe(e) }))
        .then((reply) => {
          const response: BridgeResponse = { source: BRIDGE, id, reply };
          // Addressed back to the exact origin it came from rather than to `*`, so the answer to a
          // sign-in cannot be read by a frame from anywhere else.
          window.postMessage(response, event.origin);
        });
    });
  },
});

async function answer(ask: { kind: string } & Record<string, unknown>): Promise<BridgeReply> {
  switch (ask.kind) {
    case 'hello': {
      const state = await send({ type: 'auth:state' });
      if (!state.ok) return { kind: 'error', message: state.error };
      return state.data.status === 'signed-in'
        ? { kind: 'hello', signedIn: true, email: state.data.user.email }
        : { kind: 'hello', signedIn: false, email: null };
    }

    case 'sign-in': {
      const { email, password } = ask as unknown as { email: string; password: string };
      if (typeof email !== 'string' || typeof password !== 'string') {
        return { kind: 'error', message: 'a sign-in needs an address and a password' };
      }
      const reply = await send({ type: 'auth:sign-in', email, password });
      if (!reply.ok) return { kind: 'error', message: reply.error };
      // Only the outcome goes back. The worker has the whole auth state by now, and the website
      // already knows which house hunts this person is in — it read them itself a moment ago.
      return {
        kind: 'sign-in',
        outcome: reply.data.status === 'signed-in' ? { status: 'signed-in' } : reply.data,
      };
    }

    case 'sign-out': {
      const reply = await send({ type: 'auth:sign-out' });
      if (!reply.ok) return { kind: 'error', message: reply.error };
      return { kind: 'sign-out' };
    }

    default:
      return { kind: 'error', message: `the bridge does not carry ${ask.kind}` };
  }
}
