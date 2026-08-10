import type { UiHost } from '@house-hunt/ui';
import { stationWalks } from '@house-hunt/core/db';

/** What the shared components need, done the way an ordinary web page does it.
 *
 *  Both of these are one line here and a round trip through a background worker in the extension,
 *  which is the whole argument for the split. A station walk is a database read, and this page holds
 *  a Supabase client of its own; opening a listing is a link.
 *
 *  `openListing` deliberately does not use `window.open` from a timer. Browsers block popups that
 *  are not the direct result of a click, so a paced run that opened forty tabs would have the first
 *  one succeed and the rest silently swallowed. Opening in this tab and letting the run stop is the
 *  honest behaviour, and `Opener` already treats a rejection as "stop, do not grind on". */
export const webHost: UiHost = {
  stationWalks,

  async openListing(rightmoveId) {
    const url = `https://www.rightmove.co.uk/properties/${rightmoveId}`;
    const opened = window.open(url, '_blank', 'noopener');
    if (!opened) {
      throw new Error(
        'the browser blocked a new tab — allow popups for this site to open listings in a paced run',
      );
    }
  },
};
