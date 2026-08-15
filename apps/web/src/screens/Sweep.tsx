'use client';

import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Hint, Opener } from '@house-hunt/ui';
import { toSweepHub, recheckTargets, RECHECK_AFTER_DAYS } from '@house-hunt/core';
import {
  addHub,
  listHubSweeps,
  listHubs,
  locateProperties,
  pendingSightings,
  removeHub,
  resolveLocation,
  updateHub,
  type HubSweep,
} from '@house-hunt/core/db';
import { keys, useHubs, useProjectSettings, useShortlist } from '@/lib/queries';
import { attempt, type Notify } from '@/lib/attempt';
import { helloExtension } from '@/lib/bridge';
import type { LocationResult, ProjectHub, SweepCriteria } from '@house-hunt/core';
import { SWEEP_WINDOWS, distanceMiles, sweepSearchUrl, sweepWindow, windowLabel } from '@house-hunt/core';

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
export function Sweep({ notify }: { notify: Notify }) {
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

  // Keyed on the hub's id rather than its name: `hub_sweep` re-keyed onto `project_hub.id`, and a
  // renamed neighbourhood must keep the sweep history that dates its next window.
  const byHubId = new Map((sweeps.data ?? []).map((s) => [s.hubId, s]));
  const projectHubs = hubs.data ?? [];

  return (
    <section className="sweep">
      {/* The neighbourhoods live here rather than under Settings, where they started, because this
          is the only page that uses them: a hub is a search to run, and the run is below. Under a
          personal-settings heading they read as one person's preference, which is the opposite of
          what they are. */}
      <Neighbourhoods notify={notify} />

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

      {settings.isSuccess && criteria === null && (
        <p className="dim">
          Nothing to sweep for yet — this hunt has not said what it is looking for. Set the
          Rightmove filters on Your Hunt and every neighbourhood below becomes a link. There is
          deliberately no default: a price band nobody chose returns a search that looks like it
          worked and is somebody else&rsquo;s.
        </p>
      )}

      <div className="sweep-hubs">
        {projectHubs.map((hub) => (
          <HubRow key={hub.id} hub={hub} sweep={byHubId.get(hub.id) ?? null} criteria={criteria} />
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
  const extension = useQuery({ queryKey: ['extension'], queryFn: helloExtension });
  const client = useQueryClient();

  if (shortlist.isPending) return <p className="working">Working…</p>;
  if (shortlist.isError) return <p className="error">Could not read the shortlist.</p>;

  const targets = recheckTargets(shortlist.data ?? []);
  const present = extension.data?.status === 'signed-in' || extension.data?.status === 'signed-out';

  if (targets.length === 0) {
    return (
      <p className="dim">
        Everything on the shortlist was last read within {RECHECK_AFTER_DAYS} days, so there is
        nothing worth reopening yet.
      </p>
    );
  }

  return (
    <>
      <p className="dim">
        {targets.length} {targets.length === 1 ? 'place has' : 'places have'} not been read for{' '}
        {RECHECK_AFTER_DAYS} days or more. Reopening tells us what they cost now and which have
        gone — the ones you love go first, so stopping halfway costs you the least.
      </p>
      <div className="sweep-fill">
        {extension.isPending ? null : present ? (
          <Opener
            targets={targets.map((row) => ({
              rightmoveId: row.rightmoveId,
              label: row.displayAddress || row.rightmoveId,
            }))}
            what="that may have changed"
            onFinished={() => {
              // The run rewrites property rows, price history and the off-market set, and every one
              // of those is on screen somewhere else. Refetching the lot is cheaper to reason about
              // than naming which of them a given listing happened to touch.
              void client.invalidateQueries({ queryKey: keys.shortlist });
              void client.invalidateQueries({ queryKey: keys.offMarket });
              void client.invalidateQueries({ queryKey: keys.prices });
            }}
          />
        ) : (
          <p className="dim">
            Re-checking opens listing pages in the background, which only the extension can do.
            Install it and sign in there, and this run appears.
          </p>
        )}
      </div>
    </>
  );
}

/** One neighbourhood: the link to go looking with, how far back that search reaches, and how much
 *  of a sweep already in progress is still outstanding. */
function HubRow({ hub, sweep, criteria }: { hub: ProjectHub; sweep: HubSweep | null; criteria: SweepCriteria | null }) {
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

  // Both notices are about the run that just finished, so they have to outlive the list that run was
  // working through. `onFinished` recounts before it geocodes, and a run that opened the last pending
  // listing empties the list on that recount — so a notice rendered only beside the list would be set
  // and then immediately hidden by the early return below, which is the case it most needs to cover.
  const notices = (
    <>
      {error && <p className="error">{error}</p>}
      {/* Under the error and dimmer than it: the run worked, only the pins are missing, and
          the page-load backfill places them next time. */}
      {mapNote && <p className="dim">{mapNote}. They will be placed next time this page loads.</p>}
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
                // Recount first, so the pending number updates the moment the run ends rather than
                // waiting on the geocode below — the count is "opened and analysed", not "mapped",
                // so a slow postcode lookup must not hold it up. Listings whose analysis landed
                // during the run drop out here; the rest follow as it lands and the window-focus
                // refetch re-runs this.
                refresh();
                // Then fill in map positions for the flats this run just opened. Opening records a
                // postcode but never geocodes it, and the once-per-page-load backfill will not
                // revisit these rows while this tab stays mounted — so do it here, or their pins
                // would not appear until a hard reload. Best-effort: a geocoding hiccup must not
                // stop the repaint below.
                //
                // Best-effort, but not silent. An empty catch discarded the reason entirely: the
                // pins simply would not appear, and nothing on screen or in the console connected
                // that to a lookup that failed. It stays out of `error` because the run itself
                // succeeded — colouring a finished sweep red for a missing pin says the wrong thing.
                await locateProperties().catch((e: unknown) => {
                  const why = e instanceof Error ? e.message : String(e);
                  console.warn('[sweep] filling in map positions failed', e);
                  setMapNote(`Map pins for this run could not be placed — ${why}`);
                });
                // Repaint the shortlist and map regardless of the geocode's outcome: the run opened
                // (and usually geocoded) listings, and even a geocode that threw after writing some
                // coordinates has left the shortlist holding stale null/fuzzed positions. Same
                // invalidation `useLocateProperties` does for the page-load backfill.
                await client.invalidateQueries({ queryKey: keys.shortlist });
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
          <p className="dim">
            Filling in opens each listing in a background tab, which needs the browser extension —
            and it is not installed here. Everything else on this page works without it.
          </p>
        )}
      </div>
    </>
  );
}

/** The neighbourhoods this project searches around.
 *
 *  They used to be five constants in `lib/hubs.ts`, which was right while the hubs *were* the
 *  search. They are project rows now (design D11), so this section is the only way to change what
 *  we are looking for, and it has to be honest about a row being able to answer one question and
 *  not the other:
 *
 *    - A **point** (lat/lon) is what lets a listing read "0.4 mi NE of Angel". Without one the hub
 *      names nothing, and we say so rather than placing it somewhere plausible — a hub in the wrong
 *      place silently rotates every bearing computed from it.
 *    - A **Rightmove location** is what lets a sweep open that neighbourhood's search. Without one
 *      the hub is not searchable, and the sweep view says that instead of offering a dead link.
 *
 *  Both are resolved by a person pressing a button, never in the background. */
function Neighbourhoods({ notify }: { notify: Notify }) {
  const [hubs, setHubs] = useState<ProjectHub[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [name, setName] = useState('');
  const [where, setWhere] = useState('');
  const [busy, setBusy] = useState(false);
  /** Hub id -> what the last resolve attempt said. Kept per hub rather than as one banner: two
   *  hubs can be in different states at once and a shared line would attribute one's failure to
   *  the other. */
  const [located, setLocated] = useState<Record<string, LocationResult>>({});

  useEffect(() => {
    void (async () => {
      try {
        setHubs(await listHubs());
      } catch {
        setFailed(true);
      }
    })();
  }, []);

  async function add() {
    setBusy(true);
    // `postcode` also takes a pasted "lat,lon" — the same field `places:add` accepts, resolved by
    // the same code. A hub added with neither is legitimate: it can be given a location identifier
    // and swept without ever being placeable.
    const hub = await attempt(() => addHub({ name, postcode: where.trim() || undefined }), notify);
    setBusy(false);
    if (!hub) return;
    setHubs([...(hubs ?? []), hub]);
    setName('');
    setWhere('');
  }

  async function remove(hub: ProjectHub) {
    // Removing a hub takes its sweep history with it — `hub_sweep` cascades on `project_hub`. That
    // is the whole record of having worked that neighbourhood to the end, so it is worth a stop.
    if (!confirm(`Remove ${hub.name}? Its sweep history goes with it.`)) return;
    const gone = await attempt(async () => {
      await removeHub(hub.id);
      return true;
    }, notify);
    if (!gone) return;
    setHubs((hubs ?? []).filter((h) => h.id !== hub.id));
  }

  /** Ask Rightmove what it calls this neighbourhood, once, because somebody pressed a button.
   *
   *  This is the standing no-crawl rule's one sanctioned fetch, and the reasoning is repeated here
   *  rather than left in AGENTS.md because this is exactly the kind of call that gets cited as
   *  precedent later: **one** request, for **one** hub, initiated by a person who is looking at the
   *  screen. Nothing here loops, nothing here runs in the background, and nothing here enumerates.
   *  It is `pnpm find:locations` with the terminal taken out. */
  async function resolve(hub: ProjectHub) {
    setBusy(true);
    const result = await attempt(() => resolveLocation(hub.name), notify);
    setBusy(false);
    if (!result) return;
    setLocated({ ...located, [hub.id]: result });
    if (result.status !== 'resolved') return;

    const saved = await attempt(
      () =>
        updateHub(hub.id, {
          locationIdentifier: result.locationIdentifier,
          displayLocationIdentifier: result.displayLocationIdentifier,
        }),
      notify,
    );
    if (!saved) return;
    setHubs((hubs ?? []).map((h) => (h.id === hub.id ? saved : h)));
  }

  async function setWindow(hub: ProjectHub, days: number | null) {
    const saved = await attempt(() => updateHub(hub.id, { maxDaysSinceAdded: days ?? undefined }), notify);
    if (!saved) return;
    setHubs((hubs ?? []).map((h) => (h.id === hub.id ? saved : h)));
  }

  return (
    <section className="setting">
      <h2>Neighbourhoods we search</h2>
      <p className="dim">
        Each one fixes a listing — "0.4 mi NE of Angel" — and, once Rightmove's own name for it is
        resolved, gives the sweep a search to work through.
      </p>

      {hubs === null && !failed && <p className="working">Working…</p>}
      {failed && <p className="error">Could not read this project's neighbourhoods.</p>}
      {hubs !== null && hubs.length === 0 && (
        <p className="dim">Nothing yet — add the neighbourhoods you are actually looking in.</p>
      )}

      {(hubs ?? []).map((hub) => (
        <div className="place" key={hub.id}>
          <span>
            {hub.name}{' '}
            <span className="dim">
              {hub.lat === null || hub.lon === null
                ? 'no coordinates — cannot place a listing against it'
                : `${hub.lat.toFixed(4)}, ${hub.lon.toFixed(4)}`}
              {' · '}
              {/* `STATION^4187` is Rightmove's own name for the area, and it is shown rather than
                  hidden because it is what a sweep searches and the thing to check when a sweep
                  brings back the wrong neighbourhood. Unexplained it looks like a fault. */}
              <Hint text="Rightmove's own id for this area, from Resolve. It is what a sweep searches — if the results look like the wrong neighbourhood, this is the thing to re-resolve.">
                {hub.locationIdentifier ?? 'not searchable yet'}
              </Hint>
              {hub.maxDaysSinceAdded !== null && ` · always looks back ${hub.maxDaysSinceAdded} days`}
            </span>
            {located[hub.id] && <LocationNote result={located[hub.id]!} hub={hub} />}
          </span>
          <span className="fields">
            <select
              value={hub.maxDaysSinceAdded ?? ''}
              title="A floor on how far back this hub's sweep looks. It can only widen the window — a setting that narrowed it would drop listings and still report the page fully recorded."
              onChange={(e) => void setWindow(hub, e.target.value === '' ? null : Number(e.target.value))}
            >
              <option value="">window from the last sweep</option>
              {SWEEP_WINDOWS.map((days) => (
                <option key={days} value={days}>
                  at least {days} {days === 1 ? 'day' : 'days'}
                </option>
              ))}
            </select>
            <button disabled={busy} onClick={() => void resolve(hub)}>
              {hub.locationIdentifier ? 'Re-resolve' : 'Resolve'}
            </button>
            <button className="remove" title="Remove" onClick={() => void remove(hub)}>
              ×
            </button>
          </span>
        </div>
      ))}

      <div className="fields">
        <input value={name} placeholder="Hampstead" onChange={(e) => setName(e.target.value)} />
        <input
          value={where}
          placeholder="Postcode or lat,lon (optional)"
          title="Where the neighbourhood is, for the compass on every listing. A UK postcode, or coordinates pasted from Google Maps. Leave it blank and the hub can still be swept — it just cannot say what a flat is near."
          onChange={(e) => setWhere(e.target.value)}
        />
        <button className="primary" disabled={busy || !name.trim()} onClick={() => void add()}>
          Add
        </button>
      </div>
    </section>
  );
}

/** What one resolve attempt said. All four states are rendered: a silent failure here is a hub
 *  that looks added and never appears in the sweep. */
function LocationNote({ result, hub }: { result: LocationResult; hub: ProjectHub }) {
  if (result.status === 'not-found') {
    return (
      <div className="error">
        Rightmove has no page at <code>{result.slug}</code>. Its own spelling is the one that works
        — try "{hub.name} Station", or the area rather than the stop.
      </div>
    );
  }
  if (result.status === 'rate-limited') {
    return (
      <div className="error">
        {result.used} of {result.limit} lookups used. This is capped on purpose — it is the one
        place the extension asks Rightmove anything. Try again in{' '}
        {Math.ceil(result.retryAfterSeconds / 60)} minutes.
      </div>
    );
  }
  if (result.status === 'failed') return <div className="error">{result.message}</div>;

  // Resolved. The centroid is Rightmove's own centre for that search, and it is the *verification*
  // rather than decoration: an identifier on its own is a number somebody wrote down, and one that
  // points at the wrong neighbourhood returns a page full of plausible flats and reports nothing
  // new. Two independent sources agreeing is what makes it trustworthy, so a disagreement is shown
  // rather than assumed away — and Rightmove's centre is never written over the hub's own point.
  const apart =
    result.centroid !== null && hub.lat !== null && hub.lon !== null
      ? distanceMiles({ lat: hub.lat, lon: hub.lon }, result.centroid)
      : null;
  return (
    <div className="dim">
      {result.displayName} ({result.locationIdentifier}), read out of {result.slug}.
      {apart === null
        ? ' No coordinate here to check it against — worth adding one before you trust the sweep.'
        : apart > 1
          ? ` Rightmove puts its centre ${apart.toFixed(1)} mi from where this hub is — check which of the two is wrong before sweeping it.`
          : ` Rightmove's centre agrees to within ${apart.toFixed(1)} mi.`}
    </div>
  );
}
