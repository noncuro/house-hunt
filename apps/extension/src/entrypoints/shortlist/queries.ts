import {
  MutationCache,
  QueryCache,
  QueryClient,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { isNoProject, isUnauthenticated, send, type AuthState, type Request, type ResponseMap } from '@/lib/messages';
import type { ShortlistEntry } from '@house-hunt/core/db';
import type { Rating, Verdict } from '@house-hunt/core';

/** Data plumbing for the shortlist page.
 *
 *  TanStack Query rather than hand-rolled state: this page has three server reads, an optimistic
 *  write that must roll back, and needs to refresh when you come back to the tab after rating
 *  something in the panel on Rightmove. That last one is the real reason — the page is a second
 *  window onto data the panel is also writing, so it goes stale the moment you leave it.
 *
 *  tRPC would be the wrong tool here: there is no HTTP server. The transport is
 *  chrome.runtime.sendMessage into the background worker, and `Request`/`ResponseMap` already
 *  give end-to-end type safety over it. */
export const queryClient = new QueryClient({
  // A session can end while this page is open — signed out on the other laptop, or a refresh
  // token that finally aged out. Every read then fails at once, and without this the page would
  // show six copies of "sign in to the house hunt extension" where the shell should have swapped
  // itself for the sign-in view. Re-reading `auth:state` is what makes the shell notice.
  queryCache: new QueryCache({ onError: (error) => reconsiderSession(error) }),
  mutationCache: new MutationCache({ onError: (error) => reconsiderSession(error) }),
  defaultOptions: {
    queries: {
      // The panel writes to the same database from Rightmove tabs, so coming back to this tab
      // is exactly when the data is most likely to be out of date.
      refetchOnWindowFocus: true,
      // Long enough that switching tabs twice in a row doesn't re-fetch, short enough that a
      // verdict made a minute ago on the other laptop shows up.
      staleTime: 30_000,
      retry: 1,
    },
  },
});

/** A refusal from the worker, with the two flags that are states rather than failures kept
 *  attached. Query only carries an `Error`, so matching on `unauthenticated` downstream means
 *  either subclassing it or matching on wording — and matching on wording is exactly what the
 *  flags exist to stop (design D2, D13). */
export class BackgroundError extends Error {
  readonly unauthenticated: boolean;
  readonly noProject: boolean;

  constructor(message: string, flags: { unauthenticated: boolean; noProject: boolean }) {
    super(message);
    this.name = 'BackgroundError';
    this.unauthenticated = flags.unauthenticated;
    this.noProject = flags.noProject;
  }
}

/** Unwrap the message envelope into something Query can treat as success or failure. */
export async function ask<K extends Request['type']>(
  request: Extract<Request, { type: K }>,
): Promise<ResponseMap[K]> {
  const result = await send(request);
  if (!result.ok) {
    throw new BackgroundError(result.error, {
      unauthenticated: isUnauthenticated(result),
      noProject: isNoProject(result),
    });
  }
  return result.data;
}

/** A read failed because there is no session, or no project to read within. Both change what the
 *  shell should be showing, and neither is knowable from the failed read itself. */
function reconsiderSession(error: unknown) {
  if (!(error instanceof BackgroundError)) return;
  if (!error.unauthenticated && !error.noProject) return;
  void queryClient.invalidateQueries({ queryKey: keys.auth });
}

export const keys = {
  auth: ['auth'] as const,
  shortlist: ['shortlist'] as const,
  places: ['places'] as const,
};

export function useShortlist() {
  return useQuery({ queryKey: keys.shortlist, queryFn: () => ask({ type: 'shortlist:get' }) });
}

export function usePlaces() {
  return useQuery({ queryKey: keys.places, queryFn: () => ask({ type: 'places:list' }) });
}

/** Who is signed in, which projects they are in, and which one is active — the one answer the
 *  whole shell is decided from (design D13).
 *
 *  Never stale on a timer. Being signed out is not something that quietly becomes true in the
 *  background: it happens because someone pressed Sign out, or because a read came back
 *  `unauthenticated`, and both of those invalidate this key directly. Re-asking every thirty
 *  seconds would only add a way for the whole page to blink. */
export function useAuth() {
  return useQuery({
    queryKey: keys.auth,
    queryFn: () => ask({ type: 'auth:state' }),
    staleTime: Infinity,
  });
}

/** End the session and throw away everything read under it.
 *
 *  `clear()` rather than `invalidateQueries()`: the caches hold one project's shortlist, places
 *  and travel times, and signing back in as somebody else must not paint them for a second while
 *  the refetch is in flight. */
export function useSignOut() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => ask({ type: 'auth:sign-out' }),
    onSuccess() {
      // Same order, and for the same reason, as `reload` in Project.tsx: `clear()` removes queries
      // without notifying their observers, so writing the auth state afterwards lands on a query
      // nothing is watching. This one happens to work today only because it is called from the
      // component that reads the auth query, which re-renders on the mutation's own state change
      // and re-attaches on the way past. That is an accident of where it is called, not a
      // property of the code, and it stops being true the moment sign-out moves into a menu.
      client.setQueryData<AuthState>(keys.auth, { status: 'signed-out' });
      void client.resetQueries({ predicate: (query) => query.queryKey[0] !== keys.auth[0] });
    },
  });
}

/** Every travel time already in the cache, for the compare table. Deliberately cache-only: see
 *  `travel:cached` in the background worker for why read-through would be the wrong call here. */
export function useCachedTravel(postcodes: Array<string | null>) {
  const wanted = [...new Set(postcodes.filter((p): p is string => Boolean(p)))].sort();
  return useQuery({
    // Keyed on the postcodes themselves, so adding a property refetches and reordering doesn't.
    queryKey: ['travel', wanted],
    queryFn: () => ask({ type: 'travel:cached', postcodes: wanted }),
    enabled: wanted.length > 0,
  });
}

/** Backfill postcode-accurate coordinates once per page load. Idempotent — rows that already
 *  have them are never looked at again — so this costs one query that usually returns nothing. */
export function useLocateProperties() {
  const client = useQueryClient();
  return useQuery({
    queryKey: ['locate'],
    queryFn: async () => {
      const located = await ask({ type: 'properties:locate' });
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
 *  onMutate paints the new verdict immediately and returns the previous list; onError puts it
 *  back. That is the same contract the panel implements by hand, and the reason it matters is
 *  that an optimistic UI which doesn't roll back has already told you a failed save succeeded. */
export function useRate(person: string | null) {
  const client = useQueryClient();

  return useMutation({
    mutationFn: async ({ rightmoveId, rating, note }: { rightmoveId: string; rating: Rating; note: string }) => {
      if (!person) throw new Error('Pick who you are in Settings first — nothing was saved.');
      return await ask({ type: 'verdict:set', rightmoveId, rating, note });
    },

    async onMutate({ rightmoveId, rating, note }) {
      if (!person) return;
      await client.cancelQueries({ queryKey: keys.shortlist });

      // The verdict for THIS property only, not a snapshot of the whole list. Rating three places
      // in quick succession runs three mutations at once; with a whole-list snapshot each, the
      // first one to fail would restore a list from before the other two were rated and silently
      // undo them. Roll back the one thing this mutation touched and nothing else.
      //
      // Matched on the property alone, never on `person`. A project holds ONE verdict per property
      // — `person` is who last set it, not whose copy this is. Filtering by it meant that rating a
      // flat somebody else had already rated appended a second verdict instead of replacing theirs,
      // and everything downstream reads `verdicts[0]`: the card kept their rating and their colour,
      // `groupOf` short-circuits on any 'no' so it stayed in the rejected pile, and `enthusiasm`
      // summed both. It looked like the click had done nothing until the refetch landed.
      const before =
        client
          .getQueryData<ShortlistEntry[]>(keys.shortlist)
          ?.find((e) => e.rightmoveId === rightmoveId)?.verdicts[0] ?? null;

      const optimistic: Verdict = {
        rightmoveId,
        person,
        rating,
        note,
        updatedAt: new Date().toISOString(),
      };
      client.setQueryData<ShortlistEntry[]>(keys.shortlist, (current) =>
        (current ?? []).map((entry) =>
          entry.rightmoveId === rightmoveId
            ? { ...entry, verdicts: [optimistic] }
            : entry,
        ),
      );
      return { before, rightmoveId };
    },

    onError(_error, _variables, context) {
      if (!person || !context) return;
      // Put back exactly what this property's verdict was, leaving every other row — including
      // ones rated while this request was in flight — untouched. A null `before` means there was
      // no verdict to start with, so the rollback is a removal.
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
