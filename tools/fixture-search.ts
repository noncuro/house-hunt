/** Save one hub's search-results page, the way `pnpm fixture` saves a listing.
 *
 *  A search page is the one thing `pnpm fixture` cannot do, because its URL is not `/properties/
 *  <id>` — it is a query string built from a hub's verified location identifier, and building it
 *  by hand is how you end up with a fixture of the wrong neighbourhood. This uses the same
 *  `sweepSearchUrl` the panel puts in its links, so the saved page is exactly the page the sweep
 *  opens.
 *
 *  One page, one hub, when you ask for it. Not a crawl: this is the same act as opening the
 *  search in a browser and hitting save, and it exists so `check:sweep` and `smoke:search` can
 *  run against a real page without touching the network.
 *
 *    pnpm fixture:search "Hampstead"
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { SWEEP_HUBS } from '../src/lib/hubs';
import { sweepSearchUrl, WIDEST_WINDOW } from '../src/lib/sweep';

const wanted = process.argv[2];
if (!wanted) {
  console.error(`usage: pnpm fixture:search <hub>\n\nhubs: ${SWEEP_HUBS.map((h) => h.name).join(', ')}`);
  process.exit(1);
}

const hub = SWEEP_HUBS.find((h) => h.name.toLowerCase() === wanted.toLowerCase());
if (!hub) {
  console.error(`no hub called "${wanted}" — try one of: ${SWEEP_HUBS.map((h) => h.name).join(', ')}`);
  process.exit(1);
}

const url = sweepSearchUrl({ hub, days: WIDEST_WINDOW });
if (!url) {
  console.error(`${hub.name} has no verified Rightmove location identifier, so there is no search to save`);
  process.exit(1);
}

const response = await fetch(url, {
  headers: {
    'User-Agent':
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
  },
});
if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);

const directory = resolve(import.meta.dirname, '../.fixtures');
mkdirSync(directory, { recursive: true });
const file = resolve(directory, `search-${hub.name.toLowerCase().replace(/[^a-z]+/g, '-')}.html`);
writeFileSync(file, await response.text());

console.log(`saved ${file}`);
console.log(`  from ${url}`);
console.log(`\nnow: pnpm check:sweep ${file}`);
