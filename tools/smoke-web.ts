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
 *    pnpm smoke:web                # all of it
 *    pnpm smoke:web list rating    # just those sections, in the order below
 *
 *  The sections are named so that iterating on one assertion does not cost the whole run. What they
 *  cannot skip is the setup — the fixture, the Edge Functions and a production build of the website
 *  — so a subset saves the browser work, which on a warm build is most of it: six seconds for the
 *  list and the rating against forty for everything, and `joining` alone is half of that forty.
 *  Every section is written to stand on its own against that setup: the ones that look at a tab
 *  navigate to it, the two sign-in ones take a signed-out context each, and `rating` deliberately
 *  leaves the counts `table` and `triage` assert unchanged — so no section is quietly reading state
 *  an earlier one left behind.
 */
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { chromium, type Browser, type ConsoleMessage, type Page } from 'playwright';
import {
  createInvite,
  FIXTURE_EMAIL,
  FIXTURE_NAME,
  fixtureId,
  OTHER_NAME,
  REDEEM_EMAIL,
  REDEEM_PASSWORD,
  seedFixture,
  stageOf,
  verdictHistoryOf,
  verdictOf,
} from './fixture-session';
// Deep import rather than the package barrel: the barrel is React components, and this is a Node
// script that only wants the words a rating is drawn with. Reading them from the same table the
// buttons do is what stops this harness asserting on a label the app stopped using.
import { ratingOf } from '../packages/ui/src/ratings';
import { localCredentials } from './supabase-local';
import { keepOffline, OFFLINE_ARGS } from './offline';
import { startFunctions } from './edge-functions';
import { demandFreePort, stopTree } from './servers';

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

/** The app's own origin and its Supabase, and nothing else. Map tiles are allowed because the map
 *  view is under test and a blocked tile renders as an empty grey square that looks exactly like a
 *  broken map. */
const ALLOW = [ORIGIN, supabaseUrl, 'https://tile.openstreetmap.org/'];

const problems: string[] = [];
const note = (problem: string) => problems.push(problem);

interface Stage {
  /** The signed-in page, already on the shortlist. */
  page: Page;
  /** For the two sections that need a browser nobody has signed in on. */
  browser: Browser;
}

/** Every section, in the order they run: the reads first, then the one write, then the tabs, then
 *  the way in from outside. Ordered so that none of them needs an earlier one to have run — a
 *  section that only passes as part of the whole run is a section nobody can iterate on, which is
 *  the reason for naming them in the first place. */
const SECTIONS = [
  { name: 'session', run: checkSession },
  { name: 'list', run: checkList },
  { name: 'rating', run: checkRating },
  { name: 'funnel', run: checkFunnel },
  { name: 'table', run: checkTable },
  { name: 'map', run: checkMap },
  { name: 'triage', run: checkTriage },
  { name: 'tabs', run: checkTabs },
  { name: 'refusals', run: checkRefusals },
  { name: 'joining', run: checkJoining },
] as const satisfies ReadonlyArray<{ name: string; run: (stage: Stage) => Promise<void> }>;

const wanted = process.argv.slice(2);

// Same rule as `smoke:all`, for the same reason: a name that matches nothing has to stop the run
// rather than leave the sections it does match to exit 0. A green `pnpm smoke:web typo` is the
// silent skip in its most convincing costume, and this is the argument list most likely to be
// mistyped, since the names are only written down here.
const unknown = wanted.filter((name) => !SECTIONS.some((s) => s.name === name));
if (unknown.length > 0) {
  console.error(
    `no section called ${unknown.map((n) => `"${n}"`).join(', ')}.\n` +
      `usage: pnpm smoke:web [${SECTIONS.map((s) => s.name).join('|')}]`,
  );
  process.exit(1);
}

const chosen = wanted.length === 0 ? SECTIONS : SECTIONS.filter((s) => wanted.includes(s.name));

const fixture = await seedFixture();
console.log(
  `fixture: ${fixture.listingIds.length} listings (${fixture.unratedCount} unrated), ` +
    `${fixture.hubCount} hubs, signed in as ${FIXTURE_EMAIL}`,
);

// Declared out here and started inside the try, so the `finally` covers every one of them. Started
// above it, a website that failed to build left the function server running — and a stray server is
// worse than an obvious crash, because the next run's readiness probe passes against it.
let functions: ChildProcess | undefined;
let server: ChildProcess | undefined;
let browser: Browser | undefined;

// Ctrl-C used to reach both servers through the terminal's process group. They are started in
// groups of their own now, so that no longer happens and the harness has to pass the interrupt on
// itself — otherwise the most ordinary way to end a run, giving up on it, is the one way that
// leaves a website holding the port for the next one.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    stopTree(server);
    stopTree(functions);
    process.exit(130);
  });
}

try {
  functions = await startFunctions({ supabaseUrl, origin: ORIGIN });
  server = await startWebApp();

  // A browser rather than a persistent context, because the sign-in sections need one that is
  // genuinely signed out and this one has a session planted in it. `signedOutPage` makes them a
  // context each.
  browser = await chromium.launch({ headless: true, args: OFFLINE_ARGS });
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } });

  // Before the app's own scripts run, so the client finds a session the moment it is constructed
  // rather than mounting signed-out and repainting.
  await context.addInitScript(
    ([key, value]) => window.localStorage.setItem(key as string, value as string),
    [SESSION_KEY, JSON.stringify(fixture.session)],
  );

  const offline = await keepOffline(context, { allow: ALLOW });

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

  // Each section timed, because the reason to be able to run one is that the whole thing is slow,
  // and the only way that claim stays honest is if every run says what it cost.
  const ran: Array<{ name: string; seconds: number }> = [];
  for (const section of chosen) {
    console.log(`\n─── ${section.name} ───`);
    const started = Date.now();
    await section.run({ page, browser });
    ran.push({ name: section.name, seconds: (Date.now() - started) / 1000 });
  }

  console.log(offline());
  console.log(`\nsections: ${ran.map((s) => `${s.name} ${s.seconds.toFixed(1)}s`).join(', ')}`);
} finally {
  // Each guarded and each independent: whichever started gets stopped, whatever happened to the
  // ones after it.
  await browser?.close().catch(() => {});
  stopTree(server);
  stopTree(functions);
}

if (problems.length > 0) {
  console.error('\nPROBLEMS:\n' + problems.map((p) => `  - ${p}`).join('\n'));
  process.exit(1);
}
console.log('\nok');

// --------------------------------------------------------------------------------------------- //

/** Signed in at all, and as whom. Loudly, and first: every other section would pass against a
 *  perfectly rendered sign-in form. */
async function checkSession({ page }: Stage): Promise<void> {
  if (await page.locator('.sign-in, [data-testid="signed-out"]').count()) {
    note('the website is showing the sign-in view despite a valid session');
  }
  const whoami = await page.locator('.wrap').innerText();
  if (!whoami.includes(FIXTURE_NAME)) {
    note(`the page never names the signed-in user (${FIXTURE_NAME}) — is this really a session?`);
  }
}

/** The list. `DEFAULT_SHOWING` puts excited and maybe on and leaves unrated and rejected off, so
 *  this is a number the fixture decides: one love, one maybe, one rejection, three unrated. */
async function checkList({ page }: Stage): Promise<void> {
  const cards = await page.locator('article.card').count();
  console.log(`list: ${cards} card(s) shown by default`);
  if (cards !== 2) {
    note(`the list shows ${cards} cards; the fixture has exactly 2 rated excited-or-maybe`);
  }
  // The rated flats, by id, so a wrong join that returned the right *count* still fails.
  for (const id of [fixtureId(1), fixtureId(4)]) {
    if (!(await page.locator(`#card-${id}`).count())) note(`${id} is rated but is not on the list`);
  }
  // And the ones default-hidden really are hidden, or "shows 2" means nothing.
  for (const id of [fixtureId(2), fixtureId(5)]) {
    if (await page.locator(`#card-${id}`).count()) {
      note(`${id} is rejected or unrated and should not be on the list by default`);
    }
  }

  // The shortlist read is the whole point: a card that rendered with no price or no address is a
  // join that half-worked, which looks like a design choice rather than a bug.
  const first = page.locator(`#card-${fixtureId(1)}`);
  const firstText = await first.innerText();
  for (const expected of ['Flask Walk', '£2,600 pcm']) {
    if (!firstText.includes(expected)) note(`the card for ${fixtureId(1)} is missing "${expected}"`);
  }
  // Attribution: a shared rating whose author is invisible turns a disagreement into a silent
  // overwrite, which is the reason `set_by_name` is stored at all.
  if (!(await first.locator('[data-testid="verdict-by"]').count())) {
    note('the card does not say who set the verdict');
  }

  await page.screenshot({ path: resolve(SHOTS, 'web-list.png'), fullPage: true });
}

/** Rating a flat, through the buttons, read back from Postgres.
 *
 *  The one write on this screen that nothing checked, and the product's central action. Everything
 *  above it is a read, which is not an accident — reads are easy to assert — but it leaves the whole
 *  harness passing against a page that renders beautifully and saves nothing. The mutation is
 *  optimistic on purpose (`queries.ts`): the card repaints from local state the moment it is
 *  clicked and only rolls back if the reply fails, so a verdict that never reached the database
 *  looks identical on screen to one that did. The database is the only witness.
 *
 *  The fourth flat, which the fixture seeds as `maybe`, so this is a *replacement* rather than a first
 *  rating — the case with the history table behind it, and the one that carries the design's whole
 *  point: a shared opinion whose previous value is kept and whose new author is named. It stays
 *  `love`, so nothing below it moves: the count, the compare table and the triage pile are all
 *  about a flat that was already showing and is still showing, whether or not this section ran. */
async function checkRating({ page }: Stage): Promise<void> {
  const rated = page.locator(`#card-${fixtureId(4)}`);
  const NEW_NOTE = 'Smoke: raised to loved.';
  // The note first, then the rating: the buttons pass the note themselves, precisely so that
  // leaving the field to click a rating does not race two saves. Typing it after would be testing
  // the blur path, which is a different write.
  await rated.locator('.note-edit').fill(NEW_NOTE);
  await rated.locator('[data-testid="rate-love"]').click();

  // What a person would see: the line now reads "Love it", and it is attributed to whoever clicked.
  await rated
    .locator('[data-testid="verdict-rating"]')
    .filter({ hasText: ratingOf('love').label })
    .waitFor({ timeout: 10_000 })
    .catch(() => note(`the card never showed the new rating after clicking ${ratingOf('love').label}`));
  const by = await rated.locator('[data-testid="verdict-by"]').innerText();
  if (!by.includes(FIXTURE_NAME)) {
    note(`the re-rated card is attributed to "${by}", not to ${FIXTURE_NAME} who clicked it`);
  }

  // And what is actually stored. Polled rather than read once — the click returns as soon as the
  // optimistic update paints, and a single read here would be a race that passes on a fast laptop.
  const stored = await settleOn(
    () => verdictOf(fixtureId(4)),
    (v) => v?.rating === 'love' && v.note === NEW_NOTE,
  );
  console.log(`verdict: ${stored?.rating ?? 'none'} — "${stored?.note ?? ''}" by ${stored?.setBy}`);
  if (stored?.rating !== 'love') note(`the database holds "${stored?.rating ?? 'nothing'}" for ${fixtureId(4)}, not love`);
  if (stored?.note !== NEW_NOTE) note(`the note was not saved with the rating (got "${stored?.note ?? ''}")`);
  // On `set_by`, not on `set_by_name`. The name column belongs to the pre-auth identity model and
  // the schema says new rows leave it null; the name a reader sees is resolved from project
  // membership by `authorOf`. Asserting the name here reported a correctly attributed verdict as
  // anonymous — which is why the check above, on what the card actually renders, is the other half
  // of this and not a duplicate of it.
  if (stored?.setBy !== fixture.userId) {
    note(`the stored verdict is authored by ${stored?.setBy ?? 'nobody'}, not by the user who clicked`);
  }

  // The previous value is kept. `set_verdict` archives before it replaces, and the seed writes
  // `verdict` directly, so exactly one row should exist here and it should be the `maybe` this
  // just overwrote. A silent overwrite is the failure the history table exists to prevent, and it
  // is invisible from every screen.
  const history = await verdictHistoryOf(fixtureId(4));
  console.log(`verdict history: ${history.length} prior value(s)`);
  const archived = history[0];
  if (history.length !== 1) {
    note(`${fixtureId(4)} has ${history.length} history rows after one re-rating; expected exactly 1`);
  } else if (archived?.rating !== 'maybe') {
    note(`the archived rating is "${archived?.rating}"; the fixture set it to maybe`);
  }
}

/** The funnel: moving a place along it, archiving it with a reason, and — the assertion this
 *  section exists for — the rating not moving with it.
 *
 *  A stage and a verdict are two facts about one flat, and the failure mode is silent in both
 *  directions: an archive that overwrote the rating would look like a tidy screen and would teach
 *  the verdict-score model that you disliked the flat you liked most. Nothing on screen can show
 *  that, so both are read back from Postgres.
 *
 *  Runs against the fourth flat, which the fixture seeds as `maybe` — so it is already in the
 *  funnel, whether or not `rating` ran before this. The verdict is read before the archive and
 *  compared with itself afterwards rather than against a literal, for the same reason. */
async function checkFunnel({ page }: Stage): Promise<void> {
  await openView(page, 'list');
  const id = fixtureId(4);
  const card = page.locator(`#card-${id}`);
  const before = await verdictOf(id);
  if (!before) return note(`${id} has no verdict, so it should not be in the funnel at all`);

  // The bar the shortlist is filtered by. It is the funnel's only presence on a page that is not
  // showing one flat, and it renders every step including the empty ones.
  const bar = page.locator('[data-testid="funnel"]');
  if (!(await bar.count())) note('the shortlist has no funnel bar');

  await card.locator('[data-testid="stage-enquired"]').click();
  await card
    .locator('[data-testid="stage-now"]')
    .filter({ hasText: 'Reached out' })
    .waitFor({ timeout: 10_000 })
    .catch(() => note('the card never showed the new stage after clicking Reached out'));

  const moved = await settleOn(() => stageOf(id), (s) => s?.stage === 'enquired');
  if (moved?.stage !== 'enquired') note(`the database holds "${moved?.stage ?? 'nothing'}" for ${id}, not enquired`);
  if (moved?.setBy !== fixture.userId) note(`the move is attributed to ${moved?.setBy ?? 'nobody'}, not to whoever clicked`);

  // Archiving is the one step that asks why, and nothing is written until it is answered.
  await card.locator('[data-testid="stage-archived"]').click();
  await card.locator('[data-testid="archive-gone"]').click();
  const archived = await settleOn(() => stageOf(id), (s) => s?.stage === 'archived');
  console.log(`stage: ${archived?.stage} (${archived?.archiveReason ?? 'no reason'})`);
  if (archived?.archiveReason !== 'gone') {
    note(`${id} was archived with reason "${archived?.archiveReason ?? 'none'}"; the click said gone`);
  }

  const after = await verdictOf(id);
  if (after?.rating !== before.rating) {
    note(`archiving changed the rating from "${before.rating}" to "${after?.rating ?? 'nothing'}" — the two must move apart`);
  }
}

/** The compare table, which is its own read path and has failed as a blank screen before. */
async function checkTable({ page }: Stage): Promise<void> {
  await openView(page, 'table');
  const rows = await page.locator('table tbody tr').count();
  console.log(`table: ${rows} row(s)`);
  if (rows < 2) note(`the compare table drew ${rows} rows; the fixture has 2 flats to compare`);
  await page.screenshot({ path: resolve(SHOTS, 'web-table.png'), fullPage: true });
}

async function checkMap({ page }: Stage): Promise<void> {
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
}

/** Triage opens as a table, not as cards — the pile is mostly a "no" you can see from one row,
 *  which is the whole reason it has a layout of its own. So this asserts rows, then flips to
 *  cards, because "shows the right number" in one layout says nothing about the other. */
async function checkTriage({ page }: Stage): Promise<void> {
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
  const ticks = page.locator('.triage table tbody tr .tick');
  await ticks.first().click();
  if (!(await rate.isEnabled())) note('the bulk-rate buttons stayed dead after ticking a row');

  // Shift-picking a run, from the box rather than the row: the box was the half that was broken,
  // and it was broken while the row beside it worked, so a check that only drives one of the two
  // says nothing about the other. Four rows, and the box's own `aria-checked` as well as the
  // count — a row that is in the selection while drawing itself unticked is the failure this had.
  if ((await ticks.count()) >= 4) {
    await ticks.nth(3).click({ modifiers: ['Shift'] });
    const selected = await page.locator('.triage-bar .dim').first().textContent();
    if (selected?.trim() !== '4 selected') {
      note(`shift-ticking the fourth row read "${selected?.trim()}", not "4 selected"`);
    }
    for (const i of [0, 1, 2, 3]) {
      if ((await ticks.nth(i).getAttribute('aria-checked')) !== 'true') {
        note(`row ${i + 1} of the shift-picked run draws itself unticked`);
      }
    }
    // Put the pile back the way it was found. Nothing below writes, but a harness that leaves four
    // flats selected leaves the next assertion reading a state this one invented.
    for (const i of [0, 1, 2, 3]) await ticks.nth(i).click();
    const cleared = await page.locator('.triage-bar .dim').first().textContent();
    if (cleared?.trim() !== 'Nothing selected') {
      note(`unticking the run left "${cleared?.trim()}"`);
    }
  }

  await page.locator('.triage-layout').click();
  // Scoped to the pile: `article.card` is the shortlist's card too, and an unscoped count here
  // quietly included whatever else the page had rendered.
  const triageCards = await page.locator('.triage article.card').count();
  console.log(`triage as cards: ${triageCards}`);
  if (triageCards !== fixture.unratedCount) {
    note(`triage's card layout shows ${triageCards}; the fixture has ${fixture.unratedCount} unrated`);
  }
  // The card layout keeps its own way out to the listing, at the foot of every card's detail.
  const cardExits = await page.locator('.triage article.card .rightmove-link').count();
  if (cardExits !== triageCards) {
    note(`${cardExits} of ${triageCards} triage cards offer a link to Rightmove`);
  }

  // Back to the table for the click the pile is actually worked by. The address used to be the
  // Rightmove link, which made the most obvious thing to click in triage the one that left the
  // site; it now opens the flat's own card in place, beneath its row, so working the pile never
  // leaves it. Counting rows says nothing about where they point, so both are read here.
  //
  // Reopened rather than toggled back with the layout button, which is one button in two states
  // and would leave this depending on how many times it had been pressed above. A fresh triage
  // page is the table by default, which is the layout this asserts about.
  await openView(page, 'triage');
  const rowExit = await page.locator('.triage table tbody tr .rightmove-link').first().getAttribute('href');
  if (!rowExit?.startsWith('https://www.rightmove.co.uk/')) {
    note(`the first triage row's Rightmove link points at "${rowExit}"`);
  }
  const address = page.locator('.triage table tbody tr .compare-open').first();
  const href = await address.getAttribute('href');
  // `#card-<id>`, digits — the shape the shortlist's own hash reader accepts on a cold load. The
  // click below expands in place rather than following it, but the href still has to be the deep
  // link, so a looser pattern here would pass on a link that does nothing pasted into a fresh tab.
  if (href === null || !/^#card-\d+$/.test(href)) {
    note(`the first triage row's address points at "${href}", not at a #card-<digits> deep link`);
  } else {
    const card = page.locator(`.triage .compare-expanded-row article${href}`);
    if ((await card.count()) > 0) note(`a triage card was already open at ${href} before any click`);
    await address.click();
    await settle(page);
    // In place, under its own row — still on the triage view, not jumped to the shortlist.
    if (!(await page.locator('.triage table').first().isVisible())) {
      note(`opening a triage row left the triage table`);
    }
    if ((await card.count()) === 0) note(`clicking a triage row opened no ${href} card in place`);
    else if (!(await card.isVisible())) note(`the ${href} card opened in place but is not visible`);
    console.log(`triage row expands ${href} in place`);

    // Clicking the same address again shuts it — the pile you are working is not left holding open
    // cards you have already read past.
    await address.click();
    await settle(page);
    if ((await card.count()) > 0) note(`clicking a triage row's address twice left ${href} open`);

    // And the same address arrived at cold, which is the half the click cannot reach: the click
    // expands in place and never goes near the hash reader, so everything above passes whether or
    // not the hash means anything on load. This is the promise the link makes — send it to the
    // other laptop, open it a week later — and a different piece of code keeps it.
    //
    // A new tab rather than `goto` on this one, which is what this was first and which asserted
    // nothing: the click above had already left the URL at `/`, so navigating to `/#card-…` differs
    // only by fragment, and a browser answers that without reloading. The state the click had just
    // built survived, the pile was already open, and the check passed with the hash reader deleted.
    const fresh = await page.context().newPage();
    try {
      await fresh.goto(`${ORIGIN}/${href}`, { waitUntil: 'domcontentloaded' });
      // The shell, then the reads, then the card, in that order — the same order `openView` uses,
      // and the order is the point. Going straight to the card passed here and failed on CI, and
      // going straight to `settle` would have the same hole: it asks whether anything says
      // "Working…", and on a tab that has not mounted yet nothing does. `waitForApp` also means a
      // website that renders nothing at all says so, instead of reaching us as a missing card.
      await waitForApp(fresh);
      await settle(fresh);
      const cold = fresh.locator(`article${href}`);
      // Unrated and rejected piles start shut on a fresh load, so waiting for *visible* is the whole
      // assertion: the card exists only if the hash was read, and is visible only if that opened the
      // pile it is in.
      const arrived = await cold
        .waitFor({ state: 'visible', timeout: 20_000 })
        .then(() => true)
        .catch(() => false);
      if (arrived) console.log(`${href} opens that card from cold`);
      else if ((await fresh.locator('[data-testid="signed-out"]').count()) > 0) {
        note(`loading ${href} in a new tab landed on the sign-in screen`);
      } else if ((await cold.count()) === 0) note(`loading ${href} in a new tab drew no such card`);
      else note(`loading ${href} in a new tab left it in a shut pile`);
    } finally {
      await fresh.close();
    }
  }
}

/** The remaining tabs. Shallow on purpose — each is one navigation and one landmark, which is
 *  enough to catch the failure these actually have: a screen that throws on mount, or renders its
 *  frame around a query that errored, and so appears as a heading with nothing under it. A tab
 *  that has never been opened by anything is the one that breaks silently for a month.
 *
 *  Settings and Project also read the fixture's own rows, so the landmark is a value rather than a
 *  heading wherever there is one to name: `Work` is a place this fixture created, and the two
 *  members are the two accounts it created. */
async function checkTabs({ page }: Stage): Promise<void> {
  for (const [view, landmarks] of [
    // `The in-laws` rather than `Work`: this is matched against the whole tab's text, and "Work" is
    // inside "Working…", so it would report a screen still loading as a screen that had rendered
    // its places.
    ['settings', ['Places we measure against', 'The in-laws', 'Neighbourhoods we search', 'Hampstead']],
    ['project', ['Who is in it', OTHER_NAME, 'Invite someone']],
    ['sweep', ['Scan']],
    ['install', ['Install the browser extension']],
  ] as const) {
    await openView(page, view);
    // Case-insensitively, because `innerText` returns text as *rendered* and these headings are
    // uppercased in CSS. Matching the source's capitalisation reported every one of them missing
    // from a screen that was drawing them perfectly well.
    const text = (await page.locator('.wrap').innerText()).toLowerCase();
    const missing = landmarks.filter((l) => !text.includes(l.toLowerCase()));
    console.log(`${view}: ${missing.length === 0 ? 'ok' : `missing ${missing.join(', ')}`}`);
    for (const l of missing) note(`the ${view} tab never rendered "${l}"`);
    await page.screenshot({ path: resolve(SHOTS, `web-${view}.png`), fullPage: true });
  }
}

/** The two refusals a person actually meets, and which sentence each one gets.
 *
 *  Every refusal on this screen has wording of its own — that is the design note at the top of
 *  `SignIn.tsx`, and it is the whole reason the screen is as long as it is. Nothing checked it, so
 *  a regression that collapsed them all into "Something went wrong" would have passed every check
 *  in this repo while making the screen useless: the person who mistyped a code and the person
 *  whose invite expired need different next actions, and neither can guess. `check:rls` covers the
 *  server saying no; this is the screen saying why.
 *
 *  Two, not five. `already-registered` would need an account this fixture then has to work around,
 *  and `rate-limited` means deliberately hammering the endpoint `joining` depends on. These are the
 *  two that cost nothing and can be provoked honestly. */
async function checkRefusals({ browser }: Stage): Promise<void> {
  const { page, close } = await signedOutPage(browser);
  try {
    // A wrong password against an address that definitely exists. The sentence is deliberately
    // two-sided — Supabase answers a wrong password and an unknown address identically, and saying
    // "wrong password" would make this form an oracle for who has an account — so the assertion is
    // on the part that carries that: it names both possibilities.
    await page.locator('.signin input[type="email"]').fill(FIXTURE_EMAIL);
    await page.locator('.signin input[type="password"]').fill('not-the-fixture-password');
    await page.locator('.signin button.primary').click();
    await expectNotice(page, 'do not match an account', 'a wrong password');

    // A wrong code, against an address nobody invited — not against the invite `joining` is about
    // to use. Guessing is rate-limited in the database, and spending an attempt on the live code
    // would make this check the reason the next one fails.
    await page.getByRole('button', { name: 'I have an invite code' }).click();
    await page.locator('.signin input[type="email"]').fill('smoke-fixture-nobody@example.test');
    await page.locator('.signin input[type="password"]').fill(REDEEM_PASSWORD);
    await page.locator('.signin input[placeholder="ABCD-EFGH-JKMN"]').fill('ZZZZ-ZZZZ-ZZZZ');
    await page.locator('.signin button.primary').click();
    await expectNotice(page, "isn’t right for that address", 'a code nobody was sent');
  } finally {
    await close();
  }
}

/** Invite somebody, redeem the code in a signed-out browser, and end up in the house hunt.
 *
 *  The nearest thing this product has to signing up, and until this harness the only path into it
 *  that nothing exercised: an invite is minted, the code is typed in with a chosen password, and
 *  the account that comes out is the caller's own.
 *
 *  Worth having as a browser check rather than as a call to the function, because it is four
 *  things in a row that each look fine alone — `create_invite` mints and hashes, `redeem_code`
 *  checks the code against the address, the `password` function makes the account (it is the only
 *  unauthenticated endpoint in the system), and `consume_invites()` turns the invite into a
 *  membership at exactly one moment. A break anywhere in that chain leaves an invited person
 *  holding an account in no project, which is a state the shortlist has a screen for and nobody
 *  would otherwise notice. */
async function checkJoining({ browser }: Stage): Promise<void> {
  const invite = await createInvite(fixture.session, REDEEM_EMAIL);
  if (invite.status !== 'invited' || !invite.code) {
    note(`inviting ${REDEEM_EMAIL} answered "${invite.status}" with no code — nothing to redeem`);
    return;
  }
  console.log(`invited ${REDEEM_EMAIL}, code ${invite.code}`);

  // A context of its own rather than the one the refusals used: those leave the screen in redeem
  // mode with a notice up, and this starts by pressing a button that only exists in the other mode.
  // A context each is also what lets either section be run without the other.
  const { page, offline, close } = await signedOutPage(browser);

  try {
    // Signing in is the default door; redeeming is the other one. If this button is ever renamed
    // the check should fail rather than quietly fill the sign-in form with a code it has nowhere
    // to put — hence matching the words a person reads.
    await page.getByRole('button', { name: 'I have an invite code' }).click();

    await page.locator('.signin input[type="email"]').fill(REDEEM_EMAIL);
    await page.locator('.signin input[type="password"]').fill(REDEEM_PASSWORD);
    await page.locator('.signin input[placeholder="ABCD-EFGH-JKMN"]').fill(invite.code);
    await page.locator('.signin button.primary').click();

    // Wait for the sign-in screen to *go*, which is the only signal that means what it says.
    // Redeeming deliberately does not mint a session — the screen signs in straight afterwards with
    // the password just chosen — so this is two round trips through two Edge Functions, and neither
    // the spinner class `settle()` watches nor a success notice ever appears. Waiting on anything
    // else reads the button mid-flight, still saying "Checking…", and calls it a failure.
    await page
      .locator('.signin')
      .waitFor({ state: 'detached', timeout: 60_000 })
      .catch(() => {});
    await settle(page);

    if (await page.locator('.signin').count()) {
      const said = (await page.locator('.notice').allInnerTexts().catch(() => [])).join(' | ');
      note(`redeeming an invite left the sign-in screen up — ${said || 'with nothing said'}`);
      await page.screenshot({ path: resolve(SHOTS, 'web-join-failed.png'), fullPage: true });
      return;
    }

    // Signed in — but a redeemed invite that did not become a *membership* leaves an account in no
    // project, which renders as its own screen and is exactly what `consume_invites()` exists to
    // prevent. That is the half worth asserting.
    if (await page.locator('[data-testid="no-project"]').count()) {
      note('the invitee signed in but is in no house hunt — consume_invites did not run');
    }
    const text = await page.locator('.wrap').innerText();
    if (!text.includes('Smoke fixture hunt')) {
      note('the invitee is signed in but not in the project they were invited to');
    }
    console.log('joining: invited, redeemed, signed in, and in the house hunt');
    await page.screenshot({ path: resolve(SHOTS, 'web-joined.png'), fullPage: true });
    console.log(offline());
  } finally {
    await close();
  }
}

/** A browser that is genuinely signed out, sitting on the sign-in screen.
 *
 *  A context of its own every time, rather than another page in the main one: `localStorage` is per
 *  origin and shared by every page in a context, so the session planted at the top is visible
 *  everywhere in there — a sign-in screen looked at from that context is a sign-in screen looked at
 *  while signed in, which is to say not one at all. */
async function signedOutPage(
  browser: Browser,
): Promise<{ page: Page; offline: () => string; close: () => Promise<void> }> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
  const offline = await keepOffline(context, { allow: ALLOW });
  const page = await context.newPage();
  page.on('pageerror', (e) => note(`pageerror (signed out): ${e.message}`));

  await page.goto(ORIGIN, { waitUntil: 'domcontentloaded' });
  await page.locator('.signin').waitFor({ timeout: 60_000 });
  return { page, offline, close: () => context.close() };
}

/** Wait for the screen to say something, and say what it said when it says the wrong thing. */
async function expectNotice(page: Page, expected: string, what: string): Promise<void> {
  const notice = page.locator('.signin .notice');
  await notice.first().waitFor({ timeout: 30_000 }).catch(() => {});
  const said = (await notice.allInnerTexts().catch(() => [])).join(' | ');
  if (!said.includes(expected)) {
    note(`${what} was answered with "${said || 'nothing at all'}", which does not say why`);
    return;
  }
  console.log(`refusal: ${what} → its own sentence`);
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

/** Poll a database read until it says what the screen already claims, and return whatever it last
 *  said either way.
 *
 *  The verdict mutation is optimistic, so the click resolves the moment the card repaints and the
 *  round trip lands some milliseconds later. Reading once would be a race with no error message:
 *  green on a slow laptop, "the database holds nothing" on a fast one. Returning the last read
 *  rather than throwing keeps the failure legible — the caller says which field is wrong. */
async function settleOn<T>(
  read: () => Promise<T>,
  done: (value: T) => boolean,
  attempts = 20,
): Promise<T> {
  let last = await read();
  for (let i = 1; i < attempts && !done(last); i++) {
    await new Promise((r) => setTimeout(r, 250));
    last = await read();
  }
  return last;
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
  // Before the build rather than after it, so a port somebody else holds costs a second instead of
  // a minute — and so nothing is built for a server that is not going to be started.
  await demandFreePort(PORT, 'the website under test');

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
    // In a process group of its own, so `stopTree` can take the `next start` underneath pnpm with
    // it. Signalling pnpm alone leaves the server holding the port, and the run after this one
    // then asserts against it — see `tools/servers.ts`.
    detached: true,
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
  // The caller never got a handle on this one, so its `finally` cannot stop it and this is the only
  // place that can.
  stopTree(child);
  throw new Error(`the website did not come up on ${ORIGIN} within 120s`);
}
