/** Where the app lives, as far as this extension is concerned.
 *
 *  Build configuration rather than a setting: a development build points at `http://localhost:3100`
 *  and a store build at the deployed site, and nothing running on a page can change it. The content
 *  script's `matches` reads the same variable, so the origin the extension injects into and the
 *  origin it will accept a message from are one value and cannot drift apart. */
const configured = import.meta.env.WXT_WEB_APP_URL;

if (!configured) {
  throw new Error(
    'WXT_WEB_APP_URL is missing from the workspace root .env — the extension has nowhere to send ' +
      'anyone to sign in, and the bridge has no origin to trust',
  );
}

/** Origin only, for comparing against `event.origin`, which never carries a path or a trailing
 *  slash. Comparing whole URLs here is how `http://localhost:3100/` fails to match
 *  `http://localhost:3100`. */
export function webAppOrigin(): string {
  return new URL(configured).origin;
}

/** The page to open. The origin's root — every screen is a tab within one page. */
export function webAppUrl(): string {
  return webAppOrigin();
}
