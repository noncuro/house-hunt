/** The zip the install page hands out is the build people actually run.
 *
 *  Everything else about a version bump is enforced: `EXPECTED_EXTENSION_VERSION` is compared over
 *  the bridge on `hello`, so a browser running an old copy is told so. But the copy it is told to
 *  download is a committed static asset — Vercel builds only `apps/web` and cannot build the
 *  extension — and nothing ever compared it to anything. `pnpm package` wrote to a gitignored zip at
 *  the repo root and a second script copied it across; nobody ran the second script. The served file
 *  sat at 0.1.0 through three bumps while the site said 0.3.1 and told everyone who downloaded it
 *  that they were out of date, which is exactly the message they had just acted on.
 *
 *  So this builds the extension and compares the result to the archive in git, file by file. The
 *  version numbers are checked too, but they are the weaker half and were never the problem: three
 *  strings can agree perfectly while the zip beside them is a month old. What catches that is the
 *  contents.
 *
 *  Compared as a set of path -> sha256 rather than byte-for-byte, because a zip carries modification
 *  times and an ordering that differ between two builds of identical code — a byte comparison would
 *  fail on every machine and be switched off within a week.
 *
 *  This is the one check here that builds something, and it is the slow one for that reason. It is
 *  also the only way the question can be asked: the artefact is what ships. `pnpm package` fixes a
 *  failure. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { EXPECTED_EXTENSION_VERSION } from '../apps/web/src/lib/extension-version';

const ROOT = resolve(import.meta.dirname, '..');
const ZIP = resolve(ROOT, 'apps/web/public/rightmove-house-hunt.zip');
const BUILT = resolve(ROOT, 'apps/extension/.output/chrome-mv3');

let failures = 0;
function check(what: string, got: unknown, want: unknown): void {
  const ok = got === want;
  if (!ok) failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}${ok ? '' : ` — got ${got}, want ${want}`}`);
}

function sha(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

console.log('the zip the install page serves');

if (!existsSync(ZIP)) {
  console.log(`  FAIL ${ZIP} is missing — run \`pnpm package\``);
  process.exit(1);
}

const manifest = JSON.parse(execFileSync('unzip', ['-p', ZIP, 'manifest.json'], { encoding: 'utf8' }));
check('carries the version the website expects', manifest.version, EXPECTED_EXTENSION_VERSION);

// The same number in the same place the bump rule names, so a mismatch says which of the three
// copies was forgotten rather than only that they disagree.
const pkg = JSON.parse(readFileSync(resolve(ROOT, 'apps/extension/package.json'), 'utf8'));
check("and the extension's own package.json agrees", pkg.version, EXPECTED_EXTENSION_VERSION);

console.log('\nand is a build of the code in this commit');

// Built here rather than assumed present: `.output/` is gitignored, so on CI and on a fresh clone
// there is nothing to compare against, and a check that skips itself when its input is missing is a
// check that is always green on the machine that matters.
execFileSync('pnpm', ['--filter', '@house-hunt/ext', 'build'], { cwd: ROOT, stdio: 'ignore' });

/** Every file under a directory, as repo-relative POSIX paths mapped to their content hash. */
function hashTree(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (at: string): void => {
    for (const name of readdirSync(at)) {
      const full = join(at, name);
      if (statSync(full).isDirectory()) walk(full);
      else out.set(relative(dir, full).split(sep).join('/'), sha(readFileSync(full)));
    }
  };
  walk(dir);
  return out;
}

const fresh = hashTree(BUILT);
// `unzip -Z1` lists the archive's entries; directory entries end in a slash and hold nothing.
const entries = execFileSync('unzip', ['-Z1', ZIP], { encoding: 'utf8' })
  .split('\n')
  .map((l) => l.trim())
  .filter((l) => l && !l.endsWith('/'));
const served = new Map(
  entries.map((name) => [name, sha(execFileSync('unzip', ['-p', ZIP, name], { maxBuffer: 64 << 20 }))]),
);

check('has every file the build produces, and no others', served.size, fresh.size);

// Named individually, because "the zip is stale" and "the zip is stale *and here is what changed*"
// are a different amount of help at four in the afternoon.
const differing = [...fresh]
  .filter(([name, hash]) => served.get(name) !== hash)
  .map(([name]) => name)
  .concat([...served.keys()].filter((name) => !fresh.has(name)).map((name) => `${name} (not built)`));

if (differing.length > 0) {
  failures++;
  console.log(`  FAIL ${differing.length} file(s) differ from a fresh build — run \`pnpm package\`:`);
  for (const name of differing.slice(0, 12)) console.log(`         ${name}`);
  if (differing.length > 12) console.log(`         …and ${differing.length - 12} more`);
} else {
  console.log('  ok   every file matches a fresh build');
}

console.log(failures === 0 ? '\nall ok' : `\n${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
