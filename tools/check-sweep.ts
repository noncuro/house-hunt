/** Cases for the sweep: how far back a search has to look, the URL it looks with, and reading a
 *  saved search page.
 *
 *  The window calculation is the reason this file exists. Every other mistake in the sweep is
 *  visible — a broken panel looks broken, a wrong URL lands on a page of flats in the wrong
 *  place and you notice. A window one bucket too narrow produces a search that returns fewer
 *  listings, a panel that says everything is recorded, and no error anywhere. It is only
 *  catchable here, so the boundaries are pinned to the day rather than assumed.
 *
 *    pnpm check:sweep [path/to/saved-search.html]
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { SEED_HUBS, toSweepHub } from '../packages/core/src/hubs';
import type { Place } from '../packages/core/src/types';
import { readSearchPage, staleAgainst, type SearchPage } from '../apps/extension/src/lib/search-page';
import {
  RENTAL_SEARCH,
  RESULTS_PER_PAGE,
  SWEEP_MARGIN_HOURS,
  describeCriteria,
  nextPageUrl,
  rightmoveSearchStart,
  sweepProgress,
  sweepSearchUrl,
  sweepWindow,
  searchLocationFor,
  WIDEST_WINDOW,
} from '../packages/core/src/sweep';

let failures = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) return console.log(`  ok   ${name}`);
  failures++;
  console.log(`  FAIL ${name}\n       expected ${e}\n       got      ${a}`);
}

const NOW = new Date('2026-08-09T12:00:00Z');
/** `hours` ago, as an ISO string. */
const ago = (hours: number) => new Date(NOW.getTime() - hours * 3600_000).toISOString();
const windowAfter = (hours: number) => sweepWindow(ago(hours), NOW).days;

console.log('sweepWindow — snapping');
check('never swept asks for the widest window', sweepWindow(null, NOW).days, WIDEST_WINDOW);
check('and says so rather than reporting an elapsed time', sweepWindow(null, NOW).elapsedDays, null);
check('an unparseable timestamp is treated as never, not as recent', sweepWindow('not a date', NOW).days, 14);
check('swept an hour ago needs one day', windowAfter(1), 1);
// The margin is the whole point of these two. Eleven hours plus twelve is under a day; thirteen
// plus twelve is over it, and the snap has to go UP to the next bucket rather than round.
check(`${SWEEP_MARGIN_HOURS}h of margin keeps 11h inside one day`, windowAfter(11), 1);
check('but pushes 13h into the three-day bucket', windowAfter(13), 3);
check('two days ago needs three', windowAfter(48), 3);
// 2.5 days + 0.5 margin = exactly 3.0. An inclusive comparison keeps this at 3; an exclusive one
// would jump to 7, which is the off-by-one this test exists to pin.
check('exactly three days including margin stays at three', windowAfter(60), 3);
check('a minute past three days needs seven', windowAfter(60.02), 7);
check('six days needs seven', windowAfter(144), 7);
check('exactly seven days including margin stays at seven', windowAfter(156), 7);
check('eight days needs fourteen', windowAfter(192), 14);
check('thirteen days still fits in fourteen', windowAfter(312), 14);

console.log('sweepWindow — the gap it cannot cover');
check('a fortnight-old sweep is still covered', sweepWindow(ago(324), NOW).covered, true);
// 14 days minus the margin is where cover runs out: past this, the widest filter Rightmove
// offers no longer reaches back to the last sweep and the panel has to say so out loud.
check('a month-old sweep is not', sweepWindow(ago(720), NOW).covered, false);
check('and still asks for the widest window it can', sweepWindow(ago(720), NOW).days, 14);
check('a never-swept hub is not reported as a gap', sweepWindow(null, NOW).covered, true);

console.log('sweepWindow — clocks');
// Both laptops write this column, and they do not agree to the second.
check('a sweep timestamped in the future does not go negative', sweepWindow(ago(-5), NOW).days, 1);
check('and reports no elapsed time below zero', sweepWindow(ago(-5), NOW).elapsedDays, 0);

console.log('searchLocationFor');
check('a station', searchLocationFor('Hampstead-Station.html'), 'Hampstead Station');
check('two words', searchLocationFor('Belsize-Park-Station.html'), 'Belsize Park Station');
check('a region, which has no "Station" to lose', searchLocationFor('Primrose-Hill.html'), 'Primrose Hill');

console.log('sweepSearchUrl');
/** A hunt's filters, for the checks only — the same standing as `SEED_HUBS` itself, and for the
 *  same reason it is written down here rather than in core: a price band that ships in the source
 *  is one project's budget applied to every project. `sweepSearchUrl` now refuses without one, and
 *  these are the cases that prove it. */
const CRITERIA = {
  minPrice: '4000',
  maxPrice: '6000',
  minBedrooms: '1',
  maxBedrooms: '3',
  radius: '1.0',
  _includeLetAgreed: 'on',
};
const hampstead = SEED_HUBS.find((h) => h.name === 'Hampstead')!;
const url = new URL(sweepSearchUrl({ hub: hampstead, days: 14, criteria: CRITERIA })!);
check('points at the search page', url.origin + url.pathname, 'https://www.rightmove.co.uk/property-to-rent/find.html');
check('carries the verified identifier', url.searchParams.get('locationIdentifier'), 'STATION^4187');
check('and tells Rightmove to use it', url.searchParams.get('useLocationIdentifier'), 'true');
check('the display identifier', url.searchParams.get('displayLocationIdentifier'), 'Hampstead-Station.html');
check('the window', url.searchParams.get('maxDaysSinceAdded'), '14');
check('newest first, so a sweep can stop early', url.searchParams.get('sortType'), '6');
check('the rent channel', url.searchParams.get('channel'), 'RENT');
check('the price floor', url.searchParams.get('minPrice'), '4000');
check('the price ceiling', url.searchParams.get('maxPrice'), '6000');
check('page one starts at index zero', url.searchParams.get('index'), '0');
check(
  'page three starts a page-size in from page two',
  new URL(sweepSearchUrl({ hub: hampstead, days: 7, page: 3, criteria: CRITERIA })!).searchParams.get('index'),
  String(RESULTS_PER_PAGE * 2),
);

const primrose = SEED_HUBS.find((h) => h.name === 'Primrose Hill')!;
check(
  'Primrose Hill is a region, and the URL says so',
  new URL(sweepSearchUrl({ hub: primrose, days: 14, criteria: CRITERIA })!).searchParams.get('locationIdentifier'),
  'REGION^87390',
);
check(
  'a hub with no verified identifier gets no URL at all',
  // A radius, so the missing identifier is the only thing that can be refusing.
  sweepSearchUrl({ hub: { name: 'Nowhere', rightmove: null, radiusMiles: 1 }, days: 14, criteria: CRITERIA }),
  null,
);

// The change this refusal exists for: there is no built-in price band any more, so a hunt that has
// chosen nothing gets no link rather than somebody else's budget. Both empty shapes count, since a
// stored `{}` and an absent row mean the same thing to whoever set neither.
check(
  'no criteria at all, no URL',
  sweepSearchUrl({ hub: hampstead, days: 14, criteria: null }),
  null,
);
check(
  'and an empty set is the same answer',
  sweepSearchUrl({ hub: hampstead, days: 14, criteria: {} }),
  null,
);
// Whatever the hunt saved wins over nothing, but never over the parameters a sweep owns: a pasted
// URL carrying its own location must not pin every neighbourhood to that one.
check(
  'a location in the saved criteria cannot override the hub',
  new URL(sweepSearchUrl({
    hub: hampstead,
    days: 14,
    criteria: { ...CRITERIA, locationIdentifier: 'STATION^9999', sortType: '1' },
  })!).searchParams.get('locationIdentifier'),
  'STATION^4187',
);
check(
  'and neither can it change the sort that makes a sweep terminate',
  new URL(sweepSearchUrl({
    hub: hampstead,
    days: 14,
    criteria: { ...CRITERIA, sortType: '1' },
  })!).searchParams.get('sortType'),
  '6',
);
// Filters this app has never heard of ride along untouched — the whole point of storing the query
// rather than modelling each one.
check(
  'a filter we do not model is passed straight through',
  new URL(sweepSearchUrl({
    hub: hampstead,
    days: 14,
    criteria: { ...CRITERIA, mustHave: 'garden,parking' },
  })!).searchParams.get('mustHave'),
  'garden,parking',
);

console.log('every sweep hub is usable');
for (const hub of SEED_HUBS) {
  // A null here is legitimate in the type and must be legitimate on screen too, but if one of
  // the five we verified goes null it is a regression, not a design decision.
  check(`${hub.name} has a search URL`, sweepSearchUrl({ hub, days: 14, criteria: CRITERIA }) !== null, true);
}

console.log('the seeded rows resolve to the same searches as the old constant');
// The regression that matters in the move from constants to `project_hub`. Five neighbourhoods
// stopped being compiled in and started being rows, and the way that goes wrong is silent: a
// transposed digit in a location identifier or a coordinate returns a page full of plausible flats
// in the wrong place and reports nothing new. So the migration's own INSERT is parsed and compared
// against `SEED_HUBS`, character for character on the URL.
//
// Read out of the SQL rather than copied into this file on purpose: a copy would agree with itself
// forever. If the migration is renamed or reshaped this fails loudly, which is correct — it is
// asserting a fact about what is actually in the database.
const MIGRATION = resolve(import.meta.dirname, '../supabase/migrations/20260809310000_multi_tenant.sql');
const seededRows = readSeededHubs(MIGRATION);

check('the migration seeds five neighbourhoods', seededRows.length, 5);
for (const seeded of seededRows) {
  const constant = SEED_HUBS.find((h) => h.name === seeded.label);
  if (!constant) {
    failures++;
    console.log(`  FAIL the migration seeds "${seeded.label}", which SEED_HUBS does not have`);
    continue;
  }
  // Coordinates first: these came from TfL's StopPoint API and were reverse-geocoded to confirm the
  // ward, and re-deriving one would rotate every bearing computed from it.
  check(`${seeded.label} keeps its exact coordinates`, [seeded.lat, seeded.lon], [constant.lat, constant.lon]);
  check(
    `${seeded.label} builds the identical search URL from the database`,
    sweepSearchUrl({ hub: toSweepHub(seeded), days: 14, criteria: CRITERIA }),
    sweepSearchUrl({ hub: constant, days: 14, criteria: CRITERIA }),
  );
}

console.log('toSweepHub');
// Half an identifier is not a verified one. A `locationIdentifier` with no SEO path would build a
// URL missing the parameter Rightmove echoes into its own search box.
check(
  'a row with both halves is searchable',
  toSweepHub(hubRow({ locationIdentifier: 'STATION^4187', displayLocationIdentifier: 'Hampstead-Station.html' }))
    .rightmove?.locationIdentifier,
  'STATION^4187',
);
check('a row with neither is not', toSweepHub(hubRow({})).rightmove, null);
check(
  'and a row with only half of one is not either',
  toSweepHub(hubRow({ locationIdentifier: 'STATION^4187' })).rightmove,
  null,
);
// The coordinate-less rows the migration keeps for dropped hubs. They carry sweep history and
// nothing else, and they must not produce a search.
check(
  'a place kept only for its history has no search',
  sweepSearchUrl({ hub: toSweepHub(hubRow({ label: "King's Cross" })), days: 14, criteria: CRITERIA }),
  null,
);
// A place with an identifier but no radius is not a sweep centre — nobody has said how far to look,
// and picking a distance is the same class of invention as picking a price band.
check(
  'an identifier without a radius is not searchable',
  sweepSearchUrl({
    hub: toSweepHub(
      hubRow({
        locationIdentifier: 'STATION^4187',
        displayLocationIdentifier: 'Hampstead-Station.html',
        sweepRadiusMiles: null,
      }),
    ),
    days: 14,
    criteria: CRITERIA,
  }),
  null,
);
// The place's radius wins over one carried in on a pasted URL: one radius for every place is what
// having a radius per place exists to prevent.
check(
  "the place's own radius, not the pasted one",
  new URL(
    sweepSearchUrl({
      hub: toSweepHub(
        hubRow({
          locationIdentifier: 'STATION^4187',
          displayLocationIdentifier: 'Hampstead-Station.html',
          sweepRadiusMiles: 0.5,
        }),
      ),
      days: 14,
      criteria: CRITERIA,
    })!,
  ).searchParams.get('radius'),
  '0.5',
);

console.log('sweepWindow — a hub\'s own floor');
// `project_hub.max_days_since_added` is a floor and never a ceiling. A per-hub setting that could
// narrow the window would be a switch for the one failure here that looks exactly like success.
check('a floor widens a window the elapsed time would have narrowed', sweepWindow(ago(1), NOW, 7).days, 7);
check('and snaps up to a real bucket rather than passing 5 through', sweepWindow(ago(1), NOW, 5).days, 7);
check('a floor never narrows one', sweepWindow(ago(192), NOW, 1).days, 14);
check('nor one widened by never having been swept', sweepWindow(null, NOW, 1).days, WIDEST_WINDOW);
check('no floor changes nothing', sweepWindow(ago(1), NOW, null).days, 1);
check('a floor past the widest window still gets the widest', sweepWindow(ago(1), NOW, 30).days, WIDEST_WINDOW);
// `covered` answers "does this search reach back to the last sweep", which a floor cannot change.
// Reporting covered because a floor pushed the number up would be the same lie somewhere else.
check('a floor does not make an uncoverable gap look covered', sweepWindow(ago(720), NOW, 14).covered, false);
check('and the elapsed time is still the elapsed time', Math.round(sweepWindow(ago(48), NOW, 14).elapsedDays!), 2);

console.log('readSearchPage');
const fixture = process.argv[2] ?? resolve(import.meta.dirname, '../.fixtures/search-hampstead.html');
if (!existsSync(fixture)) {
  console.log(`  skip  no saved search page at ${fixture} — save one and re-run to cover the reader`);
} else {
  const html = readFileSync(fixture, 'utf8');
  const result = readSearchPage(asDocument(html));
  if (!result.ok) {
    failures++;
    console.log(`  FAIL reading ${fixture}\n       ${result.error}`);
  } else {
    const page = result.page;
    check('resolves the area the page searched', page.locationIdentifier, 'STATION^4187');
    check('reads the window the page was served with', page.maxDaysSinceAdded, 14);
    check('finds cards', page.cards.length > 0, true);
    check('a card has an id', /^\d+$/.test(page.cards[0]!.rightmoveId), true);
    check(
      'and a canonical URL without the channel fragment',
      page.cards[0]!.url,
      `https://www.rightmove.co.uk/properties/${page.cards[0]!.rightmoveId}`,
    );
    check('every card has an address', page.cards.every((c) => c.displayAddress.length > 0), true);
    check('every card has a price', page.cards.every((c) => c.price !== null), true);
    check('every card has coordinates', page.cards.every((c) => c.latitude !== null), true);
    check('every card has a first-seen date', page.cards.every((c) => c.firstVisibleAt !== null), true);
    check('every card has an update date', page.cards.every((c) => c.listingUpdateAt !== null), true);

    // What the window actually filters on, pinned because it is not what the parameter is called.
    // On this saved page one card was first visible 27 days before the search and came back
    // anyway, because its price had been cut 5 days earlier. Asserting against `firstVisibleAt`
    // here would fail, and asserting nothing would have let the misreading through.
    const oldestBy = (pick: (c: SearchPage['cards'][number]) => string | null) =>
      page.cards.map((c) => (Date.now() - new Date(pick(c)!).getTime()) / 86_400_000).reduce((a, b) => Math.max(a, b), 0);
    check(
      `nothing has changed longer ago than the ${page.maxDaysSinceAdded}-day window`,
      oldestBy((c) => c.listingUpdateAt) <= page.maxDaysSinceAdded! + 1,
      true,
    );
    check(
      'but something was first listed well before it — maxDaysSinceAdded is "added or changed"',
      oldestBy((c) => c.firstVisibleAt) > page.maxDaysSinceAdded! + 1,
      true,
    );
    check('ids are unique', new Set(page.cards.map((c) => c.rightmoveId)).size, page.cards.length);
    check('knows which page it is', page.page >= 1, true);
    check('and how many there are', page.totalPages >= page.page, true);

    console.log('staleAgainst');
    const ids = page.cards.map((c) => c.rightmoveId);
    check('a page describing itself is not stale', staleAgainst(page, ids), []);
    check('an id the blob never saw is', staleAgainst(page, [...ids, '999999']), ['999999']);
    check('a page that lost a card is not stale — only extras matter', staleAgainst(page, ids.slice(1)), []);

    console.log(`\n  ${page.cards.length} cards, ${page.resultCount} results over ${page.totalPages} pages`);
    describe(page);
  }
}


/** A `place` row, with only the fields a case cares about spelled out. A radius by default,
 *  because these cases are about the identifier: a row missing both would be refused for the wrong
 *  reason and the check would pass without testing anything. */
function hubRow(over: Partial<Place>): Place {
  return {
    id: 'id',
    label: 'Somewhere',
    postcode: null,
    lat: null,
    lon: null,
    locationIdentifier: null,
    displayLocationIdentifier: null,
    sweepRadiusMiles: 1,
    maxDaysSinceAdded: null,
    ...over,
  };
}

/** The five rows `20260809310000_multi_tenant.sql` seeds, read out of the SQL itself.
 *
 *  Parsing a migration is not something to make a habit of, and it earns it here: the claim under
 *  test is "what the database holds resolves to the same search as the constant did", and a copy of
 *  the values in this file would only ever prove that a copy agrees with itself. Strict on purpose
 *  — a shape it does not recognise is a failure with a sentence, never zero rows quietly passing. */
function readSeededHubs(path: string): Place[] {
  const sql = readFileSync(path, 'utf8');
  const block =
    /insert into project_hub \(project_id, name, lat, lon, rightmove_location_id, display_location_id, sort_order\)\s*values\s*([\s\S]*?)on conflict/.exec(
      sql,
    );
  if (!block) {
    failures++;
    console.log(`  FAIL could not find the project_hub seed in ${path} — has the migration been reshaped?`);
    return [];
  }
  const rows: Place[] = [];
  for (const line of block[1]!.split('\n')) {
    if (!line.trim().startsWith('(')) continue;
    const m = /\('([^']+)',\s*'([^']+)',\s*(-?[\d.]+),\s*(-?[\d.]+),\s*'([^']+)',\s*'([^']+)',\s*(\d+)\)/.exec(line);
    if (!m) {
      failures++;
      console.log(`  FAIL could not read a seeded hub from: ${line.trim()}`);
      continue;
    }
    rows.push(
      hubRow({
        id: m[1]!,
        label: m[2]!,
        lat: Number(m[3]),
        lon: Number(m[4]),
        locationIdentifier: m[5]!,
        displayLocationIdentifier: m[6]!,
      }),
    );
  }
  return rows;
}

function describe(page: SearchPage): void {
  for (const card of page.cards.slice(0, 3)) {
    console.log(`  ${card.rightmoveId}  ${card.price}  ${card.bedrooms}b  ${card.addedOrReduced}  ${card.displayAddress}`);
  }
}

console.log('readSearchPage — a flat listed twice on one page');
// Rightmove puts a featured property in its own strip *and* again in the results below, so the
// same id arrives twice from one page. Postgres refuses an upsert whose batch touches a row twice
// ("ON CONFLICT DO UPDATE command cannot affect row a second time"), which failed the entire
// page's recording rather than the duplicate — and before that, made the panel count 25 listings
// on a page showing 24 flats. Synthetic rather than from a fixture, because whether a saved page
// happens to contain a duplicate is luck, and the check has to hold either way.
const twice = readSearchPage(
  asDocument(
    `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
      props: {
        pageProps: {
          searchResults: {
            location: { locationType: 'STATION', id: '4187', displayName: 'Hampstead Station' },
            resultCount: 2,
            pagination: { page: 1, total: 1 },
            searchParameters: { maxDaysSinceAdded: '14' },
            properties: [
              { id: 111, displayAddress: 'Featured Road', price: { displayPrices: [{ displayPrice: '£1 pcm' }] } },
              { id: 222, displayAddress: 'Ordinary Road', price: { displayPrices: [{ displayPrice: '£2 pcm' }] } },
              { id: 111, displayAddress: 'Featured Road', price: { displayPrices: [{ displayPrice: '£1 pcm' }] } },
            ],
          },
        },
      },
    })}</script>`,
  ),
);
if (!twice.ok) {
  failures++;
  console.log(`  FAIL the synthetic page did not parse\n       ${twice.error}`);
} else {
  check('a repeated listing is recorded once', twice.page.cards.length, 2);
  check(
    'and the page order is kept',
    twice.page.cards.map((c) => c.rightmoveId),
    ['111', '222'],
  );
}

/** `readSearchPage` takes a Document because that is what it gets in the browser. Node has no DOM
 *  and this project has no jsdom, so the one method it uses is stubbed. That is a smaller lie than
 *  it looks: the function's whole job is to find one script element and parse its text, and if it
 *  ever needs more of the DOM than this, this stub failing to compile is the right way to find out. */
function asDocument(html: string): Document {
  const match = /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/.exec(html);
  return {
    getElementById: (id: string) => (id === '__NEXT_DATA__' && match ? { textContent: match[1] } : null),
  } as unknown as Document;
}

console.log('sweepProgress');
// This decides whether the NEXT search narrows its window, and narrowing early is the one failure
// in the sweep that looks exactly like success: the pages nobody opened simply never come back.
// It replaced a "Mark swept" button, so every guard the button gave by being disabled has to be
// re-earned here.
check('one page, and that is the whole sweep', sweepProgress(null, 1, 1), { pagesSeen: [1], complete: true });
check(
  'page 1 of 3 is a start, not a sweep',
  sweepProgress(null, 1, 3),
  { pagesSeen: [1], complete: false },
);
check(
  'and page 2 carries on from it',
  sweepProgress({ pagesTotal: 3, pagesSeen: [1] }, 2, 3),
  { pagesSeen: [1, 2], complete: false },
);
check(
  'the last outstanding page finishes it',
  sweepProgress({ pagesTotal: 3, pagesSeen: [1, 2] }, 3, 3),
  { pagesSeen: [1, 2, 3], complete: true },
);
// The failure the disabled button existed to prevent. Landing on the final page of a search sorted
// newest-first and treating that as done would narrow the window past everything on pages 1 and 2.
check(
  'the last page alone does NOT finish a sweep',
  sweepProgress(null, 3, 3),
  { pagesSeen: [3], complete: false },
);
check(
  'nor does re-reading the same page',
  sweepProgress({ pagesTotal: 3, pagesSeen: [2] }, 2, 3),
  { pagesSeen: [2], complete: false },
);
// Page 1 restarts: a sweep run a week later against a narrower window is a different set of pages,
// and crediting the old ones to it would call it complete on the strength of stale work.
check(
  'page 1 starts a fresh count',
  sweepProgress({ pagesTotal: 3, pagesSeen: [2, 3] }, 1, 3),
  { pagesSeen: [1], complete: false },
);
// So does a search that came back a different shape.
check(
  'a changed page total starts a fresh count',
  sweepProgress({ pagesTotal: 2, pagesSeen: [1, 2] }, 2, 3),
  { pagesSeen: [2], complete: false },
);
// Out of order is fine — what matters is coverage, not the order you walked them in.
check(
  'pages recorded out of order still complete',
  sweepProgress({ pagesTotal: 3, pagesSeen: [1, 3] }, 2, 3),
  { pagesSeen: [1, 2, 3], complete: true },
);

console.log('nextPageUrl');
// The panel pages by full navigation because Rightmove's own pager is a client-side route change:
// it swaps every card and leaves __NEXT_DATA__ describing the page you left, which the panel then
// has to refuse to record. That refusal was firing on every single page turn.
const onPage1 = 'https://www.rightmove.co.uk/property-to-rent/find.html?locationIdentifier=STATION%5E4187&index=0';
check(
  'page 1 of 3 goes to the second page of results',
  new URL(nextPageUrl(onPage1, 1, 3)!).searchParams.get('index'),
  String(RESULTS_PER_PAGE),
);
check(
  'page 2 of 3 goes to the third',
  new URL(nextPageUrl(onPage1, 2, 3)!).searchParams.get('index'),
  String(RESULTS_PER_PAGE * 2),
);
// Everything else about the search survives. This is the reason it is built from the URL you are
// on rather than from sweepSearchUrl: a search narrowed by hand must not be silently widened.
const narrowed = onPage1 + '&maxPrice=5000&mustHave=garden';
const paged = new URL(nextPageUrl(narrowed, 1, 2)!);
check('a hand-narrowed price survives paging', paged.searchParams.get('maxPrice'), '5000');
check('and a hand-added filter does too', paged.searchParams.get('mustHave'), 'garden');
check('and it is still the same search', paged.searchParams.get('locationIdentifier'), 'STATION^4187');
// No page to go to is a sentence, not a dead button.
check('the last page has no next', nextPageUrl(onPage1, 3, 3), null);
check('nor does a single-page search', nextPageUrl(onPage1, 1, 1), null);
check('and a page past the end does not invent one', nextPageUrl(onPage1, 4, 3), null);
check('an unparseable URL yields nothing rather than a broken link', nextPageUrl('not a url', 1, 3), null);

console.log('describeCriteria');
// Rent and bedrooms are the two the screen renders as English. Everything else is somebody's own
// filter carried through from Rightmove, and it stays visible as itself rather than being dropped.
check(
  'the basics read as sentences',
  describeCriteria({ minPrice: '1500', maxPrice: '3000', minBedrooms: '1', maxBedrooms: '3' }).supported,
  ['Rent £1,500–£3,000 pcm', '1 to 3 bedrooms'],
);
check('an open end says which end', describeCriteria({ maxPrice: '2750' }).supported, ['Rent up to £2,750 pcm']);
// Rightmove counts a studio as nought bedrooms, which cannot be printed as a number.
check('nought bedrooms is a studio', describeCriteria({ minBedrooms: '0', maxBedrooms: '0' }).supported, ['Studio']);
check(
  'a filter we have no sentence for is still shown',
  describeCriteria({ ...RENTAL_SEARCH, propertyTypes: 'flat', minBedrooms: '2', maxBedrooms: '2' }),
  { supported: ['2 bedrooms'], other: ['propertyTypes=flat'] },
);
// The three that only say "this is a lettings search" are nobody's choice, so they are neither
// described nor listed as somebody's extra filter.
check('what makes it a rental search is not a filter', describeCriteria(RENTAL_SEARCH), { supported: [], other: [] });

console.log('rightmoveSearchStart');
check(
  'a resolved place is pointed at by identifier',
  rightmoveSearchStart({
    label: 'Hampstead',
    locationIdentifier: 'STATION^4187',
    displayLocationIdentifier: 'Hampstead-Station.html',
  }),
  'https://www.rightmove.co.uk/property-to-rent/search.html?searchLocation=Hampstead+Station&useLocationIdentifier=true&locationIdentifier=STATION%5E4187',
);
// No identifier, no invented one: Rightmove is asked in words and offers its own matches, which is
// honest about what we hold. A guessed identifier returns plausible flats somewhere else.
check(
  'an unresolved place is searched by name alone',
  rightmoveSearchStart({ label: 'The office', locationIdentifier: null, displayLocationIdentifier: null }),
  'https://www.rightmove.co.uk/property-to-rent/search.html?searchLocation=The+office',
);

if (failures > 0) { console.error(`\n${failures} failing`); process.exit(1); }
console.log('\nall ok');
