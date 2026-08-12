/** End-to-end check: loads the built extension into Chromium, opens a listing, and reports what
 *  the panel actually rendered.
 *
 *  The listing is served from a saved HTML file that Playwright fulfils under the real Rightmove
 *  URL. That keeps the manifest's match patterns satisfied so the content scripts inject exactly
 *  as they do in life, while no request ever leaves this machine — which is also what keeps this
 *  a reader and not a crawler (AGENTS.md).
 *
 *    pnpm fixture 88023648        # save a listing page once
 *    pnpm smoke .fixtures/88023648.html
 */
import { readFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium, type ConsoleMessage } from 'playwright';
import {
  extensionLog,
  FIXTURE_EMAIL,
  plantSession,
  projectHasListing,
  seedFixture,
  smokeBuild,
} from './fixture-session';
import { listingFromHtml } from './read-listing';
import { keepOffline, OFFLINE_ARGS } from './offline';
import { startFunctions } from './edge-functions';
import { localCredentials } from './supabase-local';

const { path: EXTENSION, allowedHosts: ALLOWED_HOSTS } = smokeBuild();
const SHOTS = resolve(import.meta.dirname, '../.fixtures/shots');

const fixturePath = process.argv[2];
if (!fixturePath) throw new Error('usage: smoke <saved-listing.html>');

const html = readFileSync(fixturePath, 'utf8');
const listingId = /\/properties\/(\d+)/.exec(html)?.[1] ?? /(\d{6,})/.exec(fixturePath)?.[1];
if (!listingId) throw new Error(`could not work out the listing id from ${fixturePath}`);
const url = `https://www.rightmove.co.uk/properties/${listingId}`;

mkdirSync(SHOTS, { recursive: true });

// Read the listing here, from the same extractor the content script uses, so the fixture can put
// this postcode's journeys and station walks in the cache before the panel asks for them. That
// keeps the panel fast and its numbers fixed, rather than depending on what TfL says this morning.
//
// It is not what keeps the panel off the network, though — that was the belief this harness ran on
// for a while, and it was wrong. The panel asks the `travel` function for the station walks
// regardless and the function decides what it already knows, so with nothing serving the functions
// it gets a 502, waits, and reports "panel never left its loading state": a sentence about a
// spinner for what is really a process nobody started. It only ever passed because a
// `supabase functions serve` happened to be running from something else. Hence `startFunctions`
// below, which is now explicit and shared with `smoke:web`.
const listing = listingFromHtml(fixturePath, url);
const alsoCache =
  listing.postcode === null
    ? []
    : [{ postcode: listing.postcode, stations: listing.nearestStations.map((s) => s.name) }];
if (alsoCache.length === 0) {
  console.warn('this listing has no postcode, so travel cannot be pre-cached — expect a slow panel');
}

// A listing the fixture project has never opened, which is exactly the case worth having here:
// recording it exercises `record_property`, whose job is to create the `project_property` link and
// the `property` row in one transaction. The two-step version that preceded it made every
// genuinely new listing unrecordable and passed every test, because every test listing already
// existed (design D15). `alsoCache` also clears any row a previous run left behind, so the "first
// time" this claims is really the first time.
const fixture = await seedFixture({ alsoCache });
console.log(`fixture: signed in as ${FIXTURE_EMAIL}, opening listing ${listingId} for the first time`);

// Before the browser: the panel asks for travel the moment it renders, and a function that comes
// up late is a panel that has already given up.
const functions = await startFunctions({ supabaseUrl: localCredentials().url });

const context = await chromium.launchPersistentContext('', {
  // Extensions need a real browser context; the headless shell cannot load them.
  headless: false,
  args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`, ...OFFLINE_ARGS],
});

const problems: string[] = [];
const noteConsole = (message: ConsoleMessage) => {
  if (message.type() === 'error' || message.type() === 'warning') {
    const text = message.text();
    // Rightmove's own bundle and other extensions are noisy; only ours is our problem.
    if (/rightmove-extension|chrome-extension/.test(text)) problems.push(`console: ${text}`);
  }
};

try {
  const worker =
    context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker', { timeout: 15_000 }));
  console.log(`extension loaded: ${new URL(worker.url()).host}`);

  // The panel is a one-line "sign in" when there is no session (design D13), which would render,
  // settle, and pass every assertion below about a panel that is doing nothing.
  await plantSession(worker, fixture.session);

  const page = await context.newPage();
  page.on('console', noteConsole);
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));

  // One interception, from `offline.ts`, rather than a copy of it per harness: the saved page is
  // served under its real URL, the extension's own backends stay live so this exercises the real
  // round trip, and everything else — ads, trackers, Rightmove's own bundles — is aborted. The
  // inline script carrying `__PAGE_MODEL` is in the saved HTML itself, so none of that is needed.
  const offline = await keepOffline(context, {
    allow: ALLOWED_HOSTS,
    fulfil: [{ prefix: url, html }],
  });

  await page.goto(url, { waitUntil: 'commit' });

  const host = page.locator('rightmove-house-hunt');
  await host.waitFor({ state: 'attached', timeout: 15_000 });

  // Loudly, before reading anything the panel says: a signed-out panel renders perfectly and
  // settles quickly, and every assertion below would pass against it.
  //
  // Asked of the DOM rather than of `auth:state`, unlike the harnesses that open an extension
  // page. This one runs on a Rightmove page, where Playwright evaluates in the main world and the
  // content script lives in the isolated one — there is no `chrome.runtime` here to ask. The two
  // states have their own test ids for exactly this reason (design D13), and the recorded-listing
  // check at the bottom is the corroborating one: it is a write, and a signed-out worker cannot
  // make it.
  if (await page.locator('rightmove-house-hunt [data-testid="signed-out"]').count()) {
    problems.push('the panel is showing its signed-out line despite a valid session');
  }
  if (await page.locator('rightmove-house-hunt [data-testid="no-project"]').count()) {
    problems.push('the panel says there is no house hunt, but the fixture user has one active');
  }

  const panel = page.locator('rightmove-house-hunt .rm-panel');
  await panel.waitFor({ state: 'visible', timeout: 15_000 });

  // Wait for the text to stop changing, not merely for the first paint. The panel renders
  // immediately and fills in identity, places and travel times as they arrive, so an early
  // screenshot shows an empty-looking panel and reads as a bug that isn't there.
  const text = await settled(async () => (await panel.innerText()).trim());

  console.log('\n--- panel ---\n' + (text ?? '(still loading after 20s)'));

  const shot = resolve(SHOTS, `${listingId}.png`);
  await panel.screenshot({ path: shot });
  console.log(`\nscreenshot: ${shot}`);

  if (text === null) problems.push('panel never left its loading state');
  if (text && /Couldn't read this listing/.test(text)) problems.push('panel reported an extraction failure');

  // The photo gallery, opened over Rightmove's own page. Two things can go wrong here and only
  // one of them is visible in the markup: the overlay must portal *inside* the shadow root, or it
  // renders as a column of unstyled full-size images over the site; and it must actually paint on
  // top, which nothing about the CSS can promise on a page whose own stacking contexts we do not
  // control. So it is checked by asking what a person would hit at the centre of the photo.
  const photos = page.locator('rightmove-house-hunt .rm-chip', { hasText: 'Photos' });
  if ((await photos.count()) === 0) {
    console.log('photos chip: absent — this listing has no gallery images');
  } else {
    await photos.click();
    const lightbox = page.locator('rightmove-house-hunt .lightbox');
    await lightbox.waitFor({ state: 'visible', timeout: 5_000 }).catch(() => {});
    if ((await lightbox.count()) === 0) {
      problems.push('the Photos chip opened nothing, or opened it outside the shadow root');
    } else {
      await page.waitForTimeout(300);
      const over = await page.evaluate(`(() => {
        const shadow = document.querySelector('rightmove-house-hunt').shadowRoot;
        const img = shadow.querySelector('.lightbox-image');
        if (!img) return { ok: false, why: 'no image in the lightbox' };
        const box = img.getBoundingClientRect();
        if (box.width === 0) return { ok: false, why: 'the image has no size' };
        // elementFromPoint on a shadow root returns the node *inside* it, which is the question.
        const hit = shadow.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
        return { ok: hit?.className === 'lightbox-image', why: hit?.className ?? 'nothing' };
      })()`);
      const seen = over as { ok: boolean; why: string };
      console.log(`gallery over Rightmove: ${seen.ok ? 'on top' : 'BLOCKED by ' + seen.why}`);
      if (!seen.ok) problems.push(`the gallery does not paint over the page: ${seen.why}`);
      await page.screenshot({ path: resolve(SHOTS, `${listingId}-gallery.png`) });
      await page.keyboard.press('Escape');
    }
  }

  if (!(await page.locator('rightmove-house-hunt [data-testid="ratings"]').count())) {
    problems.push('the panel offers no verdict buttons — nothing on this page could be rated');
  }

  // The write, read back from the database rather than inferred from a panel that looks right.
  // Opening a listing is the extension's primary action and `record_property` is what makes it
  // stick; a version of that function that refused every genuinely new listing passed 133 RLS
  // checks, because every listing they used had been backfilled by a migration (design D15).
  const linked = await projectHasListing(listingId);
  console.log(`recorded into the house hunt: ${linked}`);
  if (!linked) problems.push(`opening ${listingId} did not link it to the project — record_property refused`);
  console.log(offline());

  // Only on the way out, and only when something is already wrong: the reason a write was refused
  // lives in the worker, and printing it unconditionally would bury the panel text this harness
  // exists to show.
  // `SMOKE_LOG=all` widens it to every line the worker recorded, which is how you tell "the write
  // was refused" from "the write was never attempted" — the two look identical from the outside.
  if (problems.length > 0 || process.env.SMOKE_LOG === 'all') {
    const lines = await extensionLog(
      worker,
      process.env.SMOKE_LOG === 'all' ? { levels: ['info', 'warn', 'error'] } : {},
    );
    console.error(
      '\n--- extension log (warnings and errors) ---\n' +
        (lines.length > 0 ? lines.join('\n') : '(nothing — the worker recorded no complaint)'),
    );
  }
} finally {
  await context.close();
  functions.kill('SIGTERM');
}

if (problems.length > 0) {
  console.error('\nPROBLEMS:\n' + problems.map((p) => `  - ${p}`).join('\n'));
  process.exit(1);
}
console.log('\nok');

/** Read until the value stops changing for `stableFor` consecutive polls, or give up. */
async function settled(
  read: () => Promise<string>,
  { stableFor = 4, attempts = 40, delayMs = 500 } = {},
): Promise<string | null> {
  let previous: string | null = null;
  let unchanged = 0;

  for (let i = 0; i < attempts; i++) {
    const value = await read();
    unchanged = value === previous ? unchanged + 1 : 0;
    previous = value;
    if (unchanged >= stableFor && !/Reading listing|Working…/.test(value)) return value;
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return previous !== null && !/Reading listing|Working…/.test(previous) ? previous : null;
}
