import type { UiHost } from '@house-hunt/ui';
import { listingUrl } from '@house-hunt/core';
import { stationWalks } from '@house-hunt/core/db';
import { openTabExtension } from './bridge';

/** What the shared components need, done the way an ordinary web page does it.
 *
 *  A station walk is a database read, and this page holds a Supabase client of its own — so that one
 *  is a line here where the extension round-trips a worker.
 *
 *  `openListing` is the exception, and it inverts the usual split: opening a listing in a background
 *  tab is a `chrome.tabs.create` the website does not have, so this asks the extension to do it over
 *  the bridge. A paced run of `window.open` from a timer is throttled to the first tab, which is why
 *  the web no longer tries — the Sweep view only offers a fill-in run when the extension answered
 *  `hello`, so reaching here means it is present. A null or error therefore means it went away
 *  mid-run, and throwing is right: `Opener` stops the run rather than grinding on. */
export const webHost: UiHost = {
  stationWalks,

  async openListing(rightmoveId) {
    const reply = await openTabExtension(listingUrl(rightmoveId));
    if (!reply) {
      throw new Error(
        'the extension did not answer — a fill-in run opens each listing in a background tab, ' +
          'which only the extension can do',
      );
    }
    if (reply.kind === 'error') throw new Error(reply.message);
  },
};
