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
 *  Three version strings agreeing is the weak half of this and was never the problem — they agreed
 *  perfectly the whole time. What catches a stale archive is the stamp: the hash of every source
 *  file it was built from, written beside it by `pnpm package` and recomputed here. See
 *  `package-stamp.ts` for why this is not a rebuild-and-compare. */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { EXPECTED_EXTENSION_VERSION } from '../apps/web/src/lib/extension-version';
import { ROOT, STAMP, ZIP, stampNow, type Stamp } from './package-stamp';

let failures = 0;
function check(what: string, got: unknown, want: unknown): void {
  const ok = got === want;
  if (!ok) failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}${ok ? '' : ` — got ${got}, want ${want}`}`);
}

function missing(path: string): never {
  console.log(`  FAIL ${relative(ROOT, path)} is missing — run \`pnpm package\``);
  process.exit(1);
}

console.log('the zip the install page serves');

if (!existsSync(ZIP)) missing(ZIP);
if (!existsSync(STAMP)) missing(STAMP);

const manifest = JSON.parse(execFileSync('unzip', ['-p', ZIP, 'manifest.json'], { encoding: 'utf8' }));
check('carries the version the website expects', manifest.version, EXPECTED_EXTENSION_VERSION);

// The same number in the same place the bump rule names, so a mismatch says which of the copies was
// forgotten rather than only that they disagree.
const pkg = JSON.parse(readFileSync(resolve(ROOT, 'apps/extension/package.json'), 'utf8'));
check("and the extension's own package.json agrees", pkg.version, EXPECTED_EXTENSION_VERSION);

console.log('\nand was built from the code in this commit');

const stamped: Stamp = JSON.parse(readFileSync(STAMP, 'utf8'));
check('the stamp is of the same version', stamped.version, EXPECTED_EXTENSION_VERSION);

const now = stampNow();
// Named individually, because "the zip is stale" and "the zip is stale *and here is what changed*"
// are a different amount of help at four in the afternoon.
const changed = Object.keys(now.files)
  .filter((path) => now.files[path] !== stamped.files[path])
  .map((path) => (path in stamped.files ? path : `${path} (new)`))
  .concat(Object.keys(stamped.files).filter((path) => !(path in now.files)).map((p) => `${p} (deleted)`));

if (changed.length > 0) {
  failures++;
  console.log(`  FAIL ${changed.length} source file(s) changed since it was packaged — run \`pnpm package\`:`);
  for (const path of changed.slice(0, 12)) console.log(`         ${path}`);
  if (changed.length > 12) console.log(`         …and ${changed.length - 12} more`);
} else {
  console.log(`  ok   all ${Object.keys(now.files).length} source files match the stamp`);
}

console.log(failures === 0 ? '\nall ok' : `\n${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
