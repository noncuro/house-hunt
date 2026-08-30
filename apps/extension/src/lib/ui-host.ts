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
    // Answering `{}` here said "no walk is known for any of these", which is a state the panel draws
    // every day and cannot be told apart from a lookup that fell over. Throwing does not take the
    // panel down — `Stations` keeps the distances and adds a line saying the times are missing —
    // so the failure is passed on rather than dressed as an empty answer.
    if (!reply.ok) throw new Error(reply.error);
    return reply.data;
  },

  async openListing(rightmoveId) {
    const reply = await send({ type: 'tab:open', url: listingUrl(rightmoveId) });
    if (!reply.ok) throw new Error(reply.error);
  },
};
