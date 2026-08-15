/** Records what the served zip was built from. Run by `pnpm package`, right after the zip is
 *  written — see `package-stamp.ts` for why the alternative does not work. */
import { writeFileSync } from 'node:fs';
import { STAMP, stampNow } from './package-stamp';

const stamp = stampNow();
writeFileSync(STAMP, `${JSON.stringify(stamp, null, 2)}\n`);
console.log(`stamped ${Object.keys(stamp.files).length} source files at v${stamp.version}`);
