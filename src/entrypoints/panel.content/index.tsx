import { createRoot, type Root } from 'react-dom/client';
import { Panel } from '@/components/Panel';
import {
  PAGE_MESSAGE,
  PAGE_REQUEST,
  send,
  type PageMessage,
  type PageRequest,
  type SessionUser,
} from '@/lib/messages';
import type { Listing } from '@/lib/types';
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
    const ui = await createShadowRootUi(ctx, {
      name: 'rightmove-house-hunt',
      position: 'inline',
      anchor: 'body',
      onMount(container): Root {
        const root = createRoot(container);
        root.render(<Loading />);
        void start(root);
        return root;
      },
      onRemove(root) {
        root?.unmount();
      },
    });
    ui.mount();
  },
});

const ASK_EVERY_MS = 200;
const GIVE_UP_AFTER_MS = 8000;

/** Resolve the session, then decide what this page gets. `auth:state` is the one message the
 *  worker answers rather than refusing when nobody is signed in, so this is safe to ask first. */
async function start(root: Root): Promise<void> {
  const auth = await send({ type: 'auth:state' });
  if (!auth.ok) {
    root.render(<Broken error={auth.error} />);
    return;
  }
  if (auth.data.status === 'signed-out') {
    root.render(<SignedOut />);
    return;
  }
  if (!auth.data.activeProject) {
    root.render(<NoProject />);
    return;
  }
  listen(root, auth.data.user);
}

function listen(root: Root, user: SessionUser): void {
  let answered = false;

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.origin !== location.origin) return;
    const message = event.data as PageMessage | undefined;
    if (message?.source !== PAGE_MESSAGE) return;

    answered = true;
    // Fail loudly. A blank panel would read as "this listing has nothing nearby".
    root.render(
      message.ok ? <Panel listing={message.listing} user={user} /> : <Broken error={message.error} />,
    );
  });

  // Ask until answered. The MAIN-world script may not have finished — or, because it runs at
  // document_end and we run at document_idle, may have already broadcast before we were here.
  const ask = () => window.postMessage({ source: PAGE_REQUEST } satisfies PageRequest, location.origin);
  const asking = setInterval(() => (answered ? clearInterval(asking) : ask()), ASK_EVERY_MS);
  ask();

  // Never sit on "Reading listing…" forever — silence is a failure and should look like one.
  setTimeout(() => {
    clearInterval(asking);
    if (!answered) {
      root.render(
        <Broken error="the page-model reader never replied — check the console for errors from the extension" />,
      );
    }
  }, GIVE_UP_AFTER_MS);
}

function Loading() {
  return <div className="rm-panel rm-empty">Reading listing…</div>;
}

/** One line, and it is a sentence rather than an absence. A panel that rendered nothing at all
 *  here would be indistinguishable from one that had broken, and a panel that tried anyway would
 *  be a column of refusals. The shortlist is where signing in happens; it opens from the toolbar
 *  icon, because a content script cannot navigate to an extension page that is not
 *  web-accessible. */
function SignedOut() {
  return (
    <div className="rm-panel rm-signed-out" data-testid="signed-out">
      <strong>Sign in to the house hunt extension.</strong>
      <div className="rm-signed-out-how">
        Click the 🏠 House hunt icon in the toolbar to open the shortlist and sign in, then reload
        this page. Nothing about this listing has been recorded.
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
        Open the shortlist from the 🏠 House hunt icon and pick a project, then reload this page.
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
