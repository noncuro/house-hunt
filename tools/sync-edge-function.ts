/** Copies the runtime-agnostic libraries into the Edge Function's `_shared` directory.
 *
 *  The alternative was a fork, and a fork of the analysis prompt is exactly the kind of drift that
 *  would have the panel and the function disagree about what a flat is. Deno cannot reach up out
 *  of `supabase/functions/` at deploy time, so a copy is unavoidable — but it is generated, and
 *  `--check` fails if it is stale, so the copy can never quietly diverge from `packages/core/src/`.
 *
 *    pnpm sync:function          # write the copies
 *    pnpm sync:function --check  # fail if they are out of date (run before deploying)
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const SHARED = resolve(ROOT, 'supabase/functions/_shared');

/** Every file a function needs from `packages/core/src`. All of these are deliberately written with
 *  no `node:` imports and no `import.meta.env` reads, so they run unchanged under Deno.
 *
 *  `tfl.ts` and `postcode.ts` joined the list when travel resolution moved server-side. They had
 *  been shared between the panel and the shortlist for a year and were already free of both, which
 *  is the only reason that move was a copy rather than a rewrite — `log.ts` and `types.ts` come
 *  with them because they import them.
 *
 *  Only these are generated, and only these are checked. `_shared/` also holds hand-written modules
 *  the functions share with each other (`http.ts`, `caller.ts`) — those have no original to drift
 *  from and are edited in place, which is why the GENERATED header below is the way to tell which
 *  is which. */
//  `facts.ts` joined when the verdict model started reading the hunt's stated preferences: the
//  amenity predicates that decide whether a flat is missing a must-have, and `resolveSize`, are
//  facts the panel already renders, and a second copy inside the model is exactly the thing the
//  one-fact-one-renderer rule exists to prevent. `sweep.ts` and `hubs.ts` come with it because it
//  imports their types.
//  `listing.ts` joined when the website learned to add a flat from a pasted URL: the `listing`
//  function reads the same `__PAGE_MODEL` out of fetched HTML that the content script reads off a
//  live page, and a second copy of that decode is the one fork this repo can least afford — see the
//  file's own header.
const FILES = [
  'analysis.ts',
  'listing.ts',
  'png.ts',
  'tfl.ts',
  'postcode.ts',
  'predict.ts',
  'facts.ts',
  'sweep.ts',
  'hubs.ts',
  'log.ts',
  'types.ts',
];

const HEADER = `// GENERATED — do not edit. Copied from packages/core/src/ by tools/sync-edge-function.ts.
// Edit the original and run \`pnpm sync:function\`.

`;

const check = process.argv.includes('--check');
mkdirSync(SHARED, { recursive: true });

let stale = 0;
for (const file of FILES) {
  const source = readFileSync(resolve(ROOT, 'packages/core/src', file), 'utf8');
  // Deno resolves imports as real URLs, so the extension is not optional the way it is in Vite.
  const wanted = HEADER + source.replace(/(from\s+'\.\/[\w-]+)'/g, "$1.ts'");
  const target = resolve(SHARED, file);

  const current = existsSync(target) ? readFileSync(target, 'utf8') : null;
  if (current === wanted) {
    console.log(`ok    ${file}`);
    continue;
  }
  if (check) {
    console.error(`STALE ${file} — run \`pnpm sync:function\``);
    stale++;
    continue;
  }
  writeFileSync(target, wanted);
  console.log(`wrote ${file}`);
}

if (stale > 0) process.exit(1);
