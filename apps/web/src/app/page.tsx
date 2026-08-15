'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { SpendWarning, Toasts, useToasts } from '@house-hunt/ui';
import {
  groupOf,
  hubsFromProject,
  parseFilter,
  withKnownPlaces,
  withoutOffMarket,
  type ArchiveReason,
  type Hub,
  type Place,
  type Rating,
  type Stage,
  type TriageFilter,
} from '@house-hunt/core';
import {
  NoActiveProject,
  Unauthenticated,
  spendSummary,
  type ShortlistEntry,
} from '@house-hunt/core/db';
import type { AuthState, ProjectSummary, SessionUser } from '@house-hunt/core';
import { Shell, type Destination } from '@/components/Shell';
import { FlatPanel } from '@/components/FlatPanel';
import { Admin } from '@/screens/Admin';
import { ExtensionNotice } from '@/screens/Extension';
import { FirstRun } from '@/screens/FirstRun';
import { Install } from '@/screens/Install';
import { Places } from '@/screens/Places';
import { Project, ProjectPicker } from '@/screens/Project';
import { Settings } from '@/screens/Settings';
import { SignIn } from '@/screens/SignIn';
import { Sweep } from '@/screens/Sweep';
import { Triage } from '@/screens/Triage';
import { EVERYTHING, lensMatches, type Lens } from '@/lib/lens';
import { scoreEntries, type SortMode } from '@/lib/score';
import { useStoredState } from '@/lib/stored';
import { useRoute } from '@/lib/view';
import {
  keys,
  queryClient,
  useAuth,
  useCachedTravel,
  useLocateProperties,
  useModel,
  useOffMarket,
  usePlaces,
  usePrices,
  useProjectSettings,
  useRate,
  useSetOffMarket,
  useSetStage,
  useShortlist,
} from '@/lib/queries';

/** Nobody is off the market, for the frames before the set has been read. One shared value so that a
 *  screen's props do not change identity every render. */
const EMPTY: ReadonlySet<string> = new Set();

/** What the page is at all is decided here, and by one question: who is signed in.
 *
 *  Not being signed in is a state with a screen of its own, never a blank and never a stack trace
 *  (design D13). Which is why this sits above everything: the shortlist reads six things, and a
 *  signed-out session fails all six at once. Rendering it and letting each read say "sign in" would
 *  put that sentence on screen six times and the actual sign-in field nowhere. */
export default function Page() {
  const auth = useAuth();

  if (auth.isPending) {
    return (
      <div className="wrap">
        <p className="dim working">Loading…</p>
      </div>
    );
  }

  // The database itself is unreachable — a different thing from being signed out, and it must not be
  // dressed up as one: offering a sign-in form that cannot possibly work is the worst answer.
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

  // Keyed on the hunt, so switching remounts rather than re-renders. Everything held in React state
  // below belongs to one project — which flats are ticked, what triage is filtered to, which flat is
  // open — and a re-render carries all of it across. The ticked set is the dangerous one: the same
  // listing can be in two hunts, so a selection that survived the switch meant the next bulk-rating
  // click wrote a verdict in a hunt where nobody had selected anything.
  return (
    <App
      key={state.activeProject.id}
      user={state.user}
      project={state.activeProject}
      projects={state.projects}
    />
  );
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
  const [route, go] = useRoute();
  const { toasts, push, dismiss } = useToasts();
  const client = useQueryClient();

  const shortlist = useShortlist();
  const placesQuery = usePlaces();
  const offMarketQuery = useOffMarket();
  const modelQuery = useModel();
  const settingsQuery = useProjectSettings();
  useLocateProperties();

  const rating = useRate(user.displayName);
  const offMarketMutation = useSetOffMarket();
  const stageMutation = useSetStage();

  const all = shortlist.data ?? null;
  const pricesQuery = usePrices((all ?? []).map((e) => e.rightmoveId));
  // What the month's photo analysis has cost. The panel warns on the listing in front of you; the
  // website warns here, once, above every screen — the first sign of a budget should not be a
  // listing that quietly refuses to analyse (design D9).
  const spendQuery = useQuery({ queryKey: ['spend'], queryFn: spendSummary });

  // One narrowing over the whole hunt, shared by all four of Places' renderings — see `lib/lens.ts`
  // for why the funnel bar and the map's legend became one control.
  const [lens, setLens] = useState<Lens>(EVERYTHING);
  const [showOffMarket, setShowOffMarket] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [sortMode, setSortMode] = useState<SortMode>('default');
  // The flat opened over whatever screen you are on. A panel rather than a destination: opening one
  // from the map used to be navigation, which threw the map away, and coming back re-fitted it.
  const [open, setOpen] = useState<string | null>(null);

  // Held here rather than inside Triage so that going to the map and back does not throw away the
  // narrowing you set up to work through — and stored, so neither does closing the tab. Per hunt: a
  // filter names this project's places and this project's budget, and one shared key meant opening a
  // second hunt with the first one's rent ceiling already applied.
  const [triageFilter, setTriageFilter] = useStoredState<TriageFilter>(
    `triage:filter:${project.id}`,
    parseFilter,
  );

  const places = placesQuery.data ?? [];
  // Only against a *successful* read. `placesQuery.data ?? []` looks like the same thing and is not:
  // while the query is loading, and after it fails, an empty list means "no places" and every saved
  // travel bar is thrown away — silently widening the filter to everything on the first frame of
  // every page load. Not knowing is a reason to keep what somebody saved.
  const triageFilterNow = useMemo(
    () => (placesQuery.data ? withKnownPlaces(triageFilter, placesQuery.data) : triageFilter),
    [triageFilter, placesQuery.data],
  );

  // Three states, and the difference matters: still reading, read and failed, read. `HubFact` draws
  // each as itself, because a failed read and "nothing within a mile" are the same blank and
  // opposite claims. Every place, not just the swept ones — the office is not somewhere we look for
  // flats and is still one of the best landmarks to fix a flat against.
  const hubs: Hub[] | null | undefined = placesQuery.isError
    ? null
    : placesQuery.data
      ? hubsFromProject(placesQuery.data)
      : undefined;

  const offMarket = offMarketQuery.data ?? null;
  const inLens = useMemo(
    () => (all === null ? null : all.filter((e) => lensMatches(e, lens))),
    [all, lens],
  );
  const entries = useMemo(
    () => (inLens === null ? null : withoutOffMarket(inLens, offMarket, showOffMarket)),
    [inLens, offMarket, showOffMarket],
  );
  // Counted over what this screen would otherwise be showing, not over the whole hunt. The hunt-wide
  // number is the one that reads as a lie: filter to "viewed" with one of two gone flats viewed and
  // the sentence says two are hidden, then showing them produces one.
  const offMarketHere =
    offMarket === null ? 0 : (inLens ?? []).filter((e) => offMarket.has(e.rightmoveId)).length;

  // Every entry's P(yes) under the current model, computed once and shared by the cards, the triage
  // sort and the mismatch marker. Null while there is no model, and null until the hubs are actually
  // in hand: handing the scorer `[]` for a read still in flight is not a smaller input, it is a
  // different one, and a score computed without distance-to-neighbourhood is a confident number
  // about the wrong flat.
  const model = modelQuery.data?.model ?? null;
  const scores = useMemo(
    () => (model && all && Array.isArray(hubs) ? scoreEntries(model, all, hubs) : null),
    // placesQuery.data rather than the derived `hubs` array, which is a fresh reference every
    // render; isError alongside it so a failed refetch clears the scores instead of leaving stale
    // ones up.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
    [model, all, placesQuery.data, placesQuery.isError],
  );

  // The cards read journeys from the cache and never fetch — a grid of twenty-five would be
  // twenty-five TfL calls on scroll. The one flat somebody has actually opened resolves its own,
  // inside `FlatDetail`.
  const travel = useCachedTravel((entries ?? []).map((e) => e.postcode));

  const prefs = settingsQuery.data ?? {};
  const unrated = useMemo(() => (all ?? []).filter((e) => groupOf(e.verdicts) === 'unrated'), [all]);

  const rate = (entry: ShortlistEntry, value: Rating, note: string) =>
    rating.mutate(
      { rightmoveId: entry.rightmoveId, rating: value, note },
      { onError: (e) => push(`Not saved — ${e.message}`) },
    );

  /** Rate everything ticked, in one go.
   *
   *  Notes are the reason a verdict is worth reading later, and this writes none — which is exactly
   *  right for the job it does. Working down a pile of thirty flats nobody has looked at, most of the
   *  answer is "not for us" for a reason visible from the row: too far, too dear, no bath. Making
   *  that a per-flat conversation is what stops the pile ever being worked through. */
  const rateMany = (value: Rating) => {
    const ticked = new Set(selected);
    const batch = unrated.filter((e) => ticked.has(e.rightmoveId));
    for (const entry of batch) rate(entry, value, '');
    setSelected([]);
    push(`${batch.length} ${batch.length === 1 ? 'place' : 'places'} rated.`);
  };

  /** Move a place along the funnel. The verdict is not touched and must not be: losing a flat you
   *  loved is a fact about the flat's availability, not about your taste, and the score is fitted on
   *  the second. */
  const setStage = (entry: ShortlistEntry, stage: Stage, archiveReason: ArchiveReason | null) =>
    stageMutation.mutate(
      { rightmoveId: entry.rightmoveId, stage, archiveReason },
      { onError: (e) => push(`Not saved — ${(e as Error).message}`) },
    );

  const setOffMarket = (entry: ShortlistEntry, off: boolean) =>
    offMarketMutation.mutate(
      { rightmoveId: entry.rightmoveId, off },
      { onError: (e) => push(`Not saved — ${(e as Error).message}`) },
    );

  const setPlaces = (update: (current: Place[]) => Place[]) =>
    client.setQueryData(keys.places, (current: Place[] | undefined) => update(current ?? []));

  /** Renaming yourself is a change to the session, not to a local setting — every verdict this page
   *  attributes to you reads the same field. Patched in place rather than refetched so the name
   *  changes in the same frame the Save button was pressed. */
  const setPerson = (next: string | null) =>
    client.setQueryData<AuthState>(keys.auth, (current) =>
      current?.status === 'signed-in'
        ? { ...current, user: { ...current.user, displayName: next ?? current.user.email } }
        : current,
    );

  /** `…/#card-88023648` opens on that flat — the thing a `chrome-extension://` address could never
   *  do, and the reason for most of this change. You can send one of these to the other laptop, or
   *  keep one in a message thread, and it still means something a week later.
   *
   *  Since the redesign it opens the panel rather than scrolling to a card, which removes the three
   *  things that used to be able to swallow it: a collapsed pile, a stage filter that excluded the
   *  flat, and paging. The one remaining is being off the market, which the panel simply ignores —
   *  it draws whichever flat it is pointed at, and "is this one still going?" is exactly why somebody
   *  would follow the link. */
  const jumped = useRef<string | null>(null);
  useEffect(() => {
    if (!all) return;
    const id = /^#card-(\d+)$/.exec(window.location.hash)?.[1];
    if (!id || jumped.current === id) return;
    if (!all.some((e) => e.rightmoveId === id)) return;
    jumped.current = id;
    setOpen(id);
  }, [all]);

  const destinations: Destination[] = [
    { view: 'places', label: 'Places', icon: 'places', hint: 'Everything this hunt has looked at' },
    {
      view: 'triage',
      label: 'Triage',
      icon: 'triage',
      hint: 'Work through the places nobody has rated yet',
      badge: unrated.length,
    },
    { view: 'project', label: 'Your Hunt', icon: 'hunt', hint: 'Who is in it, where you travel to, what matters' },
  ];
  // Presentation only. Hiding the tab is not the boundary — `is_admin()` in the database is, and
  // every admin RPC checks it. This just stops a tab that answers nothing.
  if (user.isAdmin) {
    destinations.push({ view: 'admin', label: 'Admin', icon: 'columns', hint: 'Users, projects, invites and spend' });
  }

  const openEntry = open ? ((all ?? []).find((e) => e.rightmoveId === open) ?? null) : null;

  if (shortlist.isError) {
    // A read that failed because the session ended, or because the project went away, is not this
    // view's error to report: the shell is already re-reading who is signed in and is about to
    // replace the whole page. Printing "sign in" here would flash that sentence with no field
    // underneath it to act on.
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
    <Shell
      user={user}
      project={project}
      projects={projects}
      destinations={destinations}
      view={route.view}
      setView={(view) => go({ view })}
      notify={push}
    >
      {/* Above every screen rather than inside one: a budget and a half-installed extension are facts
          about the setup, not about the list you happen to be looking at. Both render nothing at all
          in the usual case. */}
      <div className="notices">
        <SpendWarning summary={spendQuery.data ?? null} />
        <ExtensionNotice email={user.email} />
      </div>

      <main className={route.view === 'places' || route.view === 'triage' ? 'wrap wrap-wide' : 'wrap'}>
        {/* A hunt with nothing in it is not an empty shortlist, it is a hunt that has not been set up
            — and the three steps are the answer, not four counts reading zero. */}
        {route.view === 'places' && all.length === 0 ? (
          <FirstRun places={places} setView={(view) => go({ view })} />
        ) : route.view === 'places' ? (
          <Places
            all={all}
            entries={entries}
            view={route.places}
            setView={(places) => go({ places })}
            lens={lens}
            setLens={setLens}
            places={places}
            travel={travel.data}
            prefs={prefs}
            scores={scores}
            picked={picked}
            setPicked={setPicked}
            offMarketHere={offMarketHere}
            showOffMarket={showOffMarket}
            setShowOffMarket={setShowOffMarket}
            offMarketUnknown={
              offMarketQuery.isError ? (offMarket === null ? 'unread' : 'stale') : null
            }
            onOpen={setOpen}
            onSetStage={setStage}
            refreshing={shortlist.isFetching}
          />
        ) : null}

        {route.view === 'triage' && (
          <>
            <Triage
              entries={unrated}
              places={places}
              hubs={hubs}
              prices={pricesQuery.data}
              prefs={prefs}
              scores={scores}
              offMarket={offMarket ?? EMPTY}
              storedModel={modelQuery.data ?? null}
              filter={triageFilterNow}
              setFilter={setTriageFilter}
              sortMode={sortMode}
              setSortMode={setSortMode}
              selected={selected}
              setSelected={setSelected}
              onRate={rate}
              onRateMany={rateMany}
              onSetStage={setStage}
              onSetOffMarket={setOffMarket}
              stageSaving={
                stageMutation.isPending && stageMutation.variables
                  ? {
                      rightmoveId: stageMutation.variables.rightmoveId,
                      stage: stageMutation.variables.stage,
                    }
                  : null
              }
              notify={push}
            />
            {/* Sweeping under Triage rather than beside it. They were two tabs, and the split cut one
                job in half: the pile you work through here *is* what a sweep produces, so "go and
                find more" and "there is nothing left to rate" belong on the same screen. */}
            <Sweep />
          </>
        )}

        {route.view === 'project' && <Project notify={push} places={places} setPlaces={setPlaces} />}
        {route.view === 'admin' && <Admin />}
        {route.view === 'install' && <Install email={user.email} />}
        {route.view === 'settings' && (
          <Settings person={user.displayName} setPerson={setPerson} notify={push} />
        )}
      </main>

      {/* One flat, over whatever you were doing, from wherever you asked. The same renderer for all
          of them — a card on Places, a pin on the map, a row in the table, a link somebody sent. */}
      {openEntry && (
        <FlatPanel
          entry={openEntry}
          places={places}
          hubs={hubs}
          prices={pricesQuery.data}
          prefs={prefs}
          score={scores?.get(openEntry.rightmoveId)}
          offMarket={offMarket ?? EMPTY}
          onClose={() => setOpen(null)}
          onRate={(value, note) => rate(openEntry, value, note)}
          onSetStage={(stage, reason) => setStage(openEntry, stage, reason)}
          onSetOffMarket={(off) => setOffMarket(openEntry, off)}
          stageSaving={
            stageMutation.isPending &&
            stageMutation.variables?.rightmoveId === openEntry.rightmoveId
              ? stageMutation.variables.stage
              : null
          }
        />
      )}

      <Toasts toasts={toasts} dismiss={dismiss} />
    </Shell>
  );
}
