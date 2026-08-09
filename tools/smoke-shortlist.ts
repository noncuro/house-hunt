/** Opens the shortlist page in the built extension and reports what it rendered. The embedded
 *  PostgREST query (property + verdict + property_analysis in one round trip) is the part most
 *  likely to be quietly wrong, and it fails as an empty page rather than an error.
 *
 *  Signed in as a fixture user against a local Supabase seeded by `tools/fixture-session.ts` —
 *  read its header for why that is now the only way this can work, and why it is an improvement
 *  rather than a concession. Two things follow from it that are worth knowing while reading below.
 *  The assertions can name numbers, because the fixture decides them. And the harness may now
 *  write: rating a place in bulk used to be checked up to the point of the write and no further,
 *  because the write would have landed on the real listings of a real house hunt, and it no longer
 *  does.
 *
 *    supabase start
 *    pnpm build:smoke && pnpm smoke:shortlist
 */
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium, type ConsoleMessage } from 'playwright';
import { assertSignedIn, FIXTURE_EMAIL, plantSession, seedFixture, smokeBuild } from './fixture-session';
import { keepOffline, OFFLINE_ARGS } from './offline';

const { path: EXTENSION, allowedHosts } = smokeBuild();
const SHOTS = resolve(import.meta.dirname, '../.fixtures/shots');
mkdirSync(SHOTS, { recursive: true });

/** The extension's own backends stay live — the Supabase round trip is most of what this
 *  harness exists to prove — and so do map tiles, which are the one thing MV3's CSP is most
 *  likely to block. Rightmove is answered from the stub. */
const ALLOWED_HOSTS = [...allowedHosts, 'https://tile.openstreetmap.org/'];

const fixture = await seedFixture();
console.log(
  `fixture: ${fixture.listingIds.length} listings (${fixture.unratedCount} unrated), ` +
    `${fixture.hubCount} hubs, signed in as ${FIXTURE_EMAIL}`,
);

const context = await chromium.launchPersistentContext('', {
  headless: false, viewport: { width: 1200, height: 1000 },
  args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`, ...OFFLINE_ARGS],
});
const problems: string[] = [];
try {
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker', { timeout: 15_000 }));
  const id = new URL(worker.url()).host;
  await plantSession(worker, fixture.session);

  const offline = await keepOffline(context, { allow: ALLOWED_HOSTS });

  const page = await context.newPage();
  page.on('console', (m: ConsoleMessage) => {
    if (m.type() === 'error') problems.push(`console: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));

  await page.goto(`chrome-extension://${id}/shortlist.html`);
  await page.locator('.wrap').waitFor({ timeout: 15_000 });

  // Before anything else, and loudly. A session the extension did not accept renders a perfectly
  // good sign-in form, and every assertion below it would then be about a login screen — the
  // silent skip in its worst form, because the whole file would still go green.
  await assertSignedIn(page, { email: FIXTURE_EMAIL, projectId: fixture.projectId });
  if (await page.locator('.sign-in, [data-testid="signed-out"]').count()) {
    problems.push('the shortlist is showing the sign-in view despite a valid session');
  }

  for (let i = 0; i < 40 && (await page.locator('.working').count()); i++) await page.waitForTimeout(500);

  // Open every collapsed pile so the screenshot shows the whole thing.
  // Re-query each time: clicking flips aria-expanded, so a snapshot of the list goes stale.
  const toggles = page.locator('.toggle');
  for (let i = 0; i < (await toggles.count()); i++) {
    const toggle = toggles.nth(i);
    if ((await toggle.getAttribute('aria-expanded')) === 'false') await toggle.click();
  }
  await page.waitForTimeout(400);

  // The fixture decides how many places this house hunt has, so this is a number rather than
  // "more than none" — which is what it had to be while the harness read whatever was in the real
  // database, and which would pass on a shortlist that had lost half its rows to a bad join.
  const cards = await page.locator('.card').count();
  console.log('cards:', cards);
  if (cards !== fixture.listingIds.length) {
    problems.push(`${cards} cards, expected ${fixture.listingIds.length} — one per listing in the fixture`);
  }
  for (const t of await page.locator('.toggle').allInnerTexts()) console.log('  pile:', t.replace(/\s+/g, ' ').trim());
  if (await page.locator('.error').count()) problems.push(`page error: ${await page.locator('.error').innerText()}`);

  await page.screenshot({ path: resolve(SHOTS, 'shortlist.png'), fullPage: true });

  // Nothing to expand any more — every card shows everything — so the check is that the detail
  // is simply there, and that its travel times arrive.
  await page.waitForSelector('.detail', { timeout: 10_000 });
  for (let i = 0; i < 40 && (await page.locator('.detail .working').count()); i++) await page.waitForTimeout(500);
  const detail = (await page.locator('.detail').first().innerText()).replace(/\n+/g, ' | ');
  console.log('\nfirst card detail:', detail.slice(0, 400));
  // Thumbnails are lazy, and the harness answers them itself rather than letting them go to
  // Rightmove's CDN (see `keepOffline`). What survives that is still worth checking — that the
  // gallery renders an img per photo and that every one carries a URL a browser will load. What
  // no longer follows is that the real photo is there; the CDN is not under test.
  await page
    .waitForFunction(
      `(() => {
        const imgs = [...document.querySelectorAll('.photo img')];
        return imgs.length > 0 && imgs.some((i) => i.naturalWidth > 0);
      })()`,
      null,
      { timeout: 15_000 },
    )
    .catch(() => {});
  await page.waitForTimeout(2000);
  const loaded = await page.evaluate(`(() => {
    const imgs = [...document.querySelectorAll('.photo img')];
    return { total: imgs.length, loaded: imgs.filter((i) => i.naturalWidth > 0).length };
  })()`);
  console.log('photos:', JSON.stringify(loaded));
  if ((loaded as any).total === 0) problems.push('no photo thumbnails rendered');
  if ((loaded as any).loaded === 0) problems.push('photo thumbnails rendered but none loaded');
  if (/Working…/.test(detail)) problems.push('travel times never arrived on the first card');
  // `data-testid`, not `.rate`: the verdict controls moved into the shared `components/Verdict.tsx`
  // so the panel and the shortlist cannot state a rating two ways, and the class names went with
  // them. A test id survives that kind of move, which is the point of having one.
  if (!(await page.locator('.detail [data-testid="ratings"]').count())) {
    problems.push('no rating buttons on the first card');
  }
  // The verdict itself, and who set it. The fixture's most recently seen listing is rated, so both
  // must be there — an unrated card renders `verdict-none` instead, and finding that here would
  // mean the embedded verdict came back unattached to its property.
  const rating = await page.locator('.detail [data-testid="verdict-rating"]').first().count();
  const by = await page.locator('.detail [data-testid="verdict-by"]').first();
  console.log('verdict on the first card:', rating ? (await by.innerText()).replace(/\s+/g, ' ').trim() : 'none');
  if (!rating) problems.push('the first card shows no verdict, but the fixture rated it');
  else if (!/Smoke Fixture/.test(await by.innerText())) {
    problems.push(`the verdict is not attributed to whoever set it: "${await by.innerText()}"`);
  }
  await page.locator('.card').first().screenshot({ path: resolve(SHOTS, 'shortlist-detail.png') });

  // The gallery and the tooltip are both overlays rendered from inside a card, and the card
  // gives every child a stacking context — which painted them *under* the cards further down
  // the page. elementFromPoint is the only check that catches that: the markup and the CSS
  // both looked right while the photo was invisible.
  await page.locator('.photo').first().click();
  await page.waitForSelector('.lightbox-image', { timeout: 10_000 });
  await page.waitForTimeout(400);
  const overlay = await page.evaluate(`(() => {
    const img = document.querySelector('.lightbox-image');
    const box = img.getBoundingClientRect();
    const onTop = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    return {
      parent: img.closest('.card') ? 'card' : 'body',
      onTop: onTop?.className ?? null,
      // A transparent floorplan over the dark backdrop is unreadable; it needs a white ground.
      background: getComputedStyle(img).backgroundColor,
    };
  })()`);
  console.log('lightbox:', JSON.stringify(overlay));
  const box = overlay as { parent: string; onTop: string | null; background: string };
  if (box.parent !== 'body') problems.push('the lightbox is still nested inside a card');
  if (box.onTop !== 'lightbox-image') problems.push(`something paints over the photo: ${box.onTop}`);
  if (!/rgb\(255, 255, 255\)/.test(box.background)) {
    problems.push(`the lightbox image has no white ground (${box.background}) — floorplans will vanish`);
  }
  await page.screenshot({ path: resolve(SHOTS, 'shortlist-gallery.png') });
  await page.keyboard.press('Escape');

  // This used to skip itself when no route happened to be cached for whichever property was seen
  // most recently — a legitimate state against a real database, and how a whole column of empty
  // `journeys` survived review. The fixture caches a transit route with named legs for every
  // property, so there is nothing left to be legitimately absent and a missing tooltip is a
  // failure rather than a shrug.
  const transit = page.locator('.detail .rm-mode', { hasText: '🚇' }).first();
  if ((await transit.count()) === 0) {
    problems.push('no transit time on the first card, though the fixture cached one for every property');
  } else {
    await transit.hover();
    await page.waitForTimeout(600);
    const tip = await page.locator('.rm-tip').count();
    const legs = await page.locator('.rm-tip .rm-leg-line').count();
    console.log(`transit tooltip: ${tip > 0 ? 'shown' : 'MISSING'}, line chips: ${legs}`);
    if (tip === 0) problems.push('hovering a transit time reveals no route');
    else if (legs === 0) problems.push('the route tooltip names no lines');
  }
  if (!(await page.locator('.detail .rm-maps').count())) {
    problems.push('no Google Maps button on the travel rows');
  }

  // The compare table. Its whole value is that every column sorts, so the check is that
  // clicking a header actually reorders the rows — and that the page never scrolls sideways,
  // which is what a wide table does if the overflow is on the wrong element.
  await page.locator('.view', { hasText: 'Compare' }).click();
  await page.waitForSelector('.compare', { timeout: 10_000 });
  await page.waitForTimeout(1200);
  const headers = await page.locator('.compare thead th').allInnerTexts();
  console.log('\ncompare columns:', headers.map((h) => h.replace(/[▴▾]/g, '').trim()).join(' | '));
  const rows = await page.locator('.compare tbody tr').count();
  console.log('compare rows:', rows);
  if (rows === 0) problems.push('the compare table has no rows');

  const firstAddress = () => page.locator('.compare tbody tr .compare-address').first().innerText();
  // The table opens sorted by rent ascending, so one click on Rent reverses it. Clicking twice
  // returns it to where it started, which is what made this look broken the first time.
  const before = await firstAddress();
  await page.locator('.compare thead th button', { hasText: 'Rent' }).click();
  await page.waitForTimeout(300);
  const reversed = await firstAddress();
  console.log(`sort by rent: ${before.trim()} -> ${reversed.trim()}`);
  if (before === reversed) problems.push('reversing the rent sort changed nothing');

  const rents = await page.locator('.compare tbody tr td:nth-child(2)').allInnerTexts();
  const numbers = rents.map((r) => Number(r.replace(/[^0-9.]/g, ''))).filter((n) => n > 0);
  const descending = numbers.every((n, i) => i === 0 || n <= numbers[i - 1]!);
  console.log('rents, most expensive first:', descending ? 'yes' : `NO — ${numbers.join(', ')}`);
  if (!descending) problems.push('the rent column does not actually sort by amount');

  const overflow = await page.evaluate(
    `({ body: document.body.scrollWidth > document.body.clientWidth,
        table: document.querySelector('.compare-scroll').scrollWidth >
               document.querySelector('.compare-scroll').clientWidth })`,
  );
  console.log('overflow:', JSON.stringify(overflow));
  if ((overflow as { body: boolean }).body) problems.push('the compare table makes the page scroll sideways');
  await page.screenshot({ path: resolve(SHOTS, 'shortlist-compare.png'), fullPage: true });

  // The map: tiles are remote images, which is the part MV3's CSP is most likely to block.
  await page.locator('.view', { hasText: 'Map' }).click();
  await page.waitForSelector('.map', { timeout: 10_000 });
  await page.waitForTimeout(4000);
  const pins = await page.locator('.leaflet-interactive').count();
  const tiles = await page.locator('.leaflet-tile-loaded').count();
  console.log(`map — pins: ${pins}, tiles loaded: ${tiles}`);
  if (pins === 0) problems.push('no pins on the map');

  // The legend explains the colours and doubles as the filter. Rejected starts off, so turning
  // it on has to add pins — if the count doesn't move, the filter isn't wired to anything.
  const keys = await page.locator('.key').allInnerTexts();
  console.log('legend:', keys.map((k) => k.replace(/\s+/g, ' ').trim()).join(' | '));
  if (keys.length !== 4) problems.push(`expected four legend keys, got ${keys.length}`);
  for (const off of ['Rejected', 'Not yet rated']) {
    if ((await page.locator('.key', { hasText: off }).getAttribute('aria-pressed')) !== 'false') {
      problems.push(`${off.toLowerCase()} places are shown on the map by default`);
    }
  }
  const rejected = page.locator('.key', { hasText: 'Rejected' });
  await rejected.click();
  await page.waitForTimeout(600);
  const withRejected = await page.locator('.leaflet-interactive').count();
  console.log(`pins with rejected shown: ${withRejected}`);
  if (withRejected < pins) problems.push('showing rejected places removed pins');
  await rejected.click();
  await page.waitForTimeout(600);
  if (tiles === 0) problems.push('no map tiles loaded — likely blocked by the extension CSP');
  const note = await page.locator('.map-note').count();
  if (note) console.log('map note:', await page.locator('.map-note').innerText());
  await page.screenshot({ path: resolve(SHOTS, 'shortlist-map.png') });

  // Triage is the one view built around the unrated pile, and the only one that writes to more
  // than one property at a time. It used to be checked up to the point of writing and no further,
  // because the harness read a real house hunt's database and a bulk rate would have put
  // verdicts nobody gave onto real listings. Against a fixture that reason is gone, so
  // the write is exercised too — and it is worth exercising: it goes through the same RLS the
  // whole change turns on, and a refusal there would look like a button that does nothing.
  await page.locator('.view', { hasText: 'Triage' }).click();
  await page.waitForSelector('.triage-bar', { timeout: 10_000 });
  // Triage opens on the table, because ticking is a comparing action. Both layouts have to carry
  // a tick box for every row: the selection is shared state, and a layout that silently dropped
  // rows would let "select all" mean something different depending on which one you were in.
  const waiting = await page.locator('.triage .compare tbody tr').count();
  const ticks = await page.locator('.triage .tick input').count();
  console.log(`\ntriage table — unrated: ${waiting}, tick boxes: ${ticks}`);
  if (waiting === 0) problems.push('triage opened on no table at all');
  if (ticks !== waiting) problems.push(`${waiting} rows in triage but ${ticks} tick boxes`);
  if (waiting !== fixture.unratedCount) {
    problems.push(`triage shows ${waiting} unrated, expected ${fixture.unratedCount}`);
  }

  await page.locator('.triage-layout').click();
  await page.waitForTimeout(300);
  const triageCards = await page.locator('.triage .card').count();
  const cardTicks = await page.locator('.triage .tick input').count();
  console.log(`triage cards — ${triageCards} cards, ${cardTicks} tick boxes`);
  if (triageCards !== waiting) problems.push(`the cards layout shows ${triageCards} of ${waiting} rows`);
  if (cardTicks !== triageCards) problems.push(`${triageCards} cards but ${cardTicks} tick boxes`);
  await page.locator('.triage-layout').click();
  await page.waitForTimeout(300);

  const rateButtons = page.locator('.triage-rate .rate');
  if (await rateButtons.first().isEnabled()) {
    problems.push('the bulk rate buttons are usable with nothing selected');
  }
  await page.locator('.triage-all').click();
  await page.waitForTimeout(200);
  const selectedText = await page.locator('.triage-bar .dim').innerText();
  const ticked = await page.locator('.tick input:checked').count();
  console.log(`select all: ${selectedText.trim()}, ticked: ${ticked}`);
  if (ticked !== waiting) problems.push(`select all ticked ${ticked} of ${waiting}`);
  if (!(await rateButtons.first().isEnabled())) {
    problems.push('the bulk rate buttons stay disabled with a selection');
  }
  console.log('bulk verdicts:', (await rateButtons.allInnerTexts()).join(' | '));
  // The viewport, not the page: thirty-eight cards is a 20,000px image nobody can read, and what
  // is being looked at here is the bar and the tick boxes on the cards under it.
  await page.screenshot({ path: resolve(SHOTS, 'shortlist-triage.png') });

  // Now actually rate them, and read the result back off the page. The whole pile is selected, so
  // the pile has to empty — and it has to empty because the write landed, which is why the count
  // is re-read rather than the button's own state being trusted.
  await rateButtons.filter({ hasText: 'Maybe' }).first().click();
  await page.waitForTimeout(1500);
  const left = await page.locator('.triage .compare tbody tr').count();
  console.log(`after rating all ${waiting} “maybe”: ${left} left in triage`);
  if (left !== 0) problems.push(`${left} of ${waiting} places stayed unrated after a bulk rate`);
  const toast = await page.locator('.toast, .rm-toast').first().innerText().catch(() => '');
  if (toast) console.log('toast:', toast.replace(/\s+/g, ' ').trim());

  // Settings absorbed the popup, so everything that used to live there has to be reachable here.
  await page.locator('.view', { hasText: '⚙' }).click();
  await page.waitForSelector('.settings', { timeout: 10_000 });
  // Headings are uppercased by CSS, so innerText comes back shouting; compare case-insensitively.
  const settings = (await page.locator('.settings').innerText()).toLowerCase();
  console.log('\nsettings sections:', (await page.locator('.setting h2').allInnerTexts()).join(' | '));
  // "Who is on this laptop" is gone with the local identity it named — you are whoever signed in,
  // and what Settings offers now is how that name is displayed (design D1, D13).
  for (const needed of ['How your name appears', 'Places we measure against', 'Neighbourhoods we search', 'Diagnostics']) {
    if (!settings.includes(needed.toLowerCase())) problems.push(`settings is missing "${needed}"`);
  }
  await page.screenshot({ path: resolve(SHOTS, 'shortlist-settings.png'), fullPage: true });
  console.log(`\nscreenshots in ${SHOTS}`);
  console.log(offline());
} finally {
  await context.close();
}
if (problems.length) { console.error('PROBLEMS:\n' + problems.map((p) => '  - ' + p).join('\n')); process.exit(1); }
console.log('\nok');
