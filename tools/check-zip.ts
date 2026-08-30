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
import { INPUTS, ROOT, STAMP, ZIP, hashOf, stampNow, type Stamp } from './package-stamp';
import { checkArchiveIsComplete } from './manifest-paths';

// A stale archive is fatal on your own machine, a note in CI. It was the other way round, on the
// reasoning that "on main there is nothing else coming" — but `package.yml` triggers on the same
// push and repairs the archive concurrently, and its commit is pushed with `GITHUB_TOKEN`, which by
// design triggers no workflow, so `check` never re-runs on the corrected tree. Main was red from
// #113 to #116 on that alone. Locally the reasoning holds: nothing is coming, `pnpm package` is the
// answer, and the person reading it can run it.
//
// The packaging job is not re-armed because drift is unreachable there — it runs this straight
// after `pnpm package` has written the stamp from the tree. The case that is not about drift at all
// — `package.yml` never running, so nothing repairs the archive and the note is permanent — is what
// the last section below rules out.
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

// --------------------------------------------------------------------------------------------- //
/** Everything the zip is built from is a path that triggers the rebuild.
 *
 *  Two lists that have to agree and are written in different languages in different files:
 *  `INPUTS` here, and `paths:` in `.github/workflows/package.yml`. An input outside the filter is a
 *  file that can change on main without `package.yml` running — so the archive is genuinely a build
 *  of an older tree, the check above says so on every subsequent run, and nothing is coming to fix
 *  it. That is the failure this whole file exists to prevent, arrived at from the other side: not a
 *  forgotten `pnpm package`, but a workflow that was never asked.
 *
 *  Four of them were outside it when this was written — both package manifests, `tsconfig.base.json`
 *  and `pnpm-lock.yaml` — which is a dependency bump changing the bundle and leaving the download
 *  behind (#120).
 *
 *  Read out of the workflow rather than restated, for the same reason `check:travel` reads its
 *  clause out of the live migration: a copy of the list is a third list. */
console.log('\nand every input to it triggers the rebuild');

const workflow = resolve(ROOT, '.github/workflows/package.yml');
if (!existsSync(workflow)) {
  failures++;
  console.log('  FAIL .github/workflows/package.yml is missing — nothing rebuilds the archive');
} else {
  const paths = pathsFilter(readFileSync(workflow, 'utf8'));
  if (paths === null) {
    failures++;
    console.log("  FAIL could not find the push `paths:` list in package.yml — the filter this holds INPUTS against");
  } else {
    const uncovered = INPUTS.filter((input) => !paths.some((pattern) => covers(pattern, input)));
    if (uncovered.length > 0) {
      failures++;
      console.log(
        `  FAIL ${uncovered.length} build input(s) are outside package.yml's \`paths:\`, so a change to ` +
          'one lands on main without rebuilding the zip:',
      );
      for (const input of uncovered) console.log(`         ${input}`);
    } else {
      console.log(`  ok   all ${INPUTS.length} build inputs are covered by ${paths.length} path pattern(s)`);
    }
  }
}

/** The `paths:` under `on.push`, and nothing else in the file that happens to be a YAML list.
 *
 *  Anchored on the line rather than parsed as YAML: adding a parser to read seven strings is more
 *  moving parts than the thing being checked, and a `paths:` that this cannot find is a failure
 *  above rather than a silent pass. */
function pathsFilter(yaml: string): string[] | null {
  const lines = yaml.split('\n');
  const at = lines.findIndex((line) => /^\s*paths:\s*$/.test(line));
  if (at === -1) return null;
  const found: string[] = [];
  for (const line of lines.slice(at + 1)) {
    const item = /^\s*-\s*'([^']+)'\s*$/.exec(line) ?? /^\s*-\s*"([^"]+)"\s*$/.exec(line);
    if (!item) {
      if (/^\s*(#.*)?$/.test(line)) continue;
      break;
    }
    found.push(item[1]!);
  }
  return found.length === 0 ? null : found;
}

/** Whether one `paths:` pattern would fire for a change under one input.
 *
 *  Only the two forms the file uses — an exact path, and a directory with `/**` after it. A pattern
 *  this does not understand covers nothing, which fails loudly rather than passing an input off as
 *  handled by a glob nobody read. */
function covers(pattern: string, input: string): boolean {
  if (pattern === input) return true;
  if (pattern.endsWith('/**')) {
    const dir = pattern.slice(0, -3);
    return input === dir || input.startsWith(`${dir}/`);
  }
  return false;
}

console.log(failures === 0 ? '\nall ok' : `\n${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
