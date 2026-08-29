/* The service worker: what this app is when the network is not there.
 *
 *  A house hunt happens on the Underground. You are on the way to a viewing with fifteen minutes of
 *  no signal, and the thing you want is the shortlist you already looked at — the address, what the
 *  photographs showed, what the two of you said, and the photographs themselves. None of that has
 *  changed since the platform, and none of it needs the network. Without a worker it is a blank page
 *  and a spinner, because a web app with no cache is exactly as offline as a dead connection.
 *
 *  So: three caches with three different policies, chosen by what each thing actually is.
 *
 *    - **The build** (`/_next/static/…`) is content-addressed — the filename contains a hash of the
 *      file — so it is cache-first, forever, and a deploy simply asks for different names. Nothing
 *      here is ever revalidated, because a hashed URL cannot have changed.
 *    - **The page itself** is network-first with the cache behind it. Network-first, not
 *      cache-first, because this app's whole job is to show what the *other* person has just said
 *      about a flat, and a stale shell that boots against a live database is the one shape that
 *      shows old data with no way to tell.
 *    - **Listing photographs** are cache-first and capped. They come from Rightmove's CDN, they are
 *      immutable at their URL, and they are the single largest thing between somebody and a usable
 *      shortlist underground.
 *
 *  **Caching a photograph is not re-hosting it.** `AGENTS.md` forbids re-hosting Rightmove's images
 *  and that rule is untouched here: nothing is copied to our origin, nothing is uploaded, nothing is
 *  served to anybody else. This is the reader's own browser keeping a copy of a file it already
 *  fetched, on the reader's own device, exactly as the HTTP cache does — the only difference being
 *  that this copy is still there when the connection is not. It is the same act that `.fixtures/`
 *  being gitignored protects: what must never happen is *us* holding and serving the pictures.
 *
 *  Written by hand rather than generated. It is a hundred lines, it is on the critical path of every
 *  request the app makes, and the CSP on this origin has no `'unsafe-eval'` and no third-party
 *  script-src — so a build-step worker would be one more thing to audit for a problem this does not
 *  have.
 */

/* Bump to throw away every cache at once. The names carry it, so an old worker's caches are deleted
   on activate rather than lingering under a name nothing reads. */
const VERSION = 'v1';
const SHELL = `shell-${VERSION}`;
const BUILD = `build-${VERSION}`;
const PHOTOS = `photos-${VERSION}`;

/* How many listing photographs to keep. A shortlist runs to a few hundred flats and this holds one
   or two apiece — at roughly 40kB for a card-sized image that is some tens of megabytes, which is
   within what a browser gives an installed app and far below what it would evict. Kept as a count
   rather than a byte budget because the Cache API will not tell us a response's size without
   reading it, and reading every entry to enforce a budget costs more than the budget saves. */
const PHOTO_LIMIT = 600;

const RIGHTMOVE_MEDIA = /^https:\/\/(media|[a-z0-9-]+)\.rightmove\.co\.uk\//;

self.addEventListener('install', (event) => {
  // The shell, so the very first offline load has something to open. One entry: this is a
  // single-page app and every screen is `/` with a different query.
  event.waitUntil(caches.open(SHELL).then((cache) => cache.add('/')));
  // No waiting for the old worker to be released. A version bump here is a bug fix in the thing
  // that decides what every other request does, and leaving the previous one serving until every
  // tab is closed means it can be days.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keep = new Set([SHELL, BUILD, PHOTOS]);
      const names = await caches.keys();
      await Promise.all(names.filter((name) => !keep.has(name)).map((name) => caches.delete(name)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Supabase, the Edge Functions, and anything else this app talks to. Never cached, never
  // intercepted: a verdict read from a cache is a verdict that may have been changed by the person
  // you are house-hunting with, and showing it as current is the one failure this whole app is
  // built to avoid. What makes the shortlist readable offline is the query cache in IndexedDB
  // (`lib/offline.ts`), which knows when it was written and says so.
  if (url.origin !== self.location.origin && !RIGHTMOVE_MEDIA.test(request.url)) return;

  if (RIGHTMOVE_MEDIA.test(request.url)) return event.respondWith(photo(request));
  if (url.pathname.startsWith('/_next/static/')) return event.respondWith(immutable(request));
  if (request.mode === 'navigate') return event.respondWith(page(request));
});

/** Hashed build assets: cache-first, and never revalidated. */
async function immutable(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) void (await caches.open(BUILD)).put(request, response.clone());
  return response;
}

/** The page: the network, and the last good copy of the shell if there isn't one.
 *
 *  Always saved under `/` rather than under the request's own URL. Every screen in this app is `/`
 *  with a different `?v=`, and caching each of those separately would fill the cache with copies of
 *  one document and still miss whichever query string somebody happened to open offline. */
async function page(request) {
  try {
    const response = await fetch(request);
    if (response.ok) void (await caches.open(SHELL)).put('/', response.clone());
    return response;
  } catch (offline) {
    const cached = await caches.match('/');
    // No cached shell means this browser has genuinely never loaded the app — there is nothing to
    // show and nothing to pretend. Rethrowing gives the browser's own offline page, which says
    // what happened; a hand-made "you are offline" page here would be a second thing to keep in
    // step for no gain.
    if (!cached) throw offline;
    return cached;
  }
}

/** A listing photograph: cache-first, and kept.
 *
 *  `no-cors` on the fallback fetch, because these are cross-origin images with no CORS headers —
 *  which is exactly how an `<img>` fetches them. What comes back is an opaque response: usable as an
 *  image, storable in a cache, and unreadable to us, which is all it needs to be. */
async function photo(request) {
  const cache = await caches.open(PHOTOS);
  const cached = await cache.match(request);
  if (cached) return cached;

  const response = await fetch(request, { mode: 'no-cors' });
  // An opaque response reports `status: 0` and `ok: false` even when it succeeded, so `ok` is the
  // wrong test here — `type === 'opaque'` is what "this arrived" looks like from inside a worker.
  // A failed cross-origin fetch rejects instead, so there is nothing to confuse it with.
  if (response.type === 'opaque' || response.ok) {
    await cache.put(request, response.clone());
    void trim(cache);
  }
  return response;
}

/** Oldest-inserted first, because `cache.keys()` returns insertion order and that is the only
 *  ordering the Cache API offers. Not an LRU — a photograph looked at twice is no likelier to be
 *  wanted than one looked at once, and pretending otherwise would need a second store to track it. */
async function trim(cache) {
  const keys = await cache.keys();
  if (keys.length <= PHOTO_LIMIT) return;
  await Promise.all(keys.slice(0, keys.length - PHOTO_LIMIT).map((key) => cache.delete(key)));
}

/** Pre-load the shortlist's photographs, asked for by the page.
 *
 *  The page sends the URLs because the page is the only one that knows them — they live behind a
 *  session this worker does not hold. Fetched one at a time, deliberately: this is a background
 *  convenience competing with whatever the reader is actually doing, and a hundred parallel image
 *  requests would take the network away from the screen in front of them. Anything already cached
 *  costs nothing, so a second run over the same list is nearly free.
 *
 *  A failure is silence. It is a photograph that will load from the network later, like every other
 *  photograph — not something to report, and not a reason to abandon the rest of the list. */
self.addEventListener('message', (event) => {
  const data = event.data;
  if (data?.type !== 'warm-photos' || !Array.isArray(data.urls)) return;
  event.waitUntil(warm(data.urls));
});

async function warm(urls) {
  const cache = await caches.open(PHOTOS);
  for (const url of urls.slice(0, PHOTO_LIMIT)) {
    if (typeof url !== 'string' || !RIGHTMOVE_MEDIA.test(url)) continue;
    try {
      if (await cache.match(url)) continue;
      const response = await fetch(url, { mode: 'no-cors' });
      if (response.type === 'opaque' || response.ok) await cache.put(url, response);
    } catch {
      // Offline, or that one image is gone. Both are the network's business, not the reader's.
    }
  }
  void trim(cache);
}
