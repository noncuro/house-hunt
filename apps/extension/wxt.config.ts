import { fileURLToPath } from 'node:url';
import { loadEnv } from 'vite';
import { defineConfig } from 'wxt';

// Config lives in the workspace root's .env — see .env.example for the two keys it needs. Only
// WXT_*-prefixed vars are exposed to the bundle, so nothing else in that file leaks into the
// extension. One file rather than one per app: the website reads the same Supabase project with
// the same publishable key, and two copies of that is two things to keep in step.
const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

// The bundle gets these through Vite's envDir below, but the manifest is built before that runs,
// so host_permissions has to read the file itself.
const env = loadEnv('production', repoRoot, 'WXT_');
const supabaseHost = env.WXT_SUPABASE_URL;
if (!supabaseHost) {
  throw new Error(`WXT_SUPABASE_URL missing from ${repoRoot}.env — the extension cannot reach its database`);
}
// Where the website lives, and now two things at once. The bridge content script is injected on
// this origin and no other, so it is a trust boundary and not only a destination (design D3) — and
// four of the functions the extension calls are routes on it, so it is also a host permission.
// One constant deliberately: the origin the extension injects into and the origin it calls must be
// the same, and two derivations of one variable is how they stop being.
//
// Origin, not the URL as written: a match pattern built from a URL with a path in it matches
// nothing.
if (!env.WXT_WEB_APP_URL) {
  throw new Error(
    `WXT_WEB_APP_URL missing from ${repoRoot}.env — the bridge has no origin to trust and the ` +
      'extension cannot reach its API routes',
  );
}
const webAppOrigin = new URL(env.WXT_WEB_APP_URL).origin;

/** The bridge entrypoint carries this, and the hook below replaces it.
 *
 *  It has to be a literal in the entrypoint file because WXT reads that file to write the manifest,
 *  in a pass where `import.meta.env` is not defined — an `import.meta.env.WXT_WEB_APP_URL` there
 *  produces the string `undefined/*`, builds cleanly, and ships a content script that matches
 *  nothing. That is the failure that looks like success, so the placeholder is a name that could
 *  never be a real site and the hook throws if it is not there. */
const BRIDGE_PLACEHOLDER = 'https://replaced-at-build-time.invalid/*';

// Two distributions, and they must not share an extension id.
//
// A load-unpacked install takes its id from the `key` below (see the comment on it). The Chrome
// Web Store mints its own id from a private key Google holds, and an uploaded manifest carrying a
// `key` we generated ourselves either fights that or is rejected outright. So the store build
// omits it: `STORE=1 pnpm zip`.
//
// The consequence is worth knowing rather than discovering. The store install is a *different*
// extension to the unpacked one — different id, therefore its own chrome.storage. Nothing of value
// lives there (the house hunt is in Supabase; local storage holds the session and the column
// choices), so the cost is signing in once more and re-picking columns.
const forStore = process.env.STORE === '1';

export default defineConfig({
  srcDir: 'src',
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'House hunt',
    description: 'Travel times and shared verdicts on Rightmove listings.',
    icons: {
      16: '/icon/16.png',
      32: '/icon/32.png',
      48: '/icon/48.png',
      128: '/icon/128.png',
    },
    // `alarms` is what keeps a session alive across a worker Chrome has torn down: a timer dies
    // with the worker, an alarm wakes it. Without it `chrome.alarms.create` throws and an install
    // nobody opened for a week comes back asking to sign in (design D2).
    permissions: ['storage', 'tabs', 'alarms'],
    // A fixed extension id, and the reason it matters is updates. An unpacked extension with no
    // `key` takes its id from the absolute path of the folder it was loaded from, so one person's
    // id differs from the other's, and moving or renaming the folder mints a new id — which means a new
    // chrome.storage, which means the settings are gone and the extension looks broken. Pinning
    // the id makes "replace the folder and hit reload" keep everything you had.
    //
    // This is a public key. It appears in the shipped manifest of every extension, and the
    // matching private key is only needed to sign a .crx, which we never do. Nothing is protected
    // by keeping it secret. Omitted from the store build — see `forStore` above.
    ...(forStore
      ? {}
      : {
          key: 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAplt9Gx2SrkcIDAe4yuuIqhfUo2//nWow7Gf/mLKfxdPh7REk75RqJLtFOMn5FvpmW/1xLitl29GBjHyP9tqhYI7NyodZaOVj+hrtiwsyKEgHeFF02GChiEVEBBCyO4HmBKrLJrrLUHJSuCtPOxEgoSeO7UuQvMi0UyB59BVmzsDMDG2j7rbl+7V6efeizf0fhLbDqplYhyzWpYqDvSnSQrGcV8R86bxOKcq27467o0oR+OzL7bDqPFSpTJgDO2ivG28igw8bwgW6be0vEJTMtq7Q+sKOR7BL9JYa9Ub3kYVtcTwSckbaNdLGomF4y2ES0OJbZ1QsOiym/7Zcu6yAKQIDAQAB',
        }),
    // No popup. The app is the website now (design D5); the extension is the panel on Rightmove and
    // a bridge on the website's origin, and holds no page of its own to pop up. Clicking the icon
    // opens the website — see the `action.onClicked` handler in background.ts.
    action: { default_title: 'House hunt' },
    // Two hosts, and that is the whole list on purpose.
    //
    // `api.tfl.gov.uk` and `api.postcodes.io` used to be here, because the worker called both
    // directly. They moved server-side — partly because a browser tab has no host permissions and
    // the website needs the same answers, but mostly because `travel_time` and `station_point` are
    // shared by every project and the client was the one writing them. The TfL key went with them;
    // it used to ship in this bundle, where it was public.
    //
    // The Supabase host covers the REST API, GoTrue and whatever Edge Functions are left. The
    // website's own origin is here because `analyse`, `invite`, `password` and `resolve-location`
    // are routes on it now: without it every one of those fetches is blocked before it leaves the
    // worker, and it fails as `TypeError: Failed to fetch`, which reads like the site being down.
    host_permissions: [`${supabaseHost}/*`, `${webAppOrigin}/*`],
  },
  hooks: {
    // The one thing in the manifest that cannot be written by the entrypoint itself — see
    // BRIDGE_PLACEHOLDER above for why.
    'build:manifestGenerated'(_wxt, manifest) {
      const bridge = manifest.content_scripts?.find((script) =>
        script.matches?.includes(BRIDGE_PLACEHOLDER),
      );
      if (!bridge) {
        throw new Error(
          `no content script matching ${BRIDGE_PLACEHOLDER} — the bridge entrypoint has to carry ` +
            'that placeholder so this hook can put the real origin in its place',
        );
      }
      bridge.matches = [`${webAppOrigin}/*`];
    },
  },
  vite: () => ({
    envDir: repoRoot,
  }),
});
