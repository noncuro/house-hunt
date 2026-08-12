/** Runs the extension's real extractor against saved listing HTML.
 *
 *  This is the check to run after a Rightmove deploy — unlike decode_page_model.py, which
 *  verifies the decode mechanic in isolation, this exercises the exact code the extension ships,
 *  so a break here is a break in the panel.
 *
 *    pnpm fixture 88023648
 *    pnpm check:extractor .fixtures/88023648.html
 */
import { listingFromHtml } from './read-listing';

const path = process.argv[2];
if (!path) throw new Error('usage: check-extractor <saved-listing.html>');

const listing = listingFromHtml(path);

console.log(JSON.stringify(listing, null, 2));

const missing = [
  listing.postcode === null && 'postcode',
  listing.price === null && 'price',
  listing.nearestStations.length === 0 && 'nearestStations',
  listing.floorArea === null && 'floorArea',
  listing.floorplans.length === 0 && 'floorplans',
].filter((x): x is string => typeof x === 'string');

console.log(missing.length === 0 ? '\nAll fields present.' : `\nEmpty (may be genuine): ${missing.join(', ')}`);
