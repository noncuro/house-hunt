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
import { lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { chromium, type Browser, type ConsoleMessage, type Locator, type Page } from 'playwright';
import {
  createInvite,
  offMarketReason,
  setOffMarketDirectly,
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
import { checkArchiveIsComplete } from './manifest-paths';

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
  { name: 'headers', run: checkHeaders },
  { name: 'session', run: checkSession },
  { name: 'list', run: checkList },
  { name: 'rating', run: checkRating },
  { name: 'funnel', run: checkFunnel },
  { name: 'offmarket', run: checkOffMarket },
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

/** The Content-Security-Policy a built app actually serves.
 *
 *  `next dev` is granted `'unsafe-eval'` because React's development build calls `eval()`, and the
 *  grant is keyed on the build phase. It used to be keyed on `NODE_ENV`, which Next preserves when
 *  it is set explicitly — so a host that exported `NODE_ENV=development` for any reason of its own
 *  put `'unsafe-eval'` into a production artifact, and nothing anywhere said so. This harness
 *  serves a production build, which makes it the one place that can read the real header back.
 *
 *  Ahead of `session` because a header is served before anything renders, and because a CSP that
 *  is wrong makes every section below it lie in one direction or the other.
 *
 *  Fetched rather than navigated to. Driving the shared page here reloaded the shortlist out from
 *  under every section after it, and `list` then reported the fixture's own rated flats missing —
 *  a harness that breaks the thing it is measuring, which is the failure this file is least able
 *  to spot in itself. */
async function checkHeaders({ page }: Stage): Promise<void> {
  const response = await page.request.get(`http://127.0.0.1:${PORT}/`);
  const csp = response.headers()['content-security-policy'];
  if (!csp) {
    note('the website served no Content-Security-Policy at all');
    return;
  }
  console.log(`headers: CSP present, ${csp.length} chars`);
  if (csp.includes('unsafe-eval')) {
    note(`the production CSP grants 'unsafe-eval' — the dev-server grant has leaked into a build`);
  }
  // The tiles and the photos both load cross-origin, and both were missing from this header once.
  for (const origin of ['https://tile.openstreetmap.org', 'https://media.rightmove.co.uk']) {
    if (!csp.includes(origin)) note(`the CSP's img-src does not allow ${origin}`);
  }
}

/** Signed in at all, and as whom. Loudly, and first: every other section would pass against a
 *  perfectly rendered sign-in form. */
async function checkSession({ page }: Stage): Promise<void> {
  if (await page.locator('.signin, [data-testid="signed-out"]').count()) {
    note('the website is showing the sign-in view despite a valid session');
  }
  // Who you are moved into the account menu in the redesign — the header row carries initials, and
  // the name is one click away. So this opens it, which also asserts the menu works at all: it is
  // the only route to signing out.
  await page.locator('[data-testid="shell"] .shell-account .menu-button').click();
  const menu = await page.locator('[data-testid="shell"] .menu-panel').innerText();
  if (!menu.includes(FIXTURE_NAME)) {
    note(`the account menu never names the signed-in user (${FIXTURE_NAME}) — is this really a session?`);
  }
  if (!(await page.locator('[data-testid="account-sign-out"]').count())) {
    note('the account menu offers no way to sign out');
  }
  await page.keyboard.press('Escape');
}

/** Places, in its default rendering: every flat the hunt has, three across, grouped by verdict.
 *
 *  Every flat, not two. The cards, the table and the map used to start with the unrated and rejected
 *  piles hidden and each kept its own pair of switches for them, so the toolbar said one number and
 *  the screen drew a different set. One lens over all four renderings now, and it starts at
 *  Everything — which is a number the fixture decides. */
async function checkList({ page }: Stage): Promise<void> {
  // Places opens on the shortlist, not on the whole hunt. The two flats the fixture rates are the
  // two the `enter_funnel` trigger puts there, so this asserts the default lens and that trigger at
  // once — and it is the assertion that fails if the screen ever goes back to opening on everything,
  // which on a swept project is hundreds of listings nobody has looked at.
  const cards = await page.locator('[data-testid="flat-card"]').count();
  const shortlisted = await openLens(page, 'shortlisted');
  console.log(`places: ${cards} card(s) by default, at "shortlisted"`);
  if ((await page.locator('[data-testid="lens-shortlisted"]').getAttribute('aria-pressed')) !== 'true') {
    note('Places did not open on the shortlist');
  }
  if (cards !== shortlisted) {
    note(`the shortlisted chip says ${shortlisted} and the screen drew ${cards}`);
  }
  if (await page.locator('[data-testid="lens-all"]').count()) {
    note('the toolbar still offers an "everything" chip');
  }
  for (const id of [fixtureId(1), fixtureId(4)]) {
    if (!(await page.locator(`#card-${id}`).count())) note(`${id} is rated, so it should be shortlisted`);
  }

  // And the flats outside the funnel, which is where the unrated ones sit and is the other half of
  // the hunt. Reached only by its chip now, so a chip that counted one thing and drew another would
  // leave those flats unreachable rather than merely miscounted.
  const outside = await openLens(page, 'none');
  const drawn = await page.locator('[data-testid="flat-card"]').count();
  if (drawn !== outside) note(`the not-in-the-funnel chip says ${outside} and the screen drew ${drawn}`);
  for (const id of [fixtureId(2), fixtureId(5)]) {
    if (!(await page.locator(`#card-${id}`).count())) note(`${id} is in no funnel step but is not drawn there`);
  }
  await openLens(page, 'shortlisted');

  // The shortlist read is the whole point: a card that rendered with no price or no address is a
  // join that half-worked, which looks like a design choice rather than a bug.
  const first = page.locator(`#card-${fixtureId(1)}`);
  const firstText = await first.innerText();
  for (const expected of ['Flask Walk', '£2,600 pcm']) {
    if (!firstText.includes(expected)) note(`the card for ${fixtureId(1)} is missing "${expected}"`);
  }

  // The verdict chips are the other kind of lens, and they cut across the funnel rather than along
  // it: "the ones we loved" is a complete answer to what you want on screen and is not a step.
  const lovedSays = await openLens(page, 'excited');
  const narrowed = await page.locator('[data-testid="flat-card"]').count();
  console.log(`places: ${narrowed} card(s) at "Loved"`);
  if (narrowed !== 1) note(`filtering to Loved drew ${narrowed} cards; the fixture loves exactly 1`);
  if (lovedSays !== narrowed) note(`the Loved chip says ${lovedSays} over ${narrowed} cards`);
  if (await page.locator(`#card-${fixtureId(2)}`).count()) {
    note(`${fixtureId(2)} is not loved but survived the Loved chip`);
  }
  // Pressing the chip you are on does nothing, deliberately: there is no everything to fall back to
  // and a control that empties the screen when pressed twice is worse than one that ignores you.
  await page.locator('[data-testid="lens-excited"]').click();
  await settle(page);
  if ((await page.locator('[data-testid="flat-card"]').count()) !== narrowed) {
    note('clicking the chip that is already on changed what the screen shows');
  }
  await openLens(page, 'shortlisted');

  await page.screenshot({ path: resolve(SHOTS, 'web-list.png'), fullPage: true });

  // And the same screen on a phone, which is where a shortlist is actually read — standing outside
  // the building, deciding whether to bother. Nothing else here narrows the window, so the whole
  // mobile layout rested on a media query no check ever evaluated. What is asserted is the one
  // failure that makes a page unusable rather than merely ugly: content wider than the window, which
  // gives every vertical scroll a sideways drift and pushes the toolbar half off screen.
  await page.setViewportSize({ width: 390, height: 844 });
  await settle(page);
  const overflow = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    window: document.documentElement.clientWidth,
  }));
  if (overflow.scroll > overflow.window + 1) {
    note(`on a 390px window the page is ${overflow.scroll}px wide, so it scrolls sideways`);
  }
  const shellWidth = await page.locator('[data-testid="shell"]').evaluate((el) => el.getBoundingClientRect().width);
  if (shellWidth > 391) note(`the shell is ${Math.round(shellWidth)}px wide in a 390px window`);
  await page.screenshot({ path: resolve(SHOTS, 'web-list-phone.png'), fullPage: true });
  await page.setViewportSize({ width: 1280, height: 1000 });
  await settle(page);
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
  const NEW_NOTE = 'Smoke: raised to loved.';
  const panel = await openFlat(page, fixtureId(4));
  if (!panel) return;

  // The note first, then the rating: the buttons pass the note themselves, precisely so that
  // leaving the field to click a rating does not race two saves. Typing it after would be testing
  // the blur path, which is a different write.
  await panel.locator('.note-edit').fill(NEW_NOTE);
  await panel.locator('[data-testid="rate-love"]').click();

  // What a person would see: the line now reads "Love it", and it is attributed to whoever clicked.
  await panel
    .locator('[data-testid="verdict-rating"]')
    .filter({ hasText: ratingOf('love').label })
    .waitFor({ timeout: 10_000 })
    .catch(() => note(`the flat never showed the new rating after clicking ${ratingOf('love').label}`));
  const by = await panel.locator('[data-testid="verdict-by"]').innerText();
  if (!by.includes(FIXTURE_NAME)) {
    note(`the re-rated flat is attributed to "${by}", not to ${FIXTURE_NAME} who clicked it`);
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
  // anonymous — which is why the check above, on what the panel actually renders, is the other half
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

  await closeFlat(page);
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
  const before = await verdictOf(id);
  if (!before) {
    note(`${id} has no verdict, so it should not be in the funnel at all`);
    return;
  }

  // The chips Places is filtered by. They are the funnel's only presence on a screen that is not
  // showing one flat, and every step is drawn including the empty ones.
  if (!(await page.locator('[data-testid="funnel"]').count())) note('Places has no funnel chips');
  for (const stage of ['shortlisted', 'enquired', 'viewing_booked', 'viewed', 'offer_made']) {
    if (!(await page.locator(`[data-testid="lens-${stage}"]`).count())) {
      note(`the funnel row is missing its "${stage}" chip`);
    }
  }

  const panel = await openFlat(page, id);
  if (!panel) return;

  await panel.locator('[data-testid="stage-enquired"]').click();
  await panel
    .locator('[data-testid="stage-now"]')
    .filter({ hasText: 'Reached out' })
    .waitFor({ timeout: 10_000 })
    .catch(() => note('the flat never showed the new stage after clicking Reached out'));

  const moved = await settleOn(() => stageOf(id), (st) => st?.stage === 'enquired');
  if (moved?.stage !== 'enquired') {
    note(`the database holds "${moved?.stage ?? 'nothing'}" for ${id}, not enquired`);
  }
  if (moved?.setBy !== fixture.userId) {
    note(`the move is attributed to ${moved?.setBy ?? 'nobody'}, not to whoever clicked`);
  }

  // Archiving is the one step that asks why, and nothing is written until it is answered.
  await panel.locator('[data-testid="stage-archived"]').click();
  await panel.locator('[data-testid="archive-gone"]').click();
  const archived = await settleOn(() => stageOf(id), (st) => st?.stage === 'archived');
  console.log(`stage: ${archived?.stage} (${archived?.archiveReason ?? 'no reason'})`);
  if (archived?.archiveReason !== 'gone') {
    note(`${id} was archived with reason "${archived?.archiveReason ?? 'none'}"; the click said gone`);
  }

  const after = await verdictOf(id);
  if (after?.rating !== before.rating) {
    note(
      `archiving changed the rating from "${before.rating}" to "${after?.rating ?? 'nothing'}" — the two must move apart`,
    );
  }

  await closeFlat(page);

  // The board draws the same fact as a layout rather than as a filter over one, which makes it the
  // rendering that could disagree with the chips without anybody noticing.
  await openView(page, 'board');
  const archivedColumn = page.locator('[data-testid="board-archived"] .board-card');
  if ((await archivedColumn.count()) === 0) {
    note('the board drew nothing in its archived column after a flat was archived');
  }
  await page.screenshot({ path: resolve(SHOTS, 'web-board.png'), fullPage: true });
  await openView(page, 'list');
}

/** Off the market: the flat moves to Archived, and nothing else about it moves.
 *
 *  Both halves are the point. A hunt's own shortlist going on offering places that are gone is what
 *  this was reported as; and the mark is written into the table the verdict-score model reads, so a
 *  version of it that also touched the verdict or the stage would be teaching the model that a flat
 *  you loved and lost was one you never liked. Nothing on screen would say so, which is why the
 *  verdict and the stage are read from Postgres either side of the click.
 *
 *  It used to vanish from every view behind a "1 off the market, hidden" note with a button to show
 *  them again — a third place to look, for the one fact that already has a name people use for it.
 *  It is drawn under Archived now, so what is asserted is a move: gone from the shortlist, present
 *  under the chip, and the two facts underneath it unchanged.
 *
 *  Runs against the first flat, which the fixture loves and which the funnel trigger therefore
 *  shortlists — so there is a lens for it to leave. Ends by putting it back, because the sections
 *  after this one count what is on screen. */
async function checkOffMarket({ page }: Stage): Promise<void> {
  await openView(page, 'list');
  const id = fixtureId(1);
  const card = page.locator(`#card-${id}`);
  const before = { verdict: await verdictOf(id), stage: await stageOf(id) };
  if (!before.verdict) {
    note(`${id} has no verdict, so it cannot be marked off the market`);
    return;
  }
  const archivedBefore = Number(
    (await page.locator('[data-testid="lens-archived"] .chip-count').innerText()).trim(),
  );

  const panel = await openFlat(page, id);
  if (!panel) return;
  await panel.getByRole('button', { name: 'Mark off the market' }).click();
  await closeFlat(page);

  await card
    .waitFor({ state: 'detached', timeout: 10_000 })
    .catch(() => note('the card was still on the shortlist after being marked off the market'));

  // Under Archived, and counted there. A flat that leaves one lens without arriving in another is
  // indistinguishable from the shortlist having lost it, which is the failure the old note existed
  // to paper over.
  const archivedNow = await openLens(page, 'archived');
  if (archivedNow !== archivedBefore + 1) {
    note(`the archived chip went from ${archivedBefore} to ${archivedNow} for one flat marked gone`);
  }
  if (!(await card.count())) note(`${id} is off the market but is not drawn under Archived`);

  // All four renderings read the same list, so the table under this chip has to hold it too — one
  // rendering still filing it elsewhere is the same bug in another view.
  await openView(page, 'table');
  await openLens(page, 'archived');
  const rows = await page.locator('table.compare tbody tr').count();
  if (rows !== archivedNow) note(`the table drew ${rows} rows under an Archived chip saying ${archivedNow}`);
  await openView(page, 'list');

  const reason = await settleOn(() => offMarketReason(id), (r) => r !== null);
  if (reason === null) note(`${id} is drawn as gone but has no training_exclusion row`);

  // The two facts that must not have moved. The stage especially: it is still shortlisted, and the
  // flat is being drawn under Archived anyway — that gap is the whole design, and a version that
  // closed it by writing the stage would be overwriting somebody's account of what happened.
  const after = { verdict: await verdictOf(id), stage: await stageOf(id) };
  if (after.verdict?.rating !== before.verdict.rating) {
    note(
      `marking off the market changed the rating from "${before.verdict.rating}" to "${after.verdict?.rating ?? 'nothing'}"`,
    );
  }
  if ((after.stage?.stage ?? null) !== (before.stage?.stage ?? null)) {
    note(
      `marking off the market changed the stage from "${before.stage?.stage ?? 'none'}" to "${after.stage?.stage ?? 'none'}"`,
    );
  }
  console.log(
    `off the market: drawn under Archived, still ${after.verdict?.rating} and still ${after.stage?.stage ?? 'unstaged'}`,
  );

  // And back where it was, by its own stage rather than to wherever it was last seen. Reached
  // under Archived, because that is where it is until it comes back — `openView` above navigated,
  // which puts the lens back to the default the way a reload does.
  await openLens(page, 'archived');
  const back = await openFlat(page, id);
  if (back) {
    await back.getByRole('button', { name: 'Back on the market' }).click();
    await closeFlat(page);
  }
  const cleared = await settleOn(() => offMarketReason(id), (r) => r === null);
  if (cleared !== null) note(`${id} is still excluded after being put back on the market`);
  await openLens(page, 'shortlisted');
  if (!(await card.count())) note(`${id} did not come back to the shortlist it left`);
}

/** The compare table, which is its own read path and has failed as a blank screen before. */
async function checkTable({ page }: Stage): Promise<void> {
  await openView(page, 'table');
  // Under the chip holding the flats outside the funnel, which is the fixture's largest slice and
  // the only one with enough in it to set two against each other. The table draws whatever the lens
  // leaves, like the other three renderings, so what is checked is that it draws exactly that.
  const said = await openLens(page, 'none');
  const rows = await page.locator('table.compare tbody tr').count();
  console.log(`table: ${rows} row(s) at "not in the funnel"`);
  if (rows !== said) note(`the table drew ${rows} rows under a chip saying ${said}`);

  // The head-to-head, which is what the tick boxes are for and the only place two flats are set
  // against each other. It offers nothing until two are ticked — a button that is live with one
  // picked is a button whose only outcome is a comparison of one thing with itself.
  const ticks = page.locator('table.compare tbody tr .tick');
  await ticks.nth(0).click();
  const one = page.locator('[data-testid="head-to-head"]');
  if (await one.isEnabled()) note('the side-by-side button is live with one flat picked');
  await ticks.nth(1).click();
  if (!(await one.isEnabled())) note('the side-by-side button stayed dead with two flats picked');
  await one.click();
  await settle(page);
  const duel = page.locator('[data-testid="head-to-head-view"]');
  if (!(await duel.count())) note('the side-by-side never opened');
  else {
    // One column per flat, plus the spine of row labels down the left.
    const columns = await duel.locator('thead th').count();
    if (columns !== 3) note(`the side-by-side drew ${columns} header cells for two flats and a spine`);
    // Every row says something. A fact nobody has for a flat is "not rated" or a dash, never the
    // empty cell a component that renders null for absence leaves behind.
    const blank = await duel.locator('tbody td:not(:has(*)):text-is("")').count();
    if (blank > 0) note(`${blank} cell(s) in the side-by-side are blank rather than saying so`);
    await page.screenshot({ path: resolve(SHOTS, 'web-head-to-head.png'), fullPage: true });
    await duel.locator('[data-testid="duel-close"]').click();
    await settle(page);
  }
  // Put the table back the way it was found: the ticks are held above this screen, so leaving two
  // set would leave the next section reading a state this one invented.
  await ticks.nth(0).click();
  await ticks.nth(1).click();

  await page.screenshot({ path: resolve(SHOTS, 'web-table.png'), fullPage: true });
  await openLens(page, 'shortlisted');
}

async function checkMap({ page }: Stage): Promise<void> {
  await openView(page, 'map');
  // The same slice the table used, for the same reason: walking the pins with the arrow keys needs
  // more than one pin to walk to.
  await openLens(page, 'none');
  // The tile layer, not merely the container: an empty map div is what a broken map looks like.
  await page
    .locator('.leaflet-container')
    .waitFor({ timeout: 20_000 })
    .catch(() => note('the map view never rendered a leaflet container'));
  // After the lens, which re-fits the map: tiles for the new viewport arrive over the network and
  // counting them the moment the click returns counts the old ones on their way out.
  await page
    .locator('.leaflet-tile-loaded')
    .first()
    .waitFor({ timeout: 20_000 })
    .catch(() => note('no map tile ever finished loading'));
  const tiles = await page.locator('.leaflet-tile').count();
  console.log(`map: ${tiles} tile(s) loaded`);
  if (tiles === 0) note('the map drew no tiles');

  // How many of these are in this bit of London — the one number a map is being asked for and the
  // one it did not have. It is recomputed on every pan, so a static count would pass here and be
  // wrong the moment anybody moved.
  const inView = await page.locator('[data-testid="map-in-view"]').innerText().catch(() => '');
  if (!/\d+ of \d+ in view/.test(inView)) note(`the map says "${inView}" rather than how many are in view`);

  // Clicking a pin docks the flat at the foot and keeps the map. It used to navigate, which threw
  // away the street you were looking at — so the assertion is both halves: the card arrives, and the
  // map is still there under it.
  const pins = page.locator('.leaflet-interactive');
  if ((await pins.count()) === 0) note('the map drew no pins for a fixture with located flats');
  else {
    await pins.first().click();
    const dock = page.locator('[data-testid="map-dock"]');
    await dock
      .waitFor({ timeout: 10_000 })
      .catch(() => note('clicking a pin docked no card at the foot of the map'));
    if (!(await page.locator('.leaflet-container').isVisible())) {
      note('clicking a pin left the map');
    }
    // The arrow keys walk the pins, which is the whole reason the dock is a dock rather than a
    // panel: one flat after another without going back to a list between them.
    const first = await dock.locator('.flat-address').innerText().catch(() => '');
    await page.keyboard.press('ArrowRight');
    await settle(page);
    const second = await dock.locator('.flat-address').innerText().catch(() => '');
    if (first !== '' && first === second) note('the right arrow key did not move the dock to another pin');
  }

  await page.screenshot({ path: resolve(SHOTS, 'web-map.png') });
}

/** Triage: the pile down the left, the flat itself on the right, and the keys that work it.
 *
 *  It was the compare table with a tick column and a card that expanded under the row you clicked,
 *  which made deciding on a flat a matter of opening it, reading down and collapsing it again. The
 *  work is one flat at a time and always the same three keys. So what is asserted here is the split:
 *  that the pile lists what is waiting, that moving through it changes the pane, that a keystroke
 *  writes a verdict — and that ticking, which is the other half of the job, still batches. */
async function checkTriage({ page }: Stage): Promise<void> {
  await openView(page, 'triage');
  const rows = page.locator('[data-testid="triage-pile"] li');
  const waiting = await rows.count();
  console.log(`triage: ${waiting} unrated in the pile`);
  if (waiting !== fixture.unratedCount) {
    note(`triage lists ${waiting}; the fixture has ${fixture.unratedCount} unrated`);
  }
  // The count line says the same number the pile draws. Two places for one fact is where they drift.
  const counted = await page.locator('[data-testid="triage-count"]').innerText();
  if (!counted.includes(String(waiting))) {
    note(`the triage bar says "${counted.trim()}" over a pile of ${waiting}`);
  }
  await page.screenshot({ path: resolve(SHOTS, 'web-triage.png'), fullPage: true });

  // The pane. One flat is shown from the first frame — a split view that starts empty is a screen
  // asking you to pick before it will help.
  if (!(await page.locator('.triage-pane [data-testid="flat-detail"]').count())) {
    note('triage opened with nothing in its pane');
  }
  const firstShown = await paneAddress(page);

  // `j` moves down the pile. Not a click: the keys are the reason this screen has the shape it has,
  // and a version where only the mouse works is the table again with extra steps.
  await page.locator('.triage-pile').click({ position: { x: 5, y: 5 } }).catch(() => {});
  await page.keyboard.press('j');
  await settle(page);
  const afterJ = await paneAddress(page);
  if (firstShown !== '' && firstShown === afterJ) note('pressing j did not move the pane to the next flat');
  await page.keyboard.press('k');
  await settle(page);
  if ((await paneAddress(page)) !== firstShown) note('pressing k did not come back to the flat j left');

  // The filters, and the rule underneath them: a bar nothing can clear must empty the pile and say
  // so, with the way out still on screen. They are collapsed to one line now, so opening them is
  // part of the assertion — a panel that cannot be reopened is a filter nobody can undo.
  await page.locator('[data-testid="triage-filters-toggle"]').click();
  if (!(await page.locator('[data-testid="triage-filters"]').count())) {
    note('the filter summary did not open its panel');
  }
  await page.locator('[data-testid="filter-max-rent"]').fill('1');
  await settle(page);
  const emptied = await rows.count();
  if (emptied !== 0) note(`a £1 rent filter left ${emptied} in the pile`);
  if (!(await page.locator('[data-testid="triage-filters"]').count())) {
    note('filtering the pile to nothing took the filter panel away with it');
  }
  await page.locator('[data-testid="clear-filters"]').click();
  await settle(page);
  const restored = await rows.count();
  if (restored !== fixture.unratedCount) {
    note(`clearing the filters left ${restored}, not the ${fixture.unratedCount} unrated`);
  }

  // The bulk bar appears when something is ticked, and not before. It used to sit there all session
  // saying "Nothing selected" beside three buttons that write a verdict for the whole hunt.
  if (await page.locator('[data-testid="triage-bulk"]').count()) {
    note('the bulk bar is on screen with nothing ticked');
  }
  const ticks = page.locator('[data-testid="triage-pile"] .tick');
  await ticks.first().click();
  const bulk = page.locator('[data-testid="triage-bulk"]');
  if (!(await bulk.count())) note('ticking a flat did not bring up the bulk bar');

  // Shift-picking a run, from the box: four rows, and each box's own `aria-checked` as well as the
  // count — a row that is in the selection while drawing itself unticked is the failure this had.
  if ((await ticks.count()) >= 4) {
    await ticks.nth(3).click({ modifiers: ['Shift'] });
    const said = (await bulk.innerText()).trim();
    if (!said.startsWith('4 ticked')) note(`shift-ticking the fourth row read "${said}", not "4 ticked"`);
    for (const i of [0, 1, 2, 3]) {
      if ((await ticks.nth(i).getAttribute('aria-checked')) !== 'true') {
        note(`row ${i + 1} of the shift-picked run draws itself unticked`);
      }
    }
    // Put the pile back the way it was found. Nothing below writes, but a harness that leaves four
    // flats ticked leaves the next assertion reading a state this one invented.
    await bulk.getByRole('button', { name: 'Clear' }).click();
    if (await bulk.count()) note('clearing the ticks left the bulk bar up');
  }

  // A withdrawn flat is not work waiting to be done. This is the incident AGENTS.md records —
  // eleven withdrawn listings sitting on a worklist that had already been taught to drop them —
  // and the pile is the one place it hides, because nothing on this screen says which flats are
  // gone: it just reads as three more to get through. Put back afterwards, since every count below
  // and in `tabs` is taken against the fixture as seeded.
  // Written to the database rather than clicked, because there is no button for it: the panel offers
  // the toggle only on a flat somebody liked, so the only thing that marks an *unrated* one gone is
  // the extension noticing the listing has been withdrawn. Reopened by navigating away and back,
  // since the pile is derived from a query this page already holds.
  const withdrawn = fixtureId(3);
  await setOffMarketDirectly(withdrawn, true);
  try {
    await openView(page, 'list');
    await openView(page, 'triage');
    await settle(page);
    const left = await rows.count();
    if (left !== waiting - 1) {
      note(`with ${withdrawn} off the market the pile held ${left}, not ${waiting - 1}`);
    } else console.log(`triage: a withdrawn flat drops out of the pile (${waiting} → ${left})`);
  } finally {
    await setOffMarketDirectly(withdrawn, false);
  }
  await openView(page, 'list');
  await openView(page, 'triage');
  await settle(page);
  const back = await rows.count();
  if (back !== waiting) note(`the pile ended this section at ${back}, not the ${waiting} it started with`);

  // The way out to the listing, at the foot of the pane. A pile you can work without leaving still
  // has to let you leave deliberately.
  const exit = await page
    .locator('.triage-pane .rightmove-link')
    .first()
    .getAttribute('href')
    .catch(() => null);
  if (!exit?.startsWith('https://www.rightmove.co.uk/')) {
    note(`the triage pane's Rightmove link points at "${exit}"`);
  }

  // And the deep link, which is the half no click can reach: `#card-<id>` opens that flat from cold,
  // in a tab that has never had any of this state built up in it. A new tab rather than `goto` on
  // this one — a browser answers a fragment-only navigation without reloading, so the state this
  // section had already built would have survived and the check would pass with the reader deleted.
  const id = fixtureId(2);
  const fresh = await page.context().newPage();
  try {
    await fresh.goto(`${ORIGIN}/#card-${id}`, { waitUntil: 'domcontentloaded' });
    await waitForApp(fresh);
    await settle(fresh);
    const arrived = await fresh
      .locator('[data-testid="flat-panel"]')
      .waitFor({ state: 'visible', timeout: 20_000 })
      .then(() => true)
      .catch(() => false);
    if (arrived) console.log(`#card-${id} opens that flat from cold`);
    else if ((await fresh.locator('[data-testid="signed-out"]').count()) > 0) {
      note(`loading #card-${id} in a new tab landed on the sign-in screen`);
    } else note(`loading #card-${id} in a new tab opened no panel`);
  } finally {
    await fresh.close();
  }
}

/** The address the triage pane is currently showing, or '' when it is showing nothing. Read rather
 *  than remembered, because what the pane shows follows the pile — rating a flat removes it, and the
 *  pane lands on whatever took its place. */
async function paneAddress(page: Page): Promise<string> {
  return (
    (await page
      .locator('.triage-pane .detail-address')
      .first()
      .innerText()
      .catch(() => '')) ?? ''
  ).trim();
}

/** Open one flat's panel from wherever the page is, and hand back a locator scoped to it.
 *
 *  Every write this harness makes goes through here: the verdict buttons, the note, the funnel and
 *  the off-the-market toggle all live in the panel now, which is the point of it — one renderer for
 *  the flat, reached identically from a card, a row, a pin or a link. Returns null and says so
 *  rather than throwing, so one missing flat does not take the rest of a section with it. */
async function openFlat(page: Page, id: string): Promise<Locator | null> {
  if ((await page.locator('[data-testid="flat-panel"]').count()) > 0) await closeFlat(page);
  const card = page.locator(`#card-${id}`);
  if ((await card.count()) === 0) {
    note(`${id} is not on screen, so its panel cannot be opened`);
    return null;
  }
  await card.locator('.flat-address').click();
  const panel = page.locator('[data-testid="flat-panel"]');
  const opened = await panel
    .waitFor({ timeout: 10_000 })
    .then(() => true)
    .catch(() => false);
  if (!opened) {
    note(`clicking ${id} opened no panel`);
    return null;
  }
  await settle(page);
  return panel;
}

async function closeFlat(page: Page): Promise<void> {
  const close = page.locator('[data-testid="panel-close"]');
  if ((await close.count()) === 0) return;
  await close.click();
  await page
    .locator('[data-testid="flat-panel"]')
    .waitFor({ state: 'detached', timeout: 10_000 })
    .catch(() => note('the flat panel would not close'));
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
    // Settings is one person's own now — a display name and the diagnostics. The places moved to
    // Your Hunt, where they belong: `place` is a project table.
    ['settings', ['You appear as']],
    // `The in-laws` rather than `Work`: this is matched against the whole tab's text, and "Work" is
    // inside "Working…", so it would report a screen still loading as a screen that had rendered
    // its places. `Hampstead` is one of the places this hunt searches around, which is the same
    // list now — a project with the neighbourhoods missing renders the destinations and looks fine.
    ['project', ['Who is in it', OTHER_NAME, 'Invite someone', 'The in-laws', 'Hampstead']],
    // Sweeping folded into Triage. `?v=sweep` still lands here — the redirect is deliberate, since
    // the extension and people's bookmarks point at it — so this covers both.
    ['sweep', ['Scan']],
    // The one-liner is built from `window.location.origin` after mount, so the heading says the
    // section rendered; the line itself is asserted on its own below, where it can be compared
    // whole rather than searched for.
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

  await checkOneLiner(page);
  await checkInstallAssets(page);
}

/** The line the reader copies, compared whole.
 *
 *  `includes` was the wrong test: the right command followed by anything at all contains the right
 *  command, so a line that curled the installer and then went on to do something else would have
 *  passed. What is on the clipboard is the entire element, so that is what is read — the element
 *  rather than the tab, because the tab's text has the prose around it. */
async function checkOneLiner(page: Page): Promise<void> {
  await openView(page, 'install');
  const expected = `curl -fsSL "${ORIGIN}/install.sh" | bash -s -- "${ORIGIN}"`;
  const shown = (await page.locator('.install-command code').innerText()).trim();
  console.log(`one-liner: ${shown === expected ? 'ok' : `"${shown}"`}`);
  if (shown !== expected) note(`the install tab draws \`${shown}\` where it should draw \`${expected}\``);
}

/** The two files the install tab hands out, fetched rather than read off disk: they are committed
 *  static assets, and a command that 404s looks exactly like a working one until it is run. The
 *  landmark above only says the line was drawn.
 *
 *  A status code is not enough on its own, and both ways of being wrong are ones a static host
 *  produces by itself. A rewrite rule that swallowed `/install.sh` answers the app's HTML with 200,
 *  which pipes into bash and does nothing anybody asked for; a zip that lost its contents is still
 *  a 200 of some length. So each is opened: the script has to be a script and has to end on the
 *  line that makes a truncated download harmless, and the archive has to be an archive holding the
 *  files its own manifest asks Chrome to load — which is the same question `install.sh` puts to it
 *  before replacing anybody's copy, asked here of the copy actually being served. */
async function checkInstallAssets(page: Page): Promise<void> {
  const response = await page.request.get(`${ORIGIN}/install.sh`);
  console.log(`/install.sh: ${response.ok() ? 'ok' : response.status()}`);
  if (!response.ok()) {
    note(`/install.sh is not served (${response.status()}) — the install tab points people at it`);
  } else {
    const body = await response.text();
    if (!body.startsWith('#!')) note('/install.sh is served but is not a script — no shebang, so something else is answering that path');
    else if (!body.includes('rightmove-house-hunt.zip')) note('/install.sh is served but never mentions the zip — that is not the installer');
    else checkTruncationIsInert(body);
  }

  const archive = await page.request.get(`${ORIGIN}/rightmove-house-hunt.zip`);
  console.log(`/rightmove-house-hunt.zip: ${archive.ok() ? 'ok' : archive.status()}`);
  if (!archive.ok()) {
    note(`/rightmove-house-hunt.zip is not served (${archive.status()}) — the install tab points people at it`);
    return;
  }
  const bytes = await archive.body();
  // The local-file-header signature rather than just `PK`: an archive with nothing in it starts
  // PK\x05\x06, and an empty archive is one of the two things this is here to catch.
  if (bytes.subarray(0, 4).toString('latin1') !== 'PK\x03\x04') {
    note('/rightmove-house-hunt.zip does not begin with a zip entry — an error page, or an archive with nothing in it, looks like this');
    return;
  }

  const saved = resolve(SHOTS, 'served-extension.zip');
  writeFileSync(saved, bytes);
  // The same parser `check:zip` gates the commit with, asked here about the bytes the site actually
  // handed over — which is the only question this harness can answer that the other one cannot.
  const { refs, missing } = checkArchiveIsComplete(saved, (problem) => note(`the served zip: ${problem}`));
  console.log(`served zip: ${refs.length} path(s) referenced, ${missing.length} missing`);
}

/** Every prefix of the installer, run in a scrubbed environment, changing nothing in its sandbox.
 *
 *  `curl | bash` hands bash the bytes as they arrive and bash runs each command the moment it has a
 *  complete one, so a dropped connection executes a prefix of the script — and the prefix that
 *  matters is the one ending just before the new copy is put in place, having already renamed the
 *  old one away. The installer's answer is that everything lives in `main`, called on the last
 *  line, so a prefix defines functions and does nothing.
 *
 *  Checking for a shebang and a closing `main "$@"` does not test that. It says the shape is right;
 *  it cannot see a stray top-level command added in the middle, which is how this gets broken. So
 *  each prefix is run for real, against a sandbox holding a decoy install and a config pointing at
 *  it, and the tree has to come back identical.
 *
 *  What that establishes, exactly, and it is worth being plain because the assertion is narrower
 *  than the sentence it is tempting to write:
 *
 *  - Cuts fall on line boundaries. A real cut falls on a byte, so a prefix ending mid-line is not
 *    covered. Bash would refuse to run most of those as a syntax error, which is the same outcome,
 *    but not all of them and this does not check which.
 *  - A mutation that undoes itself inside a single line — renaming the decoy away and back — leaves
 *    an identical tree and passes, while a download cut between those two commands would strand the
 *    install. Nothing here can see that.
 *  - The tree is compared by path, type, mode, symlink target and a hash of every file's contents,
 *    so a same-length rewrite, a chmod or a re-pointed symlink is caught. Timestamps are not.
 *  - It says nothing about what a prefix does *outside* the sandbox. The environment is scrubbed to
 *    a PATH and a HOME inside it and the working directory is the sandbox, so there is little for a
 *    stray statement to reach or to read, but "did not touch this directory" is the whole claim.
 *
 *  It is affordable because no prefix reaches the network or the disk: each run is bash parsing a
 *  small file, and the sweep costs about two seconds. The final line is excluded — that one is the
 *  whole script, and running it would install the extension, which is the behaviour under test
 *  rather than a violation of it. */
function checkTruncationIsInert(body: string): void {
  const lines = body.split('\n');
  const inert = resolve(SHOTS, 'install-prefix.sh');
  const sandbox = resolve(SHOTS, 'install-sandbox');
  const decoy = resolve(sandbox, 'extension');

  rmSync(sandbox, { recursive: true, force: true });
  mkdirSync(resolve(sandbox, 'config/rightmove-house-hunt'), { recursive: true });
  mkdirSync(decoy, { recursive: true });
  writeFileSync(resolve(decoy, 'manifest.json'), '{"name":"House hunt","version":"0.0.0"}');
  writeFileSync(resolve(decoy, '.rightmove-house-hunt-install'), 'decoy');
  writeFileSync(resolve(sandbox, 'config/rightmove-house-hunt/install.conf'), `dir=${decoy}\n`);
  const before = treeOf(sandbox);

  // The call itself, which is the one line that must never be in a prefix — running it would
  // install into the sandbox, which is the script working rather than the script leaking.
  const call = lines[lines.length - 1] === '' ? lines.length - 2 : lines.length - 1;
  if (lines[call] !== 'main "$@"') {
    note(`install.sh ends on \`${lines[call]}\` rather than \`main "$@"\` — the truncation guard is gone`);
    return;
  }

  // Descending, so the first prefix reported is the longest one that misbehaved — the deepest cut,
  // which is the one that says where the stray statement is.
  for (let cut = call; cut > 0; cut--) {
    writeFileSync(inert, lines.slice(0, cut).join('\n'));
    // The real origin, so a prefix that did reach `main` would genuinely install rather than fail
    // at a download and look inert for the wrong reason.
    // The environment is built rather than inherited. This harness runs in CI, where the real
    // environment holds the tokens CI was given, and handing those to a script whose whole point
    // is that it might contain a statement nobody meant to put there is the wrong way round. PATH
    // because bash needs to find `curl` and the coreutils; HOME and XDG_CONFIG_HOME because the
    // installer reads both and they must land inside the sandbox. The real origin, so a prefix
    // that did reach `main` would genuinely install rather than fail at a download and look inert
    // for the wrong reason.
    spawnSync('bash', [inert, ORIGIN], {
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: sandbox, XDG_CONFIG_HOME: resolve(sandbox, 'config') },
      cwd: sandbox,
      stdio: 'ignore',
      timeout: 10_000,
    });
    if (treeOf(sandbox) !== before) {
      note(`install.sh truncated after line ${cut} of ${call} changed something in its sandbox — a mutating statement is outside \`main\``);
      return;
    }
  }
  console.log(`install.sh: ${call} truncated prefix(es), none changed the sandbox`);
}

/** Every path under a directory with enough about it to notice a change, sorted.
 *
 *  Contents are hashed rather than measured: a size catches a file that grew or shrank and misses
 *  one rewritten to the same length, which is the easiest of these to do by accident. Mode comes
 *  along because a chmod is a change, and a symlink is recorded by where it points rather than
 *  followed — a re-pointed link is otherwise invisible. Timestamps are left out; they move for
 *  reasons that are not this script's doing.
 *
 *  In node rather than `find -exec stat`, whose format flag is `-f` on macOS and `-c` on the Linux
 *  this runs on in CI. */
function treeOf(dir: string): string {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .map((entry) => {
      const path = resolve(dir, entry);
      const found = lstatSync(path);
      const mode = found.mode.toString(8);
      if (found.isSymbolicLink()) return `${entry} link ${mode} ${readlinkSync(path)}`;
      if (found.isDirectory()) return `${entry} dir ${mode}`;
      return `${entry} file ${mode} ${createHash('sha256').update(readFileSync(path)).digest('hex')}`;
    })
    .sort()
    .join('\n');
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
    // The hunt's name lives in the header row now — it is the switcher and the rename as well as
    // the title, so it is the one thing on screen that says which hunt this is.
    const named = await page.locator('[data-testid="shell"]').innerText().catch(() => '');
    if (!named.includes('Smoke fixture hunt')) {
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

/** Narrow Places to one chip, and hand back the number that chip claims.
 *
 *  Sections below need a lens holding the flat they are about, because Places no longer has an
 *  "everything" to fall back on — it opens on the shortlist and every other slice is a chip. The
 *  count comes back so the caller can check the chip against what the screen then draws, which is
 *  the pair that can disagree: a chip counting the whole hunt over a view that has hidden some of
 *  it reads as flats that failed to render. */
async function openLens(page: Page, name: string): Promise<number> {
  const chip = page.locator(`[data-testid="lens-${name}"]`);
  if ((await chip.count()) === 0) {
    note(`Places has no "${name}" chip`);
    return -1;
  }
  const said = Number((await chip.locator('.chip-count').innerText()).trim());
  if ((await chip.getAttribute('aria-pressed')) !== 'true') {
    await chip.click();
    await settle(page);
  }
  return said;
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
