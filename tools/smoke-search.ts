/** End-to-end check on the sweep panel: loads the built extension into Chromium, opens a saved
 *  search-results page under its real Rightmove URL, and reports what the panel actually did.
 *
 *  Same harness rules as `smoke.ts`, and the same reasons. Playwright fulfils the real URL from a
 *  saved file, so the manifest's match patterns are satisfied and the content scripts inject
 *  exactly as they do in life while no request leaves the machine. Only `http(s)` is intercepted,
 *  because aborting `chrome-extension://` starves the panel of its own stylesheet and it renders
 *  unstyled — which reads as a CSS bug that isn't there.
 *
 *  One thing this smoke test does that the others do not: it writes. `sweep:record` puts a row in
 *  `search_sighting` for every card on the page. It used to do that against the live database,
 *  which was defensible — the write is the behaviour under test, and those were genuine sightings
 *  of genuine Hampstead listings — but it is no longer necessary: the harness signs a fixture user
 *  in against a local Supabase (see `tools/fixture-session.ts`), so the rows land in a house hunt
 *  that exists for this check and is torn down by the next run of it.
 *
 *  It still never completes a sweep. That rule is not about which database it writes to: finishing
 *  a sweep narrows what the *next* one looks at, and the guard against recording page 1 of N as a
 *  finished pass is the thing being asserted.
 *
 *    supabase start
 *    pnpm fixture:search Hampstead
 *    pnpm build:smoke && pnpm smoke:search
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium, type ConsoleMessage } from 'playwright';
import { SEED_HUBS } from '../packages/core/src/hubs';
import { readSearchPage } from '../apps/extension/src/lib/search-page';
import { sweepSearchUrl, WIDEST_WINDOW } from '../packages/core/src/sweep';

/** The filters this harness searches with. A hunt's criteria are project data now and there is no
 *  built-in band to fall back on (see `RENTAL_SEARCH`), so a harness has to state its own — the
 *  same standing as its use of `SEED_HUBS`, and it must never be read by a surface. */
const HARNESS_CRITERIA = {
  minPrice: '4000',
  maxPrice: '6000',
  minBedrooms: '1',
  maxBedrooms: '3',
  radius: '1.0',
  _includeLetAgreed: 'on',
};
import { fixtureHubs, plantSession, seedFixture, smokeBuild } from './fixture-session';
import { keepOffline, OFFLINE_ARGS } from './offline';

const { path: EXTENSION, allowedHosts: ALLOWED_HOSTS } = smokeBuild();
const SHOTS = resolve(import.meta.dirname, '../.fixtures/shots');
const savedPage = process.argv[2] ?? resolve(import.meta.dirname, '../.fixtures/search-hampstead.html');

if (!existsSync(savedPage)) {
  throw new Error(`no saved search page at ${savedPage} — run pnpm fixture:search Hampstead`);
}

const html = readFileSync(savedPage, 'utf8');

// Serve the fixture under the URL the panel itself would generate for the hub it belongs to.
// Deriving it rather than hardcoding it means the harness cannot drift from the feature: if
// sweepSearchUrl changes shape, this serves the new shape.
//
// `SEED_HUBS` is the right list for *this* question and the wrong one for every question below
// it. Here it is being asked "which neighbourhood is the file on disk a search for", which is a
// fact about the saved file — the same reason `fixture:search` reads it. What the panel lists is a
// question about the project, and that is read from the database further down.
const saved = readSearchPage(asDocument(html));
if (!saved.ok) throw new Error(`the saved page does not parse: ${saved.error}`);
const hub = SEED_HUBS.find((h) => h.rightmove?.locationIdentifier === saved.page.locationIdentifier);
if (!hub) {
  throw new Error(`${savedPage} is a search for ${saved.page.locationIdentifier}, which is not one of the seeded hubs`);
}
const url = sweepSearchUrl({ hub, days: WIDEST_WINDOW, criteria: HARNESS_CRITERIA })!;

mkdirSync(SHOTS, { recursive: true });

const fixture = await seedFixture();
const projectHubs = await fixtureHubs();
console.log(`fixture: ${projectHubs.length} hubs in the project, sweeping ${hub.name}`);

const context = await chromium.launchPersistentContext('', {
  headless: false,
  viewport: { width: 1400, height: 1000 },
  args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`, ...OFFLINE_ARGS],
});

const problems: string[] = [];

try {
  const worker =
    context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker', { timeout: 15_000 }));
  // Signed out there is no sweep panel at all (design D13), so without this the harness would
  // wait fifteen seconds for `.rm-sweep` and fail — loudly, but for the wrong reason.
  await plantSession(worker, fixture.session);

  const page = await context.newPage();
  page.on('console', (m: ConsoleMessage) => {
    if ((m.type() === 'error' || m.type() === 'warning') && /rightmove-extension|chrome-extension/.test(m.text())) {
      problems.push(`console: ${m.text()}`);
    }
  });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));

  // Serve the fixture for any find.html request — the panel's own hub links point at the same
  // path with different query strings, and a click that fell through to the network would defeat
  // the point of the harness.
  const offline = await keepOffline(context, {
    allow: ALLOWED_HOSTS,
    fulfil: [{ prefix: 'https://www.rightmove.co.uk/property-to-rent/find.html', html }],
  });

  await page.goto(url, { waitUntil: 'commit' });

  const panel = page.locator('rightmove-sweep .rm-sweep');
  await panel.waitFor({ state: 'visible', timeout: 15_000 });

  if (await panel.locator('.rm-sweep-broken').count()) {
    problems.push(`the panel could not read the page: ${await panel.innerText()}`);
  }

  // The readiness signal is the thing the panel was asked for, so it is what the harness waits on.
  // It only turns green once the write to search_sighting has come back.
  const ready = panel.locator('.rm-sweep-ready-yes');
  await ready.waitFor({ state: 'visible', timeout: 30_000 }).catch(() => {
    problems.push('the panel never reported the page recorded');
  });
  console.log('readiness:', (await panel.locator('.rm-sweep-ready').innerText()).replace(/\n/g, ' | '));

  const counts = await panel.locator('.rm-sweep-counts').innerText();
  console.log('counts:', counts.replace(/\n/g, ' | '));
  const recorded = Number(/All (\d+) recorded/.exec(await panel.innerText())?.[1] ?? 0);
  console.log(`cards on the page: ${saved.page.cards.length}, panel says recorded: ${recorded}`);
  if (recorded !== saved.page.cards.length) {
    problems.push(`the panel recorded ${recorded} of ${saved.page.cards.length} cards`);
  }

  // Every card must carry a state attribute, or the hide toggle has nothing to act on and the
  // page silently ignores it.
  const marked = await page.evaluate(
    `document.querySelectorAll('[data-rm-sweep]').length`,
  );
  console.log('cards marked with a state:', marked);
  if ((marked as number) < saved.page.cards.length) {
    problems.push(`only ${marked} cards carry data-rm-sweep, expected ${saved.page.cards.length}`);
  }

  await panel.screenshot({ path: resolve(SHOTS, 'sweep-panel.png') });

  // The hide toggle. Checking the class alone would pass while the CSS did nothing, so this
  // measures whether cards actually stopped rendering.
  const visibleCards = () =>
    page.evaluate(
      `[...document.querySelectorAll('[data-rm-sweep]')].filter((c) => c.offsetParent !== null).length`,
    );
  const before = (await visibleCards()) as number;
  await panel.locator('.rm-sweep-toggle input').check();
  await page.waitForTimeout(300);
  const after = (await visibleCards()) as number;
  const completeCount = Number(/(\d+)\s*done/.exec(counts.replace(/\n/g, ' '))?.[1] ?? 0);
  console.log(`hide toggle: ${before} cards visible -> ${after} (${completeCount} are "done")`);
  if (before - after !== completeCount) {
    problems.push(`hiding removed ${before - after} cards but ${completeCount} were marked done`);
  }
  await panel.locator('.rm-sweep-toggle input').uncheck();

  // A freshly loaded page must never read as stale. The check exists because it did: Rightmove
  // puts a developer advert at the top of some results pages ("FEATURED NEW HOME — BUILT FOR
  // RENTERS"), it links to a real listing, and it is deliberately absent from the results blob
  // because it is not a search result. Anything matching on /properties/ links counted it as a
  // card, and the panel then announced on every Primrose Hill page that the page had moved on and
  // refused to record it. A warning that fires on a normal page stops being a warning.
  const warned = await panel.locator('.rm-sweep-warn').count();
  if (warned) {
    problems.push(`a freshly loaded page reads as stale: ${await panel.locator('.rm-sweep-warn').innerText()}`);
  }
  console.log(`fresh page reads as stale: ${warned > 0}`);

  // Page 1 of 2 must NOT count as a swept hub. This is the guard that stops the next sweep's
  // window being narrowed past listings nobody looked at — it used to be a disabled button and is
  // now structural, so it is asserted here rather than eyeballed. It is invisible when it works.
  const progress = (await panel.locator('.rm-sweep-finish').innerText()).replace(/\s+/g, ' ').trim();
  console.log(`page ${saved.page.page} of ${saved.page.totalPages} — panel says: ${progress}`);
  if (saved.page.totalPages > saved.page.page) {
    if (await panel.locator('.rm-sweep-done').count()) {
      problems.push('the hub reported itself swept from page 1 — the next sweep would miss listings');
    }
    // "1 of 7 pages recorded" — the enumeration of outstanding pages was dropped as noise once
    // the pager took over saying where to go next, but the *fraction* has to stay: it is the only
    // thing on the page that says the hub is not finished.
    if (!/\b1 of 7 pages recorded\b|\b\d+ of \d+ pages recorded\b/.test(progress)) {
      problems.push(`the panel does not say how much of the hub is recorded: "${progress}"`);
    }
  }

  // What the panel prints here IS the stored row — `Progress` renders the `sweep` the write
  // returned, not a local guess — so the assertion above covers the database too.
  //
  // There is deliberately no check that `last_swept_at` is null. A hub swept completely last week
  // and part-swept again today keeps last week's date, correctly, and asserting otherwise fails on
  // real data: Hampstead was genuinely completed at 14:15 and then re-entered at page 1, which
  // this harness read as a partial sweep recorded as complete. The rule that matters — recording
  // page 1 of 2 never sets the date — is pinned in check:sweep against `sweepProgress`, where it
  // can be tested without depending on what anybody swept this afternoon.

  // The opener is NOT here any more, and its absence is worth asserting: filling in moved to the
  // website (design D5), where the worklist is the whole database rather than the cards on screen
  // and the run survives paging on. A stray second opener would be two buttons doing almost the
  // same thing from two different worklists. The website's own opener has no extension smoke of its
  // own — see TODO.md.
  if (await panel.locator('.rm-sweep-go, .rm-open-go').count()) {
    problems.push('the sweep page still has an opener — filling in belongs on the website');
  }
  // The pointer to the website only appears when there is something to fill in, so on a page
  // where everything is already done its absence is correct rather than a regression.
  const flat = counts.replace(/\n/g, ' ');
  const incompleteHere =
    Number(/(\d+)\s*new/.exec(flat)?.[1] ?? 0) + Number(/(\d+)\s*part-filled/.exec(flat)?.[1] ?? 0);
  const pointer = (await panel.innerText()).replace(/\s+/g, ' ');
  const points = /Sweep tab on the website/i.test(pointer);
  console.log(`${incompleteHere} not filled in here; points at the website: ${points}`);
  if (incompleteHere > 0 && !points) {
    problems.push('the panel does not say where filling in happens now');
  }
  if (incompleteHere === 0 && points) {
    problems.push('the panel offers to fill in a page that has nothing to fill in');
  }

  // The hub list is the entry point to the other four sweeps — and it is a list of *this
  // project's* neighbourhoods now, read through `hubs:list`, not the compile-time five. Asserted
  // against what the project actually has, because the constant and the database agreeing is a
  // property of this fixture rather than of the feature: for any other project the old assertion
  // was true of nothing on screen.
  await panel.locator('.rm-sweep-hubs summary').click();
  const hubs = await panel.locator('.rm-sweep-hubs li').allInnerTexts();
  console.log('\nhubs:', hubs.map((h) => h.replace(/\s+/g, ' ').trim()).join(' | '));
  if (hubs.length !== projectHubs.length) {
    problems.push(`the hub list shows ${hubs.length} hubs, but the project has ${projectHubs.length}`);
  }
  for (const projectHub of projectHubs) {
    if (!hubs.some((text) => text.includes(projectHub.name))) {
      problems.push(`the hub list does not mention "${projectHub.name}", which the project has`);
    }
  }
  const links = await panel.locator('.rm-sweep-hubs a').count();
  const searchable = projectHubs.filter((h) => h.locationIdentifier).length;
  if (links !== searchable) {
    problems.push(`${links} hub links, expected ${searchable} — one per hub with a location identifier`);
  }

  await panel.screenshot({ path: resolve(SHOTS, 'sweep-hubs.png') });
  await page.screenshot({ path: resolve(SHOTS, 'sweep-page.png') });
  console.log(`\nscreenshots in ${SHOTS}`);
  console.log(offline());
} finally {
  await context.close();
}

if (problems.length > 0) {
  console.error('\nPROBLEMS:\n' + problems.map((p) => `  - ${p}`).join('\n'));
  process.exit(1);
}
console.log('\nok');

/** The reader wants a Document; Node has no DOM and this project has no jsdom. It reads exactly
 *  one element, so that one method is all the stub owes it. */
function asDocument(source: string): Document {
  const match = /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/.exec(source);
  return {
    getElementById: (id: string) => (id === '__NEXT_DATA__' && match ? { textContent: match[1] } : null),
  } as unknown as Document;
}
