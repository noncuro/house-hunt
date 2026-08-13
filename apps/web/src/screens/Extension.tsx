'use client';

import { useEffect, useState } from 'react';
import { helloExtension, signInExtension, type ExtensionState } from '@/lib/bridge';
import { EXPECTED_EXTENSION_VERSION, extensionBehind } from '@/lib/extension-version';

/** Whether the Rightmove half of this is installed and signed in, and the one way to fix it if not.
 *
 *  The website and the extension hold two independent sessions on purpose (design D3), which buys
 *  the thing it was meant to buy — neither can revoke the other's refresh token — and costs exactly
 *  this: they can be out of step, and somebody has to say so. Signing in here hands the credentials
 *  across at that moment, so the usual case is already handled. This covers the other two:
 *
 *  - **Installed later.** You signed in on this site in June and installed the extension in August.
 *    There is no password in memory any more, so it asks for one. It is a re-prompt for a credential
 *    already typed on this same origin, not a new kind of secret.
 *  - **Signed in as somebody else.** Two people share a laptop, or one account was for testing. The
 *    overlay would quietly write verdicts under the other name, which is worth a sentence.
 *
 *  Absent gets a line and no link. The install is load-unpacked on a handful of laptops; a "click
 *  here to install" button that cannot install anything is worse than the sentence. */
export function ExtensionNotice({ email }: { email: string }) {
  const [state, setState] = useState<ExtensionState | null>(null);
  const [connecting, setConnecting] = useState(false);

  useEffect(() => {
    let live = true;
    void helloExtension().then((next) => {
      if (live) setState(next);
    });
    return () => {
      live = false;
    };
  }, []);

  // Nothing to say while the question is outstanding — half a second of "checking for the
  // extension…" above the shortlist is half a second of noise about something almost always fine —
  // but the space it might need is held from the first paint. Returning nothing here is what made
  // the page jump when the answer arrived, which is the whole point of the slot.
  if (!state) return <div className="notice-slot" />;

  // Staleness is orthogonal to sign-in — an out-of-date extension can be signed in, signed out, or
  // on the wrong account — so it renders as its own banner above whatever else this component has to
  // say, rather than replacing it. A build too old to report its version (`version === null`) counts
  // as behind. `broken`/`absent` carry no version and are never flagged.
  const installedVersion =
    state.status === 'signed-in' || state.status === 'signed-out' ? state.version : null;
  const outOfDate =
    (state.status === 'signed-in' || state.status === 'signed-out') && extensionBehind(installedVersion) ? (
      <p className="notice notice-warn">
        Your browser extension is out of date{installedVersion ? ` (v${installedVersion})` : ''} — this
        site ships v{EXPECTED_EXTENSION_VERSION}. Re-download it from the <strong>Install</strong> tab
        and hit Reload on <code>chrome://extensions</code>; your session and settings survive it.
      </p>
    ) : null;

  const primary = (() => {
    if (state.status === 'signed-in') {
      if (state.email === email) return null;
      return (
        <p className="notice notice-warn">
          The extension is signed in as <strong>{state.email}</strong>, not as you. Verdicts you leave
          on Rightmove would be recorded under that name — sign out here and back in to put both
          halves on the same account.
        </p>
      );
    }

    if (state.status === 'broken') {
      return <p className="notice notice-bad">The extension is installed but did not answer — {state.message}</p>;
    }

    if (state.status === 'absent') {
      return (
        <p className="dim">
          The browser extension is not installed here, so Rightmove pages will not show travel times
          or the rating panel. Everything on this page works without it.
        </p>
      );
    }

    return connecting ? (
      <Connect
        email={email}
        version={installedVersion}
        onDone={(next) => { setConnecting(false); if (next) setState(next); }}
      />
    ) : (
      <p className="notice notice-warn">
        The extension is installed but signed out, so Rightmove pages show nothing.{' '}
        <button className="key" onClick={() => setConnecting(true)}>
          Connect it
        </button>
      </p>
    );
  })();

  // The slot keeps its height whether or not there is anything in it. The check finishes after the
  // first paint, so a banner that appears then pushes the page down under the cursor — and the
  // controls it pushes are the ones being clicked at exactly that moment: a tick landing on the row
  // below the one aimed at is how this was found.
  if (!outOfDate && !primary) return <div className="notice-slot" />;
  return (
    <div className="notice-slot">
      {outOfDate}
      {primary}
    </div>
  );
}

/** The password re-prompt.
 *
 *  The address is not asked for — it is whoever is signed in here, and offering to type a different
 *  one would be offering to put the two halves on different accounts, which is the state this
 *  component exists to complain about. */
function Connect({
  email,
  version,
  onDone,
}: {
  email: string;
  /** The version reported before connecting, carried straight into the resulting signed-in state so
   *  the staleness banner does not blink off then back on after a connect. */
  version: string | null;
  onDone: (next: ExtensionState | null) => void;
}) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  async function connect() {
    setBusy(true);
    setFailed(null);
    const reply = await signInExtension(email, password);
    setPassword('');
    setBusy(false);

    if (!reply) return setFailed('the extension stopped answering — try reloading this page');
    if (reply.kind === 'error') return setFailed(reply.message);
    if (reply.kind !== 'sign-in') return setFailed(`unexpected ${reply.kind} reply`);
    if (reply.outcome.status === 'signed-in') return onDone({ status: 'signed-in', email, version });
    if (reply.outcome.status === 'wrong-credentials') return setFailed('that is not the password for this account');
    setFailed(
      'message' in reply.outcome ? reply.outcome.message : `the extension refused: ${reply.outcome.status}`,
    );
  }

  return (
    <section className="notice notice-warn">
      <p>
        Type your password once and the extension signs itself in as <strong>{email}</strong>. It
        gets its own session rather than a copy of this one, which is why it needs this.
      </p>
      <div className="fields">
        <input
          type="password"
          autoComplete="current-password"
          value={password}
          placeholder="Password"
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && password && !busy) void connect();
          }}
        />
        <button className="primary" disabled={busy || !password} onClick={() => void connect()}>
          {busy ? 'Connecting…' : 'Connect'}
        </button>
        <button disabled={busy} onClick={() => onDone(null)}>
          Not now
        </button>
      </div>
      {failed && <p className="error">{failed}</p>}
    </section>
  );
}
