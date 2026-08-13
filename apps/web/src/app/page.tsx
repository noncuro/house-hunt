'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  stationDistance,
  relativeUpdate,
} from '@house-hunt/core';
import { Toasts, useToasts } from '@house-hunt/ui';
import { Sweep } from '@/screens/Sweep';
import { duplicateIds, enthusiasm, groupOf, sizeOf, type Group } from '@house-hunt/core';
import { NoActiveProject, spendSummary, Unauthenticated, type ShortlistEntry } from '@house-hunt/core/db';
import type { HuntPreferences, Place, Rating } from '@house-hunt/core';
import { HubFact } from '@house-hunt/ui';
import { Hint } from '@house-hunt/ui';
import { Flags } from '@house-hunt/ui';
import { SizeFact } from '@house-hunt/ui';
import { SpendWarning } from '@house-hunt/ui';
import { RATINGS, ratingOf } from '@house-hunt/ui';
import { ScoreBadge } from '@house-hunt/ui';
import { OffMarketRow } from '@house-hunt/ui';
import { scoreEntries, sortForTriage, isSurprise, SORT_LABEL, type SortMode } from '@/lib/score';
import type { StoredModel } from '@house-hunt/core/db';
import { hubsFromProject, type Hub } from '@house-hunt/core';
import { ExtensionNotice } from '@/screens/Extension';
import { Tick, useRangePick, type Selection } from '@/components/Tick';
import { Install } from '@/screens/Install';
import { Compare } from '@/screens/Compare';
import { Detail } from '@/screens/Detail';
import { Admin } from '@/screens/Admin';
import { Project, ProjectPicker } from '@/screens/Project';
import { Settings } from '@/screens/Settings';
import { SignIn } from '@/screens/SignIn';
import { ShortlistMap } from '@/screens/Map';
import type { AuthState, ProjectSummary, SessionUser } from '@house-hunt/core';
import {
  keys,
  queryClient,
  useAuth,
  useHubs,
  useLocateProperties,
  useModel,
  useOffMarket,
  usePlaces,
  useProjectSettings,
  useRate,
  useRetrain,
  useSetOffMarket,
  useShortlist,
  useSignOut,
} from '@/lib/queries';

/** What the page is at all is decided here, and by one question: who is signed in.
 *
 *  Not being signed in is a state with a screen of its own, never a blank and never a stack trace
 *  (design D13). Which is why this sits above the shortlist rather than inside it: the shortlist
 *  reads six things, and a signed-out session fails all six at once. Rendering the shortlist and
 *  letting each read say "sign in" would put that sentence on screen six times and the actual
 *  sign-in field nowhere. */
export default function Page() {
  const auth = useAuth();

  if (auth.isPending) {
    return (
      <div className="wrap">
        <p className="dim working">Loading…</p>
      </div>
    );
  }

  // The database itself is unreachable — a different thing from being signed out, and it must not
  // be dressed up as one: offering a sign-in form that cannot possibly work is the worst answer.
  if (auth.isError) {
    return (
      <div className="wrap">
        <div className="error">{(auth.error as Error).message}</div>
      </div>
    );
  }

  const state = auth.data;

  if (state.status === 'signed-out') {
    return (
      <div className="wrap">
        <SignIn onSignedIn={(next) => queryClient.setQueryData<AuthState>(keys.auth, next)} />
      </div>
    );
  }

  // Signed in, in no house hunt — where you are between an invite being consumed and a hunt being
  // chosen, and after leaving the last one you were in. The picker, not an empty shortlist (D13).
  if (!state.activeProject) {
    return (
      <div className="wrap">
        <ProjectPicker />
      </div>
    );
  }

  return <App user={state.user} project={state.activeProject} />;
}

/** Everything the two of you have looked at, in the order you'd want to think about it: the
 *  places someone is excited about first, the maybes underneath and hideable, and the rejects
 *  as a number — the point of writing "not our place" down is never seeing it again. */
const VIEWS = ['list', 'table', 'map', 'triage', 'sweep', 'project', 'install', 'admin', 'settings'] as const;
type View = (typeof VIEWS)[number];

/** The open tab lives in the URL (`?v=sweep`), so a reload, a bookmark, or a link sent to the
 *  other laptop lands on the same view rather than snapping back to the list. Driven through the
 *  History API rather than Next's router on purpose: `useSearchParams` would force a Suspense
 *  boundary on this whole client page for prerendering, and there is nothing to prerender here.
 *  The default view carries no param at all, so the bare URL stays clean, and `popstate` makes the
 *  browser's own back and forward move between tabs. */
function useUrlView(): [View, (next: View) => void] {
  const [view, setViewState] = useState<View>('list');
  useEffect(() => {
    const read = () => {
      const v = new URLSearchParams(window.location.search).get('v');
      setViewState((VIEWS as readonly string[]).includes(v ?? '') ? (v as View) : 'list');
    };
    read();
    window.addEventListener('popstate', read);
    return () => window.removeEventListener('popstate', read);
  }, []);
  const setView = (next: View) => {
    setViewState(next);
    const params = new URLSearchParams(window.location.search);
    if (next === 'list') params.delete('v');
    else params.set('v', next);
    const qs = params.toString();
    // The hash comes along. It is the deep link to a flat, and rewriting the URL without it
    // meant that opening `#card-123` and then touching anything left an address bar that no
    // longer pointed at the flat on screen.
    const hash = window.location.hash;
    window.history.pushState(null, '', `${qs ? `?${qs}` : window.location.pathname}${hash}`);
  };
  return [view, setView];
}

function App({ user, project }: { user: SessionUser; project: ProjectSummary }) {
  const [view, setView] = useUrlView();
  const [showMaybes, setShowMaybes] = useState(true);
  const [showUnrated, setShowUnrated] = useState(false);
  const [showRejected, setShowRejected] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const { toasts, push, dismiss } = useToasts();

  const client = useQueryClient();
  const shortlist = useShortlist();
  const placesQuery = usePlaces();
  const signOut = useSignOut();
  useLocateProperties();

  // The verdict score: the project's own taste as a classifier. The model is read here; scoring
  // happens below, at render, so a score is always the current model's — never stored, never stale.
  const modelQuery = useModel();
  const offMarketQuery = useOffMarket();
  const settingsQuery = useProjectSettings();
  const retrain = useRetrain();
  const offMarketMutation = useSetOffMarket();
  const [sortMode, setSortMode] = useState<SortMode>('default');

  // The neighbourhoods every card places its flat against (design D11). Same hook the Sweep view
  // reads, so switching between them costs nothing and the two cannot disagree about which
  // neighbourhoods this house hunt has.
  const hubsQuery = useHubs();

  // What the month's photo analysis has cost. The panel warns on the listing in front of you; the
  // shortlist warns here, once, at the top — the first sign of a budget should not be a listing
  // that quietly refuses to analyse (design D9).
  const spendQuery = useQuery({ queryKey: ['spend'], queryFn: spendSummary });

  const entries = shortlist.data ?? null;
  const places = placesQuery.data ?? [];
  // Three states, and the difference matters: still reading, read and failed, read. `HubFact`
  // renders each as itself rather than letting a failure read as "nothing near this flat".
  const hubs: Hub[] | null | undefined = hubsQuery.isError
    ? null
    : hubsQuery.data
      ? hubsFromProject(hubsQuery.data)
      : undefined;
  // A verdict is attributed to whoever set it, and that is now the signed-in user rather than a
  // name typed into Settings. Kept as a plain string here because every view below it — the
  // cards, the detail pane, the panel — already speaks in display names.
  const person = user.displayName;

  const rating = useRate(person);
  const rate = (entry: ShortlistEntry, value: Rating, note: string) =>
    rating.mutate(
      { rightmoveId: entry.rightmoveId, rating: value, note },
      { onError: (e) => push(`Not saved — ${e.message}`) },
    );

  /** Jump from an overview — a map pin, a table row, a link somebody sent you — to the place
   *  itself. Nothing to open now that every card shows everything; it is purely a scroll, plus
   *  whichever pile the flat is in, since three of the four start collapsed and scrolling to a card
   *  that is not rendered lands on nothing. */
  function openCard(id: string, group?: Group) {
    setView('list');
    if (group === 'maybe') setShowMaybes(true);
    if (group === 'unrated') setShowUnrated(true);
    if (group === 'rejected') setShowRejected(true);
    // Wait for the card, rather than for one frame. Revealing the unrated pile renders two hundred
    // cards, which does not fit in the frame after the state change — so the single rAF scrolled
    // to nothing at all and left you at the top of a page with the flat you asked for thirteen
    // thousand pixels below. Give up after a second: by then the id is not in this shortlist.
    const deadline = performance.now() + 1000;
    const tryScroll = () => {
      const card = document.getElementById(`card-${id}`);
      if (card) card.scrollIntoView({ block: 'center' });
      else if (performance.now() < deadline) requestAnimationFrame(tryScroll);
    };
    requestAnimationFrame(tryScroll);
  }

  const setPlaces = (next: Place[]) => client.setQueryData(keys.places, next);

  /** Renaming yourself is a change to the session, not to a local setting — every verdict this
   *  page attributes to you reads the same field. Patched in place rather than refetched so the
   *  name under the heading changes in the same frame the Save button was pressed. */
  const setPerson = (next: string | null) =>
    client.setQueryData<AuthState>(keys.auth, (current) =>
      current?.status === 'signed-in'
        ? { ...current, user: { ...current.user, displayName: next ?? current.user.email } }
        : current,
    );

  const grouped = useMemo(() => {
    const piles: Record<Group, ShortlistEntry[]> = { excited: [], maybe: [], rejected: [], unrated: [] };
    for (const entry of entries ?? []) piles[groupOf(entry.verdicts)].push(entry);
    // Both of you keen beats one of you keen; within that, most recently looked at first.
    for (const pile of Object.values(piles)) {
      pile.sort(
        (a, b) =>
          enthusiasm(b.verdicts) - enthusiasm(a.verdicts) || b.lastSeenAt.localeCompare(a.lastSeenAt),
      );
    }
    return piles;
  }, [entries]);

  // Over every entry, not per pile: a relisted flat is routinely rejected under one id and
  // unrated under the other, which lands the two halves in piles that never see each other.
  const twins = useMemo(() => duplicateIds(entries ?? []), [entries]);

  /** `…/#card-88023648` opens on that flat — the thing a `chrome-extension://` address could never
   *  do, and the reason for most of this change. You can send one of these to the other laptop, or
   *  keep one in a message thread, and it still means something a week later.
   *
   *  Honoured here rather than by the browser's own anchor jump, which has already happened and
   *  found nothing: the list does not exist until the shortlist read lands. Runs once per id, so
   *  scrolling away and toggling a pile does not yank you back. */
  const jumped = useRef<string | null>(null);
  useEffect(() => {
    if (!entries) return;
    const id = /^#card-(\d+)$/.exec(window.location.hash)?.[1];
    if (!id || jumped.current === id) return;
    const entry = entries.find((e) => e.rightmoveId === id);
    if (!entry) return;
    jumped.current = id;
    openCard(id, groupOf(entry.verdicts));
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [entries]);
  // Every entry's P(yes) under the current model, computed once and shared by the cards, the
  // triage sort and the mismatch marker. Null while there is no model (never trained, or too few
  // verdicts) — the UI then simply shows no scores rather than an error.
  //
  // Also null until the hubs are actually in hand. Handing the scorer `[]` for a read that is still
  // in flight or has failed is not a smaller input, it is a different one: distance to the
  // project's neighbourhoods is the feature most likely to decide a verdict, and a score computed
  // without it is a confident number about the wrong flat. No score is the honest state.
  const model = modelQuery.data?.model ?? null;
  const scores = useMemo(
    () => (model && entries && Array.isArray(hubs) ? scoreEntries(model, entries, hubs) : null),
    // hubsQuery.data rather than the derived `hubs` array, which is a fresh reference every render;
    // isError alongside it so a failed refetch clears the scores instead of leaving stale ones up.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
    [model, entries, hubsQuery.data, hubsQuery.isError],
  );
  const offMarket = offMarketQuery.data ?? new Set<string>();
  const setEntryOffMarket = (entry: ShortlistEntry, off: boolean) =>
    offMarketMutation.mutate(
      { rightmoveId: entry.rightmoveId, off },
      { onError: (e) => push(`Not saved — ${(e as Error).message}`) },
    );

  const prefs = settingsQuery.data ?? {};
  const cardProps = { places, hubs, twins, rate, scores, offMarket, setOffMarket: setEntryOffMarket, prefs };
  const byId = useMemo(() => new Map((entries ?? []).map((e) => [e.rightmoveId, e])), [entries]);

  /** The one jump from anywhere pointing at a flat — a map pin, a compare row, a triage row — so
   *  the three cannot disagree about which pile the card is waiting in. */
  const open = (id: string) => openCard(id, groupOf(byId.get(id)?.verdicts ?? []));

  /** Rate everything ticked, in one go.
   *
   *  Notes are the reason a verdict is worth reading later, and this writes none — which is
   *  exactly right for the job it does. Working down a pile of thirty flats nobody has looked at,
   *  most of the answer is "not for us" for a reason visible from the card: too far, too dear,
   *  no bath. Making that a per-card conversation is what stops the pile ever being worked
   *  through. Anything you have something to say about, say it on the card itself. */
  function rateSelected(value: Rating) {
    const ticked = new Set(selected);
    const batch = grouped.unrated.filter((e) => ticked.has(e.rightmoveId));
    for (const entry of batch) rate(entry, value, '');
    setSelected([]);
    push(`${batch.length} ${batch.length === 1 ? 'place' : 'places'} marked “${ratingOf(value).label}”.`);
  }

  if (shortlist.isError) {
    // A read that failed because the session ended, or because the project went away, is not this
    // view's error to report: the shell is already re-reading who is signed in and is about to
    // replace the whole page with the sign-in view or the picker. Printing "sign in" here would
    // flash that sentence with no field underneath it to act on.
    const handled =
      shortlist.error instanceof Unauthenticated || shortlist.error instanceof NoActiveProject;
    return (
      <div className="wrap">
        {handled ? (
          <p className="dim working">Loading…</p>
        ) : (
          <div className="error">{(shortlist.error as Error).message}</div>
        )}
      </div>
    );
  }
  if (!entries) {
    return (
      <div className="wrap">
        <p className="dim working">Loading…</p>
      </div>
    );
  }

  return (
    // The compare table is wide on purpose — a column per saved place — and reading it through
    // a 980px letterbox defeats it. Triage draws the same table, with a tick column and a score
    // column on top of it, so it needs the window every bit as much: in the letterbox the "against
    // it" column was clipped mid-word on every row and the card that opens under a row was wider
    // than the box it opens in.
    <div className={view === 'table' || view === 'triage' ? 'wrap wrap-wide' : 'wrap'}>
      <header className="top">
        <div>
          <h1>Shortlist</h1>
          <p className="dim">
            {entries.length} {entries.length === 1 ? 'place' : 'places'} opened in{' '}
            <strong>{project.name}</strong>, shared with everyone in it.
            {shortlist.isFetching && <span className="working"> · refreshing</span>}
          </p>
          {/* Who you are, because a verdict is now signed. Sign out sits with it rather than in
              Settings: the one moment you want it is the moment you notice the wrong name here. */}
          <p className="dim who">
            {user.displayName}{' '}
            {user.displayName !== user.email && <span className="who-email">{user.email}</span>}
            <button className="linkish" disabled={signOut.isPending} onClick={() => signOut.mutate()}>
              {signOut.isPending ? 'Signing out…' : 'Sign out'}
            </button>
          </p>
        </div>
        <div className="views">
          <button className={view === 'list' ? 'view view-on' : 'view'} onClick={() => setView('list')}>
            Shortlist
          </button>
          <button className={view === 'table' ? 'view view-on' : 'view'} onClick={() => setView('table')}>
            Compare
          </button>
          <button className={view === 'map' ? 'view view-on' : 'view'} onClick={() => setView('map')}>
            Map
          </button>
          <button
            className={view === 'triage' ? 'view view-on' : 'view'}
            title="Work through the places nobody has rated yet"
            onClick={() => setView('triage')}
          >
            Triage{grouped.unrated.length > 0 && <span className="dim"> {grouped.unrated.length}</span>}
          </button>
          <button
            className={view === 'sweep' ? 'view view-on' : 'view'}
            title="Go looking for places we don't have yet"
            onClick={() => setView('sweep')}
          >
            Sweep
          </button>
          <button
            className={view === 'project' ? 'view view-on' : 'view'}
            title="Who is in this house hunt, and who has been asked"
            onClick={() => setView('project')}
          >
            Your Hunt
          </button>
          <button
            className={view === 'install' ? 'view view-on' : 'view'}
            title="Download the browser extension and load it into Chrome"
            onClick={() => setView('install')}
          >
            Install
          </button>
          {/* Presentation only. Hiding the tab is not the boundary — `is_admin()` in the database
              is, and every admin RPC checks it. This just stops a tab that answers nothing. */}
          {user.isAdmin && (
            <button
              className={view === 'admin' ? 'view view-on' : 'view'}
              title="Users, projects, invites and spend"
              onClick={() => setView('admin')}
            >
              Admin
            </button>
          )}
          <button
            className={view === 'settings' ? 'view view-on' : 'view'}
            title="Settings"
            onClick={() => setView('settings')}
          >
            ⚙
          </button>
        </div>
      </header>

      {/* Above every view rather than inside one: the budget is a fact about the house hunt, not
          about the list you happen to be looking at, and it renders nothing at all while there is
          room left. Rendered by the same component the panel uses, so a limit on real money is
          not phrased two ways (design D9, task 5.5). */}
      <SpendWarning summary={spendQuery.data ?? null} />

      {/* Beside the budget rather than inside a view, and for the same reason: whether the Rightmove
          half is installed and signed in is a fact about the setup, not about the list you happen
          to be looking at. Renders nothing at all when the two halves agree, which is the usual
          case, because signing in on this page hands the credentials across at that moment. */}
      <ExtensionNotice email={user.email} />

      {view === 'settings' && (
        <Settings
          places={places}
          setPlaces={setPlaces}
          person={person}
          setPerson={setPerson}
          notify={push}
        />
      )}

      {view === 'project' && <Project notify={push} />}

      {view === 'install' && <Install email={user.email} />}

      {view === 'admin' && <Admin />}

      {view === 'sweep' && <Sweep />}

      {view === 'triage' && (
        <Triage
          entries={grouped.unrated}
          selected={selected}
          setSelected={setSelected}
          onOpen={open}
          onRate={rateSelected}
          storedModel={modelQuery.data ?? null}
          retrain={retrain}
          sortMode={sortMode}
          setSortMode={setSortMode}
          notify={push}
          {...cardProps}
        />
      )}

      {view === 'table' && (
        <Compare
          entries={entries}
          places={places}
          onOpen={open}
          prefs={prefs}
        />
      )}

      {view === 'map' && (
        <ShortlistMap
          entries={entries}
          selectedId={null}
          onSelect={open}
        />
      )}

      <div hidden={view !== 'list' && view !== 'map'}>
      <Pile
        title="Excited about"
        entries={grouped.excited}
        empty="Nothing yet — mark a place “Exciting” in the panel and it lands here."
        {...cardProps}
      />

      <Toggle
        label={`Maybes (${grouped.maybe.length})`}
        open={showMaybes}
        onToggle={() => setShowMaybes((v) => !v)}
      />
      {showMaybes && <Pile entries={grouped.maybe} empty="No maybes." {...cardProps} />}

      <Toggle
        label={`Not yet rated (${grouped.unrated.length})`}
        open={showUnrated}
        onToggle={() => setShowUnrated((v) => !v)}
      />
      {showUnrated && (
        <Pile entries={grouped.unrated} empty="Everything you've opened has a verdict." {...cardProps} />
      )}

      {/* A count, not a list. Seeing them again is the thing rejecting was meant to prevent —
          but the number is worth knowing, and it's one click if you want to check. */}
      <Toggle
        label={`Rejected (${grouped.rejected.length})`}
        open={showRejected}
        onToggle={() => setShowRejected((v) => !v)}
      />
      {showRejected && <Pile entries={grouped.rejected} empty="Nothing rejected." {...cardProps} />}
      </div>

      <Toasts toasts={toasts} dismiss={dismiss} />
    </div>
  );
}

function Toggle({ label, open, onToggle }: { label: string; open: boolean; onToggle: () => void }) {
  return (
    <button className="toggle" onClick={onToggle} aria-expanded={open}>
      <span className={open ? 'chevron chevron-open' : 'chevron'}>›</span> {label}
    </button>
  );
}

/** Above this many, a bulk verdict asks first. Five is "I ticked these deliberately" — the batch
 *  you can still see all of on screen — and anything more came from "Select all", where the
 *  distance between the button that selects and the button that writes is one inch. */
const CONFIRM_BULK_ABOVE = 5;

/** The pile nobody has an opinion on, and the one screen built for changing that.
 *
 *  Every other view here is for comparing places you already care about, which is why they all
 *  now start with the unrated hidden. That leaves the unrated pile needing somewhere of its own,
 *  and it needs different affordances: a sweep leaves thirty flats sitting there, and most of
 *  them are a "no" you can see from the card without opening anything. One at a time, through the
 *  panel, that pile never empties — so here you tick and rate in one go. */
function Triage({
  entries,
  selected,
  setSelected,
  onOpen,
  onRate,
  storedModel,
  retrain,
  sortMode,
  setSortMode,
  notify,
  ...cardProps
}: {
  entries: ShortlistEntry[];
  selected: string[];
  setSelected: (next: string[]) => void;
  /** Leave the pile for the flat itself. A row here is four numbers and a thumbnail's worth of
   *  judgement, and some of the pile is a "maybe" you cannot settle without the photos and the
   *  commute — so the address goes to the card rather than to Rightmove, which is where the rest
   *  of what we know about the place is already written down. */
  onOpen: (rightmoveId: string) => void;
  onRate: (rating: Rating) => void;
  storedModel: StoredModel | null;
  retrain: ReturnType<typeof useRetrain>;
  sortMode: SortMode;
  setSortMode: (mode: SortMode) => void;
  notify: (message: string) => void;
} & CardProps) {
  // The table is the default, and it is the layout the tick boxes were asking for. Ticking is a
  // comparing action — you decide "not this one, not this one, this one maybe" by reading the
  // same four numbers down a column — and a checkbox beside a full-width card makes you scroll
  // past everything the card knows to reach the next decision. Cards stay one click away for the
  // pile where the photos are what you want.
  const [layout, setLayout] = useState<'table' | 'cards'>('table');
  // The rating waiting on a "yes, all of them" — see the bar below.
  const [confirming, setConfirming] = useState<Rating | null>(null);
  // A row's full card, opened in place. Clicking the address here used to leave the pile for the
  // list view scrolled to the card; the whole of what a flat is fits under its own row, so the
  // photos, travel times and verdict come to the pile rather than the pile going to them.
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const toggleExpand = (id: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  const chosen = new Set(selected);
  // Ticking a flat that has since been rated elsewhere would rate it again on the next click,
  // so the selection is read against what is actually in the pile now.
  const all = entries.map((e) => e.rightmoveId);
  const allChosen = all.length > 0 && all.every((id) => chosen.has(id));
  const toggle = (id: string) =>
    setSelected(chosen.has(id) ? selected.filter((s) => s !== id) : [...selected, id]);
  const setMany = (ids: string[], on: boolean) => {
    const run = new Set(ids);
    setSelected(on ? [...new Set([...selected, ...ids])] : selected.filter((s) => !run.has(s)));
  };

  // The pile in the order the score suggests working it. When there is no model the control is off
  // and this is the incoming order (newest first) — the pile still triages, just unranked.
  const shown = sortForTriage(entries, cardProps.scores, sortMode);
  const metrics = storedModel?.model.metrics;

  const onRerun = () =>
    retrain.mutate(undefined, {
      onSuccess: (result) =>
        notify(
          result.status === 'trained'
            ? `Rescored on ${result.nExamples} verdicts — ${Math.round(result.metrics.cvAuc * 100)}% cross-validated AUC.`
            : `Not enough to learn from yet — rate at least ${result.minPerClass} exciting and ${result.minPerClass} rejected (${result.positives} exciting so far).`,
        ),
      onError: (error) => notify(`Couldn't rerun — ${(error as Error).message}`),
    });

  // The score's own row: rerun the model, and choose which end of the pile to work from. Kept
  // apart from the rating bar below — one is about deciding, the other about ordering the
  // deciding — and quiet when there is no model yet.
  const scoreBar = (
    <div className="triage-score-bar">
      <button className="key" onClick={onRerun} disabled={retrain.isPending}>
        {retrain.isPending ? 'Rerun ratings…' : 'Rerun ratings'}
      </button>
      <label className="triage-sort">
        <span className="dim">Sort:</span>
        <select
          value={sortMode}
          onChange={(e) => setSortMode(e.target.value as SortMode)}
          disabled={!cardProps.scores || entries.length === 0}
          title={cardProps.scores ? 'Order the pile by the predicted score.' : 'Rerun ratings first to sort by score.'}
        >
          {(Object.keys(SORT_LABEL) as SortMode[]).map((mode) => (
            <option key={mode} value={mode}>
              {SORT_LABEL[mode]}
            </option>
          ))}
        </select>
      </label>
      <span className="dim triage-model-note">
        {metrics
          ? `Model: ${metrics.n} verdicts, ${Math.round(metrics.cvAuc * 100)}% AUC`
          : cardProps.scores
            ? 'Model ready'
            : 'No model yet — rate a few, then rerun.'}
      </span>
    </div>
  );

  // An empty pile is the normal end state of triage, and it is exactly when retraining is worth
  // doing — every verdict the model could learn from has just been given. So the score bar stays;
  // only the rating bar and the pile itself go, having nothing to act on.
  if (entries.length === 0) {
    return (
      <div className="triage">
        {scoreBar}
        <p className="dim">Nothing waiting — every place either of you has opened has a verdict.</p>
      </div>
    );
  }

  return (
    <div className="triage">
      <div className="triage-bar">
        {/* A verdict on a batch this size is worth one more click. "Select all 219" sits an inch
            from three buttons that write a verdict for everybody in the hunt to see, each of them
            219 writes with nothing that puts them back. Below the threshold this never appears —
            ticking four flats and rating them is the gesture the pile exists for. */}
        {confirming && selected.length > 0 ? (
          <>
            <span className="triage-confirm">
              Mark all {selected.length} “{ratingOf(confirming).label}”?
            </span>
            <button
              className={`rate rate-${confirming}`}
              onClick={() => {
                onRate(confirming);
                setConfirming(null);
              }}
            >
              Yes, mark {selected.length}
            </button>
            <button className="key" onClick={() => setConfirming(null)}>
              Cancel
            </button>
          </>
        ) : (
          <>
            <button className="key triage-all" onClick={() => setSelected(allChosen ? [] : all)}>
              {allChosen ? 'Clear' : `Select all ${entries.length}`}
            </button>
            <span className="dim">
              {selected.length === 0 ? 'Nothing selected' : `${selected.length} selected`}
            </span>
            {/* The same three ratings, in the same words and the same order as everywhere else —
                from `components/ratings.ts` rather than a table of its own, which is how rating in
                bulk and rating one place came to call the same verdict two things. Not
                `RatingButtons`: these are wider, sit in the triage bar's own layout, and have no
                current value to show, since a selection of thirty flats has no one rating between
                them. */}
            <div className="triage-rate">
              {RATINGS.map((r) => (
                <button
                  key={r.value}
                  className={`rate rate-${r.value}`}
                  disabled={selected.length === 0}
                  title={
                    selected.length === 0
                      ? 'Tick at least one place first — nothing is selected.'
                      : `Mark all ${selected.length} selected “${r.label}”, with no note.`
                  }
                  onClick={() =>
                    selected.length >= CONFIRM_BULK_ABOVE ? setConfirming(r.value) : onRate(r.value)
                  }
                >
                  {r.emoji} {r.label}
                </button>
              ))}
            </div>
            <button
              className="key triage-layout"
              onClick={() => setLayout(layout === 'table' ? 'cards' : 'table')}
            >
              {layout === 'table' ? 'Show cards' : 'Show table'}
            </button>
          </>
        )}
      </div>

      {scoreBar}

      {layout === 'table' ? (
        <Compare
          entries={shown}
          places={cardProps.places}
          onOpen={onOpen}
          expand={{
            isOpen: (id) => expanded.has(id),
            toggle: toggleExpand,
            // The same card the list draws, from the same renderer. No tick box inside it — the row
            // it sits under already carries one, and two would ask the same question twice.
            render: (entry) => <Card entry={entry} {...cardProps} />,
          }}
          selection={{ chosen, toggle, setMany }}
          filters={false}
          columnsKey="triage"
          // Triage's table gets the score as a column — the same number the cards and the sort
          // control read. It is deliberately absent from the compare table; see Compare's `scores`.
          scores={cardProps.scores}
          prefs={cardProps.prefs}
          // Triage decides its own order — newest first, or whichever end of the score the sort
          // control asked for — and a default price sort inside the table would throw that away
          // silently, which is the one thing the "Most likely yes" control must not do. Any column
          // header still sorts on click; it just isn't the starting point here.
          defaultSort={null}
        />
      ) : (
        <Pile entries={shown} empty="Nothing waiting." selection={{ chosen, toggle, setMany }} {...cardProps} />
      )}
    </div>
  );
}

interface CardProps {
  places: Place[];
  /** This house hunt's neighbourhoods, read once for the page and handed down. Undefined while
   *  the read is in flight, null when it failed — `HubFact` renders the three states apart,
   *  because a failed read and "nothing within a mile" are the same blank and opposite claims. */
  hubs: Hub[] | null | undefined;
  /** Rightmove id -> the other ids that are the same flat. Computed once over the whole
   *  shortlist rather than per pile, because a relisted flat is very often rejected under one id
   *  and unrated under the other, which puts the two halves in different piles. */
  twins: Map<string, string[]>;
  rate: (entry: ShortlistEntry, rating: Rating, note: string) => void;
  /** Each flat's P(yes) under the current model, or null when there is no model. A card shows its
   *  own score as a badge; the triage sort reads the same map. */
  scores: Map<string, number> | null;
  /** This hunt's preferences, so a card's flags reflect what the hunt must have and where its
   *  great-room bar sits. Empty until Settings is touched — the default flag behaviour. */
  prefs: HuntPreferences;
  /** Flats withheld from training (off the market). A love you can no longer act on is still a
   *  love — this only keeps the model from learning it. */
  offMarket: Set<string>;
  setOffMarket: (entry: ShortlistEntry, off: boolean) => void;
  /** Present only in triage: cards grow a tick box and join a batch. Absent everywhere else,
   *  because a card you are reading to decide on is not a card you are selecting. */
  selection?: Selection;
}

function Pile({
  title,
  entries,
  empty,
  ...cardProps
}: { title?: string; entries: ShortlistEntry[]; empty: string } & CardProps) {
  // Cards get the same shift-pick the table has. They were the one layout of triage where a run
  // could only be ticked one at a time, and `setMany` was handed down and never called.
  const pick = useRangePick(
    useMemo(() => entries.map((e) => e.rightmoveId), [entries]),
    cardProps.selection,
  );
  return (
    <section>
      {title && <h2>{title}</h2>}
      {entries.length === 0 ? (
        <p className="dim">{empty}</p>
      ) : (
        <div className="cards">
          {entries.map((entry) => (
            <Card
              key={entry.rightmoveId}
              entry={entry}
              onPick={(shiftKey) => pick(entry.rightmoveId, shiftKey)}
              {...cardProps}
            />
          ))}
        </div>
      )}
    </section>
  );
}

/** One place, whole, at the full width of the page.
 *
 *  This used to be a three-column grid of summaries that expanded in place. Two problems with
 *  that. Everything worth knowing — the travel times, the photos, the verdict buttons — was
 *  behind a click, so comparing two places meant opening one, reading it, closing it and opening
 *  the other from memory. And the expansion needed a full-card invisible button, a chevron, a
 *  0fr-to-1fr grid animation and a rule blanking pointer events on every child so links still
 *  worked, all of which existed only to hide things there was room to show.
 *
 *  A shortlist of seventeen is short. Scrolling past a place you have already decided on is
 *  cheaper than clicking into every one you have not. */
function Card({
  entry,
  places,
  hubs,
  twins,
  rate,
  scores,
  offMarket,
  setOffMarket,
  selection,
  prefs,
  onPick,
}: { entry: ShortlistEntry; /** Tick this one, with the shift key's answer. From the pile, which
     *  is the only thing that knows what order the cards are in. */
  onPick?: (shiftKey: boolean) => void } & CardProps) {
  const group = groupOf(entry.verdicts);
  const alsoAs = twins.get(entry.rightmoveId) ?? [];
  const ticked = selection?.chosen.has(entry.rightmoveId) ?? false;
  const score = scores?.get(entry.rightmoveId);
  const surprise = isSurprise(entry, score);
  const isOff = offMarket.has(entry.rightmoveId);
  // A love or maybe you can act on can be taken off the market; a rejection has nothing to withhold
  // (it is already out of the positive class), and an unrated flat is not in training yet.
  const canGoOffMarket = group === 'excited' || group === 'maybe';

  return (
    <article
      className={`card card-${group}${ticked ? ' card-ticked' : ''}${isOff ? ' card-off-market' : ''}${surprise ? ' card-surprise' : ''}`}
      id={`card-${entry.rightmoveId}`}
    >
      <div className="card-head">
        {selection && onPick && (
          <Tick checked={ticked} label={entry.displayAddress} onPick={onPick} />
        )}
        {/* The address, and only the address. It was a link to Rightmove, which made the most
            obvious thing to click on a card the one thing that took you off the site; the card
            below already holds the photos, the times and the verdict, and `Detail` ends with the
            explicit way out to the listing. */}
        <span className="address">{entry.displayAddress}</span>
        {score !== undefined && (
          <span className="card-score">
            <ScoreBadge score={score} surprise={surprise} />
          </span>
        )}
      </div>

      {/* The same facts the panel states, in the same words. When the two disagreed about what
          a place is, the shortlist stopped being a view of the same data. */}
      <div className="facts">
        {entry.price && <span className="price">{entry.price}</span>}
        {/* "3 weeks ago" is the useful form and Rightmove's own sentence is the fact behind it, so
            the sentence is a hint rather than a `title` — reachable by keyboard, and on a schedule
            we control. */}
        {entry.listingUpdate && (
          <Hint
            underline={false}
            className={/reduc/i.test(entry.listingUpdate) ? 'since reduced' : 'since dim'}
            text={entry.listingUpdate}
          >
            {relativeUpdate(entry.listingUpdate)}
          </Hint>
        )}
        {entry.bedrooms !== null && <span>🛏 {entry.bedrooms} bed</span>}
        {entry.bathrooms !== null && <span>🚿 {entry.bathrooms} bath</span>}
        <span>
          {/* Resolved by the same rule as the panel and the compare table, and carrying the
              same caveat when the number came out of prose rather than off a plan. */}
          <SizeFact source={sizeOf(entry)} missing="size unknown" />
        </span>
        {entry.furnishType && <span>{entry.furnishType}</span>}
        {entry.postcode && <span className="dim">{entry.postcode}</span>}
        {alsoAs.length > 0 && (
          <Hint
            className="twin"
            text="Same postcode and rent — one flat, listed twice."
          >
            ⧉ also listed as{' '}
            {alsoAs.map((id, i) => (
              <span key={id}>
                {i > 0 && ', '}
                <a href={`#card-${id}`} onClick={(e) => e.stopPropagation()}>
                  #{id}
                </a>
              </span>
            ))}
          </Hint>
        )}
      </div>

      {/* The same fix the panel draws, from the same component. A card that placed a flat
          relative to a different hub, or pointed the needle a different way, would be the third
          time the two views have quietly disagreed about what a place is. */}
      <div className="card-hub">
        <HubFact
          point={entry.lat !== null && entry.lon !== null ? { lat: entry.lat, lon: entry.lon } : null}
          hubs={hubs}
          places={places}
          approximate={!entry.exactLocation}
        />
      </div>

      {/* Cards keep the good news — a bathtub IS the reason you'd look twice — but the rings
          go bare: four flags each shouting "HIGH" is four times the noise for one fact. */}
      <Flags source={{ analysis: entry.analysis, floorplanUrl: entry.floorplanUrl }} prefs={prefs} />

      {entry.nearestStations.length > 0 && (
        <div className="stations dim">
          {entry.nearestStations
            .slice(0, 2)
            .map((s) => `${s.name.replace(/\s+Station$/, '')} ${stationDistance(s.distance, s.unit)}`)
            .join(' · ')}
        </div>
      )}

      {/* The verdict itself is stated once, by `Detail` immediately below, where it sits with the
          buttons that change it and the note that explains it. This card used to draw its own pill
          per person — its own emoji, its own wording, no author and no date — which is exactly the
          drift `components/Verdict.tsx` was written to end. A project now holds one rating
          (design D6), and one renderer states it. */}
      <Detail entry={entry} places={places} onRate={(value, note) => rate(entry, value, note)} />

      {/* Off the market, but still a place you liked — kept in the shortlist with its verdict,
          withheld only from training. The same control, and the same rules for when it shows, as
          the Rightmove panel: one renderer in packages/ui. */}
      <OffMarketRow
        isOff={isOff}
        canGoOffMarket={canGoOffMarket}
        onToggle={(next) => setOffMarket(entry, next)}
      />
    </article>
  );
}
