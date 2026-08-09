/** Runs the extension's real extractor against saved listing HTML.
 *
 *  This is the check to run after a Rightmove deploy — unlike decode_page_model.py, which
 *  verifies the decode mechanic in isolation, this exercises the exact code the extension ships,
 *  so a break here is a break in the panel.
 *
 *    curl -sA "Mozilla/5.0 ... Chrome/126.0" https://www.rightmove.co.uk/properties/<id> -o /tmp/rm.html
 *    pnpm check:extractor /tmp/rm.html
 */
import { readFileSync } from 'node:fs';
import { decodePageModel } from '../src/lib/decode';
import { toListing } from '../src/lib/extract';

/** Pull the `window.__PAGE_MODEL = {...}` object out of the HTML by brace matching. */
function readPageModel(html: string): unknown {
  const marker = /window\.__PAGE_MODEL\s*=\s*\{/.exec(html);
  if (!marker) throw new Error('no window.__PAGE_MODEL in this HTML');

  const start = marker.index + marker[0].length - 1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < html.length; i++) {
    const c = html[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return JSON.parse(html.slice(start, i + 1));
  }
  throw new Error('unbalanced braces in __PAGE_MODEL');
}

const path = process.argv[2];
if (!path) throw new Error('usage: check-extractor <saved-listing.html>');

const listing = toListing(decodePageModel(readPageModel(readFileSync(path, 'utf8'))), `file://${path}`);

console.log(JSON.stringify(listing, null, 2));

const missing = [
  listing.postcode === null && 'postcode',
  listing.price === null && 'price',
  listing.nearestStations.length === 0 && 'nearestStations',
  listing.floorArea === null && 'floorArea',
  listing.floorplans.length === 0 && 'floorplans',
].filter((x): x is string => typeof x === 'string');

console.log(missing.length === 0 ? '\nAll fields present.' : `\nEmpty (may be genuine): ${missing.join(', ')}`);
