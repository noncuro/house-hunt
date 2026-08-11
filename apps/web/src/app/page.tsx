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
import type { Place, Rating } from '@house-hunt/core';
import { HubFact } from '@house-hunt/ui';
import { Hint } from '@house-hunt/ui';
import { Flags } from '@house-hunt/ui';
import { SizeFact } from '@house-hunt/ui';
import { SpendWarning } from '@house-hunt/ui';
import { RATINGS, ratingOf } from '@house-hunt/ui';
import { hubsFromProject, type Hub } from '@house-hunt/core';
import { ExtensionNotice } from '@/screens/Extension';
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
  usePlaces,
  useRate,
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
    window.history.pushState(null, '', qs ? `?${qs}` : window.location.pathname);
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
    // Let the list render before scrolling to the card that was pointed at.
    requestAnimationFrame(() => document.getElementById(`card-${id}`)?.scrollIntoView({ block: 'center' }));
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
  const cardProps = { places, hubs, twins, rate };
  const byId = useMemo(() => new Map((entries ?? []).map((e) => [e.rightmoveId, e])), [entries]);

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
    // a 980px letterbox defeats it. That view alone gets the whole window.
    <div className={view === 'table' ? 'wrap wrap-wide' : 'wrap'}>
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
            List
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
            House hunt
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
          onRate={rateSelected}
          {...cardProps}
        />
      )}

      {view === 'table' && (
        <Compare
          entries={entries}
          places={places}
          onOpen={(id) => openCard(id, groupOf(byId.get(id)?.verdicts ?? []))}
        />
      )}

      {view === 'map' && (
        <ShortlistMap
          entries={entries}
          selectedId={null}
          onSelect={(id) => openCard(id, groupOf(byId.get(id)?.verdicts ?? []))}
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
  onRate,
  ...cardProps
}: {
  entries: ShortlistEntry[];
  selected: string[];
  setSelected: (next: string[]) => void;
  onRate: (rating: Rating) => void;
} & CardProps) {
  // The table is the default, and it is the layout the tick boxes were asking for. Ticking is a
  // comparing action — you decide "not this one, not this one, this one maybe" by reading the
  // same four numbers down a column — and a checkbox beside a full-width card makes you scroll
  // past everything the card knows to reach the next decision. Cards stay one click away for the
  // pile where the photos are what you want.
  const [layout, setLayout] = useState<'table' | 'cards'>('table');
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

  if (entries.length === 0) {
    return <p className="dim">Nothing waiting — every place either of you has opened has a verdict.</p>;
  }

  return (
    <div className="triage">
      <div className="triage-bar">
        <button className="key triage-all" onClick={() => setSelected(allChosen ? [] : all)}>
          {allChosen ? 'Clear' : `Select all ${entries.length}`}
        </button>
        <span className="dim">
          {selected.length === 0 ? 'Nothing selected' : `${selected.length} selected`}
        </span>
        {/* The same three ratings, in the same words and the same order as everywhere else — from
            `components/ratings.ts` rather than a table of its own, which is how rating in bulk
            and rating one place came to call the same verdict two things. Not `RatingButtons`:
            these are wider, sit in the triage bar's own layout, and have no current value to
            show, since a selection of thirty flats has no one rating between them. */}
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
              onClick={() => onRate(r.value)}
            >
              {r.emoji} {r.label}
            </button>
          ))}
        </div>
        <button className="key triage-layout" onClick={() => setLayout(layout === 'table' ? 'cards' : 'table')}>
          {layout === 'table' ? 'Show cards' : 'Show table'}
        </button>
      </div>

      {layout === 'table' ? (
        <Compare
          entries={entries}
          places={cardProps.places}
          onOpen={() => {}}
          selection={{ chosen, toggle, setMany }}
          filters={false}
          columnsKey="triage"
        />
      ) : (
        <Pile entries={entries} empty="Nothing waiting." selection={{ chosen, toggle, setMany }} {...cardProps} />
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
  /** Present only in triage: cards grow a tick box and join a batch. Absent everywhere else,
   *  because a card you are reading to decide on is not a card you are selecting. */
  selection?: {
    chosen: Set<string>;
    toggle: (rightmoveId: string) => void;
    setMany: (rightmoveIds: string[], on: boolean) => void;
  };
}

function Pile({
  title,
  entries,
  empty,
  ...cardProps
}: { title?: string; entries: ShortlistEntry[]; empty: string } & CardProps) {
  return (
    <section>
      {title && <h2>{title}</h2>}
      {entries.length === 0 ? (
        <p className="dim">{empty}</p>
      ) : (
        <div className="cards">
          {entries.map((entry) => (
            <Card key={entry.rightmoveId} entry={entry} {...cardProps} />
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
function Card({ entry, places, hubs, twins, rate, selection }: { entry: ShortlistEntry } & CardProps) {
  const group = groupOf(entry.verdicts);
  const alsoAs = twins.get(entry.rightmoveId) ?? [];
  const ticked = selection?.chosen.has(entry.rightmoveId) ?? false;

  return (
    <article
      className={`card card-${group}${ticked ? ' card-ticked' : ''}`}
      id={`card-${entry.rightmoveId}`}
    >
      <div className="card-head">
        {selection && (
          <label className="tick">
            <input
              type="checkbox"
              checked={ticked}
              onChange={() => selection.toggle(entry.rightmoveId)}
            />
            <span className="visually-hidden">Select {entry.displayAddress}</span>
          </label>
        )}
        <a className="address" href={entry.url} target="_blank" rel="noopener">
          {entry.displayAddress}
        </a>
      </div>

      {/* The same facts the panel states, in the same words. When the two disagreed about what
          a place is, the shortlist stopped being a view of the same data. */}
      <div className="facts">
        {entry.price && <span className="price">{entry.price}</span>}
        {entry.listingUpdate && (
          <span
            className={/reduc/i.test(entry.listingUpdate) ? 'since reduced' : 'since dim'}
            title={entry.listingUpdate}
          >
            {relativeUpdate(entry.listingUpdate)}
          </span>
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
      <Flags source={{ analysis: entry.analysis, floorplanUrl: entry.floorplanUrl }} />

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
    </article>
  );
}
