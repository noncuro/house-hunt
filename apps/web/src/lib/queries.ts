'use client';

import {
  MutationCache,
  QueryCache,
  QueryClient,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import {
  readAuthState,
  cachedTravelTimes,
  getShortlist,
  listHubs,
  listPlaces,
  locateProperties,
  NoActiveProject,
  setVerdict,
  travelTimes,
  Unauthenticated,
  type ShortlistEntry,
} from '@house-hunt/core/db';
import type { AuthState, Rating, TravelTime, Verdict } from '@house-hunt/core';
import { endSession } from './session';
import { signOutExtension } from './bridge';

/** Data plumbing for the house hunt.
 *
 *  This is `entrypoints/shortlist/queries.ts` from the extension with the transport taken out. The
 *  keys, the stale times, the optimistic verdict write and its per-property rollback, and the
 *  `onError` that re-reads the auth state are all unchanged, because none of them were ever about
 *  being inside an extension — they were about a page that is a second window onto data something
 *  else is also writing, which is still exactly what this is.
 *
 *  What went: `ask({ type: 'shortlist:get' })` and the `chrome.runtime.sendMessage` behind it. Every
 *  one of those messages existed only because the shortlist page could not reach the database
 *  itself. This one can, so `getShortlist()` is the whole of it. */
export const queryClient = new QueryClient({
  // A session can end while this page is open — signed out on the other laptop, or a refresh token
  // that finally aged out. Every read then fails at once, and without this the page would show six
  // copies of "sign in" where the shell should have swapped itself for the sign-in view.
  queryCache: new QueryCache({ onError: (error) => reconsiderSession(error) }),
  mutationCache: new MutationCache({ onError: (error) => reconsiderSession(error) }),
  defaultOptions: {
    queries: {
      // The panel on Rightmove writes to the same database, so coming back to this tab is exactly
      // when the data is most likely to be out of date.
      refetchOnWindowFocus: true,
      // Long enough that switching tabs twice in a row doesn't re-fetch, short enough that a
      // verdict made a minute ago on the other laptop shows up.
      staleTime: 30_000,
      retry: 1,
    },
  },
});

/** A read failed because there is no session, or no project to read within. Both change what the
 *  shell should be showing, and neither is knowable from the failed read itself.
 *
 *  In the extension these arrived as flags on a message envelope, because the failure crossed a
 *  worker boundary that only carries plain objects and the alternative was matching on wording. Here
 *  the call is in-process, so the classes core already throws are the same information without the
 *  envelope. */
function reconsiderSession(error: unknown) {
  if (!(error instanceof Unauthenticated) && !(error instanceof NoActiveProject)) return;
  void queryClient.invalidateQueries({ queryKey: keys.auth });
}

export const keys = {
  auth: ['auth'] as const,
  shortlist: ['shortlist'] as const,
  places: ['places'] as const,
  hubs: ['hubs'] as const,
};

export function useShortlist() {
  return useQuery({ queryKey: keys.shortlist, queryFn: getShortlist });
}

export function usePlaces() {
  return useQuery({ queryKey: keys.places, queryFn: listPlaces });
}

export function useHubs() {
  return useQuery({ queryKey: keys.hubs, queryFn: listHubs });
}

/** Who is signed in, which projects they are in, and which one is active — the one answer the whole
 *  shell is decided from (design D13).
 *
 *  Never stale on a timer. Being signed out is not something that quietly becomes true in the
 *  background: it happens because someone pressed Sign out, or because a read came back
 *  unauthenticated, and both invalidate this key directly. Re-asking every thirty seconds would
 *  only add a way for the whole page to blink. */
export function useAuth() {
  return useQuery({ queryKey: keys.auth, queryFn: readAuthState, staleTime: Infinity });
}

/** End the session and throw away everything read under it.
 *
 *  Write the new state first, then `resetQueries` — never `clear()`. `clear()` removes queries
 *  without notifying their observers, so a write immediately afterwards lands on a query nothing is
 *  watching and the screen does not change. That cost the project switcher a whole release: the
 *  switch reached the database and the shell carried on naming the hunt you had just left. */
export function useSignOut() {
  const client = useQueryClient();
  return useMutation({
    // The extension goes first, and its failure is not allowed to stop this one. Signing out is
    // something you do because you want to be signed out; a bridge that did not answer must not
    // leave you signed in here on the strength of it.
    mutationFn: async () => {
      await signOutExtension().catch(() => null);
      await endSession();
    },
    onSuccess() {
      client.setQueryData<AuthState>(keys.auth, { status: 'signed-out' });
      void client.resetQueries({ predicate: (query) => query.queryKey[0] !== keys.auth[0] });
    },
  });
}

/** Every travel time already in the cache, for the compare table.
 *
 *  Cache-only on purpose. Resolving a missing leg costs a TfL call, and the compare table asks
 *  about every flat at once — read-through here would turn opening a table into fifty lookups. The
 *  detail view resolves the one flat you are actually looking at. */
export function useCachedTravel(postcodes: Array<string | null>) {
  const wanted = [...new Set(postcodes.filter((p): p is string => Boolean(p)))].sort();
  return useQuery({
    // Keyed on the postcodes themselves, so adding a property refetches and reordering doesn't.
    queryKey: ['travel', wanted],
    queryFn: () => cachedTravelTimes(wanted),
    enabled: wanted.length > 0,
  });
}

/** Travel times for one listing, resolving anything missing. The detail view's read.
 *
 *  Keyed on the places as well as the postcode. A card stays mounted while you visit Settings, so
 *  with the postcode alone, adding a destination left the card rendering that new place with no row
 *  to match it — and printing "no route", which is a claim about geography rather than about the
 *  fetch never having happened. */
export function useTravel(postcode: string | null, placesKey: string) {
  return useQuery<TravelTime[]>({
    queryKey: ['travel-live', postcode, placesKey],
    queryFn: () => travelTimes(postcode!),
    enabled: Boolean(postcode),
    // Resolving costs real calls at the far end, so do not re-ask because a window regained focus.
    refetchOnWindowFocus: false,
    staleTime: 5 * 60_000,
  });
}

/** Backfill postcode-accurate coordinates once per page load. Idempotent — rows that already have
 *  them are never looked at again — so this costs one query that usually returns nothing. */
export function useLocateProperties() {
  const client = useQueryClient();
  return useQuery({
    queryKey: ['locate'],
    queryFn: async () => {
      const located = await locateProperties();
      if (located > 0) await client.invalidateQueries({ queryKey: keys.shortlist });
      return located;
    },
    // Geocoding doesn't go stale, and re-running it on every window focus would be pure waste.
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
}

/** Rate a place, optimistically.
 *
 *  onMutate paints the new verdict immediately and returns the previous one; onError puts it back.
 *  An optimistic UI that doesn't roll back has already told you a failed save succeeded. */
export function useRate(person: string | null) {
  const client = useQueryClient();

  return useMutation({
    mutationFn: async ({ rightmoveId, rating, note }: { rightmoveId: string; rating: Rating; note: string }) => {
      if (!person) throw new Error('Pick who you are in Settings first — nothing was saved.');
      return await setVerdict(rightmoveId, rating, note);
    },

    async onMutate({ rightmoveId, rating, note }) {
      if (!person) return;
      await client.cancelQueries({ queryKey: keys.shortlist });

      // The verdict for THIS property only, not a snapshot of the whole list. Rating three places
      // in quick succession runs three mutations at once; with a whole-list snapshot each, the
      // first to fail would restore a list from before the other two and silently undo them.
      //
      // Matched on the property alone, never on `person`. A project holds ONE verdict per property
      // — `person` is who last set it, not whose copy it is. Filtering by it meant that rating a
      // flat somebody else had already rated appended a second verdict instead of replacing theirs,
      // and everything downstream reads `verdicts[0]`.
      const before =
        client.getQueryData<ShortlistEntry[]>(keys.shortlist)?.find((e) => e.rightmoveId === rightmoveId)
          ?.verdicts[0] ?? null;

      const optimistic: Verdict = {
        rightmoveId,
        person,
        rating,
        note,
        updatedAt: new Date().toISOString(),
      };
      client.setQueryData<ShortlistEntry[]>(keys.shortlist, (current) =>
        (current ?? []).map((entry) =>
          entry.rightmoveId === rightmoveId ? { ...entry, verdicts: [optimistic] } : entry,
        ),
      );
      return { before, rightmoveId };
    },

    onError(_error, _variables, context) {
      if (!person || !context) return;
      // Put back exactly what this property's verdict was, leaving every other row — including ones
      // rated while this request was in flight — untouched. A null `before` means there was no
      // verdict to start with, so the rollback is a removal.
      client.setQueryData<ShortlistEntry[]>(keys.shortlist, (current) =>
        (current ?? []).map((entry) =>
          entry.rightmoveId === context.rightmoveId
            ? { ...entry, verdicts: context.before ? [context.before] : [] }
            : entry,
        ),
      );
    },

    onSettled() {
      void client.invalidateQueries({ queryKey: keys.shortlist });
    },
  });
}
