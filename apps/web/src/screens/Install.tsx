'use client';

import { useEffect, useState } from 'react';
import type { ExtensionState } from '@/lib/bridge';
import { EXPECTED_EXTENSION_VERSION, extensionBehind } from '@/lib/extension-version';
import { useExtension } from '@/lib/queries';

/** Getting the Rightmove half onto this laptop.
 *
 *  This is the download surface, not `ExtensionNotice` — the two answer different questions and must
 *  not be confused. `ExtensionNotice` (screens/Extension.tsx) reports whether an *already installed*
 *  extension is signed in as you and offers to connect it; this screen hands you the zip and the
 *  load-unpacked steps for a laptop that has no extension at all. It is a tab of its own for the
 *  same reason the notice stays a one-line aside: the install is a deliberate thing you come here to
 *  do, not something to bolt onto a warning.
 *
 *  Gated with every other tab — the page renders nothing until someone is signed in (see app/page),
 *  so a signed-out visitor never sees the download link, which matters: the zip is sent privately,
 *  never through the Chrome Web Store, and a public download button would undo that.
 *
 *  The zip is a committed static asset at `apps/web/public/rightmove-house-hunt.zip`, served from
 *  `/rightmove-house-hunt.zip`. Vercel builds only apps/web and cannot build the extension, so the
 *  file cannot be generated at deploy time — `.github/workflows/package.yml` rebuilds and commits
 *  it when extension or shared-package source lands on main. It used to be refreshed by hand, and
 *  so it was not: the served zip stayed at 0.1.0 through three version bumps while this page told
 *  everybody who downloaded it that their copy was out of date. The steps below are lifted from
 *  SETUP.md's "Installing it" so the page and the printed instructions cannot drift. */
export function Install({ email }: { email: string }) {
  // The same probe the banner above the page reads. Two of them, each with its own deadline, could
  // and did disagree — this screen saying "already installed (v0.3.1)" under a banner saying it was
  // not installed at all.
  const state = useExtension().data ?? null;

  return (
    <div className="settings">
      <section className="setting">
        <h2>Install the browser extension</h2>
        {/* Six numbered steps for something already done reads as "this did not work". The page
            still offers the download either way — the zip is how a second laptop gets it, and how
            an out-of-date copy is replaced. */}
        <Installed state={state} />
        <p className="dim">
          The extension is the Rightmove half of this: it draws the panel on every listing — travel
          times, nearest stations, the shared rating — and badges search results. Everything on this
          page works without it, but Rightmove pages show nothing until it is loaded.
        </p>
        <p className="dim">
          It loads unpacked from a folder on disk, not from the Chrome Web Store — access is an
          invite, not a download. Keep the folder to yourself.
        </p>
        <div className="fields">
          <a className="primary" href="/rightmove-house-hunt.zip" download>
            Download the extension (.zip)
          </a>
        </div>
      </section>

      <OneLiner />

      <section className="setting">
        <h2>Or load it into Chrome by hand</h2>
        <ol className="steps">
          <li>
            Unzip it somewhere you will not move or delete —{' '}
            <code>~/Applications/rightmove-house-hunt</code> is fine. <strong>The folder has to
            stay where it is</strong>; Chrome loads it from disk every time it starts.
          </li>
          <li>
            Go to <code>chrome://extensions</code>.
          </li>
          <li>
            Turn on <strong>Developer mode</strong>, top right.
          </li>
          <li>
            Click <strong>Load unpacked</strong> and pick the unzipped folder. On macOS the picker
            opens on <code>/Applications</code>, which is not <code>~/Applications</code> and does
            not contain it — press <kbd>⌘⇧G</kbd> and type the path to go straight there.
          </li>
          <li>
            Click the extension icon. It opens the house hunt in a browser tab. Sign in there with{' '}
            <strong>{email}</strong> — the address you are signed in as here — and your password;
            signing in on the website signs the extension in too.
          </li>
          <li>Open any Rightmove rental listing and the panel appears.</li>
        </ol>
      </section>

      <section className="setting">
        <h2>Updating it</h2>
        <p className="dim">
          Run the one-liner again — it goes back to the folder it used last time, so there is never
          a second copy for Chrome to keep reading. By hand: download the zip again and replace the
          contents of the same folder. Either way, hit <strong>Reload</strong> on{' '}
          <code>chrome://extensions</code> afterwards and check the card shows the new version.
        </p>
        <p className="dim">
          Your session and settings survive that, and they survive moving the folder too — the
          manifest pins the extension id.
        </p>
      </section>
    </div>
  );
}

/** The terminal route: one line that downloads the zip, unpacks it, and says what to do in Chrome.
 *
 *  It exists for the update rather than the first install. Unzipping into the folder Chrome is
 *  already loading is the step people get wrong — a second copy ends up somewhere new, Chrome keeps
 *  reading the old one, and the site goes on saying they are out of date after they have just
 *  updated. The script remembers the folder from the first run, so every run after that replaces
 *  the contents of the right one without asking.
 *
 *  The origin is passed as an argument rather than baked into the script, so the same line works on
 *  production, on a preview deployment and against localhost — whichever of them you are reading
 *  this on is the one it installs from, and the script refuses to guess if it is left off.
 *
 *  Rendered only after mount: `window` does not exist while this is prerendered, and the address is
 *  the one thing the line cannot be written without. */
function OneLiner() {
  const [origin, setOrigin] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => setOrigin(window.location.origin), []);

  // Both interpolations are quoted for the shell that will run them. An ordinary DNS origin needs
  // no quotes, and an IPv6 one — `http://[::1]:3100` — is a glob: bash expands the brackets against
  // the caller's working directory, and a matching filename there silently rewrites both the URL
  // curl fetches and the address the script is told to install from.
  const command = origin ? `curl -fsSL "${origin}/install.sh" | bash -s -- "${origin}"` : '';

  return (
    <section className="setting">
      <h2>Install it from the terminal</h2>
      <p className="dim">
        macOS and Linux. It asks where to keep the extension the first time — anywhere you will not
        move or delete, and <code>~/Applications/rightmove-house-hunt</code> is the default — then
        remembers, so later runs update that same folder in place.
      </p>
      <p className="install-command">
        <code>{command || '…'}</code>
        <button
          className="key"
          disabled={!command}
          onClick={() => {
            void navigator.clipboard.writeText(command).then(() => setCopied(true));
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </p>
      <p className="dim">
        It cannot reload Chrome for you — an unpacked extension is read off disk by the browser —
        so it finishes by telling you where to click and which version number you should see once
        you have.
      </p>
    </section>
  );
}

/** What this browser already has, once the handshake has answered.
 *
 *  Nothing while the question is outstanding, and nothing when the answer is "no extension here" —
 *  that is what the whole page is already for, and saying it twice is noise. */
function Installed({ state }: { state: ExtensionState | null }) {
  if (!state || state.status === 'absent') return null;

  if (state.status === 'broken') {
    return (
      <p className="notice notice-bad">
        An extension is installed here but did not answer — {state.message}. Reloading it on{' '}
        <code>chrome://extensions</code> usually fixes that; re-installing from the zip below always
        does.
      </p>
    );
  }

  const version = state.version;
  if (extensionBehind(version)) {
    return (
      <p className="notice notice-warn">
        Installed here{version ? ` (v${version})` : ''}, but this site ships v
        {EXPECTED_EXTENSION_VERSION}. Download the zip below and follow <strong>Updating it</strong>{' '}
        rather than the install steps — your session and settings survive it.
      </p>
    );
  }

  return (
    <p className="notice notice-good">
      Already installed in this browser (v{version}) and up to date. The steps below are for another
      laptop.
    </p>
  );
}
