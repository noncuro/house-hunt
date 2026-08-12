'use client';

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Opener } from '@house-hunt/ui';
import { toSweepHub } from '@house-hunt/core';
import { listHubSweeps, locateProperties, pendingSightings, type HubSweep } from '@house-hunt/core/db';
import { keys, useHubs } from '@/lib/queries';
import { helloExtension } from '@/lib/bridge';
import type { ProjectHub } from '@house-hunt/core';
import { sweepSearchUrl, sweepWindow, windowLabel } from '@house-hunt/core';

/** Going looking, in two separate halves.
 *
 *  **Scanning** is per page and instant: open a hub's search results, the panel there records
 *  every card, and you page on. That is the half that has to happen on Rightmove, because the
 *  cards only exist there.
 *
 *  **Filling in** is one long unattended run over everything scanned so far, and it used to be
 *  bolted onto the scanning page — which made its worklist the two dozen cards on screen and
 *  killed it the moment you paged on. Sweeping five hubs of four pages each meant twenty separate
 *  runs, each of which you had to sit through before navigating. It belongs here instead, where
 *  the tab stays open and the worklist is a question about the database rather than about a DOM.
 *
 *  Nothing on this page fetches a search. The hub links are anchors a human clicks, and the opener
 *  opens listing pages one at a time — through the extension, in the background, which is the one
 *  thing the website cannot do for itself, so the fill-in run is only offered when the extension is
 *  installed here. See the standing rule in AGENTS.md. */
export function Sweep() {
  // The neighbourhoods are the project's own rows now, not a compiled list (design D11). Which is
  // why this view can be legitimately empty, and has to say so rather than name somewhere nobody
  // is searching.
  // The same key the shell's card view reads, through the same hook, so switching between them
  // costs nothing and the two cannot disagree about which neighbourhoods this house hunt has.
  const hubs = useHubs();

  const sweeps = useQuery({
    queryKey: ['sweeps'],
    queryFn: listHubSweeps,
  });

  const pending = useQuery({
    queryKey: ['pending'],
    queryFn: pendingSightings,
    // Every listing the opener opens changes this answer, and each one takes a while to finish
    // extracting. Refetching on focus is how the count comes back down after a run without anyone
    // pressing anything — the opener's worklist is "opened and analysed yet", both of which land
    // asynchronously as the background tabs finish.
    refetchOnWindowFocus: true,
  });

  // Keyed on the hub's id rather than its name: `hub_sweep` re-keyed onto `project_hub.id`, and a
  // renamed neighbourhood must keep the sweep history that dates its next window.
  const byHubId = new Map((sweeps.data ?? []).map((s) => [s.hubId, s]));
  const projectHubs = hubs.data ?? [];

  return (
    <section className="sweep">
      <h2>Scan</h2>
      <p className="dim">
        Each link opens Rightmove's own search for that neighbourhood, filtered to what has
        appeared or changed since it was last swept. The panel on that page records every card and
        says when it is safe to page on. Scan as many hubs and pages as you like — filling them in
        is the separate step below, and it works through everything you have scanned.
      </p>

      {(hubs.isPending || sweeps.isPending) && <p className="working">Working…</p>}
      {hubs.isError && <p className="error">Could not read this project's neighbourhoods.</p>}
      {sweeps.isError && <p className="error">Could not read when each hub was last swept.</p>}

      {/* A project with no neighbourhoods gets this rather than an empty grid or, worse, the five
          London ones this file used to compile in. Naming Hampstead at someone searching Manchester
          is not a friendlier first run, it is a wrong one. */}
      {hubs.isSuccess && projectHubs.length === 0 && (
        <p className="dim">
          No neighbourhoods yet. A sweep works one neighbourhood's search results to the end, so
          there is nothing to sweep until you add one — Settings → Neighbourhoods, by name or
          postcode.
        </p>
      )}

      <div className="sweep-hubs">
        {projectHubs.map((hub) => (
          <HubRow key={hub.id} hub={hub} sweep={byHubId.get(hub.id) ?? null} />
        ))}
      </div>

      <h2 className="sweep-fill-heading">Fill in</h2>
      <FillIn
        pending={pending.data ?? null}
        loading={pending.isPending}
        failed={pending.isError}
        refresh={() => void pending.refetch()}
      />
    </section>
  );
}

/** One neighbourhood: the link to go looking with, how far back that search reaches, and how much
 *  of a sweep already in progress is still outstanding. */
function HubRow({ hub, sweep }: { hub: ProjectHub; sweep: HubSweep | null }) {
  // From `hub_sweep` and nowhere else. `project_hub` briefly carried a copy and the migration
  // dropped it — two homes for this one date is how they come to disagree, and a disagreement here
  // narrows the next window past listings nobody looked at.
  const choice = sweepWindow(sweep?.lastSweptAt ?? null, new Date(), hub.maxDaysSinceAdded);
  const url = sweepSearchUrl({ hub: toSweepHub(hub), days: choice.days });

  // Which pages of a sweep in progress are still outstanding. This is the cross-tab answer to
  // "where did I get to" — the panel on the search page only ever knew about the tab it was in, so
  // a hub swept across two sittings meant remembering.
  const total = sweep?.pagesTotal ?? null;
  const outstanding =
    total === null
      ? []
      : Array.from({ length: total }, (_, i) => i + 1).filter((n) => !sweep!.pagesSeen.includes(n));

  return (
    <div className="sweep-hub">
      <div className="sweep-hub-head">
        {/* A hub whose Rightmove identifier we could not verify gets no link at all. A search URL
            with the wrong identifier still returns a page full of plausible flats somewhere else,
            which is the failure that looks like success. */}
        {url ? (
          <a className="sweep-go" href={url} target="_blank" rel="noopener">
            {hub.name} ↗
          </a>
        ) : (
          <span className="sweep-go sweep-go-off">{hub.name}</span>
        )}
        {sweep?.lastResultCount !== null && sweep?.lastResultCount !== undefined && (
          <span className="dim">{sweep.lastResultCount} last time</span>
        )}
      </div>
      <div className={choice.covered ? 'dim sweep-window' : 'sweep-window sweep-gap'}>
        {url ? (
          windowLabel(choice)
        ) : (
          <>
            Not searchable: this neighbourhood has no verified Rightmove location, so there is no
            search to open.{' '}
            {hub.lat === null
              ? 'It has no coordinates either — it is carrying old sweep history and nothing else.'
              : 'It can still say what a listing is near. Resolve it in Settings to sweep it.'}
          </>
        )}
      </div>
      {outstanding.length > 0 && (
        <div className="sweep-window sweep-partway">
          Part way through: {sweep!.pagesSeen.length} of {sweep!.pagesTotal} pages recorded,{' '}
          {outstanding.length === 1 ? 'page' : 'pages'} {outstanding.join(', ')} still to open. Not
          swept until they are all in.
        </div>
      )}
    </div>
  );
}

function FillIn({
  pending,
  loading,
  failed,
  refresh,
}: {
  pending: Array<{ rightmoveId: string; displayAddress: string; hub: string; missing: string[] }> | null;
  loading: boolean;
  failed: boolean;
  refresh: () => void;
}) {
  // The opener throws when a tab fails to open, and `Opener` stops the run on it; without somewhere
  // to show the reason the run would just stop with nothing on screen.
  const [error, setError] = useState<string | null>(null);
  /** Separate from `error`, because it is not one. The fill-in run succeeded and only the map
   *  positions did not land, so this says so quietly rather than colouring a finished run red. */
  const [mapNote, setMapNote] = useState<string | null>(null);
  const client = useQueryClient();

  // A fill-in run opens each listing in a background tab, which is `chrome.tabs.create` over the
  // bridge — the website has no such call. So the run is only offered when the extension answered
  // `hello`. The count below is a plain database read and shows regardless; it is the *opening* that
  // needs the extension. Held in react-query so flipping between Sweep and the other views does not
  // re-probe the extension each time.
  const extension = useQuery({ queryKey: ['extension'], queryFn: helloExtension });

  if (loading) return <p className="working">Working…</p>;
  if (failed) return <p className="error">Could not read what still needs opening.</p>;
  if (!pending) return null;

  if (pending.length === 0) {
    return <p className="dim">Everything scanned has been opened and filled in.</p>;
  }

  // Grouped only to say where the work is. The run itself goes newest-sighting-first across all
  // hubs, because a flat that appeared this morning is the one worth opening before it goes.
  const byHub = new Map<string, number>();
  for (const row of pending) byHub.set(row.hub, (byHub.get(row.hub) ?? 0) + 1);

  const present = extension.data?.status === 'signed-in' || extension.data?.status === 'signed-out';

  return (
    <>
      <p className="dim">
        {pending.length} scanned {pending.length === 1 ? 'listing has' : 'listings have'} not been
        opened yet, so we have no travel times, no floorplan reading and no map position for
        {pending.length === 1 ? ' it' : ' them'}.{' '}
        {[...byHub.entries()].map(([hub, n]) => `${hub} ${n}`).join(' · ')}
      </p>
      <div className="sweep-fill">
        {/* Nothing while the question is outstanding — the run either appears or the reason it
            cannot does, but not a flicker between them. */}
        {extension.isPending ? null : present ? (
          <>
            <Opener
              targets={pending.map((row) => ({
                rightmoveId: row.rightmoveId,
                label: row.displayAddress || row.rightmoveId,
              }))}
              what="we haven't opened yet"
              onFinished={async () => {
                setError(null);
                setMapNote(null);
                // Fill in map positions for the flats this run just opened. Opening records a
                // postcode but never geocodes it, and the once-per-page-load backfill will not
                // revisit these rows while this tab stays mounted — so do it here, once the run is
                // done, or their pins would not appear until a hard reload. Best-effort: a geocoding
                // hiccup must not swallow the recount. It does not gate the count (the opener is
                // "opened and analysed", not "mapped"); it just makes the map catch up.
                //
                // Best-effort, but not silent. `catch(() => 0)` said nothing at all, which is the
                // swallowed-error case this repo's own review rules name: the pins simply would not
                // appear and nothing on screen or in the console would connect that to a geocoding
                // call that failed. The run itself still counts as finished, so the reason goes in
                // its own quiet line rather than into `error`.
                const located = await locateProperties().catch((e: unknown) => {
                  const why = e instanceof Error ? e.message : String(e);
                  console.warn('[sweep] filling in map positions failed', e);
                  setMapNote(`Map pins for this run could not be placed — ${why}`);
                  return 0;
                });
                // If anything got a real position, the shortlist and map are holding stale
                // null/fuzzed coordinates for those rows — invalidate so they repaint, exactly as
                // `useLocateProperties` does for the page-load backfill.
                if (located > 0) await client.invalidateQueries({ queryKey: keys.shortlist });
                // Recount. Listings whose analysis landed during the run drop out; the rest follow
                // as their analysis lands and the window-focus refetch re-runs this.
                refresh();
              }}
              onError={setError}
            />
            {error && <p className="error">{error}</p>}
            {/* Under the error, and dimmer than it: the run worked and only the pins are missing.
                They land on the next page load, which the backfill runs on its own. */}
            {mapNote && (
              <p className="dim">
                {mapNote}. They will be placed the next time this page loads.
              </p>
            )}
            <p className="dim sweep-fill-note">
              Each listing opens in a background tab through the extension, so the run does not steal
              focus. It runs while this tab is open; stopping loses nothing — the ones already opened
              are filled in, and the rest are still here next time.
            </p>
          </>
        ) : extension.data?.status === 'broken' ? (
          <p className="error">
            The extension is installed but did not answer, so a fill-in run cannot open tabs —{' '}
            {extension.data.message}
          </p>
        ) : (
          // Absent. The listings must load as real Rightmove tabs for the extension to read them,
          // and the browser will not let the website open them in the background — so this needs
          // the extension, and says so rather than offering a button that cannot work.
          <p className="dim">
            Filling in opens each listing in a background tab, which needs the browser extension —
            and it is not installed here. Everything else on this page works without it.
          </p>
        )}
      </div>
    </>
  );
}
