'use client';

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
 *  file cannot be generated at deploy time — it is refreshed by hand with `pnpm package:web`
 *  whenever the extension changes. The steps are lifted from SETUP.md's "Installing it" so the page
 *  and the printed instructions cannot drift. */
export function Install({ email }: { email: string }) {
  return (
    <div className="settings">
      <section className="setting">
        <h2>Install the browser extension</h2>
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

      <section className="setting">
        <h2>Load it into Chrome</h2>
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
            Click <strong>Load unpacked</strong> and pick the unzipped folder.
          </li>
          <li>
            Click the extension icon. It opens the shortlist page and asks you to sign in — use{' '}
            <strong>{email}</strong>, the address you are signed in as here. A six-digit code
            arrives; type that in.
          </li>
          <li>Open any Rightmove rental listing and the panel appears.</li>
        </ol>
      </section>

      <section className="setting">
        <h2>Updating it</h2>
        <p className="dim">
          When a newer build is posted, download the zip again, replace the contents of the same
          folder, and hit <strong>Reload</strong> on <code>chrome://extensions</code>. Your session
          and settings survive that, and they survive moving the folder too — the manifest pins the
          extension id.
        </p>
      </section>
    </div>
  );
}
