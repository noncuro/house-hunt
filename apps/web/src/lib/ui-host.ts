import type { UiHost } from '@house-hunt/ui';
import { listingUrl } from '@house-hunt/core';
import { stationWalks } from '@house-hunt/core/db';
import { queryClient } from './queries';
import { openTabExtension } from './bridge';

/** What the shared components need, done the way an ordinary web page does it.
 *
 *  A station walk is a database read, and this page holds a Supabase client of its own — so that one
 *  is a line here where the extension round-trips a worker.
 *
 *  `openListing` is the exception, and it inverts the usual split: opening a listing in a background
 *  tab is a `chrome.tabs.create` the website does not have, so this asks the extension to do it over
 *  the bridge. A paced run of `window.open` from a timer is throttled to the first tab, which is why
 *  the web no longer tries — the Sweep view only offers a fill-in run when the extension answered
 *  `hello`, so reaching here means it is present. A null or error therefore means it went away
 *  mid-run, and throwing is right: `Opener` stops the run rather than grinding on. */
export const webHost: UiHost = {
  // Cached at the host seam rather than in `Stations`, which cannot cache: it renders inside the
  // Rightmove panel too, where there is no QueryClient — the fetch is injected for exactly that
  // reason. Without this, triage refetched the walks on every `j`/`k` step (the pane is keyed on
  // the flat, so each step unmounts it), and the station rows sat blank for ~200ms next to a
  // travel block that snapped back from its own cache. A walk from a postcode to a station is
  // fixed geography, not a verdict, so it is kept far longer than the 30s the rest of the app
  // uses — and `fetchQuery` dedupes in-flight asks as well. Note `stationWalks` resolves `{}`
  // rather than throwing when the lookup fails, so a failure is cached like an answer until the
  // staleTime lapses; it degrades one row's walk column, which is the documented trade there.
  stationWalks: (postcode, stations) =>
    queryClient.fetchQuery({
      queryKey: ['station-walks', postcode, [...stations].sort().join(',')],
      queryFn: () => stationWalks(postcode, stations),
      staleTime: 30 * 60_000,
      gcTime: 6 * 60 * 60_000,
    }),

  async openListing(rightmoveId) {
    const reply = await openTabExtension(listingUrl(rightmoveId));
    if (!reply) {
      throw new Error(
        'the extension did not answer — a fill-in run opens each listing in a background tab, ' +
          'which only the extension can do',
      );
    }
    if (reply.kind === 'error') throw new Error(reply.message);
  },
};
