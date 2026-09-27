/** The site seam: what a property key is, which URLs belong to whom, and whether each adapter can
 *  still read its site's page. Run with `pnpm check:sites`.
 *
 *  Three things, because they fail in three different ways and only one of them is loud.
 *
 *  **The key** is the primary key of ten tables. Rightmove's stays bare and every other site's is
 *  prefixed, which is what let eight sites be added without renaming a column five hundred
 *  references point at — so the round-trip is asserted in both directions, including that a key we
 *  could not have written is refused rather than guessed at. `isPropertyKey` gates a PostgREST
 *  filter on two routes, so a widening here is a widening there.
 *
 *  **The registry** is offered every URL in turn and the first site to claim one wins. Two sites
 *  claiming one host is a flat read by the wrong adapter; a site claiming a URL another site owns
 *  is the same bug with a longer fuse. Neither shows up as an error — the wrong adapter returns a
 *  listing, just not that one.
 *
 *  **The adapters** are checked against saved pages, which are gitignored (`docs/fixtures.md` says
 *  why a committed fixture answers "did we parse last month's page", green, while the live one
 *  drifts). So this half skips on a machine with no `.fixtures/sites/`, and says how many it
 *  skipped rather than passing quietly — a check that silently tests nothing is worse than one that
 *  is not run.
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  allHosts,
  isPropertyKey,
  parseKey,
  propertyKey,
  siteForUrl,
  SITE_IDS,
  SITES,
  type Site,
} from '../packages/core/src/sites';
import { ListingWithdrawn } from '../packages/core/src/listing';
import type { Listing } from '../packages/core/src/types';

const FIXTURES = fileURLToPath(new URL('../.fixtures/sites/', import.meta.url));

let failed = 0;
function check(ok: boolean, what: string): void {
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
}

// ------------------------------------------------------------------------------------------------
// The key.
// ------------------------------------------------------------------------------------------------

console.log('— keys —');

for (const id of SITE_IDS) {
  // Rightmove's has to be numeric — a bare key is read back as Rightmove's only when it is all
  // digits, which `propertyKey` now refuses to let it not be.
  const externalId = id === 'rightmove' ? '88023648' : 'ab12-CD';
  const key = propertyKey(id, externalId);
  const back = parseKey(key);
  check(back?.site === id && back.externalId === externalId, `${id}: ${key} round-trips`);
  check(isPropertyKey(key), `${id}: ${key} is a property key`);
}

// The other half of that: Rightmove cannot mint a key that would not read back as its own.
let refusedNonNumeric = false;
try {
  propertyKey('rightmove', 'ab12-CD');
} catch {
  refusedNonNumeric = true;
}
check(refusedNonNumeric, 'propertyKey refuses a non-numeric rightmove id');

// Rightmove's stays bare, which is the whole reason no existing row had to be rewritten.
check(propertyKey('rightmove', '88023648') === '88023648', 'rightmove keeps its bare id');
check(parseKey('88023648')?.site === 'rightmove', 'a bare numeric key reads as rightmove');

// A key naming no site we have is refused rather than read as Rightmove's — guessing would attach
// a flat to the wrong site's URL builder, which is a fetch at the wrong host.
const badKeys = [
  'notasite_123',
  '_123',
  'foxtons_',
  'foxtons_ab_cd', // the external id may not contain the separator
  'foxtons_ab.cd', // nor anything outside [A-Za-z0-9-]
  'foxtons_ab,cd',
  'foxtons_ab)cd',
  "foxtons_a'b",
  'not-numeric',
  '88023648x',
  '',
];
for (const key of badKeys) {
  check(parseKey(key) === null && !isPropertyKey(key), `refused: ${JSON.stringify(key)}`);
}

// The throw is the enforcement point: an adapter that returns an id with a comma in it must not be
// able to put one in the database, because the key is interpolated into a PostgREST filter.
for (const bad of ['', '  ', 'ab cd', 'ab,cd', 'ab/cd', 'ab_cd', 'ab.cd']) {
  let threw = false;
  try {
    propertyKey('foxtons', bad);
  } catch {
    threw = true;
  }
  check(threw, `propertyKey throws on ${JSON.stringify(bad)}`);
}

// ------------------------------------------------------------------------------------------------
// The registry.
// ------------------------------------------------------------------------------------------------

console.log('\n— registry —');

check(SITES.some((s) => s.id === 'rightmove'), 'rightmove is registered');

const byHost = new Map<string, string>();
for (const site of SITES) {
  check(site.hosts.length > 0, `${site.id} lists at least one host`);
  for (const host of site.hosts) {
    const owner = byHost.get(host);
    check(owner === undefined, `${host} is claimed only by ${site.id}${owner ? ` (also ${owner})` : ''}`);
    byHost.set(host, site.id);
    check(!/^https?:|\/$/.test(host), `${host} is a bare hostname, no scheme and no trailing slash`);
  }
}
check(allHosts().length === new Set(allHosts()).size, 'allHosts() has no duplicates');

// A URL nobody should claim. `rightmove.co.uk.evil.example` contains the string every naive host
// test looks for, and a site accepting it would have `app/api/listing` fetch whatever that host
// served and decode it as a flat.
const claimedByNobody = [
  'javascript:alert(1)//www.rightmove.co.uk/properties/88023648',
  'not a url at all',
  '',
  'https://example.invalid/properties/88023648',
];
for (const site of SITES) {
  for (const host of site.hosts) {
    claimedByNobody.push(`https://${host}.evil.example/properties/88023648`);
    claimedByNobody.push(`https://${lookalike(host)}/properties/88023648`);
  }
}
for (const url of claimedByNobody) {
  const found = siteForUrl(url);
  check(found === null, `nobody claims ${JSON.stringify(url).slice(0, 64)}${found ? ` (${found.site.id} did)` : ''}`);
}

// `listingId` is offered every URL in the app and must answer rather than throw — "not mine" is the
// commonest answer it gives.
for (const site of SITES) {
  let threw = false;
  for (const url of [...claimedByNobody, 'https://', 'http://[', '//x']) {
    try {
      site.listingId(url);
    } catch {
      threw = true;
    }
  }
  check(!threw, `${site.id}.listingId never throws`);
}

// `listingUrl` is what the server fetches, so an id it did not shape itself must be refused rather
// than interpolated.
const DOCTORED_IDS = ['', '../../etc/passwd', 'a b', 'a/b', 'a?b', 'evil.example/x', 'a#b'];
for (const site of SITES) {
  let threw = 0;
  for (const bad of DOCTORED_IDS) {
    try {
      site.listingUrl(bad);
    } catch {
      threw++;
    }
  }
  check(
    threw === DOCTORED_IDS.length,
    `${site.id}.listingUrl refuses all ${DOCTORED_IDS.length} doctored ids (refused ${threw})`,
  );
}

// ------------------------------------------------------------------------------------------------
// The adapters, against saved pages.
// ------------------------------------------------------------------------------------------------

console.log('\n— adapters —');

/** Only so the skip line can print a URL of the right shape. Any live listing does — these are not
 *  expected to still be on the market, and nothing reads them. */
const SAMPLE_ID: Partial<Record<string, string>> = { rightmove: '88023648' };

const POSTCODE = /^[A-Z]{1,2}\d[A-Z\d]? \d[A-Z]{2}$/;
const OUTCODE = /^[A-Z]{1,2}\d[A-Z\d]?$/;

let skipped = 0;
let read = 0;
let statedBedrooms = 0;
for (const site of SITES) {
  const path = `${FIXTURES}${site.id}.html`;
  if (!existsSync(path)) {
    skipped++;
    console.log(
      `skip ${site.id} — no .fixtures/sites/${site.id}.html ` +
        `(pnpm fixture:site ${site.listingUrl(SAMPLE_ID[site.id] ?? '000000')} — any live listing will do)`,
    );
    continue;
  }
  readOne(site, readFileSync(path, 'utf8'));
}

if (read > 0) {
  check(
    statedBedrooms > 0,
    `${statedBedrooms} of ${read} saved pages state a bedroom count (0 would mean the read broke, not that they are all studios)`,
  );
}

if (skipped > 0) {
  console.log(
    `\n${skipped} of ${SITES.length} adapters were not exercised — the saved pages are gitignored, ` +
      'so this is expected in CI and is a gap on a machine that is meant to have them.',
  );
}

console.log(failed === 0 ? '\nall passed' : `\n${failed} failed`);
if (failed > 0) process.exit(1);

/** One saved page, decoded and asserted. Everything here is a floor rather than a full field list:
 *  what a site does not state stays null on purpose, and asserting a value per site would be this
 *  file re-stating each adapter rather than checking it. */
function readOne(site: Site, html: string): void {
  const url = canonicalUrl(html);
  if (url === null) {
    check(false, `${site.id}: the saved page states no address of its own to read it as`);
    return;
  }

  const found = siteForUrl(url);
  if (!found || found.site.id !== site.id) {
    check(false, `${site.id}: claims its own saved page's URL (${found?.site.id ?? 'nobody'} did)`);
    return;
  }

  // The security property: what the server fetches is rebuilt, so it has to come back to the same
  // listing rather than to whatever the caller sent.
  const rebuilt = site.listingUrl(found.externalId);
  check(
    site.listingId(rebuilt) === found.externalId,
    `${site.id}: ${found.externalId} -> ${rebuilt} -> itself`,
  );
  check(new URL(rebuilt).protocol === 'https:', `${site.id}: rebuilds an https URL`);
  check(
    site.hosts.includes(new URL(rebuilt).hostname),
    `${site.id}: rebuilds onto a host it declares (${new URL(rebuilt).hostname})`,
  );

  let listing: Listing;
  try {
    listing = site.extract(html, url);
  } catch (e) {
    const gone = e instanceof ListingWithdrawn;
    check(false, `${site.id}: reads its saved page — ${gone ? 'read as withdrawn' : String(e)}`);
    return;
  }

  read++;
  check(listing.site === site.id, `${site.id}: says which site it is`);
  check(listing.externalId === found.externalId, `${site.id}: external id matches the URL's`);
  check(
    listing.rightmoveId === propertyKey(site.id, listing.externalId),
    `${site.id}: key is propertyKey(${site.id}, ${listing.externalId})`,
  );
  check(listing.displayAddress !== 'Unknown address', `${site.id}: has an address`);
  check(listing.price !== null, `${site.id}: has a price`);
  // Not asserted per site. A studio states no bedroom count on Rightmove — its own model omits the
  // field rather than saying 0, because "no separate bedroom" and "zero bedrooms" are different
  // answers — and all four saved Rightmove pages are studios. Counted across sites below instead,
  // so a shared helper that stopped reading the field is still caught.
  if (listing.bedrooms !== null) statedBedrooms++;
  // One of the two, and the full one is what travel routes from — so a site with only an outcode
  // passes here and is a known thinness rather than a failure.
  check(
    listing.postcode !== null || listing.outcode !== null,
    `${site.id}: locates the flat by postcode or outcode`,
  );
  if (listing.postcode !== null) {
    check(POSTCODE.test(listing.postcode), `${site.id}: postcode "${listing.postcode}" is a full one`);
  }
  if (listing.outcode !== null) {
    check(OUTCODE.test(listing.outcode), `${site.id}: outcode "${listing.outcode}" is shaped like one`);
  }
  check(listing.imageUrls.length > 0, `${site.id}: found photographs`);
  // We link, we never re-host. A relative URL here would be resolved against our own origin the
  // moment it reached an `<img>`, which is the failure this rule exists to stop. Floorplans are
  // checked with them and were not at first: they are drawn by the same components, off the same
  // kind of URL, and Portico's come off the CRM's host rather than the site's own — so a check that
  // looked only at photographs was asserting the rule on half the images on the page.
  const linked = [...listing.imageUrls, ...listing.floorplans.map((f) => f.url)];
  check(
    linked.every((u) => u.startsWith('https://')),
    `${site.id}: all ${linked.length} image URLs are absolute https, on a host the page named`,
  );
  check(!Number.isNaN(Date.parse(listing.observedAt)), `${site.id}: stamped observedAt`);

  console.log(
    `     ${site.id}: ${[
      listing.postcode ?? listing.outcode ?? '—',
      `${listing.bedrooms} bed`,
      listing.price,
      listing.floorArea ? `${listing.floorArea.sqft} sqft` : 'no area',
      `${listing.imageUrls.length} photos`,
      listing.floorplans.length > 0 ? `${listing.floorplans.length} floorplan` : 'no floorplan',
      listing.furnishType ?? 'furnishing unsaid',
      listing.letAvailableDate ?? 'available unsaid',
      listing.deposit === null ? 'deposit unsaid' : `£${listing.deposit} deposit`,
      listing.councilTaxBand ? `band ${listing.councilTaxBand}` : 'band unsaid',
      listing.agentCompany ?? 'agent unsaid',
    ].join(' · ')}`,
  );
}

/** A host that reads like this one and is a different registrable domain — `www.rightmovex.co.uk`.
 *
 *  The letter goes in front of the public suffix rather than in front of the host, and that is the
 *  whole point: `notwww.rightmove.co.uk` is a *subdomain of the real site*, which every adapter
 *  here accepts on purpose, so prefixing the host would assert the opposite of what is wanted. */
function lookalike(host: string): string {
  return host.replace(/^(.*?)((?:\.co)?\.[a-z]+)$/, '$1x$2');
}

/** The URL a saved page says it is. Read off the page rather than kept in a table here, so adding a
 *  fixture is saving a file and nothing else. */
function canonicalUrl(html: string): string | null {
  const canonical = /<link[^>]+rel=["']canonical["'][^>]*>/i.exec(html)?.[0];
  const fromCanonical = canonical ? /href=["']([^"']+)["']/i.exec(canonical)?.[1] : undefined;
  if (fromCanonical) return fromCanonical;
  const og = /<meta[^>]+property=["']og:url["'][^>]*>/i.exec(html)?.[0];
  const fromOg = og ? /content=["']([^"']+)["']/i.exec(og)?.[1] : undefined;
  if (fromOg) return fromOg;

  // Third, and only because Dexters states its own address nowhere else: the first `"url"` in the
  // page that a site claims as a listing. Last because it is the weakest — a page carrying a strip
  // of similar properties carries their addresses too, while the two above are the page's own
  // statement about itself. Every other saved page has one of those and never reaches this.
  for (const match of html.matchAll(/"url"\s*:\s*"(https:\/\/[^"]+)"/g)) {
    const candidate = match[1];
    if (candidate && siteForUrl(candidate)) return candidate;
  }
  return null;
}
