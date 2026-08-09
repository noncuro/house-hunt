import { fileURLToPath } from 'node:url';
import { loadEnv } from 'vite';
import { defineConfig } from 'wxt';

// Config lives in this repo's own .env — see .env.example for the two keys it needs. Only
// WXT_*-prefixed vars are exposed to the bundle, so nothing else in that file leaks into the
// extension. This used to read the PARENT directory's .env, from when the extension lived inside a
// larger private repo; standalone, that pointed at whatever folder happened to sit above the clone
// and nobody but the original author could build it.
const repoRoot = fileURLToPath(new URL('.', import.meta.url));

// The bundle gets these through Vite's envDir below, but the manifest is built before that runs,
// so host_permissions has to read the file itself.
const env = loadEnv('production', repoRoot, 'WXT_');
const supabaseHost = env.WXT_SUPABASE_URL;
if (!supabaseHost) {
  throw new Error(`WXT_SUPABASE_URL missing from ${repoRoot}.env — the extension cannot reach its database`);
}

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
    name: 'Rightmove house hunt',
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
    // No popup. The popup and the shortlist page were two front doors to one tool — you set who
    // you are in one and read the results in the other, and the popup closed itself the moment
    // you clicked away. Clicking the icon opens the shortlist; settings are a tab on it.
    action: { default_title: 'House hunt' },
    host_permissions: [
      'https://api.tfl.gov.uk/*',
      // UK postcode -> coordinates. TfL's own geocoder cannot be trusted with postcodes.
      'https://api.postcodes.io/*',
      // Covers both the REST API and the analyse Edge Function, which live on the same host.
      `${supabaseHost}/*`,
    ],
  },
  vite: () => ({
    envDir: repoRoot,
  }),
});
