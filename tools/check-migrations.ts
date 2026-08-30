/** Every migration has a version string, and no two have the same one.
 *
 *  Supabase keys `supabase_migrations.schema_migrations` on the `YYYYMMDDHHMMSS` prefix of the
 *  filename, not on the file. So when two files share a prefix the first to run records the
 *  version and `supabase db push` reads the second as already applied and skips it. There is no
 *  error, no log line, and nothing that looks like a migration problem — the column, function or
 *  policy is simply absent, and only in production, because CI starts from an empty database and
 *  applies both files happily. It has nearly happened twice in one day here, both times between
 *  two branches open at once: each author read `origin/main`, correctly found the minute free, and
 *  could not see the other branch.
 *
 *  This is where that is caught: CI runs it against the merge result, so it is red on the second
 *  pull request when that branch is current with main, and otherwise on the `main` push straight
 *  after it lands. A `pull_request` run is not recomputed when the base moves, so a branch behind
 *  main can merge on a stale green tick — rebase before merging when another migration is in
 *  flight.
 *
 *  A name that is not `YYYYMMDDHHMMSS_lower_snake.sql` fails for the same reason rather than a
 *  tidiness one — a version string nobody can parse is a version string nobody can compare, and
 *  it would sail past the collision test by having no prefix to collide with.
 *
 *  Run: `pnpm check:migrations`
 */
import { readdirSync } from 'node:fs';
import { relative, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const DIR = 'supabase/migrations';
// `[a-z0-9_]+` would have accepted `20260830120000___.sql` and `20260830120000__a_.sql`, which are
// not lower_snake and read as a typo that got committed. Words of at least one character, joined by
// single underscores, with none leading or trailing.
const NAME = /^(\d{14})_[a-z0-9]+(?:_[a-z0-9]+)*\.sql$/;

let failures = 0;

function fail(message: string): void {
  failures++;
  console.log(`  FAIL  ${message}`);
}

function ok(message: string): void {
  console.log(`  ok    ${message}`);
}

const dir = resolve(ROOT, DIR);
let entries: string[];
try {
  entries = readdirSync(dir);
} catch (e) {
  // Not "no collisions". A check that could not read the directory has not looked, and saying the
  // migrations are fine about a directory it never opened is the one wrong answer this can give —
  // the failure it exists to catch is already silent.
  console.log(`  FAIL  cannot read ${relative(ROOT, dir)}: ${e instanceof Error ? e.message : String(e)}`);
  console.log('\n1 failed');
  process.exit(1);
}

// --------------------------------------------------------------------------------------------- //
console.log('every migration is named so its version can be read');

const byVersion = new Map<string, string[]>();
let named = 0;

for (const name of entries.sort()) {
  const version = NAME.exec(name)?.[1];
  if (!version) {
    fail(`${DIR}/${name} is not YYYYMMDDHHMMSS_lower_snake_name.sql — nothing can tell what version it is`);
    continue;
  }
  named++;
  byVersion.set(version, [...(byVersion.get(version) ?? []), name]);
}

if (named === 0) {
  // Not a pass. This check going quiet because the directory moved is exactly how it would fail to
  // notice the collision it is here for.
  fail(`no migrations under ${DIR} — this check found nothing to check, which is not the same as passing`);
} else if (failures === 0) {
  ok(`${named} migration(s) under ${DIR}`);
}

// --------------------------------------------------------------------------------------------- //
console.log('\nand no two share a version');

let collisions = 0;
for (const [version, names] of byVersion) {
  if (names.length < 2) continue;
  collisions++;
  fail(
    `${names.length} migrations claim version ${version}: ${names.join(', ')} — ` +
      'only the first would run in production, and the rest are recorded as applied. ' +
      'Rename all but one to a minute no other migration uses, on main or on a branch in flight.',
  );
}
if (collisions === 0 && named > 0) ok('each version string belongs to one file');

// --------------------------------------------------------------------------------------------- //
console.log(failures === 0 ? '\nall good' : `\n${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
