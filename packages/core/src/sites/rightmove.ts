import { listingFromHtml, rightmoveListingId } from '../listing';
import { listingUrl } from '../sweep';
import type { Site } from './types';

/** Rightmove, as one of the sites — a wrapper, not a reimplementation.
 *
 *  Every method here delegates to the module that has always done this. The point of the wrapper is
 *  that the dispatcher can treat Rightmove like the rest, so there is one code path for "read the
 *  listing at this URL" rather than a special case that the other eight sites are bolted beside. */
export const rightmove: Site = {
  id: 'rightmove',
  name: 'Rightmove',
  hosts: ['rightmove.co.uk', 'www.rightmove.co.uk'],
  listingId: rightmoveListingId,
  // Validated before it is built, which `listingUrl` in `sweep.ts` does not do on its own — every
  // caller there hands it an id that came off a page. This one is reachable from `app/api/listing`
  // with whatever a caller sent, so the id is checked against the shape Rightmove's own ids have
  // before it goes into a URL the server will fetch.
  listingUrl: (id) => {
    if (!/^\d{5,12}$/.test(id)) throw new Error(`not a rightmove id: ${JSON.stringify(id)}`);
    return listingUrl(id);
  },
  extract: listingFromHtml,
};
