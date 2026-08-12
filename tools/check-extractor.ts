/** Runs the extension's real extractor against saved listing HTML.
 *
 *  This is the check to run after a Rightmove deploy — unlike decode_page_model.py, which
 *  verifies the decode mechanic in isolation, this exercises the exact code the extension ships,
 *  so a break here is a break in the panel.
 *
 *    pnpm fixture 88023648
 *    pnpm check:extractor .fixtures/88023648.html
 */
import { ListingWithdrawn } from '../apps/extension/src/lib/extract';
import { listingFromHtml } from './read-listing';

const path = process.argv[2];
if (!path) throw new Error('usage: check-extractor <saved-listing.html>');

let listing;
try {
  listing = listingFromHtml(path);
} catch (e) {
  // A withdrawn listing is a page shape this extractor understands, so it is a result rather than a
  // crash — and saying so here is what stops it being read as "Rightmove changed the page", which
  // is the thing this check exists to detect and would then be reporting falsely.
  if (e instanceof ListingWithdrawn) {
    console.log('This listing has been withdrawn: the page model is present but emptied.');
    console.log('Not an extraction failure — Rightmove serves this for a listing the agent removed.');
    process.exit(0);
  }
  throw e;
}

console.log(JSON.stringify(listing, null, 2));

const missing = [
  listing.postcode === null && 'postcode',
  listing.price === null && 'price',
  listing.nearestStations.length === 0 && 'nearestStations',
  listing.floorArea === null && 'floorArea',
  listing.floorplans.length === 0 && 'floorplans',
].filter((x): x is string => typeof x === 'string');

console.log(missing.length === 0 ? '\nAll fields present.' : `\nEmpty (may be genuine): ${missing.join(', ')}`);
