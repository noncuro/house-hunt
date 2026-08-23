'use client';

import type { AuthState } from '@house-hunt/core';
import { keys, queryClient } from './queries';

/** The hunt, kept on this device, so the app has something to show with no network.
 *
 *  The service worker beside this (`public/sw.js`) keeps the *app* — the shell, the build, the
 *  photographs. This keeps what the app is about: the flats, the places, the verdicts, the funnel.
 *  Both are needed and neither is the other: a shell that boots to a spinner is as useless as a
 *  cache of data with no page to draw it.
 *
 *  IndexedDB rather than `localStorage`, for two reasons that are both about the data. It is
 *  structured-clone, so a `Set` of off-market ids and a `Map` of price histories go in as themselves
 *  rather than through a bespoke encoding that has to be kept in step with every query's shape. And
 *  it is asynchronous and roomy, where `localStorage` is a synchronous ~5MB budget that a few
 *  hundred flats with their analyses would fill — and would fill *on the main thread*, in the middle
 *  of a scroll.
 *
 *  **What is deliberately not kept here.** Anything that is money or permission: spend, the admin
 *  tables, the invite list. Those are read fresh or not shown. Nothing here is a decision — it is a
 *  copy of what this browser was last told, and everything restored from it is restored *stale*, so
 *  React Query refetches it the moment there is a network. That last part is the whole safety
 *  argument: a shared verdict is exactly the thing that must not be shown as current when it is not,
 *  and the timestamp goes back in with the data so the app can say how old it is (`Offline.tsx`).
 */

const DB_NAME = 'house-hunt';
const STORE = 'cache';
const RECORD = 'snapshot';
/** Bumped when the shape below changes. `onupgradeneeded` throws the old object store away, so a
 *  bump is also how a snapshot written by an incompatible build stops being read. */
const DB_VERSION = 1;

/** Which reads are worth keeping, by the first element of their query key.
 *
 *  Everything on this list is a fact about flats and hunts: what is on the shortlist, where the
 *  hunt travels to, what has been said, what things cost, how long the journeys take. Everything
 *  off it is either cheap to re-read, meaningless when stale, or nobody's business to keep — the
 *  extension handshake (about this browser, not this hunt), the spend summary (money, and moving),
 *  the one-shot geocoding backfill, and the live travel lookups the detail view makes. */
const KEEP = new Set<string>(['shortlist', 'places', 'off-market', 'settings', 'model', 'prices', 'travel']);

interface Snapshot {
  savedAt: number;
  /** Who this snapshot belongs to. Restored as the auth query's initial data so the shell can draw
   *  itself before — or without — a round trip. */
  auth: AuthState | null;
  /** The hunt the queries below were read under. Query keys do not carry the project (the active
   *  one is resolved inside each read), so this is the only thing standing between a restore and one
   *  hunt's flats appearing under another's name. A mismatch throws the queries away and keeps the
   *  auth, which is the half that decides which hunt is active in the first place. */
  projectId: string | null;
  queries: Array<{ key: readonly unknown[]; data: unknown; updatedAt: number }>;
}

/** How long to wait for the database to open before giving up on the offline copy.
 *
 *  `indexedDB.open` has a third outcome besides success and error, and it has no deadline: when the
 *  version has to change and another tab still holds a connection at the old one, the request goes
 *  `blocked` and stays pending until that tab closes. `Providers` awaits this before it renders
 *  anything, so an unbounded wait there is not a slow restore — it is a permanently blank app, on
 *  the second tab, with nothing on screen to say why.
 *
 *  A second is far longer than a local database read and short enough to be invisible if it is hit.
 *  Everything on the other side of it treats a failure as a cold start, which is what every version
 *  of this app before the snapshot existed did on every load. */
const OPEN_MS = 1_000;

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    let settled = false;

    const give = (outcome: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      outcome();
    };

    const timer = setTimeout(
      () =>
        give(() => {
          reject(new Error('the offline database did not open — another tab may be holding it'));
          // If it opens after all, close it rather than leaving a connection nothing holds a
          // reference to: an abandoned one would itself block the next version change.
          request.onsuccess = () => request.result.close();
        }),
      OPEN_MS,
    );

    request.onupgradeneeded = () => {
      const db = request.result;
      if (db.objectStoreNames.contains(STORE)) db.deleteObjectStore(STORE);
      db.createObjectStore(STORE);
    };
    request.onsuccess = () => give(() => resolve(request.result));
    request.onerror = () => give(() => reject(request.error));
    // Named rather than left to the timeout above, so the common cause reports itself in one second
    // instead of being indistinguishable from a database that is merely slow.
    request.onblocked = () =>
      give(() => reject(new Error('the offline database is open in another tab at an older version')));
  });
}

async function read(): Promise<Snapshot | null> {
  const db = await open();
  try {
    return await new Promise<Snapshot | null>((resolve, reject) => {
      const request = db.transaction(STORE, 'readonly').objectStore(STORE).get(RECORD);
      request.onsuccess = () => resolve((request.result as Snapshot | undefined) ?? null);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

async function write(snapshot: Snapshot): Promise<void> {
  const db = await open();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(snapshot, RECORD);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

/** Put the last snapshot back into the query cache, before anything reads it.
 *
 *  Called from `Providers`, in the same tick as `configureOnce` and before a single query mounts.
 *  That ordering is the point: React Query only takes `initialData` on a query's *first* render, so
 *  restoring after the shell has mounted would restore into queries that had already decided they
 *  had nothing and shown a spinner or an error.
 *
 *  Everything goes in with the timestamp it was written at, never with `now`. A restored shortlist
 *  is therefore stale on arrival and refetches immediately if there is a network — and if there is
 *  not, `dataUpdatedAt` is an honest answer to "how old is this", which is what the offline notice
 *  reads.
 */
export async function restore(): Promise<void> {
  let snapshot: Snapshot | null = null;
  try {
    snapshot = await read();
  } catch {
    // No IndexedDB at all (private browsing, storage denied), or a database this build cannot read.
    // Both mean the same thing: start from nothing, which is what every previous version of this
    // app did on every load.
    return;
  }
  if (!snapshot) return;

  if (snapshot.auth) {
    queryClient.setQueryData(keys.auth, snapshot.auth, { updatedAt: snapshot.savedAt });
    // And then marked stale by hand, which the timestamp alone does not do here: `useAuth` is
    // `staleTime: Infinity` on purpose — being signed out does not quietly become true in the
    // background, it happens because somebody pressed Sign out — so a restored answer would
    // otherwise be believed for the whole visit without one round trip. Invalidating makes the
    // shell draw immediately from the copy and re-ask the moment there is a network, which is the
    // pair of properties this whole file is for. It refetches when the observer mounts; there are
    // none yet, since nothing below `Providers` has rendered.
    void queryClient.invalidateQueries({ queryKey: keys.auth });
  }

  // The queries belong to one hunt. If the restored auth says a different one is active — somebody
  // switched hunts on another device, or signed in as somebody else — the flats in this snapshot
  // are not this hunt's, and drawing them under its name is worse than drawing nothing.
  const active = snapshot.auth?.status === 'signed-in' ? (snapshot.auth.activeProject?.id ?? null) : null;
  if (!snapshot.projectId || snapshot.projectId !== active) return;

  for (const { key, data, updatedAt } of snapshot.queries) {
    queryClient.setQueryData(key, data, { updatedAt });
  }
}

/** Start writing the cache back out as it changes. Returns the unsubscribe.
 *
 *  Debounced, because the cache fires an event per query and a page load settles half a dozen of
 *  them within a second of each other — one write of everything is both cheaper and more consistent
 *  than six writes of increasing subsets. The delay is long enough to coalesce a page load and short
 *  enough that closing the tab a few seconds after rating a flat keeps the rating. */
const SETTLE_MS = 1_500;

export function persist(): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;

  const save = () => {
    timer = null;
    const auth = queryClient.getQueryData<AuthState>(keys.auth) ?? null;
    const projectId = auth?.status === 'signed-in' ? (auth.activeProject?.id ?? null) : null;

    const queries = queryClient
      .getQueryCache()
      .getAll()
      .filter((query) => query.state.status === 'success' && KEEP.has(String(query.queryKey[0])))
      .map((query) => ({
        key: query.queryKey,
        data: query.state.data,
        updatedAt: query.state.dataUpdatedAt,
      }));

    // Failure is silence and has to be: this runs on a timer behind whatever the reader is doing,
    // a full quota or an evicted database is not something they asked for or can act on, and the
    // app is completely functional without it. What it must never do is throw into a cache
    // subscriber, which would take the next query update down with it.
    void write({ savedAt: Date.now(), auth, projectId, queries }).catch(() => {});
  };

  const unsubscribe = queryClient.getQueryCache().subscribe(() => {
    if (timer !== null) return;
    timer = setTimeout(save, SETTLE_MS);
  });

  return () => {
    if (timer !== null) clearTimeout(timer);
    unsubscribe();
  };
}

/** Throw the snapshot away. Signing out has to take the copy on the device with it — otherwise the
 *  next person to open this browser gets somebody else's shortlist drawn from a cache before the
 *  sign-in screen has decided anything. */
export async function forget(): Promise<void> {
  try {
    const db = await open();
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).delete(RECORD);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } finally {
      db.close();
    }
  } catch {
    // Nothing to clear, or no storage to clear it from.
  }
}
