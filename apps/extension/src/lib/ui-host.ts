import type { UiHost } from '@house-hunt/ui';
import { send } from './messages';

/** What the shared components need, done the way an extension does it.
 *
 *  Both operations go through the background worker rather than being performed here, and for
 *  different reasons. A station walk is a database read, and the worker is the only context holding
 *  a Supabase client (design D2). Opening a tab is a `chrome.tabs` call, which a content script
 *  cannot make at all — `window.open` is its only option and it steals focus, which is unbearable
 *  when the paced opener does it a dozen times over several minutes.
 *
 *  The website supplies its own pair: a direct database read, and a link. */
export const extensionHost: UiHost = {
  async stationWalks(postcode, stations) {
    const reply = await send({ type: 'stations:walk', postcode, stations });
    // A failure here is not worth surfacing: the component renders the distance it already has and
    // simply lacks the walk. Throwing would take down a panel over a missing number.
    return reply.ok ? reply.data : {};
  },

  async openListing(rightmoveId) {
    const reply = await send({
      type: 'tab:open',
      url: `https://www.rightmove.co.uk/properties/${rightmoveId}`,
    });
    // This one does throw. `Opener` stops a paced run on a rejection, which is the right response
    // to the tab mechanism being unavailable — see the comment where it catches.
    if (!reply.ok) throw new Error(reply.error);
  },
};
