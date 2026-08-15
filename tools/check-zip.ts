/** The zip the install page hands out is the build people actually run.
 *
 *  Everything else about a version bump is enforced: `EXPECTED_EXTENSION_VERSION` is compared over
 *  the bridge on `hello`, so a browser running an old copy is told so. But the copy it is told to
 *  download is a committed static asset — Vercel builds only `apps/web` and cannot build the
 *  extension — and nothing ever compared it to anything. `pnpm package` wrote to a gitignored zip at
 *  the repo root instead, so the served file was a hand copy that stopped being made. It sat at
 *  0.1.0 through three bumps while the site said 0.3.1 and told everyone who downloaded it that
 *  they were out of date, which is exactly the message they had just acted on.
 *
 *  So: the zip's own manifest, against the version the website expects. This is the one check that
 *  reads a build artefact rather than source, and it fails when the artefact is stale — which is the
 *  point, and is fixed by `pnpm package`. */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { EXPECTED_EXTENSION_VERSION } from '../apps/web/src/lib/extension-version';

const ROOT = resolve(import.meta.dirname, '..');
const ZIP = resolve(ROOT, 'apps/web/public/rightmove-house-hunt.zip');

let failures = 0;
function check(what: string, got: unknown, want: unknown): void {
  const ok = got === want;
  if (!ok) failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}${ok ? '' : ` — got ${got}, want ${want}`}`);
}

console.log('the zip the install page serves');

if (!existsSync(ZIP)) {
  console.log(`  FAIL ${ZIP} is missing — run \`pnpm package\``);
  process.exit(1);
}

// `unzip -p` rather than a zip library: the file is read once, in CI, and this is the tool every
// machine that can open the zip by hand already has.
const manifest = JSON.parse(execFileSync('unzip', ['-p', ZIP, 'manifest.json'], { encoding: 'utf8' }));
check('carries the version the website expects', manifest.version, EXPECTED_EXTENSION_VERSION);

// The same number in the same place the bump rule names, so a mismatch says which of the three
// copies was forgotten rather than only that they disagree.
const pkg = JSON.parse(readFileSync(resolve(ROOT, 'apps/extension/package.json'), 'utf8'));
check("and the extension's own package.json agrees", pkg.version, EXPECTED_EXTENSION_VERSION);

console.log(failures === 0 ? '\nall ok' : `\n${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
