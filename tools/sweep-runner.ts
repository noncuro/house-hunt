/** The whole sweep, on a machine nobody is sitting at: a real Chrome, the real extension, the real
 *  button.
 *
 *  There is no server-side sweep to schedule and there deliberately never will be. `runFullSweep`
 *  is the website's own JavaScript (`apps/web/src/screens/Sweep.tsx` — "it runs while this tab is
 *  open"), and the only thing in the system that may open a Rightmove page is the extension's
 *  `tab:open`, which creates a real background tab and lets the same panel record it that records a
 *  page you opened yourself. So an unattended sweep is not a different mechanism with the browser
 *  taken out; it is the same mechanism with the *press* automated, and this file automates exactly
 *  that one thing. It navigates to the Sweep screen, clicks the button that is already there, and
 *  watches. It knows nothing about hubs, pages, pacing or Rightmove's markup, because the page it is
 *  driving already does.
 *
 *  ---------------------------------------------------------------------------------------------
 *  THIS IS THE ONE FILE IN `tools/` THAT IS MEANT TO REACH RIGHTMOVE, AND IT IS NOT A HARNESS.
 *
 *  `tools/offline.ts` opens "nothing a harness does may reach Rightmove", and every other Playwright
 *  file here obeys it — they serve saved pages and kill DNS for the domain. This one is the product
 *  being run, not a test of it: the pages it opens are the sweep, and blocking them would leave a
 *  script that proves a button is clickable. Do not import `OFFLINE_ARGS` here, and do not copy this
 *  file's launch arguments into a harness.
 *
 *  What keeps it inside the standing rule is unchanged and is the button's argument, not a new one:
 *  it opens the pages one at a time at the opener's configured pace, on hubs somebody chose, for a
 *  hunt they are in. If that pace or that scope is ever widened *because this is automated*, the
 *  rule has been left behind — automation is what removes the person who would have noticed.
 *  ---------------------------------------------------------------------------------------------
 *
 *  Two modes:
 *
 *    pnpm sweep:sign-in     once, by hand, on a machine with a screen — sign in and leave
 *    pnpm sweep             every night, from a timer
 *
 *  The profile is persistent, which is the whole trick. A `launchPersistentContext` directory keeps
 *  both sessions across restarts — the website's in its origin storage, the extension's in
 *  `chrome.storage` where `background.ts` is the only thing that touches it — so the sign-in is a
 *  one-time act and every run after it starts already authenticated. The extension's own heartbeat
 *  refreshes the token while Chrome runs (design D2), and a nightly run is well inside the window.
 *
 *  Updating the extension is not this file's job and does not need to be. Chrome reads an unpacked
 *  extension off disk *at launch*, and `--load-extension` is that read — so a run that relaunches
 *  Chrome picks up whatever `install.sh` last wrote, with none of the `chrome://extensions` clicking
 *  the manual instructions need. `docs/sweep-runner.md` has the systemd unit that does the update
 *  immediately before the launch, which is where a shell step belongs.
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, type Locator, type Page } from 'playwright';

/** Where `install.sh` records the folder it installed into. Read rather than assumed, so the runner
 *  and the installer cannot end up pointing at two different copies of the extension — which is the
 *  stale-unpacked-copy failure AGENTS.md calls the most common bug in this project, and it is worse
 *  here because there is nobody looking at the screen to notice. */
const INSTALL_CONF = join(
  process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'),
  'rightmove-house-hunt',
  'install.conf',
);

/** `install.sh`'s own default on Linux, used only when it has never run. */
const DEFAULT_EXTENSION = join(homedir(), '.local', 'share', 'rightmove-house-hunt');

/** Beside the extension rather than inside it: Chrome rewrites a profile constantly, and the
 *  extension folder is replaced wholesale on every update. */
const DEFAULT_PROFILE = join(homedir(), '.local', 'share', 'rightmove-house-hunt-profile');

/** How long a whole run may take before it is abandoned. A sweep is long by design — every page is
 *  a real navigation at the opener's pace — so this is a stop on a run that has *hung*, not a
 *  schedule. Stopping loses nothing: what was opened is recorded and the rest is there next time. */
const BUDGET_MINUTES = Number(process.env.SWEEP_BUDGET_MINUTES ?? 180);

/** The sign-in screen, in both its spellings — the same pair `smoke:web` asks on. The testid is
 *  the one that matters and the class is what a deployment older than it answers to, which is not
 *  hypothetical here: this drives whatever is currently live, not the checkout it was built from. */
const SIGNED_OUT = '[data-testid="signed-out"], .signin';

/** How long to leave the browser open waiting for a person to sign in. */
const SIGN_IN_MINUTES = Number(process.env.SWEEP_SIGN_IN_MINUTES ?? 15);

const ORIGIN = (process.env.SWEEP_ORIGIN ?? '').replace(/\/$/, '');
const EXTENSION = process.env.SWEEP_EXTENSION ?? installedExtensionDir();
const PROFILE = process.env.SWEEP_PROFILE ?? DEFAULT_PROFILE;
const signInMode = process.argv.includes('--sign-in');

// There is deliberately no default origin, for the reason install.sh gives for the same decision:
// guessing one would sweep somebody else's deployment, and the address is one copy-paste away.
if (!ORIGIN) {
  die(
    'SWEEP_ORIGIN is not set. It is the address of your house hunt — the same origin the Install\n' +
      "tab's one-liner carries, e.g. SWEEP_ORIGIN=https://your-hunt.vercel.app",
  );
}
if (!/^https?:\/\/[^/]+$/.test(ORIGIN)) {
  die(`SWEEP_ORIGIN is "${ORIGIN}", which is not an origin — a scheme, a host, an optional port, and no path.`);
}
if (!existsSync(join(EXTENSION, 'manifest.json'))) {
  die(
    `No extension at ${EXTENSION} (no manifest.json).\n` +
      `Install it first:  curl -fsSL ${ORIGIN}/install.sh | bash -s -- ${ORIGIN}`,
  );
}

const version = extensionVersion();
console.log(`extension  ${EXTENSION} (v${version ?? 'unreadable'})`);
console.log(`profile    ${PROFILE}`);
console.log(`site       ${ORIGIN}`);

const context = await chromium.launchPersistentContext(PROFILE, {
  // Headed. MV3 extensions under `--headless=new` are a fight with nothing at the end of it; on a
  // machine with no screen this runs under `xvfb-run`, which is a display like any other.
  headless: false,
  viewport: { width: 1400, height: 1000 },
  args: [
    `--disable-extensions-except=${EXTENSION}`,
    `--load-extension=${EXTENSION}`,
    // The sweep is `setTimeout` in a page, and these three stop Chrome deciding that page is not
    // worth running on time. Without them a window that nobody is looking at — which is every
    // window here, and under Xvfb there is not even a compositor to say otherwise — gets its
    // timers throttled towards one tick a minute. That does not fail: it produces a sweep that
    // crawls, blows the budget below, and looks from the log like Rightmove being slow.
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--no-first-run',
    '--no-default-browser-check',
  ],
});

let failure: string | null = null;

try {
  // The service worker is `background.ts`, and it is the extension's only session holder. Waiting
  // for it here separates "the extension did not load" from every failure that looks like it.
  const worker =
    context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker', { timeout: 30_000 }));
  console.log(`extension worker up (${new URL(worker.url()).host})`);

  // The persistent context opens with a page already; using it avoids leaving a blank tab behind.
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(`${ORIGIN}/?v=triage`, { waitUntil: 'domcontentloaded' });

  if (signInMode) await signIn(page);
  else await sweep(page);
} catch (e) {
  failure = e instanceof Error ? e.message : String(e);
} finally {
  await context.close();
}

if (failure !== null) {
  console.error(`\n${failure}`);
  process.exit(1);
}

/** Wait for a person to sign in, then leave the profile behind holding both sessions.
 *
 *  The readiness signal is the sweep button itself, which is the strongest one available: it is
 *  rendered only when the *extension* reports `signed-in`, and the extension only learns that
 *  through the bridge on this origin after the website session exists. One condition therefore
 *  proves both halves, and proves them the way the nightly run will need them. */
async function signIn(page: Page): Promise<void> {
  console.log(
    `\nSign in in the browser window — the email address your invite went to.\n` +
      `Waiting up to ${SIGN_IN_MINUTES} minutes, and closing on its own once the extension is signed in too.`,
  );
  try {
    await page
      .locator('[data-testid="full-sweep-go"]')
      .waitFor({ state: 'attached', timeout: SIGN_IN_MINUTES * 60_000 });
  } catch {
    throw new Error(
      'Timed out before the sweep button appeared. That means one of the two sessions is missing:\n' +
        'either the website is still signed out, or the extension is (it has its own session, and\n' +
        'the bridge only hands it over on this origin). The Triage tab says which.',
    );
  }
  console.log(`\nSigned in. The profile at ${PROFILE} now holds both sessions — run \`pnpm sweep\` from a timer.`);
}

/** One full sweep, start to finish. */
async function sweep(page: Page): Promise<void> {
  const go = page.locator('[data-testid="full-sweep-go"]');
  const signedOut = page.locator(SIGNED_OUT);

  // Raced rather than checked in turn. The app renders neither of these until it has read the
  // session, so asking "are we signed out?" the moment the DOM exists always answers no — and the
  // signed-out run then spent the button's full timeout before reporting the wrong thing. Whichever
  // of the two appears is the answer, and it arrives as soon as the app knows it.
  try {
    await page
      .locator(`[data-testid="full-sweep-go"], ${SIGNED_OUT}`)
      .first()
      .waitFor({ state: 'attached', timeout: 60_000 });
  } catch {
    throw new Error(
      `Neither the sweep button nor a sign-in screen appeared within a minute, so the app did not\n` +
        `finish loading. What the page says:\n\n${await sectionText(page)}`,
    );
  }

  // Named rather than left to the generic report below: it is the one failure with a different fix.
  if (await signedOut.count()) {
    throw new Error(
      `Signed out — this profile has no session, so there is nothing to sweep.\n` +
        `Run \`pnpm sweep:sign-in\` once on a machine with a screen; the profile at\n` +
        `${PROFILE} keeps it from then on.`,
    );
  }

  // Past here the app is signed in and the button is either present or deliberately absent. Its
  // four reasons for being absent are already written on the screen in prose, so they are reprinted
  // rather than re-diagnosed: the log and the screen then say the same thing.
  if (!(await go.count())) {
    throw new Error(`The sweep button is not on the page. What the page says instead:\n\n${await sectionText(page)}`);
  }

  if (await go.isDisabled()) {
    throw new Error(
      `The sweep button is there but disabled, which is a hunt that has nothing to sweep:\n\n${(
        await go.innerText()
      ).trim()}`,
    );
  }

  const started = Date.now();
  await go.click();

  const running = page.locator('[data-testid="full-sweep-running"]');
  // `start()` sets the running state synchronously, before any awaiting, so this appears promptly or
  // the click did not land on what we think it did.
  await running.waitFor({ state: 'attached', timeout: 30_000 });
  console.log('\nrunning\n');

  await watch(page, running, started);

  const finished = page.locator('[data-testid="full-sweep-finished"]');
  if (await finished.count()) {
    console.log(`\n${(await finished.innerText()).trim()}`);
    return;
  }
  // The run ended without the summary, which the screen only fails to render when `runFullSweep`
  // threw. Its message is on the page.
  throw new Error(`The sweep ended without finishing. What the page says:\n\n${await sectionText(page)}`);
}

/** Follow a running sweep, printing each phase and each page as it is opened.
 *
 *  Progress rather than silence, because the alternative on a nightly job is a log that says
 *  "running" at 03:00 and "done" three hours later, and no way to tell a slow sweep from a stuck
 *  one — which is precisely the shape the throttling bug above takes. */
async function watch(page: Page, running: Locator, started: number): Promise<void> {
  const deadline = started + BUDGET_MINUTES * 60_000;
  let last = '';

  // The phase and the count, then what is being opened. Read as two elements rather than as the
  // whole running block, whose innerText also contains the Stop button — which is how the log came
  // out as "Scanning Stop London Bridge — page 1".
  const head = running.locator('.rm-open-run-head span').first();
  const at = running.locator('.rm-open-at').first();

  while (await running.count()) {
    if (Date.now() > deadline) {
      throw new Error(
        `Still running after ${BUDGET_MINUTES} minutes, so this is being abandoned. Nothing is lost —\n` +
          'every page already opened was recorded, and the rest is waiting for the next run. If this\n' +
          'keeps happening the run is being throttled or a page is not loading; raise\n' +
          'SWEEP_BUDGET_MINUTES only once you know which.',
      );
    }
    const phase = (await head.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
    const where = (await at.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
    const now = [phase, where].filter(Boolean).join('  ');
    if (now && now !== last) {
      console.log(`  ${elapsed(started)}  ${now}`);
      last = now;
    }
    // Polled rather than subscribed, so this is a sample of the run and not a ledger — the summary
    // at the end is the count that is true. Two seconds because five missed a whole place: the
    // first hub is scanned within a moment of the run reading its progress, well inside one poll.
    await page.waitForTimeout(2_000);
  }
}

/** Whatever the sweep section is currently saying, for a failure message. Its own text and not a
 *  guess at what went wrong: the four reasons the button can be absent are already written there,
 *  in the words somebody will search for.
 *
 *  Falls back outwards — the section, then the screen, then the body — because the case where the
 *  section is missing entirely is exactly the case somebody needs the text for, and reporting
 *  "nothing rendered" about a page that rendered a whole screen sends them looking for a blank page
 *  that does not exist. Truncated, since the fallback is a whole screen. */
async function sectionText(page: Page): Promise<string> {
  for (const selector of ['.sweep-fill', 'main', 'body']) {
    const text = (await page.locator(selector).first().innerText().catch(() => '')).trim();
    if (text) return text.length > 800 ? `${text.slice(0, 800)}\n…` : text;
  }
  return '(the page rendered nothing at all)';
}

function elapsed(since: number): string {
  const seconds = Math.round((Date.now() - since) / 1000);
  return `${String(Math.floor(seconds / 60)).padStart(3)}m${String(seconds % 60).padStart(2, '0')}s`;
}

/** The folder `install.sh` last installed into, or its default when it has never run. `dir=` is the
 *  only key that file has; the parse matches the installer's own `sed -n 's/^dir=//p' | tail -n 1`,
 *  last wins. */
function installedExtensionDir(): string {
  if (!existsSync(INSTALL_CONF)) return DEFAULT_EXTENSION;
  const lines = readFileSync(INSTALL_CONF, 'utf8').split('\n');
  const dirs = lines.flatMap((l) => (l.startsWith('dir=') ? [l.slice('dir='.length).trim()] : []));
  const dir = dirs.at(-1);
  // A conf file that exists but names nothing is not the same as no conf file, and must not be
  // treated as one. Falling back would load a different copy of the extension than the installer
  // last put down — and in the `dir=` with nothing after it case, `resolve('')` is the working
  // directory, which is not an extension at all. Either way the sweep goes on to print a version
  // and run, so the wrong build looks exactly like the right one. A stale unpacked copy is the
  // most common bug in this project and it never looks like one; this is the one place that can
  // still say so.
  if (!dir) {
    die(
      `${INSTALL_CONF} exists but names no dir=.\n` +
        'Reinstall so it does, delete the file to fall back to the default, or point this run at a ' +
        'build with SWEEP_EXTENSION=/path/to/chrome-mv3.',
    );
  }
  return resolve(dir);
}

/** Printed on every run, because "which build was that" is the first question of any sweep that
 *  behaved oddly, and an unpacked copy carries no other evidence of its age. */
function extensionVersion(): string | null {
  try {
    const manifest = JSON.parse(readFileSync(join(EXTENSION, 'manifest.json'), 'utf8')) as { version?: unknown };
    return typeof manifest.version === 'string' ? manifest.version : null;
  } catch {
    return null;
  }
}

function die(message: string): never {
  console.error(message);
  process.exit(1);
}
