/** What the served zip was built from, so anyone can tell whether it is out of date.
 *
 *  The obvious check — rebuild the extension and compare the archive file by file — cannot work off
 *  this repository's own machine. The bundle bakes in the `WXT_*` variables, and CI builds against
 *  `.env.ci` while the committed zip is built against the real `.env`, so `background.js`,
 *  `panel.js`, `bridge.js` and the manifest all differ for a reason that has nothing to do with the
 *  code. A check that only passes on one laptop is a check nobody keeps.
 *
 *  So the zip is stamped with the hash of every source file that goes into it, and `check:zip`
 *  recomputes those hashes and compares. Environment-independent, needs no build, and answers the
 *  actual question: does this archive predate a change to the code it contains.
 *
 *  The accepted gap: a dependency bump or a change to `.env` with no source change is not detected.
 *  Config is not in git and cannot be, and a lockfile change that alters the bundle without altering
 *  a line of this repository's own code is rare enough to be worth less than the false failures
 *  pinning it would cause.
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

export const ROOT = resolve(import.meta.dirname, '..');
export const ZIP = resolve(ROOT, 'apps/web/public/rightmove-house-hunt.zip');
export const STAMP = resolve(ROOT, 'apps/web/public/rightmove-house-hunt.sources.json');

/** Everything the extension bundle is built out of. `packages/` is in here because the extension
 *  imports both — a fact changed in `core` reaches the panel and would otherwise stamp as unchanged
 *  — and so are the icons, the tsconfigs and the lockfile: an icon is copied into the archive
 *  verbatim, module resolution decides what the bundler pulls in, and a dependency bump changes the
 *  bundle without touching a line of this repository's own code. */
export const INPUTS = [
  'apps/extension/src',
  'apps/extension/public',
  'apps/extension/wxt.config.ts',
  'apps/extension/tsconfig.json',
  'apps/extension/package.json',
  'packages/core/src',
  'packages/core/package.json',
  'packages/ui/src',
  'packages/ui/package.json',
  'tsconfig.base.json',
  'pnpm-lock.yaml',
];

/** Where `wxt build` leaves the files that go into the archive. */
export const BUILT = resolve(ROOT, 'apps/extension/.output/chrome-mv3');

export interface Stamp {
  version: string;
  /** Source path -> sha256. Answers "has the code changed since this was built". */
  files: Record<string, string>;
  /** Path inside the archive -> sha256, as built. Answers "is this stamp actually of that zip".
   *
   *  Without it the two halves are only related by having been written at the same moment, and
   *  running the stamper on its own — or swapping the archive's contents while keeping its
   *  `manifest.version` — leaves every assertion passing and the served file wrong. Both sides of
   *  this comparison come out of the same build, so it holds on any machine even though the bundle
   *  bakes in `WXT_*` and CI's differ. */
  contents: Record<string, string>;
}

export function hashOf(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

function walk(at: string, into: string[]): string[] {
  for (const name of readdirSync(at)) {
    const full = join(at, name);
    if (statSync(full).isDirectory()) walk(full, into);
    else into.push(full);
  }
  return into;
}

/** The hash of every file under a directory, by path relative to it. */
export function hashTree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const path of walk(dir, []).sort()) {
    out[relative(dir, path).split(sep).join('/')] = hashOf(readFileSync(path));
  }
  return out;
}

/** The hash of every input, by repo-relative POSIX path. Sorted, so the file is a stable diff.
 *
 *  `contents` is filled in by the stamper, which runs straight after the build and can read it. */
export function stampNow(): Omit<Stamp, 'contents'> {
  const files: Record<string, string> = {};
  const paths: string[] = [];
  for (const input of INPUTS) {
    const full = resolve(ROOT, input);
    if (!existsSync(full)) throw new Error(`package stamp: ${input} does not exist`);
    if (statSync(full).isDirectory()) walk(full, paths);
    else paths.push(full);
  }
  for (const path of paths.sort()) {
    files[relative(ROOT, path).split(sep).join('/')] = hashOf(readFileSync(path));
  }
  const pkg = JSON.parse(readFileSync(resolve(ROOT, 'apps/extension/package.json'), 'utf8'));
  return { version: pkg.version, files };
}
