'use client';

import { setDisplayName } from '@house-hunt/core/db';
import { attempt } from '@/lib/attempt';
import { InlineName } from '@/components/InlineName';

/** Everything that used to live in the browser-action popup.
 *
 *  It moved here because the popup and this page were two front doors to one tool: you set who
 *  you are in one and looked at the results in the other, and the popup shut itself every time
 *  you clicked away from it. Clicking the extension now opens this page, and settings are a tab
 *  on it. */
export function Settings({
  person,
  setPerson,
  notify,
}: {
  person: string | null;
  setPerson: (person: string | null) => void;
  notify: (text: string, kind?: 'error' | 'info') => void;
}) {

  /** A display name, not an identity.
   *
   *  This field used to be who you were: there was no login, and the name typed here was written
   *  onto every verdict. Now the session says who you are and this only decides how that person is
   *  written down — on a verdict, in the members list, on an invite. Changing it renames you
   *  everywhere rather than making you somebody else, which is why it no longer says "on this
   *  laptop". */
  async function saveName(next: string) {
    const saved = await attempt(async () => {
      await setDisplayName(next);
      return true;
    }, notify);
    if (!saved) return;
    setPerson(next);
    notify(`You appear as ${next}.`, 'info');
  }

  return (
    <div className="settings">
      {/* The name, as a name — the same control the hunt's own name uses at the top of the page.
          It was a labelled field and a Save button under a paragraph explaining what a display name
          is, which is three lines of screen for a word most people set once. Where it shows up is
          worth one sentence; how to change it should not need any. */}
      <section className="setting">
        <h2>You</h2>
        <p className="dim">
          You appear as{' '}
          <InlineName
            className="inline-name"
            value={person ?? ''}
            label="yourself"
            onSave={(next) => void saveName(next)}
          />{' '}
          on your verdicts and in the members list, to everyone in the hunt.
        </p>
      </section>

      {/* Neighbourhoods used to sit here, and moved to Your Hunt. Which places this hunt searches
          is a property of the hunt — shared, and the same for everyone in it — where everything
          left on this page is one person's own: their display name, and the destinations they
          measure journeys to. Filing a shared setting under a personal heading is how it comes to
          be edited by whoever happened to find it. */}

      {/* The extension keeps a Diagnostics section here — a ring buffer in `chrome.storage` with a
          Copy log button — because a background worker's console is wiped every time Chrome idles it
          out, so there was nowhere else for it to go. A tab has devtools. `configureOnce` points
          core's log sink at the console and there is nothing to store or copy. */}
    </div>
  );
}
