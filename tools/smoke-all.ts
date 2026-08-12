/** Every browser harness, in the order that fails cheapest first, with timings.
 *
 *  Two things this exists for.
 *
 *  **Fail fast, in the right order.** Each harness on its own collects all its problems and reports
 *  them together — deliberately, because three findings from one run beat three runs. Across
 *  harnesses the opposite is right: they take a database and a browser each, and there is no point
 *  building the website to find out the extension never loaded. So this stops at the first one that
 *  fails, cheapest first.
 *
 *  **Say what it cost.** The reason the order can be justified at all is that these are seconds
 *  apart, and the only way that stays true is if every run prints it.
 *
 *    pnpm smoke:all              # all of them
 *    pnpm smoke:all web search   # just those, same order rules
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const fixtures = resolve(root, '.fixtures');

/** Cheapest first, so the slowest thing is never what tells you the database is down. */
const HARNESSES = [
  { name: 'search', script: 'smoke:search', needs: 'a search fixture' },
  { name: 'listing', script: 'smoke', needs: 'a listing fixture' },
  { name: 'web', script: 'smoke:web', needs: null },
] as const;

const wanted = process.argv.slice(2);

// Every name has to be one we have, not merely one of them. `pnpm smoke:all web typo` used to run
// `web`, say nothing about `typo`, and exit 0 — which is the silent skip this repo treats as worse
// than a failure, in its most convincing costume: a green run that answered a question nobody asked.
const unknown = wanted.filter((name) => !HARNESSES.some((h) => h.name === name));
if (unknown.length > 0) {
  console.error(
    `no harness called ${unknown.map((n) => `"${n}"`).join(', ')}.\n` +
      `usage: pnpm smoke:all [${HARNESSES.map((h) => h.name).join('|')}]`,
  );
  process.exit(1);
}

const chosen = wanted.length === 0 ? HARNESSES : HARNESSES.filter((h) => wanted.includes(h.name));

/** The saved listing page, whichever one this machine has. Named by id, so it cannot be a constant;
 *  and `search-*.html` is the other fixture, which belongs to a different harness. */
function listingFixture(): string | null {
  if (!existsSync(fixtures)) return null;
  const file = readdirSync(fixtures).find((f) => /^\d+\.html$/.test(f));
  return file ? resolve(fixtures, file) : null;
}

const results: Array<{ name: string; seconds: number }> = [];

for (const harness of chosen) {
  const args: string[] = [harness.script];
  if (harness.script === 'smoke') {
    const fixture = listingFixture();
    if (!fixture) {
      console.error(
        `\n${harness.name}: no listing fixture in .fixtures/.\n` +
          '  Save one with `pnpm fixture <listing-id>` — see docs/fixtures.md.\n' +
          '  Skipping is not an option here: a harness that quietly does not run is worse than one\n' +
          '  that fails, so this stops.',
      );
      process.exit(1);
    }
    args.push(fixture);
  }

  console.log(`\n─── ${harness.name} ───`);
  const started = Date.now();
  const run = spawnSync('pnpm', args, { cwd: root, stdio: 'inherit' });
  const seconds = (Date.now() - started) / 1000;
  results.push({ name: harness.name, seconds });

  if (run.status !== 0) {
    console.error(`\n${harness.name} failed after ${seconds.toFixed(1)}s — stopping here.`);
    report();
    process.exit(run.status ?? 1);
  }
}

report();
console.log('\nall harnesses ok');

function report(): void {
  if (results.length === 0) return;
  const total = results.reduce((sum, r) => sum + r.seconds, 0);
  console.log('\ntimings');
  for (const r of results) console.log(`  ${r.name.padEnd(8)} ${r.seconds.toFixed(1)}s`);
  console.log(`  ${'total'.padEnd(8)} ${total.toFixed(1)}s`);
}
