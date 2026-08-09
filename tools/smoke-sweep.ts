/** The shortlist's Sweep view: the hub links, the page progress, and the paced opener.
 *
 *  Filling in used to live on the Rightmove search page, where `smoke:search` covered it. Moving it
 *  here changed what it is: the worklist is now a question about the database rather than about the
 *  cards on screen, and the run survives paging on. Both of those are worth a harness, and the
 *  pacing especially — the failure that matters is opening forty tabs at once, which would look
 *  fine in the code and be unmistakable in a browser.
 *
 *  Nothing here reaches Rightmove — see `offline.ts`. The tabs are opened for real, by the real
 *  background worker, at real listing URLs; the domain simply does not resolve, so each one lands
 *  on Chrome's error page. That is exactly enough for what is under test, and it means the tabs
 *  record nothing and the database is only read.
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium, type ConsoleMessage } from 'playwright';
import { readSearchPage } from '../src/lib/search-page';
import { assertSignedIn, FIXTURE_EMAIL, plantSession, seedFixture, smokeBuild } from './fixture-session';
import { keepOffline, OFFLINE_ARGS } from './offline';

const { path: EXTENSION, allowedHosts: ALLOWED_HOSTS } = smokeBuild();
const SHOTS = resolve(import.meta.dirname, '../.fixtures/shots');
mkdirSync(SHOTS, { recursive: true });

/** A few real listing ids off the saved Hampstead search, used to stand in for the opener's
 *  worklist. Real ones because the background worker refuses to open anything that is not a
 *  Rightmove listing URL — invented ids would exercise that refusal rather than the pacing. */
const FIXTURE = resolve(import.meta.dirname, '../.fixtures/search-hampstead.html');
const pendingStub = (() => {
  if (!existsSync(FIXTURE)) return [];
  const read = readSearchPage(asDocument(readFileSync(FIXTURE, 'utf8')));
  if (!read.ok) return [];
  return read.page.cards.slice(0, 4).map((card) => ({
    rightmoveId: card.rightmoveId,
    url: card.url,
    hub: 'Hampstead',
    displayAddress: card.displayAddress,
    price: card.price,
    missing: [],
  }));
})();

/** Node has no DOM, and `readSearchPage` only ever asks for one element. Same stub as check-sweep. */
function asDocument(html: string): Document {
  const match = /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/.exec(html);
  return {
    getElementById: (id: string) =>
      id === '__NEXT_DATA__' && match ? { textContent: match[1] } : null,
  } as unknown as Document;
}

const fixture = await seedFixture();
console.log(`fixture: ${fixture.hubCount} hubs, signed in as ${FIXTURE_EMAIL}`);

const context = await chromium.launchPersistentContext('', {
  headless: false,
  viewport: { width: 1200, height: 1000 },
  args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`, ...OFFLINE_ARGS],
});
const problems: string[] = [];

try {
  const worker =
    context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker', { timeout: 15_000 }));
  // Signed out the shortlist is the sign-in view and there is no Sweep tab to click, so this is
  // the difference between a check and fifteen seconds of waiting for a selector.
  await plantSession(worker, fixture.session);

  // Nothing here reads what lands in those tabs: what is under test is that one opens rather
  // than forty.
  const offline = await keepOffline(context, { allow: ALLOWED_HOSTS });

  const page = await context.newPage();
  page.on('console', (m: ConsoleMessage) => {
    if (m.type() === 'error') problems.push(`console: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));

  // Answer `sweep:pending` with a fixed handful, so the pacing assertions below always run.
  //
  // Left to the real database this check skips whenever everything happens to be filled in, and a
  // harness that silently skips its most important assertion is how the empty-journeys bug
  // survived its first review. Only the worklist is stubbed: `tab:open` still goes to the real
  // background worker and opens real listing pages, so what is under test — one tab, then a wait,
  // then Stop actually stopping — is exercised for real. The ids come from the saved search page
  // rather than being invented, because the worker refuses to open anything that is not a
  // Rightmove listing URL and inventing them would test the refusal instead.
  await page.addInitScript(`(() => {
    const real = chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage = (message, ...rest) => {
      if (message && message.type === 'sweep:pending') {
        return Promise.resolve({ ok: true, data: ${JSON.stringify(pendingStub)} });
      }
      return real(message, ...rest);
    };
  })()`);

  await page.goto(`chrome-extension://${new URL(worker.url()).host}/shortlist.html`);
  await assertSignedIn(page, { email: FIXTURE_EMAIL, projectId: fixture.projectId });
  await page.locator('.view', { hasText: 'Sweep' }).click();
  await page.waitForSelector('.sweep', { timeout: 15_000 });
  for (let i = 0; i < 40 && (await page.locator('.sweep .working').count()); i++) {
    await page.waitForTimeout(500);
  }

  // What the view lists has to match what `hubs:list` answered, and that is asked of the extension
  // rather than of `SWEEP_HUBS`. Hubs are project data now (design D11): the constant answers for
  // the first project whoever is signed in, so asserting against it passes for a project with a
  // completely different set of neighbourhoods and, worse, for one with none at all.
  const listed = (await page.evaluate(`chrome.runtime.sendMessage({ type: 'hubs:list' })`)) as {
    ok?: boolean;
    data?: Array<{ name: string; locationIdentifier: string | null }>;
    error?: string;
  };
  if (!listed?.ok || !listed.data) {
    throw new Error(`hubs:list failed — ${listed?.error ?? 'no answer from the worker'}`);
  }
  const projectHubs = listed.data;
  if (projectHubs.length === 0) {
    throw new Error('hubs:list returned nothing — every assertion below would be vacuously true');
  }

  const hubs = await page.locator('.sweep-hub').count();
  console.log(`hubs listed: ${hubs} (hubs:list returned ${projectHubs.length})`);
  if (hubs !== projectHubs.length) problems.push(`expected ${projectHubs.length} hubs, got ${hubs}`);
  const shown = await page.locator('.sweep-hub').allInnerTexts();
  for (const text of shown) console.log('  ', text.replace(/\s+/g, ' ').trim());
  for (const hub of projectHubs) {
    if (!shown.some((text) => text.includes(hub.name))) {
      problems.push(`"${hub.name}" came back from hubs:list but is not on the Sweep view`);
    }
  }

  // Every link has to be a real Rightmove search carrying a verified identifier. A URL with the
  // wrong one returns a page full of plausible flats in the wrong neighbourhood, which nothing on
  // screen would contradict — so it is checked rather than looked at.
  const links = await page
    .locator('.sweep-hub a.sweep-go')
    .evaluateAll((as) => as.map((a) => (a as HTMLAnchorElement).href));
  const verified = projectHubs.filter((h) => h.locationIdentifier).length;
  console.log(`links: ${links.length} (expected ${verified})`);
  if (links.length !== verified) problems.push(`${links.length} links, expected one per verified hub`);
  for (const href of links) {
    if (!href.startsWith('https://www.rightmove.co.uk/property-to-rent/find.html?')) {
      problems.push(`not a search URL: ${href}`);
    }
    if (!/locationIdentifier=(STATION|REGION)%5E\d+/.test(href)) {
      problems.push(`no verified identifier in ${href}`);
    }
  }
  console.log('  sample:', links[0]?.slice(0, 130));

  const fill = (await page.locator('.sweep').innerText()).split(/FILL IN/i)[1] ?? '';
  console.log('\nfill in:', fill.replace(/\s+/g, ' ').trim().slice(0, 240));

  // The paced opener. Started and stopped almost immediately: what is under test is that it opens
  // ONE tab rather than all of them, which is the failure that would matter — and that Stop
  // actually stops, rather than letting one more through from a sleep already in flight.
  const go = page.locator('.rm-open-go');
  if (!(await go.count())) {
    problems.push(
      pendingStub.length === 0
        ? `no opener, and no saved search page at ${FIXTURE} to stub one from — run pnpm fixture:search Hampstead`
        : 'the opener is missing even though the worklist was stubbed with listings',
    );
  } else {
    console.log('opener button:', (await go.innerText()).replace(/\n/g, ' — '));
    const before = context.pages().length;
    await go.click();
    await page.waitForSelector('.rm-open-run', { timeout: 5_000 });
    // The first opens straight away; the second is a full interval later, so a few seconds proves
    // the pacing without sitting through the whole run.
    await page.waitForTimeout(4_000);
    const opened = context.pages().length - before;
    const at = (await page.locator('.rm-open-at').innerText()).trim();
    console.log(`after 4s: ${opened} tab(s) opened · now on "${at}"`);
    if (opened === 0) problems.push('the paced opener opened nothing');
    if (opened > 1) problems.push(`the opener opened ${opened} tabs in 4 seconds — pacing is not working`);
    if (!at) problems.push('the run does not say which listing it is on');

    await page.locator('.rm-open-stop').click();
    await page.waitForTimeout(1_000);
    if (await page.locator('.rm-open-run').count()) problems.push('Stop did not end the run');
    const afterStop = context.pages().length - before;
    await page.waitForTimeout(3_000);
    if (context.pages().length - before > afterStop) problems.push('a tab opened after Stop was pressed');
    console.log('stop: run ended, no further tabs');

    // Read the block back rather than trusting it. This is the one harness that opens tabs the
    // route handler never sees — `chrome.tabs.create` navigations go straight past interception —
    // so `OFFLINE_ARGS` is the only thing stopping them, and a flag that silently stops applying
    // would look exactly like a passing run. A tab that got through would report a rightmove.co.uk
    // URL; one the resolver rule stopped reports Chromium's error page instead.
    const live = context.pages().filter((tab) => tab.url().includes('rightmove.co.uk'));
    console.log(`tabs that reached Rightmove: ${live.length} (must be 0)`);
    for (const tab of live) problems.push(`a tab reached Rightmove for real: ${tab.url()}`);
  }

  await page.screenshot({ path: resolve(SHOTS, 'shortlist-sweep.png'), fullPage: true });
  console.log(`\nscreenshot in ${SHOTS}`);
  console.log(offline());
} finally {
  await context.close();
}

if (problems.length) {
  console.error('PROBLEMS:\n' + problems.map((p) => '  - ' + p).join('\n'));
  process.exit(1);
}
console.log('\nok');
