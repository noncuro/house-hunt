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
import { ROOT, STAMP, ZIP, hashOf, stampNow, type Stamp } from './package-stamp';
import { checkArchiveIsComplete } from './manifest-paths';

// A stale archive is fatal on your own machine and a note in CI. It used to be a note on a pull
// request and fatal everywhere else, and "everywhere else" included the one place it could not be
// acted on.
//
// The reasoning it replaces was "locally and on main it is a real failure: there is nothing else
// coming". On main something is coming. `package.yml` triggers on the same push and the two
// workflows run concurrently, so `check` reads the archive as it stood before the merge and fails
// on drift that is being repaired while it reads. Nothing then supersedes that result either: the
// repackage commit is pushed with the default `GITHUB_TOKEN`, and GitHub does not trigger workflows
// for those by design, so `check` is never re-run on the corrected tree. Main sat red from #113 to
// #116 for that alone — three merges of real work all reporting failure, which is worse than no
// check at all, because the next red one would have been read as normal.
//
// Locally it stays fatal because there the sentence is true: nothing is coming, `pnpm package` is
// the answer, and the person reading it is the one who can run it.
//
// It is not re-armed for the packaging job, and that is not a gap. That job runs this immediately
// after `pnpm package`, which has just written the stamp from the sources in the tree — so drift
// there is unreachable unless `pnpm package` is itself broken, in which case the build, the zip and
// the stamp steps have already failed. The three assertions that step is actually for — the
// versions agree, the archive holds every file its own manifest names, the stamp is of this
// archive — are untouched and fatal everywhere, including there.
//
// What no longer has a CI check is "the zip on main is a build of main" in the case where
// `package.yml` did not run at all, which its `paths:` filter decides. See #120.
const advisory = Boolean(process.env.GITHUB_ACTIONS);

let failures = 0;
/** `stale` marks a check that a pending repackage will fix by itself, which is the whole set of
 *  them that compare the archive to the code beside it. A check that a repackage would NOT fix —
 *  the two hand-maintained version strings disagreeing with each other — stays fatal everywhere,
 *  because that one is a forgotten bump and no workflow is coming to fix it. */
function check(what: string, got: unknown, want: unknown, stale = false): void {
  const ok = got === want;
  if (!ok && !(stale && advisory)) failures++;
  const how = ok ? 'ok  ' : stale && advisory ? 'note' : 'FAIL';
  const why = stale && advisory ? ' (package.yml rebuilds it on main)' : '';
  console.log(`  ${how} ${what}${ok ? '' : ` — got ${got}, want ${want}${why}`}`);
}

function missing(path: string): never {
  console.log(`  FAIL ${relative(ROOT, path)} is missing — run \`pnpm package\``);
  process.exit(1);
}

console.log('the zip the install page serves');

if (!existsSync(ZIP)) missing(ZIP);
if (!existsSync(STAMP)) missing(STAMP);

const manifest = JSON.parse(execFileSync('unzip', ['-p', ZIP, 'manifest.json'], { encoding: 'utf8' }));
check('carries the version the website expects', manifest.version, EXPECTED_EXTENSION_VERSION, true);

// The same number in the same place the bump rule names, so a mismatch says which of the copies was
// forgotten rather than only that they disagree.
const pkg = JSON.parse(readFileSync(resolve(ROOT, 'apps/extension/package.json'), 'utf8'));
check("and the extension's own package.json agrees", pkg.version, EXPECTED_EXTENSION_VERSION);

const stamped: Stamp = JSON.parse(readFileSync(STAMP, 'utf8'));
check('the stamp is of the same version', stamped.version, EXPECTED_EXTENSION_VERSION, true);

console.log('\nand the stamp is of this archive');

// `unzip -Z1` lists the entries; directory entries end in a slash and hold nothing.
const entries = execFileSync('unzip', ['-Z1', ZIP], { encoding: 'utf8' })
  .split('\n')
  .map((l) => l.trim())
  .filter((l) => l && !l.endsWith('/'));
const inZip = Object.fromEntries(
  entries.map((name) => [name, hashOf(execFileSync('unzip', ['-p', ZIP, name], { maxBuffer: 64 << 20 }))]),
);
const wrong = Object.keys({ ...inZip, ...stamped.contents }).filter(
  (name) => inZip[name] !== stamped.contents[name],
);
check('every file in it is the one that was stamped', wrong.length, 0);
if (wrong.length > 0) for (const name of wrong.slice(0, 8)) console.log(`         ${name}`);

console.log('\nand Chrome would find everything it names');

// Fatal on a pull request too, unlike everything above it: an archive missing a file its manifest
// names is not "behind the code", it is broken, and `package.yml` would commit it exactly as it is.
// This runs there as well, before the push — see `manifest-paths.ts` for why placement was the
// whole of the finding.
const named = checkArchiveIsComplete(ZIP, (problem) => {
  failures++;
  console.log(`  FAIL ${problem}`);
});
if (named.missing.length === 0 && named.refs.length > 0) {
  console.log(`  ok   all ${named.refs.length} path(s) the manifest names are in it`);
}

console.log('\nand was built from the code in this commit');

const now = stampNow();
// Named individually, because "the zip is stale" and "the zip is stale *and here is what changed*"
// are a different amount of help at four in the afternoon.
const changed = Object.keys(now.files)
  .filter((path) => now.files[path] !== stamped.files[path])
  .map((path) => (path in stamped.files ? path : `${path} (new)`))
  .concat(Object.keys(stamped.files).filter((path) => !(path in now.files)).map((p) => `${p} (deleted)`));

if (changed.length > 0) {
  if (!advisory) failures++;
  const how = advisory ? 'note' : 'FAIL';
  console.log(
    `  ${how} ${changed.length} source file(s) changed since it was packaged` +
      `${advisory ? ' — package.yml rebuilds it on main' : ' — run `pnpm package`'}:`,
  );
  for (const path of changed.slice(0, 12)) console.log(`         ${path}`);
  if (changed.length > 12) console.log(`         …and ${changed.length - 12} more`);
} else {
  console.log(`  ok   all ${Object.keys(now.files).length} source files match the stamp`);
}

console.log(failures === 0 ? '\nall ok' : `\n${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
