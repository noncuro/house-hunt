/** The website in a browser: the shortlist, the compare table, the map and triage.
 *
 *  This is the harness the split left behind. `smoke:shortlist` and `smoke:sweep` tested those
 *  screens while they were extension pages; when the app moved to `apps/web` both were deleted and
 *  nothing replaced them, so the half of this product a person actually spends their evening in
 *  had no browser coverage at all — AGENTS.md said so, and this is that gap.
 *
 *  What it is really for is the embedded PostgREST read behind the shortlist (property + verdict +
 *  analysis in one round trip). That is the part most likely to be quietly wrong, and it fails as
 *  an empty page rather than as an error — which is indistinguishable from a house hunt nobody has
 *  added anything to.
 *
 *  Signed in as the same fixture user the extension harnesses use, against the same local stack, so
 *  the assertions can name numbers: the fixture decides how many flats are rated and how.
 *
 *    supabase start
 *    pnpm smoke:web
 */
import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { chromium, type ConsoleMessage, type Page } from 'playwright';
import { FIXTURE_EMAIL, FIXTURE_NAME, seedFixture } from './fixture-session';
import { localCredentials } from './supabase-local';
import { keepOffline, OFFLINE_ARGS } from './offline';

/** Must match `storageKey` in `apps/web/src/lib/client.ts`. Asserted below rather than trusted:
 *  a session written under the wrong key renders a perfectly good sign-in form, and every
 *  assertion after it would be about a login screen. */
const SESSION_KEY = 'house-hunt-session';

/** Not 3100. `pnpm dev:web` runs there, and a harness that quietly attached to the dev server
 *  somebody had open would be testing whatever code that server was pointed at — including the
 *  hosted database, which is a real house hunt with real verdicts in it. */
const PORT = 3199;
const ORIGIN = `http://127.0.0.1:${PORT}`;

const SHOTS = resolve(import.meta.dirname, '../.fixtures/shots');
mkdirSync(SHOTS, { recursive: true });

const { url: supabaseUrl, anonKey } = localCredentials();
const problems: string[] = [];
const note = (problem: string) => problems.push(problem);

const fixture = await seedFixture();
console.log(
  `fixture: ${fixture.listingIds.length} listings (${fixture.unratedCount} unrated), ` +
    `${fixture.hubCount} hubs, signed in as ${FIXTURE_EMAIL}`,
);

const functions = await startFunctions();
const server = await startWebApp();

const context = await chromium.launchPersistentContext('', {
  headless: true,
  viewport: { width: 1280, height: 1000 },
  args: OFFLINE_ARGS,
});

try {
  // Before the app's own scripts run, so the client finds a session the moment it is constructed
  // rather than mounting signed-out and repainting.
  await context.addInitScript(
    ([key, value]) => window.localStorage.setItem(key as string, value as string),
    [SESSION_KEY, JSON.stringify(fixture.session)],
  );

  const offline = await keepOffline(context, {
    // The app's own origin and its Supabase, and nothing else. Map tiles are allowed because the
    // map view is under test and a blocked tile renders as an empty grey square that looks exactly
    // like a broken map.
    allow: [ORIGIN, supabaseUrl, 'https://tile.openstreetmap.org/'],
  });

  const page = await context.newPage();
  page.on('console', (m: ConsoleMessage) => {
    if (process.env.SMOKE_LOG === 'all') console.log(`[page:${m.type()}] ${m.text()}`);
    // React's hydration and dev-server noise are not this harness's problem; a thrown error is.
    else if (m.type() === 'error') note(`console: ${m.text()}`);
  });
  page.on('pageerror', (e) => note(`pageerror: ${e.message}`));

  await page.goto(ORIGIN, { waitUntil: 'domcontentloaded' });
  await waitForApp(page);
  await settle(page);

  // Loudly, and first. Every assertion below would pass against a sign-in form.
  if (await page.locator('.sign-in, [data-testid="signed-out"]').count()) {
    note('the website is showing the sign-in view despite a valid session');
  }
  const whoami = await page.locator('.wrap').innerText();
  if (!whoami.includes(FIXTURE_NAME)) {
    note(`the page never names the signed-in user (${FIXTURE_NAME}) — is this really a session?`);
  }

  // ----------------------------------------------------------------------------------------- //
  // The list. `DEFAULT_SHOWING` puts excited and maybe on and leaves unrated and rejected off, so
  // this is a number the fixture decides: one love, one maybe, one rejection, three unrated.
  // ----------------------------------------------------------------------------------------- //
  const cards = await page.locator('article.card').count();
  console.log(`list: ${cards} card(s) shown by default`);
  if (cards !== 2) {
    note(`the list shows ${cards} cards; the fixture has exactly 2 rated excited-or-maybe`);
  }
  // The rated flats, by id, so a wrong join that returned the right *count* still fails.
  for (const id of ['smokefix-1', 'smokefix-4']) {
    if (!(await page.locator(`#card-${id}`).count())) note(`${id} is rated but is not on the list`);
  }
  // And the ones default-hidden really are hidden, or "shows 2" means nothing.
  for (const id of ['smokefix-2', 'smokefix-5']) {
    if (await page.locator(`#card-${id}`).count()) {
      note(`${id} is rejected or unrated and should not be on the list by default`);
    }
  }

  // The shortlist read is the whole point: a card that rendered with no price or no address is a
  // join that half-worked, which looks like a design choice rather than a bug.
  const first = page.locator('#card-smokefix-1');
  const firstText = await first.innerText();
  for (const expected of ['Flask Walk', '£2,600 pcm']) {
    if (!firstText.includes(expected)) note(`the card for smokefix-1 is missing "${expected}"`);
  }
  // Attribution: a shared rating whose author is invisible turns a disagreement into a silent
  // overwrite, which is the reason `set_by_name` is stored at all.
  if (!(await first.locator('[data-testid="verdict-by"]').count())) {
    note('the card does not say who set the verdict');
  }

  await page.screenshot({ path: resolve(SHOTS, 'web-list.png'), fullPage: true });

  // ----------------------------------------------------------------------------------------- //
  // The compare table, the map and triage. Each is a separate read path and each has failed as a
  // blank screen before.
  // ----------------------------------------------------------------------------------------- //
  await openView(page, 'table');
  const rows = await page.locator('table tbody tr').count();
  console.log(`table: ${rows} row(s)`);
  if (rows < 2) note(`the compare table drew ${rows} rows; the fixture has 2 flats to compare`);
  await page.screenshot({ path: resolve(SHOTS, 'web-table.png'), fullPage: true });

  await openView(page, 'map');
  // The tile layer, not merely the container: an empty map div is what a broken map looks like.
  await page
    .locator('.leaflet-container')
    .waitFor({ timeout: 20_000 })
    .catch(() => note('the map view never rendered a leaflet container'));
  const tiles = await page.locator('.leaflet-tile').count();
  console.log(`map: ${tiles} tile(s) loaded`);
  if (tiles === 0) note('the map drew no tiles');
  await page.screenshot({ path: resolve(SHOTS, 'web-map.png') });

  // Triage opens as a table, not as cards — the pile is mostly a "no" you can see from one row,
  // which is the whole reason it has a layout of its own. So this asserts rows, then flips to
  // cards, because "shows the right number" in one layout says nothing about the other.
  await openView(page, 'triage');
  const triageRows = await page.locator('.triage table tbody tr').count();
  console.log(`triage: ${triageRows} unrated row(s)`);
  if (triageRows !== fixture.unratedCount) {
    note(`triage lists ${triageRows} rows; the fixture has ${fixture.unratedCount} unrated`);
  }
  await page.screenshot({ path: resolve(SHOTS, 'web-triage.png'), fullPage: true });

  // The bulk-rate buttons are dead until something is ticked. Checked up to the write and no
  // further, deliberately: the rest of this harness reads, and a bulk write is the one action here
  // that would put verdicts nobody gave onto rows — which is exactly what the fixture exists to
  // keep away from a real house hunt, and worth not relying on that alone.
  const rate = page.locator('.triage-rate button').first();
  if (await rate.isEnabled()) note('the bulk-rate buttons are live with nothing selected');
  await page.locator('.triage table tbody tr input[type="checkbox"]').first().check();
  if (!(await rate.isEnabled())) note('the bulk-rate buttons stayed dead after ticking a row');

  await page.locator('.triage-layout').click();
  // Scoped to the pile: `article.card` is the shortlist's card too, and an unscoped count here
  // quietly included whatever else the page had rendered.
  const triageCards = await page.locator('.triage article.card').count();
  console.log(`triage as cards: ${triageCards}`);
  if (triageCards !== fixture.unratedCount) {
    note(`triage's card layout shows ${triageCards}; the fixture has ${fixture.unratedCount} unrated`);
  }

  console.log(offline());
} finally {
  await context.close();
  server.kill('SIGTERM');
  functions.kill('SIGTERM');
}

if (problems.length > 0) {
  console.error('\nPROBLEMS:\n' + problems.map((p) => `  - ${p}`).join('\n'));
  process.exit(1);
}
console.log('\nok');

// --------------------------------------------------------------------------------------------- //

/** Serve the Edge Functions with an environment, and wait until they will talk to us.
 *
 *  Needed because travel resolution is server-side: the shortlist asks the `travel` function for
 *  every flat, and the function answers `Access-Control-Allow-Origin` built from `WEB_APP_ORIGIN`.
 *  Without a match the browser discards every reply and the page sits on "Working…" until the
 *  settle timeout — which reaches the harness output as "the page never stopped saying it was
 *  working", a sentence about a spinner for what is really a missing environment variable.
 *
 *  And it has to be `functions serve` rather than the runtime `supabase start` already has, which
 *  was the surprise here: that container is built with no environment of its own. `supabase/.env`
 *  does not reach it, and neither does the host's — both were tried. `functions serve --env-file`
 *  is the documented way to give the functions an environment locally, and Kong routes
 *  `/functions/v1/*` to it, so nothing else has to know it happened. */
async function startFunctions(): Promise<ChildProcess> {
  const root = resolve(import.meta.dirname, '..');
  const envFile = resolve(root, 'supabase/.env');
  if (!existsSync(envFile)) {
    throw new Error(
      `no supabase/.env, so the Edge Functions would run with no WEB_APP_ORIGIN and refuse this\n` +
        `harness's origin. Copy the template and try again:\n\n` +
        '    cp supabase/.env.example supabase/.env\n',
    );
  }

  console.log('serving the edge functions');
  const child = spawn('supabase', ['functions', 'serve', '--env-file', 'supabase/.env'], {
    cwd: root,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    if (process.env.SMOKE_LOG === 'all') process.stderr.write(`[functions] ${chunk.toString()}`);
  });

  // Poll the thing we actually depend on — the CORS answer — rather than a readiness line. It is
  // the only signal that distinguishes "serving" from "serving, and will talk to us".
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`supabase functions serve exited (${child.exitCode})`);
    const allowed = await fetch(`${supabaseUrl}/functions/v1/travel`, {
      method: 'OPTIONS',
      headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'POST' },
      signal: AbortSignal.timeout(3_000),
    })
      .then((r) => r.headers.get('access-control-allow-origin'))
      .catch(() => null);

    if (allowed === ORIGIN) {
      console.log(`edge functions accept ${ORIGIN}`);
      return child;
    }
    await new Promise((r) => setTimeout(r, 1_000));
  }

  child.kill('SIGTERM');
  throw new Error(
    `the travel function never answered Access-Control-Allow-Origin: ${ORIGIN}.\n` +
      `Check that supabase/.env says WEB_APP_ORIGIN=${ORIGIN} and that \`supabase start\` is up.`,
  );
}

/** Wait for the app shell, and say what is on screen instead if it never arrives.
 *
 *  A bare `waitFor` on `.wrap` reports only that a selector did not appear in 60 seconds, which is
 *  true of a crashed app, a blocked bundle and a redirect alike. Whatever the page *did* render is
 *  the thing that tells them apart, so it goes in the failure. */
async function waitForApp(page: Page): Promise<void> {
  try {
    await page.locator('.wrap').waitFor({ timeout: 60_000 });
  } catch {
    const body = (await page.locator('body').innerText().catch(() => '')).trim();
    const html = (await page.content().catch(() => '')).slice(0, 600);
    throw new Error(
      `the website never rendered its .wrap shell at ${page.url()}.\n\n` +
        `what the page says:\n${body || '(nothing)'}\n\nfirst 600 chars of markup:\n${html}`,
    );
  }
}

/** Switch tabs through the URL rather than by clicking.
 *
 *  The open view lives in `?v=` precisely so a link lands on it, so this exercises the same path a
 *  bookmark takes — and it does not depend on a button's label, which is the kind of thing that
 *  changes without the view behind it changing at all. */
async function openView(page: Page, view: string): Promise<void> {
  await page.goto(`${ORIGIN}/?v=${view}`, { waitUntil: 'domcontentloaded' });
  await waitForApp(page);
  await settle(page);
}

/** Wait for the page to stop saying it is working.
 *
 *  Every screen here renders immediately and fills in as six queries land, so a screenshot at
 *  first paint shows an empty shortlist and reads as an empty database — the same trap the panel
 *  harness documents. */
async function settle(page: Page, attempts = 60): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    if ((await page.locator('.working').count()) === 0) return;
    await page.waitForTimeout(500);
  }
  note('the page never stopped saying it was working');
}

/** A production build, served with `next start`, pointed at the local stack.
 *
 *  **Not `next dev`, and that is not a preference.** This app ships a deliberately strict
 *  Content-Security-Policy (see `apps/web/next.config.ts`, where it is load-bearing: sign-in hands
 *  credentials to the extension over a `postMessage` on this origin, so any script that could run
 *  here could read them). React's development build needs `eval()`, and the header does not grant
 *  `unsafe-eval` — so under `next dev` the bundle dies on load and the app renders nothing at all,
 *  which is exactly what it looked like: a blank page and a selector that never appeared.
 *
 *  Serving the production build is also the more honest test. It is the bundle people actually get,
 *  CSP and all, so this harness would catch a header that broke the app in production — which a dev
 *  server, with its own relaxed rules, could never do.
 *
 *  Which Supabase the website talks to is read from `NEXT_PUBLIC_*` at build time, exactly as the
 *  extension reads `WXT_*` — so, like `build:smoke`, it cannot be arranged at runtime and is passed
 *  in here. Nothing about the repo's `.env` is read or changed. */
async function startWebApp(): Promise<ChildProcess> {
  const cwd = resolve(import.meta.dirname, '..');
  const env = {
    ...process.env,
    NEXT_PUBLIC_SUPABASE_URL: supabaseUrl,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: anonKey,
  };
  // Note: this writes the ordinary `apps/web/.next`, so it replaces whatever `pnpm dev:web` last
  // built — with a bundle pointed at the *local* stack. Harmless (the next `dev:web` rebuilds from
  // the root `.env`) but worth knowing if a dev server is running while this does.

  console.log(`building the website against ${supabaseUrl} (this takes a minute)`);
  const built = spawn('pnpm', ['--filter', '@house-hunt/web', 'exec', 'next', 'build'], {
    cwd,
    env,
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  const code = await new Promise<number>((done) => built.on('exit', (c) => done(c ?? 1)));
  if (code !== 0) throw new Error(`next build failed with code ${code} — the harness cannot run`);

  console.log(`starting the website on ${ORIGIN}`);
  const child = spawn('pnpm', ['--filter', '@house-hunt/web', 'exec', 'next', 'start', '-p', String(PORT)], {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stderr?.on('data', (chunk: Buffer) => {
    const text = chunk.toString();
    if (/Error|error:/.test(text)) process.stderr.write(`[next] ${text}`);
  });

  // Poll rather than parse the banner: the "ready" line has moved between Next versions, and a
  // harness that waits for a string it no longer prints hangs for its whole timeout with the
  // server up and healthy behind it.
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`next dev exited with code ${child.exitCode}`);
    try {
      const response = await fetch(ORIGIN, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) {
        console.log('website is up');
        return child;
      }
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 1_000));
  }
  child.kill('SIGTERM');
  throw new Error(`the website did not come up on ${ORIGIN} within 120s`);
}
