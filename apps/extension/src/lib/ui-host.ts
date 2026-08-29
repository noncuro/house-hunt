import type { UiHost } from '@house-hunt/ui';
import { listingUrl } from '@house-hunt/core';
import { send } from './messages';

/** What the shared components need, done the way an extension does it.
 *
 *  Both operations go through the background worker rather than being performed here, and for
 *  different reasons. A station walk is a database read, and the worker is the only context holding
 *  a Supabase client (design D2). Opening a tab is a `chrome.tabs` call, which a content script
 *  cannot make at all.
 *
 *  Only the panel consumes this host today, and it reads station walks — it never opens a listing.
 *  `openListing` is here because the shared `UiHost` requires it, and it is the honest extension
 *  implementation: the same `tab:open` message the website reaches over the bridge. The paced
 *  fill-in run that used to call it lives on the website now (design D5). */
export const extensionHost: UiHost = {
  async stationWalks(postcode, stations) {
    const reply = await send({ type: 'stations:walk', postcode, stations });
    // A failure here is not worth surfacing: the component renders the distance it already has and
    // simply lacks the walk. Throwing would take down a panel over a missing number.
    return reply.ok ? reply.data : {};
  },

  async openListing(rightmoveId) {
    const reply = await send({ type: 'tab:open', url: listingUrl(rightmoveId) });
    if (!reply.ok) throw new Error(reply.error);
  },
};
