/** Builds the extension, writes the zip the install page serves, and stamps it — one command,
 *  because the three cannot be done separately without lying.
 *
 *  This was a shell one-liner that ended by invoking a stamper script. Running that stamper on its
 *  own re-recorded the current sources against a build that had not been rerun, and every assertion
 *  in `check:zip` then passed against an archive that did not contain the change: the sources agreed
 *  with the stamp, the stamp agreed with the zip, and the zip was wrong. The stamp is only worth
 *  anything if stamping *is* building, so there is one entry point and it always does both.
 *
 *  The archive is written to a temporary beside the destination and renamed, so a build that dies
 *  half way through leaves the last good one in place rather than nothing at all. */
import { execFileSync } from 'node:child_process';
import { renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { BUILT, ROOT, STAMP, ZIP, hashTree, stampNow, type Stamp } from './package-stamp';

const EXT = resolve(ROOT, 'apps/extension');
const TEMP = resolve(dirname(ZIP), '.rightmove-house-hunt.zip.tmp');

const run = (cmd: string, args: string[], cwd: string): void => {
  execFileSync(cmd, args, { cwd, stdio: 'inherit' });
};

run('pnpm', ['exec', 'wxt', 'build'], EXT);

rmSync(TEMP, { force: true });
// `zip -r .` from inside the output, so paths in the archive are `manifest.json` rather than
// `apps/extension/.output/chrome-mv3/manifest.json` — Chrome loads the folder, not a tree above it.
run('zip', ['-qr', TEMP, '.'], BUILT);
renameSync(TEMP, ZIP);

const stamp: Stamp = { ...stampNow(), contents: hashTree(BUILT) };
writeFileSync(STAMP, `${JSON.stringify(stamp, null, 2)}\n`);

console.log(
  `wrote apps/web/public/rightmove-house-hunt.zip — v${stamp.version}, ` +
    `${Object.keys(stamp.contents).length} bundled files from ${Object.keys(stamp.files).length} sources`,
);
