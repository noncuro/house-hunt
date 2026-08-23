'use client';

import { galleryFor } from '@house-hunt/core';
import type { ShortlistEntry } from '@house-hunt/core/db';
import { isInstalled } from './platform';

/** Registering the worker, and giving it the photographs to keep.
 *
 *  The worker (`public/sw.js`) decides what to do with a request; this decides that it should exist
 *  and hands it the one thing it cannot know — which photographs belong to this hunt, which lives
 *  behind a session the worker does not hold.
 */

/** Only a production build. `next dev` serves a different bundle on every edit and a worker holding
 *  the last one is a page that will not update however many times it is reloaded — the classic way
 *  to spend an afternoon. The website is served as a production build under `smoke:web` too, which
 *  is what makes the offline behaviour something a harness can drive. */
export function registerServiceWorker(): void {
  if (process.env.NODE_ENV !== 'production') return;
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  // Failure is silence, and that is the right shape here: a browser that refuses the registration —
  // private mode, storage denied, an insecure origin — is a browser where this app still works
  // completely, minus the offline copy. There is nothing for the reader to do about it and nothing
  // to tell them.
  void navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {});
}

/** How many flats to pre-load photographs for. The shortlist is ordered with the ones worth looking
 *  at first, so this is not an arbitrary truncation — it is the top of the list, which is what
 *  somebody standing on a platform is going to open. Below the worker's own cap, so this can never
 *  be the thing that evicts what it just fetched. */
const WARM_FLATS = 300;

/** Ask the worker to fetch this hunt's photographs into its cache.
 *
 *  **Only when the app is installed.** A tab is a visit — it is open for a few minutes and closed,
 *  and spending somebody's data on photographs for a shortlist they are already looking at online
 *  buys nothing. An installed app is the one that gets opened on the Underground, and it is also
 *  the one whose storage the browser will not evict at the first sign of pressure.
 *
 *  Two images a flat, not the whole gallery. The card shows one and the panel opens on the same one
 *  beside the floorplan, and those two answer the question somebody actually has in front of the
 *  building — is this the flat, and is the second bedroom real. Fetching all twenty photographs of
 *  three hundred flats would be a gigabyte to save an offline swipe.
 */
export function warmPhotos(entries: ShortlistEntry[]): void {
  if (!isInstalled()) return;
  const worker = navigator.serviceWorker?.controller;
  // No controller means the worker is registered but has not taken over this page yet — it does so
  // on the next load. Nothing to do but wait for that; the photographs are cached as they are drawn
  // in the meantime, which is the normal path anyway.
  if (!worker) return;

  const urls = entries.slice(0, WARM_FLATS).flatMap((entry) => galleryFor(entry).slice(0, 2));
  if (urls.length === 0) return;
  worker.postMessage({ type: 'warm-photos', urls });
}
