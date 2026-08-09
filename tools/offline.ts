/** Nothing a harness does may reach Rightmove.
 *
 *  The standing rule in AGENTS.md — read pages the user opened, never crawl — is about the
 *  extension, and it applies at least as hard to a test that can be run in a loop. Two harnesses
 *  were quietly breaking it. The shortlist renders every saved property's photo thumbnails, which
 *  is a few hundred requests to Rightmove's CDN per run. And `smoke:sweep` drives the paced
 *  opener, which opens real listing pages in real tabs — a page load each, plus its scripts,
 *  fonts and images.
 *
 *  Two layers, because one was not enough:
 *
 *  1. `keepOffline` intercepts every http(s) request. Rightmove images are answered from memory;
 *     the extension's own backends and anything else explicitly allowed stay live, since the
 *     round trip to Supabase and TfL is much of what these harnesses exist to prove; everything
 *     else is aborted.
 *  2. `OFFLINE_ARGS` stops the domain resolving at all — see below for the leak that found.
 *
 *  The counts come back so the harness can print them. A run that says nothing about what it
 *  blocked is a run you have to take on trust. */
import type { BrowserContext } from 'playwright';

/** A 1×1 light grey PNG. Enough for `naturalWidth > 0`, which is all a photo check can honestly
 *  assert once the real image is not being fetched — and it renders as a flat grey tile, which is
 *  what a stubbed photo should look like rather than a broken one. */
const PLACEHOLDER = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==',
  'base64',
);

const RIGHTMOVE = /^https?:\/\/([a-z0-9-]+\.)*rightmove\.co\.uk\//i;

/** Chromium launch flags that make the leak impossible rather than merely handled.
 *
 *  Interception alone was not enough, and the way that showed is worth keeping. With the route
 *  installed, `smoke:sweep` reported every font, script and stylesheet of a listing page as
 *  blocked — which meant the *document* had loaded, for real, from Rightmove. The opener's tabs
 *  are opened by the extension through `chrome.tabs.create`, and Playwright does not route that
 *  first navigation: it picks the page up straight afterwards, in time for the subresources and
 *  too late for the page itself.
 *
 *  So resolution is forced to fail for the whole domain. Anything a harness means to answer is
 *  answered by `keepOffline` before DNS is consulted, so the stubs still work; anything it does
 *  not mean to answer now cannot leave the machine even if a later harness forgets the route.
 *  The tab the opener opens therefore shows Chrome's own "this site can't be reached", which is
 *  correct for what it is under test for — that one tab opens, not forty. */
export const OFFLINE_ARGS = [
  '--host-resolver-rules=MAP *.rightmove.co.uk ~NOTFOUND, MAP rightmove.co.uk ~NOTFOUND',
];

export interface OfflineOptions {
  /** Hosts that stay live. The extension's own `host_permissions` belong here — see the callers. */
  allow?: string[];
  /** Saved pages, served under the real Rightmove URL they were saved from.
   *
   *  This is how the content scripts get injected at all: the manifest matches on
   *  `rightmove.co.uk`, so a fixture served from `file://` or `localhost` is a page the extension
   *  never sees. Fulfilling the real URL satisfies the match patterns while nothing leaves the
   *  machine. Matched by prefix and checked before anything else, so a fixture always wins. */
  fulfil?: Array<{ prefix: string; html: string }>;
}

/** Intercept everything, and hand back a one-line report of what was served and what was blocked. */
export async function keepOffline(
  context: BrowserContext,
  { allow = [], fulfil = [] }: OfflineOptions = {},
): Promise<() => string> {
  const tally = { images: 0, blocked: 0, live: 0, pages: 0 };

  // Only http(s): aborting chrome-extension:// starves the panel of its own stylesheet, and it
  // then renders unstyled — which looks like a CSS bug that isn't there.
  await context.route(/^https?:\/\//, async (route) => {
    const target = route.request().url();

    const saved = fulfil.find((f) => target.startsWith(f.prefix));
    if (saved) {
      tally.pages += 1;
      await route.fulfill({ status: 200, contentType: 'text/html', body: saved.html });
      return;
    }

    if (RIGHTMOVE.test(target)) {
      if (route.request().resourceType() === 'image') {
        tally.images += 1;
        await route.fulfill({ status: 200, contentType: 'image/png', body: PLACEHOLDER });
        return;
      }
      tally.blocked += 1;
      await route.abort();
      return;
    }

    if (allow.some((host) => target.startsWith(host))) {
      tally.live += 1;
      await route.continue();
      return;
    }

    tally.blocked += 1;
    await route.abort();
  });

  return () =>
    `rightmove: ${tally.pages} page(s) served from a saved file, ${tally.images} image(s) answered ` +
    `from memory, ${tally.blocked} request(s) blocked, 0 reached rightmove.co.uk (it does not ` +
    `resolve) · ${tally.live} allowed request(s) went out`;
}
