'use client';

import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { Opener, loadIntervalMs } from '@house-hunt/ui';
import { toSweepHub, recheckTargets, RECHECK_AFTER_DAYS } from '@house-hunt/core';
import {
  getShortlist,
  listHubSweeps,
  locateProperties,
  pendingSightings,
  resetSweepProgress,
  type HubSweep,
} from '@house-hunt/core/db';
import { keys, useExtension, useHubs, useProjectSettings, useShortlist } from '@/lib/queries';
import { useCanHoldExtension } from '@/lib/platform';
import { openTabExtension, type ExtensionState } from '@/lib/bridge';
import {
  abortableSleep,
  runFullSweep,
  type FullSweepProgress,
  type FullSweepSummary,
} from '@/lib/full-sweep';
import type { Place, SweepCriteria } from '@house-hunt/core';
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
  // What this hunt searches for. There is no default (see `RENTAL_SEARCH`), so a project that has
  // not chosen gets no sweep links and a sentence saying where to choose.
  const settings = useProjectSettings();
  const criteria = settings.data?.search ?? null;

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

  // Keyed on the place's id rather than its name: a renamed place must keep the sweep history that
  // dates its next window.
  const byPlaceId = new Map((sweeps.data ?? []).map((s) => [s.placeId, s]));
  const projectHubs = hubs.data ?? [];

  return (
    <section className="sweep">
      <h2 className="sweep-fill-heading">Everything</h2>
      <FullSweep
        hubs={projectHubs}
        criteria={criteria}
        ready={hubs.isSuccess && settings.isSuccess}
        onFinished={() => void pending.refetch()}
      />

      <h2 className="sweep-fill-heading">Scan</h2>
      <p className="dim">
        Each link opens Rightmove's own search around one of your places, filtered to what has
        appeared or changed since it was last swept. The panel on that page records every card and
        says when it is safe to page on. Scan as many places and pages as you like — filling them
        in is the separate step below, and it works through everything you have scanned.
      </p>

      {(hubs.isPending || sweeps.isPending) && <p className="working">Working…</p>}
      {hubs.isError && <p className="error">Could not read this project's places.</p>}
      {sweeps.isError && <p className="error">Could not read when each hub was last swept.</p>}

      {/* A project with no neighbourhoods gets this rather than an empty grid or, worse, the five
          London ones this file used to compile in. Naming Hampstead at someone searching Manchester
          is not a friendlier first run, it is a wrong one. */}
      {hubs.isSuccess && projectHubs.length === 0 && (
        <p className="dim">
          Nowhere to sweep yet. A sweep works one place's search results to the end, so there is
          nothing to do until you tick <em>search around</em> on one of your places — Your Hunt →
          Places.
        </p>
      )}

      {settings.isSuccess && criteria === null && (
        <p className="dim">
          Nothing to sweep for yet — this hunt has not said what it is looking for. Set the
          Rightmove filters on Your Hunt and every place below becomes a link. There is
          deliberately no default: a price band nobody chose returns a search that looks like it
          worked and is somebody else&rsquo;s.
        </p>
      )}

      <div className="sweep-hubs">
        {projectHubs.map((hub) => (
          <HubRow key={hub.id} hub={hub} sweep={byPlaceId.get(hub.id) ?? null} criteria={criteria} />
        ))}
      </div>

      <h2 className="sweep-fill-heading">Fill in</h2>
      <FillIn
        pending={pending.data ?? null}
        loading={pending.isPending}
        failed={pending.isError}
        refresh={() => void pending.refetch()}
      />

      <h2 className="sweep-fill-heading">Re-check</h2>
      <Recheck />
    </section>
  );
}

/** Installed and answering, whichever way it is signed in. The fill-in and re-check runs need the
 *  extension for one thing only — opening a background tab — and a signed-out one can still do
 *  that; the listing's own panel then says it is signed out. The full run is gated harder, on
 *  `signed-in`: it *waits* for each search page to be recorded, and a signed-out panel records
 *  nothing, so the button would start a minute of silence ending in `PageNotRecorded`. */
function extensionPresent(state: ExtensionState | undefined): boolean {
  return state?.status === 'signed-in' || state?.status === 'signed-out';
}

/** What every run rewrites, refetched. A run touches property rows, price history, the off-market
 *  set and sweep progress, and each is on screen somewhere; refetching the lot is cheaper to
 *  reason about than naming which of them a given listing happened to touch. */
function invalidateAfterRun(client: QueryClient): void {
  for (const key of [keys.shortlist, keys.offMarket, keys.prices, ['sweeps'], ['pending']]) {
    void client.invalidateQueries({ queryKey: key });
  }
}

/** Fill in map positions for the flats a run just opened. Opening records a postcode but never
 *  geocodes it, and the once-per-page-load backfill will not revisit these rows while this tab
 *  stays mounted — so do it here, or their pins would not appear until a hard reload.
 *
 *  Best-effort, but not silent. An empty catch discarded the reason entirely: the pins simply
 *  would not appear, and nothing on screen or in the console connected that to a lookup that
 *  failed. Returns the note to show, which stays out of the run's error because the run itself
 *  succeeded — colouring a finished sweep red for a missing pin says the wrong thing. */
async function placePins(): Promise<string | null> {
  try {
    await locateProperties();
    return null;
  } catch (e: unknown) {
    const why = e instanceof Error ? e.message : String(e);
    console.warn('[sweep] filling in map positions failed', e);
    return `Map pins for this run could not be placed — ${why}. They will be placed next time this page loads.`;
  }
}

type FullRun =
  | { state: 'running'; progress: FullSweepProgress | null }
  | { state: 'finished'; summary: FullSweepSummary; mapNote: string | null }
  | { state: 'failed'; message: string };

/** The whole sweep from one button — see `runFullSweep` for what it does and in what order.
 *
 *  The three sections below it are unchanged and still work on their own; this is them in
 *  sequence, unattended, at the pace the opener is set to. Offered only when the extension is
 *  here, for the same reason as the fill-in run: every page is a background tab, and only the
 *  extension can open one. */
function FullSweep({
  hubs,
  criteria,
  ready,
  onFinished,
}: {
  hubs: Place[];
  criteria: SweepCriteria | null;
  /** Whether the places and criteria have been read. A button offered before then would start a
   *  run over an empty list and report "nothing to scan" about a hunt with five places. */
  ready: boolean;
  onFinished: () => void;
}) {
  // The shared hook rather than a third `useQuery` on the key `useExtension` owns — see the note
  // in `Recheck`. This one arrived on `main` while the other two were being folded together, so it
  // is the same duplication one merge later.
  const extension = useExtension();
  const client = useQueryClient();
  const [run, setRun] = useState<FullRun | null>(null);
  const controller = useRef<AbortController | null>(null);

  // Leaving the screen stops the run: the tabs already opened are recorded and the rest are still
  // here next time, exactly as the fill-in run's note promises. Nulled as well as aborted, so the
  // handlers below can tell a run that ended from one that was walked away from.
  useEffect(
    () => () => {
      controller.current?.abort();
      controller.current = null;
    },
    [],
  );

  const start = () => {
    const abort = new AbortController();
    controller.current = abort;
    // Whether this run is still the one on screen. False after an unmount, or after Stop and a
    // second press — either way the state below belongs to somebody else now.
    const current = () => controller.current === abort;
    setRun({ state: 'running', progress: null });
    void runFullSweep({
      hubs,
      criteria,
      intervalMs: loadIntervalMs(),
      signal: abort.signal,
      onProgress: (progress) => setRun({ state: 'running', progress }),
      deps: {
        openTab: async (url) => {
          const reply = await openTabExtension(url);
          if (!reply) throw new Error('the extension did not answer');
          if (reply.kind === 'error') throw new Error(reply.message);
        },
        listSweeps: listHubSweeps,
        resetSweep: resetSweepProgress,
        pending: pendingSightings,
        shortlist: getShortlist,
        sleep: abortableSleep,
        now: () => new Date(),
      },
    })
      .then(async (summary) => {
        if (!current()) return;
        // Pins first, then the repaint — the other order refetches the shortlist into the cache
        // with the null/fuzzed positions the geocode is about to replace. Not after Stop, though:
        // the geocode cannot be interrupted, and Stop promised to take effect at once. The
        // page-load backfill places those pins next time.
        const opened = summary.filledIn > 0 || summary.rechecked > 0;
        const mapNote = opened && !summary.stopped ? await placePins() : null;
        if (!current()) return;
        invalidateAfterRun(client);
        onFinished();
        controller.current = null;
        setRun({ state: 'finished', summary, mapNote });
      })
      .catch((e: unknown) => {
        if (!current()) return;
        // What did land is on screen somewhere, even when the run stopped on an error.
        invalidateAfterRun(client);
        controller.current = null;
        setRun({ state: 'failed', message: e instanceof Error ? e.message : String(e) });
      });
  };

  if (run?.state === 'running') {
    const p = run.progress;
    return (
      <div className="rm-open-run" data-testid="full-sweep-running">
        <div className="rm-open-run-head">
          <span>
            {p ? PHASE_LABEL[p.phase] : 'Reading what has been swept…'}
            {p && p.total !== null ? ` · ${Math.min(p.done + 1, p.total)} of ${p.total}` : ''}
          </span>
          <button type="button" className="rm-open-stop" onClick={() => controller.current?.abort()}>
            Stop
          </button>
        </div>
        {/* Indeterminate until page 1 of a place is in — the total is not known before then. */}
        {p && p.total !== null ? <progress value={p.done} max={p.total} /> : <progress />}
        <div className="rm-open-at">{p?.label ?? ''}</div>
      </div>
    );
  }

  const searchable = hubs.filter((hub) => toSweepHub(hub).rightmove !== null && hub.sweepRadiusMiles !== null);
  // The same test `sweepSearchUrl` makes: a saved-but-empty set of filters is no filters.
  const noCriteria = criteria === null || Object.keys(criteria).length === 0;
  const intervalMs = loadIntervalMs();

  return (
    <div className="sweep-fill">
      <p className="dim">
        One press does the lot, in order: scan every place below page by page, open every listing
        the scan turned up, then reopen every place in the funnel that is due a re-check. Each page
        is a background tab through the extension, one every {Math.round(intervalMs / 1000)}s — the
        pace is the one set under <em>Fill in</em>. It runs while this tab is open, and stopping
        loses nothing: what was opened is recorded, and the rest is still here next time.
      </p>
      {run?.state === 'finished' && <Finished summary={run.summary} mapNote={run.mapNote} />}
      {run?.state === 'failed' && <p className="error">{run.message}</p>}
      {/* Nothing while the extension question is outstanding — the button either appears or the
          reason it cannot does, but not a flicker between them. */}
      {extension.isPending || !ready ? null : extension.data?.status === 'signed-in' ? (
        <button
          type="button"
          className="rm-open-go"
          data-testid="full-sweep-go"
          disabled={searchable.length === 0 || noCriteria}
          onClick={start}
        >
          <span>Sweep everything</span>
          <small>
            {noCriteria
              ? 'nothing to search for yet — set the Rightmove filters on Your Hunt'
              : searchable.length === 0
                ? 'no place is searchable yet — tick "search around" on Your Hunt → Places'
                : `${searchable.length} ${searchable.length === 1 ? 'place' : 'places'} to scan, then ` +
                  'everything scanned and everything due · unattended · stoppable'}
          </small>
        </button>
      ) : extension.data?.status === 'broken' ? (
        <p className="error">
          The extension is installed but did not answer, so a sweep cannot open tabs —{' '}
          {extension.data.message}
        </p>
      ) : extension.data?.status === 'signed-out' ? (
        <p className="dim">
          The extension is installed but signed out, and a signed-out extension records nothing.
          Sign in there — signing in here again does it — and this run appears.
        </p>
      ) : (
        <p className="dim">
          A full sweep opens Rightmove pages in the background, which only the extension can do.
          Install it and sign in there, and this run appears.
        </p>
      )}
    </div>
  );
}

const PHASE_LABEL: Record<FullSweepProgress['phase'], string> = {
  scan: 'Scanning',
  fill: 'Filling in',
  recheck: 'Re-checking',
};

/** What a run did, in the terms the three sections underneath use, so the numbers can be read
 *  against them. Skipped places are named with their reason — the same three reasons the per-place
 *  rows give — rather than folded into a count. */
function Finished({ summary, mapNote }: { summary: FullSweepSummary; mapNote: string | null }) {
  const s = summary;
  return (
    <>
      <p className="dim" data-testid="full-sweep-finished">
        {s.stopped ? 'Stopped. ' : 'Done. '}
        Scanned {s.pagesScanned} {s.pagesScanned === 1 ? 'page' : 'pages'} across {s.hubsScanned}{' '}
        {s.hubsScanned === 1 ? 'place' : 'places'}, opened {s.filledIn} new{' '}
        {s.filledIn === 1 ? 'listing' : 'listings'}, re-checked {s.rechecked}.
        {s.hubsSkipped.length > 0 &&
          ` Not scanned: ${s.hubsSkipped.map((h) => `${h.hub} (${h.why})`).join('; ')}.`}
      </p>
      {mapNote && <p className="dim">{mapNote}</p>}
    </>
  );
}

/** Going back over what we already have, which is the half of a sweep that was missing.
 *
 *  Everything above finds flats we have never seen. Nothing found out whether the ones we *had*
 *  seen were still true — so a shortlist could show a place at a price it no longer asks, on a
 *  market it has already left, with no sign of either. Opening a listing again is the only way to
 *  ask: the price and the withdrawal both live on Rightmove's page and nothing on our side may go
 *  and read it (AGENTS.md), so this is the same act as a first look, driven from the same opener.
 *
 *  What comes back is written down by paths that already exist. A live page updates the property
 *  row, and the `property_price` trigger records the price if it has moved; a withdrawn one is
 *  recognised by the extractor and marks the flat off the market. Neither needed anything new here,
 *  which is why this screen is a worklist and a button rather than a feature. */
function Recheck() {
  const shortlist = useShortlist();
  // `useExtension`, not a `useQuery` of its own on the same key. Two observers of one key with
  // different options is how the banner and the Install screen came to answer the same question
  // differently, and these two were doing it again — with no `staleTime`, so a window focus
  // re-probed, and with no idea that a phone has no extension to probe for.
  const extension = useExtension();
  const extensionPossible = useCanHoldExtension();
  const client = useQueryClient();

  if (shortlist.isPending) return <p className="working">Working…</p>;
  if (shortlist.isError) return <p className="error">Could not read the shortlist.</p>;

  const targets = recheckTargets(shortlist.data ?? []);
  const present = extensionPresent(extension.data);

  if (targets.length === 0) {
    return (
      <p className="dim">
        Nothing in the funnel is due for a re-check — a reading holds for {RECHECK_AFTER_DAYS} days.
        Places nobody has liked or staged are left alone, and so is anything archived: a flat you
        have walked away from is not worth a tab to find out it has gone.
      </p>
    );
  }

  return (
    <>
      {/* Says which flats, not just how many. The count is a *slice* — the funnel, minus archived —
          and a sentence that said "places" while the number came from a narrower set would read as
          full coverage of a run that skips four hundred flats on purpose. */}
      <p className="dim">
        {targets.length} {targets.length === 1 ? 'place' : 'places'} in the funnel{' '}
        {targets.length === 1 ? 'is' : 'are'} due for a re-check — last read over{' '}
        {RECHECK_AFTER_DAYS} days ago, or on a date we cannot read. Reopening tells us what they cost
        now and which have gone — the ones you love go first, so stopping halfway costs you the
        least. Places nobody has liked or staged are left alone, and so is anything archived.
      </p>
      <div className="sweep-fill">
        {extension.isPending ? null : present ? (
          <Opener
            targets={targets.map((row) => ({
              rightmoveId: row.rightmoveId,
              label: row.displayAddress || row.rightmoveId,
            }))}
            what="that may have changed"
            onFinished={() => invalidateAfterRun(client)}
          />
        ) : (
          <p className="dim">
            {extensionPossible
              ? 'Re-checking opens listing pages in the background, which only the extension can do. Install it and sign in there, and this run appears.'
              : 'Re-checking opens listing pages in the background, which only the browser extension can do — and no phone can run one. Open this hunt on a computer and the run appears there. The list above is the same either way.'}
          </p>
        )}
      </div>
    </>
  );
}

/** One place we search around: the link to go looking with, how far back that search reaches, and how much
 *  of a sweep already in progress is still outstanding. */
function HubRow({ hub, sweep, criteria }: { hub: Place; sweep: HubSweep | null; criteria: SweepCriteria | null }) {
  // From `hub_sweep` and nowhere else. `project_hub` briefly carried a copy and the migration
  // dropped it — two homes for this one date is how they come to disagree, and a disagreement here
  // narrows the next window past listings nobody looked at.
  const choice = sweepWindow(sweep?.lastSweptAt ?? null, new Date(), hub.maxDaysSinceAdded);
  const url = sweepSearchUrl({ hub: toSweepHub(hub), days: choice.days, criteria });

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
        {/* No link unless there is a real search behind it. A URL built from an unverified
            identifier returns a page full of plausible flats somewhere else, which is the failure
            that looks like success — and one built with no criteria returns every rental in the
            radius. The line underneath says which of the three is missing. */}
        {url ? (
          <a className="sweep-go" href={url} target="_blank" rel="noopener">
            {hub.label} ↗
          </a>
        ) : (
          <span className="sweep-go sweep-go-off">{hub.label}</span>
        )}
        {sweep?.lastResultCount !== null && sweep?.lastResultCount !== undefined && (
          <span className="dim">{sweep.lastResultCount} last time</span>
        )}
      </div>
      <div className={choice.covered ? 'dim sweep-window' : 'sweep-window sweep-gap'}>
        {/* A null URL has three causes and they need three different things doing about them.
            Collapsed into "no verified Rightmove location" they read as a fault with this place,
            and two thirds of the time that is wrong and the advice is to redo something already
            done. */}
        {url ? (
          windowLabel(choice)
        ) : criteria === null ? (
          <>
            Nothing to search for yet — this hunt has not said what it is looking for. Set the
            Rightmove filters on Your Hunt and this becomes a link.
          </>
        ) : hub.sweepRadiusMiles === null ? (
          <>
            Not swept: nobody has said how far around {hub.label} to look. Tick{' '}
            <em>search around</em> on Your Hunt → Places.
          </>
        ) : (
          <>
            Not searchable: this place has no verified Rightmove location, so there is no search to
            open.{' '}
            {hub.lat === null
              ? 'It has no coordinates either — it is carrying old sweep history and nothing else.'
              : 'It can still say what a listing is near. Resolve it on Your Hunt to sweep it.'}
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
  // needs the extension. One shared query for the whole page — see the note in `Recheck`.
  const extension = useExtension();
  const extensionPossible = useCanHoldExtension();

  if (loading) return <p className="working">Working…</p>;
  if (failed) return <p className="error">Could not read what still needs opening.</p>;
  if (!pending) return null;

  // Both notices are about the run that just finished, so they have to outlive the list that run was
  // working through. `onFinished` recounts before it geocodes, and a run that opened the last pending
  // listing empties the list on that recount — so a notice rendered only beside the list would be set
  // and then immediately hidden by the early return below, which is the case it most needs to cover.
  const notices = (
    <>
      {error && <p className="error">{error}</p>}
      {/* Under the error and dimmer than it: the run worked, only the pins are missing, and
          the page-load backfill places them next time. */}
      {mapNote && <p className="dim">{mapNote}</p>}
    </>
  );

  if (pending.length === 0) {
    return (
      <>
        <p className="dim">Everything scanned has been opened and filled in.</p>
        {notices}
      </>
    );
  }

  // Grouped only to say where the work is. The run itself goes newest-sighting-first across all
  // hubs, because a flat that appeared this morning is the one worth opening before it goes.
  const byHub = new Map<string, number>();
  for (const row of pending) byHub.set(row.hub, (byHub.get(row.hub) ?? 0) + 1);

  const present = extensionPresent(extension.data);

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
                // Recount first, so the pending number updates the moment the run ends rather than
                // waiting on the geocode below — the count is "opened and analysed", not "mapped",
                // so a slow postcode lookup must not hold it up. Listings whose analysis landed
                // during the run drop out here; the rest follow as it lands and the window-focus
                // refetch re-runs this.
                refresh();
                // Then the pins for what this run opened (`placePins` says why here rather than
                // the page-load backfill), and a repaint regardless of the geocode's outcome: even
                // a geocode that threw after writing some coordinates has left the shortlist
                // holding stale null/fuzzed positions.
                setMapNote(await placePins());
                invalidateAfterRun(client);
              }}
              onError={setError}
            />
            {notices}
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
          //
          // "Not installed here" and "cannot be installed here" are different sentences and only
          // one of them is an instruction. On a phone the first reads as something to go and fix,
          // and there is nothing to fix — so it names the computer instead, which is where the run
          // can actually happen.
          <p className="dim">
            {extensionPossible
              ? 'Filling in opens each listing in a background tab, which needs the browser extension — and it is not installed here. Everything else on this page works without it.'
              : 'Filling in opens each listing in a background tab, which needs the browser extension — and no phone can run one. Open this hunt on a computer to do a run; the count above is the same wherever you read it.'}
          </p>
        )}
      </div>
    </>
  );
}
