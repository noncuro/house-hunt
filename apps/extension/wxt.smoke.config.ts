/** The build the browser harnesses load.
 *
 *  Identical to the real one in every way except two, and both are safety properties rather than
 *  conveniences:
 *
 *  1. **It points at the local Supabase, not the live project.** Which database the extension talks
 *     to is compiled in (`WXT_SUPABASE_URL` reaches the bundle through Vite, and the manifest's
 *     `host_permissions` through `loadEnv`), so a harness cannot redirect it at runtime — it has to
 *     be built. `tools/build-smoke.ts` sets those variables from `supabase status` before invoking
 *     this config; the base config below reads them because Vite's `loadEnv` prefers `process.env`
 *     over the `.env` file for prefixed keys.
 *
 *     This is not only about not writing to real data. Signing in needs a user, creating a user
 *     needs the service role key, and that key exists only for the local stack — so a signed-in
 *     harness is a local-stack harness by construction (see `tools/fixture-session.ts`).
 *
 *  2. **It writes somewhere else.** `.output/smoke/chrome-mv3` rather than `.output/chrome-mv3`.
 *     Sharing the directory would mean running a check quietly repointed the extension you have
 *     loaded in Chrome at a database on your laptop that is empty when Docker is not running — a
 *     working install turning into an empty one with nothing on screen to explain it.
 *
 *  It lives beside the config it extends rather than in `tools/`, which is where it was until the
 *  repo became a workspace. WXT resolves `srcDir`, `outDir` and the entrypoint directory against
 *  the directory it is run from, so a config in `tools/` run from the repo root looked for `src/`
 *  at the root and found nothing. Nobody noticed because the harnesses refuse to run without a
 *  local Supabase, so the first error you meet is about Docker rather than about this.
 */
import base from './wxt.config';

export default { ...base, outDir: '.output/smoke' };
