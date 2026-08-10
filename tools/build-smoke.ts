/** `pnpm build:smoke` — the extension the browser harnesses load.
 *
 *  Which Supabase the extension talks to is compiled in: `WXT_SUPABASE_URL` reaches the bundle
 *  through Vite and the manifest's `host_permissions` through `loadEnv`. A harness therefore
 *  cannot point the extension at a test database at runtime; it has to be built that way. This
 *  reads the local stack's URL and publishable key from `supabase status` and hands them to
 *  `wxt build` as environment variables, which Vite prefers over the `.env` file for prefixed
 *  keys — so nothing about the hub's `.env` changes and nothing about it is read.
 *
 *  It writes to `apps/extension/.output/smoke`, not `.output`. The extension you have loaded in
 *  Chrome lives in the second one, and quietly repointing it at a database that is empty whenever
 *  Docker is not running would turn a working install into an empty one with nothing on screen to
 *  say why.
 */
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { localCredentials } from './supabase-local';

const { url, anonKey } = localCredentials();
const root = resolve(import.meta.dirname, '..');
// WXT resolves srcDir, outDir and the entrypoints directory against the directory it runs in, so
// this has to be the extension's own — not the workspace root, where there is no `src/`.
const extension = resolve(root, 'apps/extension');

console.log(`building the smoke extension against ${url}`);

const result = spawnSync(
  // The extension's own bin, not the workspace root's: wxt is a dependency of `apps/extension` and
  // pnpm links it there.
  resolve(extension, 'node_modules/.bin/wxt'),
  ['build', '-c', 'wxt.smoke.config.ts'],
  {
    cwd: extension,
    stdio: 'inherit',
    env: {
      ...process.env,
      WXT_SUPABASE_URL: url,
      WXT_SUPABASE_PUBLISHABLE_KEY: anonKey,
    },
  },
);

if (result.status !== 0) {
  console.error('\nthe smoke build failed — the harnesses will refuse to run without it');
  process.exit(result.status ?? 1);
}
console.log(`\nwrote apps/extension/.output/smoke/chrome-mv3 — pointed at ${url}`);
