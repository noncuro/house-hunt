/** Save one listing page from any site we read, for `pnpm check:sites` to decode.
 *
 *    pnpm fixture:site https://www.foxtons.co.uk/properties-to-rent/nw3/chpk3392427
 *
 *  Takes the URL rather than a site and an id, because that is what you have when you find a
 *  listing: the site is worked out by offering the URL to every adapter, which is the same
 *  dispatch `app/api/listing` uses, so a URL this refuses is one the app would refuse too.
 *
 *  It fetches the canonical URL the adapter rebuilds, not the one you pasted. Saving what a
 *  redirect or a tracking parameter served would make the fixture a page nobody's app would ever
 *  ask for.
 *
 *  These are gitignored on purpose — `docs/fixtures.md` says why: a committed fixture answers "do
 *  we still parse last month's page", green, while the live page drifts underneath it. No image is
 *  ever fetched or saved; the page is HTML and the photographs stay on the site's own CDN.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { siteForUrl, SITES } from '../packages/core/src/sites';
import { ListingWithdrawn } from '../packages/core/src/listing';

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

const argument = process.argv[2];
if (!argument) {
  console.error('usage: pnpm fixture:site <listing-url>');
  console.error(`       sites: ${SITES.map((s) => `${s.id} (${s.hosts[0]})`).join(', ')}`);
  process.exit(1);
}

const found = siteForUrl(argument);
if (!found) {
  console.error(`${argument} is not a listing address on any site in SITES.`);
  console.error(`sites: ${SITES.map((s) => `${s.id} (${s.hosts[0]})`).join(', ')}`);
  process.exit(1);
}

const url = found.site.listingUrl(found.externalId);
const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
const html = await response.text();

// Decoded before it is saved. A page that cannot be read is not a fixture — it is a check that will
// fail tomorrow with a message about the adapter, when the fault was this page all along.
try {
  const listing = found.site.extract(html, url);
  console.log(`read ${listing.displayAddress} — ${listing.price ?? 'no price'}, ${listing.imageUrls.length} photos`);
} catch (e) {
  if (e instanceof ListingWithdrawn) {
    throw new Error(`${url} reads as withdrawn — pick a live listing on ${found.site.name}`);
  }
  throw new Error(`${found.site.name} served a page ${found.site.id}.extract could not read: ${String(e)}`);
}

const directory = resolve(import.meta.dirname, '../.fixtures/sites');
mkdirSync(directory, { recursive: true });
const file = resolve(directory, `${found.site.id}.html`);
writeFileSync(file, html);

console.log(`\nsaved ${file}`);
console.log(`  from ${url}`);
console.log('\nnow: pnpm check:sites');
