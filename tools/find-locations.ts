/** Where the `rightmove` identifiers in `src/lib/hubs.ts` came from, and how to check them again.
 *
 *  A location identifier cannot be guessed and must not be. `STATION^4187` looks like nothing in
 *  particular, and the failure mode of getting one wrong is silent: the search returns a page of
 *  plausible London flats for somewhere else entirely, the sweep records them against the wrong
 *  hub, and nothing on screen looks wrong. So each one is read back out of Rightmove's own page.
 *
 *  The trick is that Rightmove resolves its own SEO paths server-side. Ask for
 *  `/property-to-rent/Belsize-Park-Station.html` and the page comes back with
 *  `__NEXT_DATA__.props.pageProps.searchResults.location` describing what it decided that meant:
 *  the `locationType` and `id` that together make the identifier, the `displayName` a human can
 *  sanity-check, and a polygon whose centroid should land on the coordinates `hubs.ts` already
 *  holds from a completely independent source. Two sources agreeing to a tenth of a mile is the
 *  actual verification; the identifier alone would just be a number someone wrote down.
 *
 *  This is a development-time tool, run once per hub and then not again until a hub changes.
 *  Nothing in the extension resolves a location at runtime. One page fetch per hub, spaced out,
 *  is the same act as opening each of them in a browser tab — it is not the search endpoint, and
 *  it is not a crawl.
 *
 *    pnpm find:locations                    # re-check all five
 *    pnpm find:locations Kentish-Town-Station Tufnell-Park-Station
 */
import { distanceMiles, SWEEP_HUBS } from '../packages/core/src/hubs';

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

/** Rightmove rate-limits nothing at this volume, but five requests in five seconds is still five
 *  requests. A pause between them costs us nothing and keeps the shape of this obviously manual. */
const PAUSE_MS = 3000;

const slugs =
  process.argv.length > 2
    ? process.argv.slice(2).map((slug) => slug.replace(/\.html$/, ''))
    : SWEEP_HUBS.flatMap((hub) =>
        hub.rightmove ? [hub.rightmove.displayLocationIdentifier.replace(/\.html$/, '')] : [],
      );

let mismatches = 0;

for (const [index, slug] of slugs.entries()) {
  if (index > 0) await new Promise((resolve) => setTimeout(resolve, PAUSE_MS));

  const url = `https://www.rightmove.co.uk/property-to-rent/${slug}.html`;
  const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!response.ok) {
    console.log(`${slug}: HTTP ${response.status} — no such search path`);
    mismatches++;
    continue;
  }

  const html = await response.text();
  const blob = /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/.exec(html);
  if (!blob) {
    console.log(`${slug}: no __NEXT_DATA__ — the page did not resolve to a search`);
    mismatches++;
    continue;
  }

  // oxlint-disable-next-line no-explicit-any -- someone else's JSON, read for two fields.
  const results = (JSON.parse(blob[1]!) as any).props?.pageProps?.searchResults;
  const location = results?.location;
  if (!location) {
    console.log(`${slug}: the page has no searchResults.location`);
    mismatches++;
    continue;
  }

  const identifier = `${location.locationType}^${location.id}`;
  const centre = location.geometry ? centroid(location.geometry.coordinates) : null;

  console.log(`${slug}`);
  console.log(`  identifier   ${identifier}`);
  console.log(`  displayName  ${location.displayName}`);
  console.log(`  canonical    ${results.seoModel?.canonicalUrl}`);
  console.log(`  centroid     ${centre ? `${centre.lat.toFixed(5)}, ${centre.lon.toFixed(5)}` : 'none'}`);
  console.log(`  results      ${results.resultCount}`);

  // If this slug is one we already hold, the run is a regression check rather than a discovery.
  const hub = SWEEP_HUBS.find(
    (h) => h.rightmove?.displayLocationIdentifier.replace(/\.html$/, '') === slug,
  );
  if (!hub?.rightmove) continue;

  if (hub.rightmove.locationIdentifier !== identifier) {
    mismatches++;
    console.log(`  MISMATCH     hubs.ts says ${hub.rightmove.locationIdentifier} for ${hub.name}`);
  } else if (centre) {
    // The polygon is drawn around the search centre, so its centroid and our coordinate are two
    // independent answers to "where is this". A quarter of a mile is generous for a station and
    // still far tighter than the gap to the next neighbourhood.
    const apart = distanceMiles(hub, centre);
    const verdict = apart <= 0.25 ? 'ok' : 'FAR';
    if (apart > 0.25) mismatches++;
    console.log(`  ${verdict}           ${apart.toFixed(2)} mi from ${hub.name} in hubs.ts`);
  }
}

if (mismatches > 0) {
  console.error(`\n${mismatches} identifier(s) did not check out — do not edit hubs.ts from a guess`);
  process.exit(1);
}
console.log('\nall ok');

/** Mean of the ring's vertices. The polygons are regular circles of ~100 points around the search
 *  centre, so the plain mean is the centre to well under the tolerance above; nothing here needs a
 *  proper area-weighted centroid. */
function centroid(coordinates: number[][][]): { lat: number; lon: number } {
  const ring = coordinates[0]!;
  let lat = 0;
  let lon = 0;
  for (const [x, y] of ring) {
    lon += x!;
    lat += y!;
  }
  return { lat: lat / ring.length, lon: lon / ring.length };
}
