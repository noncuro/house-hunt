import { createRoot, type Root } from 'react-dom/client';
import type { ReactNode } from 'react';
import { UiHostProvider } from '@house-hunt/ui';
import { extensionHost } from '@/lib/ui-host';
import { webAppUrl } from '@/lib/web-app';
import { listingIdFromUrl } from '@/lib/cards';
import { Panel } from '@/components/Panel';
import {
  onSessionChange,
  PAGE_MESSAGE,
  PAGE_REQUEST,
  send,
  type PageMessage,
  type PageRequest,
  type SessionUser,
} from '@/lib/messages';
import type { Listing } from '@house-hunt/core';
import './style.css';

/** Isolated world. Receives the decoded listing from the MAIN-world script and renders the
 *  panel into a shadow root.
 *
 *  Nothing happens here until the session is known. A signed-out visitor gets one line inviting
 *  them to sign in (design D13) and nothing else: no handshake with the page-model reader, no
 *  `listing:seen`, no analysis request. Every one of those would be refused by the worker, and a
 *  panel full of refusals reads as a broken extension rather than as one nobody has signed into. */
export default defineContentScript({
  matches: ['https://www.rightmove.co.uk/properties/*'],
  cssInjectionMode: 'ui',

  async main(ctx) {
    // Only the current session's listeners may be live. The set `start` leaves behind holds the
    // user it was started with, so a second person signing in on the same browser would have the
    // older set render the panel — and write a verdict — as whoever was signed in before. The
    // generation count covers the await inside `start`: a session that changes twice during it
    // would otherwise leave the first run's listeners with nothing referring to them.
    let stopListening: (() => void) | null = null;
    let stopWatching: (() => void) | null = null;
    let generation = 0;
    const restart = async (root: Root): Promise<void> => {
      stopListening?.();
      stopListening = null;
      const mine = ++generation;
      const stop = await start(root);
      if (mine === generation) stopListening = stop;
      else stop?.();
    };

    const ui = await createShadowRootUi(ctx, {
      name: 'rightmove-house-hunt',
      position: 'inline',
      anchor: 'body',
      onMount(container): Root {
        // Every render below goes through this, so the shared components can reach the background
        // worker for a station walk or a paced tab without importing the transport themselves.
        const root = withHost(createRoot(container));
        root.render(<Loading />);
        void restart(root);
        stopWatching = onSessionChange(() => void restart(root));
        return root;
      },
      onRemove(root) {
        // The watcher first: it would otherwise call `restart` on an unmounted root. Bumping the
        // generation is what stops a `start` already awaiting the worker from attaching to it.
        stopWatching?.();
        stopWatching = null;
        generation += 1;
        stopListening?.();
        stopListening = null;
        root?.unmount();
      },
    });
    ui.mount();
  },
});

const ASK_EVERY_MS = 200;
const GIVE_UP_AFTER_MS = 8000;

/** Resolve the session, then decide what this page gets. `auth:state` is the one message the
 *  worker answers rather than refusing when nobody is signed in, so this is safe to ask first.
 *
 *  Asked again whenever the session changes, so the tab somebody was looking at when they signed in
 *  stops being the one page that does not notice (#86). Signing out re-runs it too and the panel
 *  goes back to its one honest line, rather than leaving a working overlay on a machine somebody has
 *  just left. Returns what stops the listeners it set up, or null where it set none up. */
async function start(root: Root): Promise<(() => void) | null> {
  const auth = await send({ type: 'auth:state' });
  if (!auth.ok) {
    root.render(<Broken error={auth.error} />);
    return null;
  }
  if (auth.data.status === 'signed-out') {
    root.render(<SignedOut />);
    return null;
  }
  if (!auth.data.activeProject) {
    root.render(<NoProject />);
    return null;
  }
  return listen(root, auth.data.user);
}

/** Returns what stops it: the handler, the asking, and the deadline all go together, because the
 *  user this closes over is the one it renders the panel as. */
function listen(root: Root, user: SessionUser): () => void {
  let answered = false;

  const onMessage = (event: MessageEvent) => {
    if (event.source !== window || event.origin !== location.origin) return;
    const message = event.data as PageMessage | undefined;
    if (message?.source !== PAGE_MESSAGE) return;

    answered = true;
    if (!message.ok && message.withdrawn) {
      root.render(<Withdrawn />);
      // The id is only in the address here — the withdrawn page keeps its URL and empties everything
      // else — so a page we cannot parse is still one we can name. Fire and forget: this tidies the
      // sweep's worklist, and a failure to tidy it must not replace the sentence above with one
      // about the database.
      const id = listingIdFromUrl(location.href);
      if (id) void send({ type: 'listing:withdrawn', rightmoveId: id });
      return;
    }
    // Fail loudly. A blank panel would read as "this listing has nothing nearby".
    root.render(
      message.ok ? <Panel listing={message.listing} user={user} /> : <Broken error={message.error} />,
    );
  };
  window.addEventListener('message', onMessage);

  // Ask until answered. The MAIN-world script may not have finished — or, because it runs at
  // document_end and we run at document_idle, may have already broadcast before we were here.
  const ask = () => window.postMessage({ source: PAGE_REQUEST } satisfies PageRequest, location.origin);
  const asking = setInterval(() => (answered ? clearInterval(asking) : ask()), ASK_EVERY_MS);
  ask();

  // Never sit on "Reading listing…" forever — silence is a failure and should look like one.
  const giveUp = setTimeout(() => {
    clearInterval(asking);
    if (!answered) {
      root.render(
        <Broken error="the page-model reader never replied — check the console for errors from the extension" />,
      );
    }
  }, GIVE_UP_AFTER_MS);

  return () => {
    window.removeEventListener('message', onMessage);
    clearInterval(asking);
    clearTimeout(giveUp);
  };
}

function Loading() {
  return <div className="rm-panel rm-empty">Reading listing…</div>;
}

/** One line, and it is a sentence rather than an absence. A panel that rendered nothing at all
 *  here would be indistinguishable from one that had broken, and a panel that tried anyway would
 *  be a column of refusals.
 *
 *  A link now, rather than "click the toolbar icon". Signing in happens on the website and hands
 *  the credentials to this extension at that moment (design D3), so the whole of the fix is one
 *  click away and can be pointed at — which is the sort of thing a `chrome-extension://` address
 *  could never be. */
function SignedOut() {
  return (
    <div className="rm-panel rm-signed-out" data-testid="signed-out">
      <strong>Sign in to the house hunt.</strong>
      <div className="rm-signed-out-how">
        <a href={webAppUrl()} target="_blank" rel="noopener">
          Open the house hunt
        </a>{' '}
        and sign in, then reload this page. Signing in there signs this in too. Nothing about this
        listing has been recorded.
      </div>
    </div>
  );
}

/** Signed in, but between an invite being consumed and a project being chosen. Rare, and named:
 *  a shortlist with no project is not an empty shortlist (design D13). */
function NoProject() {
  return (
    <div className="rm-panel rm-signed-out" data-testid="no-project">
      <strong>No house hunt selected.</strong>
      <div className="rm-signed-out-how">
        <a href={webAppUrl()} target="_blank" rel="noopener">
          Open the house hunt
        </a>{' '}
        and pick one, then reload this page.
      </div>
    </div>
  );
}

/** The flat is gone, which is an answer rather than a failure.
 *
 *  Separate from `Broken` because that one sends you to `decode_page_model.py` to find out what
 *  Rightmove renamed, and there is nothing to find: the page is exactly as Rightmove meant it. */
function Withdrawn() {
  return (
    <div className="rm-panel rm-signed-out" data-testid="withdrawn">
      <strong>This listing has been removed.</strong>
      <div className="rm-signed-out-how">
        The agent has taken it down, so there is nothing here to read or rate. It has been dropped
        from the sweep so a fill-in run will not keep reopening it.
      </div>
    </div>
  );
}

function Broken({ error }: { error: string }) {
  return (
    <div className="rm-panel">
      <div className="rm-error">
        <strong>Couldn't read this listing.</strong>
        <div style={{ marginTop: 4 }}>{error}</div>
        <div style={{ marginTop: 6 }}>
          Rightmove may have changed the page. Re-check with{' '}
          <code>tools/decode_page_model.py</code>.
        </div>
      </div>
    </div>
  );
}

export type { Listing };

/** Wrap everything rendered into this root in the host the shared components read from.
 *
 *  The panel renders into one root from four places — loading, signed out, no project, the panel
 *  itself, and two failure states — and wrapping each call site would be five chances to forget
 *  one. The symptom of forgetting would be a thrown error from `useHost` on whichever state was
 *  missed, which is a state you only see when something has already gone wrong. */
function withHost(root: Root): Root {
  return {
    render: (node: ReactNode) => root.render(<UiHostProvider host={extensionHost}>{node}</UiHostProvider>),
    unmount: () => root.unmount(),
  };
}
