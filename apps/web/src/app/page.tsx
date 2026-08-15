'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  stationDistance,
  relativeUpdate,
} from '@house-hunt/core';
import { Toasts, useToasts } from '@house-hunt/ui';
import { Sweep } from '@/screens/Sweep';
import {
  applyFilter,
  placePoints,
  duplicateIds,
  addressBesidePostcode,
  enthusiasm,
  groupOf,
  parseFilter,
  withKnownPlaces,
  sizeOf,
  FILTER_LABEL,
  funnelCounts,
  GROUP_LABEL,
  matchesStage,
  STAGE_FILTERS,
  type FunnelCounts,
  type Group,
  type StageFilter,
} from '@house-hunt/core';
import { NoActiveProject, renameProject, spendSummary, Unauthenticated, type ShortlistEntry } from '@house-hunt/core/db';
import type { ArchiveReason, HuntPreferences, Place, PricePoint, Rating, Stage, TriageFilter } from '@house-hunt/core';
import { HubFact } from '@house-hunt/ui';
import { Hint } from '@house-hunt/ui';
import { Flags } from '@house-hunt/ui';
import { SizeFact } from '@house-hunt/ui';
import { SpendWarning } from '@house-hunt/ui';
import { RATINGS, ratingOf } from '@house-hunt/ui';
import { ScoreBadge } from '@house-hunt/ui';
import { OffMarketRow } from '@house-hunt/ui';
import { PriceMove } from '@house-hunt/ui';
import { scoreEntries, sortForTriage, isSurprise, NEEDS_MODEL, SORT_LABEL, type SortMode } from '@/lib/score';
import type { StoredModel } from '@house-hunt/core/db';
import { hubsFromProject, type Hub } from '@house-hunt/core';
import { ExtensionNotice } from '@/screens/Extension';
import { Tick, useRangePick, type Selection } from '@/components/Tick';
import { Pager, usePaging } from '@/components/Pager';
import { InlineName } from '@/components/InlineName';
import { TriageFilters } from '@/components/TriageFilters';
import { useStoredState } from '@/lib/stored';
import { Install } from '@/screens/Install';
import { Compare } from '@/screens/Compare';
import { Detail } from '@/screens/Detail';
import { Admin } from '@/screens/Admin';
import { HuntSwitch, Project, ProjectPicker } from '@/screens/Project';
import { Settings } from '@/screens/Settings';
import { SignIn } from '@/screens/SignIn';
import { ShortlistMap, COLOUR } from '@/screens/Map';
import { CardMap } from '@/components/CardMap';
import type { AuthState, ProjectSummary, SessionUser } from '@house-hunt/core';
import {
  keys,
  queryClient,
  useAuth,
  useLocateProperties,
  useModel,
  useOffMarket,
  usePlaces,
  useProjectSettings,
  useRate,
  useRetrain,
  useSetOffMarket,
  useSetStage,
  useShortlist,
  useSignOut,
  useCachedTravel,
  usePrices,
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

  // Keyed on the hunt, so switching remounts rather than re-renders. Everything held in React
  // state here belongs to one project — which flats are ticked, what triage is filtered to, which
  // card is revealed — and a re-render carries all of it across. The ticked set is the dangerous
  // one: the same listing can be in two hunts, so a selection that survived the switch meant the
  // next bulk-rating click wrote a verdict in a hunt where nobody had selected anything. The query
  // caches were already reset on switch; this is the other half.
  return (
    <App
      key={state.activeProject.id}
      user={state.user}
      project={state.activeProject}
      projects={state.projects}
    />
  );
}

/** Everything the two of you have looked at, in the order you'd want to think about it: the
 *  places someone is excited about first, the maybes underneath and hideable, and the rejects
 *  as a number — the point of writing "not our place" down is never seeing it again. */
/** The order the funnel is read in: what you are keen on, then what is still open, then what is
 *  done with. `rejected` last because it is the only one that is not work. */
const TALLY_ORDER: Group[] = ['excited', 'maybe', 'unrated', 'rejected'];

const VIEWS = ['list', 'table', 'map', 'triage', 'project', 'install', 'admin', 'settings'] as const;
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
      // `sweep` was its own tab until sweeping moved under Triage. Links to it are in people's
      // bookmarks and in the extension, so it lands where its contents went rather than silently
      // on the list.
      if (v === 'sweep') return setViewState('triage');
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

function App({
  user,
  project,
  projects,
}: {
  user: SessionUser;
  project: ProjectSummary;
  projects: ProjectSummary[];
}) {
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
  // Price history for the whole list in one read — see `usePrices`.
  const pricesQuery = usePrices((shortlist.data ?? []).map((e) => e.rightmoveId));
  const settingsQuery = useProjectSettings();
  const retrain = useRetrain();
  const offMarketMutation = useSetOffMarket();
  const stageMutation = useSetStage();
  const [sortMode, setSortMode] = useState<SortMode>('default');
  // The flat a jump from elsewhere has asked to see. Held here because the pile that holds it is
  // decided by its verdict, and only that pile can page to it — see `openCard`.
  //
  // A fresh object per ask rather than a bare id: clicking the same pin again after paging away has
  // to page back to it, and the same id twice would read as nothing having been asked.
  const [reveal, setReveal] = useState<{ id: string } | null>(null);
  // Held here rather than inside Triage so that going to the map and back does not throw away the
  // narrowing you set up to work through — and stored, so neither does closing the tab. Working a
  // pile of two hundred takes more than one sitting, and setting the same four bars up again each
  // time is the friction that stops the second sitting happening.
  // Per hunt. A filter names this project's places and this project's budget; one shared key meant
  // opening a second hunt with the first one's rent ceiling already applied, and the count on the
  // bar explaining a number nobody had chosen.
  const [triageFilter, setTriageFilter] = useStoredState<TriageFilter>(
    `triage:filter:${project.id}`,
    parseFilter,
  );

  // The neighbourhoods every card places its flat against (design D11). Same hook the Sweep view
  // reads, so switching between them costs nothing and the two cannot disagree about which
  // neighbourhoods this house hunt has.

  // What the month's photo analysis has cost. The panel warns on the listing in front of you; the
  // shortlist warns here, once, at the top — the first sign of a budget should not be a listing
  // that quietly refuses to analyse (design D9).
  const spendQuery = useQuery({ queryKey: ['spend'], queryFn: spendSummary });

  const all = shortlist.data ?? null;
  // The funnel is a filter over the whole shortlist rather than a view of its own: "the two we have
  // viewed" is the same list of cards, the same table and the same map, narrowed. Triage is
  // deliberately outside it — that pile is everything nobody has judged yet, which is by definition
  // everything not in the funnel.
  const [stageFilter, setStageFilter] = useState<StageFilter>('all');
  const funnel = useMemo(() => funnelCounts(all ?? []), [all]);
  const entries = useMemo(
    () => (all === null ? null : all.filter((e) => matchesStage(e.stage, stageFilter))),
    [all, stageFilter],
  );
  const places = placesQuery.data ?? [];
  // A stored filter can name a place somebody has since deleted, and a bar with no place is one the
  // panel cannot draw and nobody can clear. Pruned on the way in rather than on the way out of
  // storage, because which places exist is a query that has not answered yet when the filter is
  // read.
  //
  // Only against a *successful* read. `placesQuery.data ?? []` looked like the same thing and was
  // not: while the query is loading, and after it fails, an empty list means "no places" and every
  // saved travel bar is thrown away — silently widening the triage filter to everything on the
  // first frame of every page load. Undefined means we do not know yet, and not knowing is a
  // reason to keep what somebody saved.
  //
  // Derived, and deliberately not written back to storage. A bar can be pruned for a state that
  // reverses — a place whose postcode was cleared and later filled in again — and persisting would
  // delete somebody's saved filter on the strength of a moment. The cost is that such a bar
  // reappears when its place can answer it again, which is a surprise; the alternative is the same
  // failure the paragraph above is about, made permanent, and it would be reached by any transient
  // oddity in the places data rather than only by a loading frame.
  const triageFilterNow = useMemo(
    () =>
      placesQuery.data
        ? withKnownPlaces(triageFilter, placesQuery.data)
        : triageFilter,
    [triageFilter, placesQuery.data],
  );
  // Three states, and the difference matters: still reading, read and failed, read. `HubFact`
  // renders each as itself rather than letting a failure read as "nothing near this flat".
  // Every place, not just the swept ones. `useHubs()` filters to what can be searched, which is
  // the right list for the sweep view and the wrong one here: the office is not somewhere we look
  // for flats and is still one of the best landmarks to fix a flat against. Reading the filtered
  // list made the website say "no hub within a mile" about a flat the extension panel — which
  // reads every place — was happily placing next to work.
  const hubs: Hub[] | null | undefined = placesQuery.isError
    ? null
    : placesQuery.data
      ? hubsFromProject(placesQuery.data)
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
    // Three things can hide the card you asked for, and all three have to be undone or the scroll
    // below lands on nothing and the jump reads as "it just opened the shortlist".
    //
    // The pile being collapsed is the one this always knew about. The other two arrived later: the
    // funnel filter, which can exclude the flat outright, and paging, which renders twenty-five of
    // two hundred — so a map pin for anything below the first page scrolled to an element that was
    // never in the document.
    const entry = byId.get(id);
    if (entry && !matchesStage(entry.stage, stageFilter)) setStageFilter('all');
    setReveal({ id });
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

  // An updater rather than a value. Two place writes that complete out of order both derived their
  // next list from the same rendered snapshot, so the second could restore a place the first had
  // already deleted — and the travel-bar filters keyed on it would stay live until a refetch.
  const setPlaces = (update: (current: Place[]) => Place[]) =>
    client.setQueryData(keys.places, (current: Place[] | undefined) => update(current ?? []));

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

  // Over the whole hunt rather than over `grouped`, which is computed from the filtered `entries`:
  // the header states what the hunt is, and a stage filter must not make places disappear from it.
  const tally = useMemo(() => {
    const counts: Record<Group, number> = { excited: 0, maybe: 0, rejected: 0, unrated: 0 };
    for (const entry of all ?? []) counts[groupOf(entry.verdicts)]++;
    return counts;
  }, [all]);

  const rename = useMutation({
    mutationFn: async (next: string) => await renameProject(project.id, next),
    onSuccess: async () => await client.invalidateQueries({ queryKey: keys.auth }),
    onError: (e: Error) => push(`Not renamed — ${e.message}`),
  });

  // Over every entry, not per pile: a relisted flat is routinely rejected under one id and
  // unrated under the other, which lands the two halves in piles that never see each other.
  const twins = useMemo(() => duplicateIds(all ?? []), [all]);

  /** `…/#card-88023648` opens on that flat — the thing a `chrome-extension://` address could never
   *  do, and the reason for most of this change. You can send one of these to the other laptop, or
   *  keep one in a message thread, and it still means something a week later.
   *
   *  Honoured here rather than by the browser's own anchor jump, which has already happened and
   *  found nothing: the list does not exist until the shortlist read lands. Runs once per id, so
   *  scrolling away and toggling a pile does not yank you back. */
  const jumped = useRef<string | null>(null);
  useEffect(() => {
    if (!all) return;
    const id = /^#card-(\d+)$/.exec(window.location.hash)?.[1];
    if (!id || jumped.current === id) return;
    const entry = all.find((e) => e.rightmoveId === id);
    if (!entry) return;
    jumped.current = id;
    // A link to a flat has to land on it. Somebody who left the shortlist filtered to "viewed" and
    // then opened a link to a flat that is not would otherwise be scrolled to nothing at all.
    if (!matchesStage(entry.stage, stageFilter)) setStageFilter('all');
    openCard(id, groupOf(entry.verdicts));
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [all]);
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
    () => (model && all && Array.isArray(hubs) ? scoreEntries(model, all, hubs) : null),
    // placesQuery.data rather than the derived `hubs` array, which is a fresh reference every
    // render; isError alongside it so a failed refetch clears the scores instead of leaving stale
    // ones up.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
    [model, all, placesQuery.data, placesQuery.isError],
  );
  const offMarket = offMarketQuery.data ?? new Set<string>();
  const setEntryOffMarket = (entry: ShortlistEntry, off: boolean) =>
    offMarketMutation.mutate(
      { rightmoveId: entry.rightmoveId, off },
      { onError: (e) => push(`Not saved — ${(e as Error).message}`) },
    );

  /** Move a place along the funnel. The verdict is not touched and must not be: losing a flat you
   *  loved is a fact about the flat's availability, not about your taste, and the score is fitted on
   *  the second. */
  const setEntryStage = (entry: ShortlistEntry, stage: Stage, archiveReason: ArchiveReason | null) =>
    stageMutation.mutate(
      { rightmoveId: entry.rightmoveId, stage, archiveReason },
      { onError: (e) => push(`Not saved — ${(e as Error).message}`) },
    );

  const prefs = settingsQuery.data ?? {};
  const cardProps = {
    places,
    hubs,
    twins,
    rate,
    scores,
    offMarket,
    prices: pricesQuery.data,
    setOffMarket: setEntryOffMarket,
    setStage: setEntryStage,
    // react-query holds the variables of the mutation in flight, which is exactly the "which flat,
    // which step" this needs — no second piece of state to keep in step with it.
    stageSaving: stageMutation.isPending && stageMutation.variables
      ? { rightmoveId: stageMutation.variables.rightmoveId, stage: stageMutation.variables.stage }
      : null,
    prefs,
  };
  const byId = useMemo(() => new Map((all ?? []).map((e) => [e.rightmoveId, e])), [all]);

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
  if (!all || !entries) {
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
          {/* The hunt, not the view. This said "Shortlist" on every screen — which is the name of
              the first tab, so the shortlist announced itself twice and the map announced itself as
              the shortlist. The one thing true of every view here is which house hunt you are
              looking at, and it was buried mid-sentence in the line below. */}
          {/* Renamed here, where the name is read. It had a labelled field and a Save button under
              a paragraph on the Your Hunt page, which is a page away from the only place anybody
              ever looks at it. */}
          <h1>
            <InlineName
              value={project.name}
              label="this house hunt"
              busy={rename.isPending}
              onSave={(next) => rename.mutateAsync(next).catch(() => {})}
            />
          </h1>
          <p className="dim">
            {/* The funnel, not the total. "459 places, shared with everyone in this hunt" answered
                a question nobody had — the sharing is the whole point of the app and does not need
                restating on every screen, and one big number says nothing about whether there is
                anything to do. These four are the state of the hunt. */}
            <span className="tally">
              {TALLY_ORDER.map((group) => (
                <span key={group}>
                  <strong>{tally[group]}</strong> {GROUP_LABEL[group].toLowerCase()}
                </span>
              ))}
            </span>
            {/* The counts above are the whole hunt, so a filter has to say what is actually on
                screen — otherwise a shortlist showing two flats claims to be showing forty. */}
            {stageFilter !== 'all' && (
              <span> Showing the {entries.length} at “{FILTER_LABEL[stageFilter].toLowerCase()}”.</span>
            )}
            {shortlist.isFetching && <span className="working"> · refreshing</span>}
          </p>
        </div>
        <div className="top-right">
          {/* Who you are, because a verdict is signed. Above the tabs rather than under the
              heading: it is not a fact about the hunt, it is the state of this browser, and it sat
              in the one place that made the top of the page read as three headings. The moment you
              want it is the moment you notice the wrong name, which is why it is not in Settings. */}
          <p className="dim who">
            {/* Beside the account rather than three clicks into Your Hunt: this is the control that
                decides what every other screen is showing. */}
            <HuntSwitch projects={projects} activeId={project.id} />
            {user.displayName}{' '}
            {user.displayName !== user.email && <span className="who-email">{user.email}</span>}
            <button className="linkish" disabled={signOut.isPending} onClick={() => signOut.mutate()}>
              {signOut.isPending ? 'Signing out…' : 'Sign out'}
            </button>
          </p>
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

      {/* The funnel, over the three views that show places rather than manage them. Triage is
          excluded on purpose: it is the pile nobody has judged, which is exactly the pile that has
          not entered the funnel. */}
      {(view === 'list' || view === 'table' || view === 'map') && (
        <Funnel counts={funnel} filter={stageFilter} setFilter={setStageFilter} />
      )}

      {view === 'settings' && (
        <Settings
          person={person}
          setPerson={setPerson}
          notify={push}
        />
      )}

      {view === 'project' && <Project notify={push} places={places} setPlaces={setPlaces} />}

      {view === 'install' && <Install email={user.email} />}

      {view === 'admin' && <Admin />}

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
          filter={triageFilterNow}
          setFilter={(next) => {
            setTriageFilter(next);
            // Anything ticked and then filtered away would still be rated by the bulk buttons —
            // a verdict for everybody in the hunt, on flats no longer on screen. Changing what is
            // shown clears what is chosen.
            setSelected([]);
          }}
          notify={push}
          {...cardProps}
        />
      )}

      {/* Sweeping under Triage rather than beside it. They were two tabs, and the split cut one
          job in half: the pile you work through here *is* what a sweep produces, so "go and find
          more" and "there is nothing left to rate" belong on the same screen. A separate tab meant
          the empty triage list said nothing about how to refill it. */}
      {view === 'triage' && <Sweep />}

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

      {/* Every pile is handed the same request. The flat is in exactly one of them; the other three
          look for it, do not find it, and stay where they are. */}
      <div hidden={view !== 'list' && view !== 'map'}>
      <Pile
        title={GROUP_LABEL.excited}
        entries={grouped.excited}
        empty="Nothing yet — mark a place “Love it” in the panel and it lands here."
        reveal={reveal}
        {...cardProps}
      />

      <Toggle
        label={`${GROUP_LABEL.maybe} (${grouped.maybe.length})`}
        open={showMaybes}
        onToggle={() => setShowMaybes((v) => !v)}
      />
      {showMaybes && (
        <Pile entries={grouped.maybe} empty="Nothing liked." reveal={reveal} {...cardProps} />
      )}

      <Toggle
        label={`${GROUP_LABEL.unrated} (${grouped.unrated.length})`}
        open={showUnrated}
        onToggle={() => setShowUnrated((v) => !v)}
      />
      {showUnrated && (
        <Pile
          entries={grouped.unrated}
          empty="Everything you've opened has a verdict."
          reveal={reveal}
          {...cardProps}
        />
      )}

      {/* A count, not a list. Seeing them again is the thing rejecting was meant to prevent —
          but the number is worth knowing, and it's one click if you want to check. */}
      <Toggle
        label={`${GROUP_LABEL.rejected} (${grouped.rejected.length})`}
        open={showRejected}
        onToggle={() => setShowRejected((v) => !v)}
      />
      {showRejected && (
        <Pile entries={grouped.rejected} empty="Nothing rejected." reveal={reveal} {...cardProps} />
      )}
      </div>

      <Toasts toasts={toasts} dismiss={dismiss} />
    </div>
  );
}

/** The funnel as a row of counts you can filter on: shortlisted, reached out, viewing booked,
 *  viewed, offer in, archived — and the pile that is in none of them.
 *
 *  A step with nothing in it is still drawn, dimmed. A funnel that hid its empty steps would read
 *  as a hunt with no "viewed" step rather than one with nothing viewed yet, and the shape of what
 *  is left to do is the whole reason to look at it. */
function Funnel({
  counts,
  filter,
  setFilter,
}: {
  counts: FunnelCounts;
  filter: StageFilter;
  setFilter: (next: StageFilter) => void;
}) {
  return (
    <div className="funnel" data-testid="funnel">
      {STAGE_FILTERS.map((step) => (
        <button
          key={step}
          className={filter === step ? 'key key-on' : 'key'}
          aria-pressed={filter === step}
          disabled={counts[step] === 0 && filter !== step}
          data-testid={`funnel-${step}`}
          // Clicking the step you are already on goes back to everything, so the filter can always
          // be undone with the button that set it.
          onClick={() => setFilter(filter === step ? 'all' : step)}
        >
          {FILTER_LABEL[step]} <span className="dim">{counts[step]}</span>
        </button>
      ))}
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
  filter,
  setFilter,
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
  /** The bars a flat has to clear to stay in the pile. Held above this component so that going to
   *  the map and back does not throw away the narrowing you set up to work through. */
  filter: TriageFilter;
  setFilter: (next: TriageFilter) => void;
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
  const toggle = (id: string) =>
    setSelected(chosen.has(id) ? selected.filter((s) => s !== id) : [...selected, id]);
  const setMany = (ids: string[], on: boolean) => {
    const run = new Set(ids);
    setSelected(on ? [...new Set([...selected, ...ids])] : selected.filter((s) => !run.has(s)));
  };

  // The cache and nothing else, for the same reason the compare table reads it that way: a
  // read-through here would fire a journey-planner request for every gap in a pile of two hundred,
  // on every keystroke in the minutes box. A pairing nobody has looked up is unknown, and a travel
  // bar keeps the unknowns — which on a fresh sweep is most of them, and is what the count says.
  const travel = useCachedTravel(entries.map((e) => e.postcode));

  // Narrowed first, then ordered: sorting the pile and then throwing most of it away would leave
  // the ranking meaning something about flats that are no longer on screen. `unknowns` is what the
  // filter kept without an answer either way, which the bar says out loud.
  // Where the places are, for the bars measured as the crow flies rather than by a journey. Memoed
  // because the pile is refiltered on every keystroke in the bar's number box.
  const points = useMemo(() => placePoints(cardProps.places), [cardProps.places]);
  const { kept, unknowns } = applyFilter(entries, filter, travel.data, points);
  const shown = sortForTriage(kept, cardProps.scores, sortMode);
  const metrics = storedModel?.model.metrics;

  // "Select all" means all of what is on screen. Ticking a flat that has since been rated elsewhere
  // would rate it again on the next click, so the selection is read against what is in the pile now
  // — and with a filter on, the pile is what the filter left.
  const all = shown.map((e) => e.rightmoveId);
  const allChosen = all.length > 0 && all.every((id) => chosen.has(id));

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
        {/* Per option, not per control. Disabling the whole select when there is no model — which
            is how this started — took away "cheapest first" and "biggest first" as well, and those
            never needed one. The day a hunt starts is the day the pile is biggest and the model
            does not exist yet. */}
        <select
          value={sortMode}
          onChange={(e) => setSortMode(e.target.value as SortMode)}
          disabled={entries.length === 0}
          title="Choose which end of the pile to work from."
        >
          {(Object.keys(SORT_LABEL) as SortMode[]).map((mode) => (
            <option key={mode} value={mode} disabled={NEEDS_MODEL.includes(mode) && !cardProps.scores}>
              {SORT_LABEL[mode]}
              {NEEDS_MODEL.includes(mode) && !cardProps.scores ? ' — needs a model' : ''}
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

  const filters = (
    <TriageFilters
      filter={filter}
      setFilter={setFilter}
      kept={kept.length}
      unknowns={unknowns}
      total={entries.length}
      places={cardProps.places}
    />
  );

  // Filtered down to nothing is a different sentence from an empty pile, and it needs the filter
  // bar left on screen: the only way out of it is the control that caused it.
  if (shown.length === 0) {
    return (
      <div className="triage">
        {filters}
        {scoreBar}
        <p className="dim">
          None of the {entries.length} waiting clears those bars. Loosen one, or clear the filters.
        </p>
      </div>
    );
  }

  return (
    <div className="triage">
      {filters}
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
              {/* All of what the filters left, which is all of what is on screen. Offering to
                  select two hundred when twelve are shown is offering to rate a hundred and
                  eighty-eight flats nobody can see. */}
              {allChosen ? 'Clear' : `Select all ${shown.length}`}
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
                    selected.length > CONFIRM_BULK_ABOVE ? setConfirming(r.value) : onRate(r.value)
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
  /** What each flat has cost over time, keyed by listing. Undefined while the read is outstanding,
   *  which renders as no note rather than as "no change" — see `PriceMove`. */
  prices: Map<string, PricePoint[]> | undefined;
  /** Move a place along the funnel. Never touches its rating — the two are separate facts, which is
   *  the point of the funnel existing at all (`packages/core/src/stage.ts`). */
  setStage: (entry: ShortlistEntry, stage: Stage, archiveReason: ArchiveReason | null) => void;
  /** The one flat whose funnel write is in flight, if any. Named rather than a bare boolean so that
   *  saving on one card does not freeze the control on every other. */
  stageSaving: { rightmoveId: string; stage: Stage } | null;
  /** Present only in triage: cards grow a tick box and join a batch. Absent everywhere else,
   *  because a card you are reading to decide on is not a card you are selecting. */
  selection?: Selection;
}

function Pile({
  title,
  entries,
  empty,
  reveal,
  ...cardProps
}: {
  title?: string;
  entries: ShortlistEntry[];
  empty: string;
  /** A flat something outside this pile has asked to see — a map pin, a compare row, a link. Only
   *  the pile actually holding it responds; for every other pile this is an id it does not have. */
  reveal?: { id: string } | null;
} & CardProps) {
  // Where that flat is *now*, searched on every render rather than remembered: a refetch that drops
  // or reorders earlier flats moves it, and a remembered index would turn to the page it used to be
  // on. `usePaging` compares the index by value, so recomputing it costs nothing when nothing moved
  // — and `reveal` rides along as the token that makes a second click on the same pin count.
  const at = reveal
    ? { index: entries.findIndex((e) => e.rightmoveId === reveal.id), token: reveal }
    : null;
  // A page at a time. Two hundred cards, each with a photo strip and a travel-time block, is both
  // slow and unreadable — see `Pager`.
  const paging = usePaging(entries, at);
  // Cards get the same shift-pick the table has. They were the one layout of triage where a run
  // could only be ticked one at a time, and `setMany` was handed down and never called.
  //
  // Over the page on screen rather than the whole pile: a range you cannot see both ends of is one
  // you did not mean to draw.
  const pick = useRangePick(
    useMemo(() => paging.shown.map((e) => e.rightmoveId), [paging.shown]),
    cardProps.selection,
  );
  return (
    <section>
      {title && <h2>{title}</h2>}
      {entries.length === 0 ? (
        <p className="dim">{empty}</p>
      ) : (
        <>
          <div className="cards">
            {paging.shown.map((entry) => (
              <Card
                key={entry.rightmoveId}
                entry={entry}
                onPick={(shiftKey) => pick(entry.rightmoveId, shiftKey)}
                {...cardProps}
              />
            ))}
          </div>
          <Pager {...paging} />
        </>
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
  prices,
  setOffMarket,
  setStage,
  stageSaving,
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
  const point = entry.lat !== null && entry.lon !== null ? { lat: entry.lat, lon: entry.lon } : null;

  return (
    <article
      className={`card card-${group}${ticked ? ' card-ticked' : ''}${isOff ? ' card-off-market' : ''}${surprise ? ' card-surprise' : ''}`}
      id={`card-${entry.rightmoveId}`}
    >
      {/* Everything that says what and where this place is, in one block so the map can be floated
          into its top right and the rest read around it. */}
      <div className="card-top">
        {/* First in the block because a float only pushes aside what comes after it. */}
        <CardMap
          point={point}
          hubs={hubs}
          colour={COLOUR[group]}
          approximate={!entry.exactLocation}
          address={entry.displayAddress}
        />

      <div className="card-head">
        {selection && onPick && (
          <Tick checked={ticked} label={entry.displayAddress} onPick={onPick} />
        )}
        {/* The address, and only the address. It was a link to Rightmove, which made the most
            obvious thing to click on a card the one thing that took you off the site; the card
            below already holds the photos, the times and the verdict, and `Detail` ends with the
            explicit way out to the listing. */}
        {/* The postcode chip a few pixels away says the district already — see
            `addressBesidePostcode`. */}
        <span className="address">{addressBesidePostcode(entry.displayAddress, entry.postcode)}</span>
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
        {/* What it used to cost, when that is a thing we have watched change. Nothing at all for a
            flat seen once — see `PriceMove`. */}
        <PriceMove history={prices?.get(entry.rightmoveId)} />
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
          point={point}
          hubs={hubs}
          approximate={!entry.exactLocation}
        />
      </div>

      {/* Cards keep the good news — a bathtub IS the reason you'd look twice — but the rings
          go bare: four flags each shouting "HIGH" is four times the noise for one fact. */}
      <Flags source={{ analysis: entry.analysis, floorplanUrl: entry.floorplanUrl, size: sizeOf(entry) }} prefs={prefs} />

      {entry.nearestStations.length > 0 && (
        <div className="stations dim">
          {entry.nearestStations
            .slice(0, 2)
            .map((s) => `${s.name.replace(/\s+Station$/, '')} ${stationDistance(s.distance, s.unit)}`)
            .join(' · ')}
        </div>
      )}
      </div>

      {/* The verdict itself is stated once, by `Detail` immediately below, where it sits with the
          buttons that change it and the note that explains it. This card used to draw its own pill
          per person — its own emoji, its own wording, no author and no date — which is exactly the
          drift `components/Verdict.tsx` was written to end. A project now holds one rating
          (design D6), and one renderer states it. */}
      <Detail
        entry={entry}
        places={places}
        onRate={(value, note) => rate(entry, value, note)}
        onSetStage={(stage, reason) => setStage(entry, stage, reason)}
        stageSaving={stageSaving?.rightmoveId === entry.rightmoveId ? stageSaving.stage : null}
      />

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
