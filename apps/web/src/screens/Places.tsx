'use client';

import { useMemo, useState } from 'react';
import { Icon, type IconName } from '@house-hunt/ui';
import {
  GROUP_LABEL,
  enthusiasm,
  groupOf,
  type Group,
  type HuntPreferences,
  type Place,
  type TravelTime,
} from '@house-hunt/core';
import type { ShortlistEntry } from '@house-hunt/core/db';
import { FlatCard } from '@/components/FlatCard';
import { Pager, usePaging } from '@/components/Pager';
import { Board } from '@/screens/Board';
import { Compare } from '@/screens/Compare';
import { HeadToHead } from '@/screens/HeadToHead';
import { ShortlistMap } from '@/screens/Map';
import type { SetStage } from '@/lib/actions';
import { chipsFor, lensLabel, sameLens, DEFAULT_LENS, type Lens } from '@/lib/lens';
import type { PlacesView } from '@/lib/view';

/** Every flat this hunt has looked at, narrowed once and drawn four ways.
 *
 *  Shortlist, Compare and Map were three tabs over the same list, so the funnel filter you set on one
 *  was not the one the next had, and choosing between them was navigation when it is a rendering
 *  choice. One screen, one filter, and a segmented control — plus a fourth rendering that could not
 *  have been a fifth tab: the board, where the funnel is the layout rather than a filter over it.
 *
 *  The toolbar is the same on all four, which is the point: the chips say what you are looking at and
 *  the switch says how, and neither moves when you change the other. */

const RENDERINGS: Array<{ value: PlacesView; label: string; icon: IconName; hint: string }> = [
  { value: 'cards', label: 'Cards', icon: 'places', hint: 'The photographs, three across' },
  { value: 'table', label: 'Table', icon: 'columns', hint: 'One row each, every number side by side' },
  { value: 'board', label: 'Board', icon: 'triage', hint: 'The funnel as columns — drag a flat forward' },
  { value: 'map', label: 'Map', icon: 'map', hint: 'Where they are' },
];

/** `find` returns undefined for an id whose flat has since left the lens — a chip changed, or the
 *  other person archived it while you were reading. Dropping those keeps the rest of the comparison
 *  rather than refusing the whole of it. */
const isEntry = (e: ShortlistEntry | undefined): e is ShortlistEntry => e !== undefined;

export function Places({
  all,
  entries,
  view,
  setView,
  lens,
  setLens,
  places,
  travel,
  prefs,
  scores,
  picked,
  setPicked,
  boardEntries,
  offMarket,
  offMarketUnknown,
  onOpen,
  onSetStage,
  refreshing,
}: {
  /** The whole hunt, which is what the chips count. A chip that counted only what the current lens
   *  left would say "Loved 0" the moment you filtered to the archived ones, and the row would stop
   *  being a way back out of the filter you are in. */
  all: ShortlistEntry[];
  /** What this lens leaves. */
  entries: ShortlistEntry[];
  view: PlacesView;
  setView: (next: PlacesView) => void;
  lens: Lens;
  setLens: (next: Lens) => void;
  places: Place[];
  travel: Record<string, TravelTime[]> | undefined;
  prefs: HuntPreferences;
  scores: Map<string, number> | null;
  /** The finalists ticked in the table, for the head-to-head. Held above this screen so that going
   *  to the map and back does not throw the shortlist of four you had just assembled. */
  picked: string[];
  setPicked: (next: string[]) => void;
  /** The same lens with its stage half dropped — see `forBoard`. */
  boardEntries: ShortlistEntry[];
  offMarket: ReadonlySet<string> | null;
  offMarketUnknown: 'unread' | 'stale' | null;
  onOpen: (rightmoveId: string) => void;
  onSetStage: SetStage;
  refreshing: boolean;
}) {
  const { main, aside } = useMemo(() => chipsFor(all, offMarket), [all, offMarket]);
  // Not a route of its own. The side-by-side is a moment in the middle of working the table — you
  // tick four, look, and go back to the same sort and the same page — and making it a screen would
  // put a back button where a close is, and lose all three when you used it.
  const [duel, setDuel] = useState(false);
  const finalists = useMemo(
    () => (duel ? picked.map((id) => all.find((e) => e.rightmoveId === id)).filter(isEntry) : []),
    [duel, picked, all],
  );

  if (duel && finalists.length >= 2) {
    return (
      <HeadToHead
        entries={finalists}
        places={places}
        prefs={prefs}
        onOpen={onOpen}
        onClose={() => setDuel(false)}
      />
    );
  }

  return (
    <section className="places">
      <div className="toolbar">
        <div className="segmented" role="group" aria-label="How to show these">
          {RENDERINGS.map((r) => (
            <button
              key={r.value}
              type="button"
              className={view === r.value ? 'segment segment-on' : 'segment'}
              aria-pressed={view === r.value}
              title={r.hint}
              data-testid={`places-${r.value}`}
              onClick={() => setView(r.value)}
            >
              <Icon name={r.icon} size={13} className="segment-icon" />
              {r.label}
            </button>
          ))}
        </div>

        <span className="toolbar-rule" aria-hidden="true" />

        <div className="chips" data-testid="funnel">
          {main.map((chip) => (
            <Chip key={lensLabel(chip.lens)} chip={chip} lens={lens} setLens={setLens} />
          ))}
        </div>

        <div className="chips chips-aside">
          {aside.map((chip) => (
            <Chip key={lensLabel(chip.lens)} chip={chip} lens={lens} setLens={setLens} quiet />
          ))}
        </div>
      </div>

      {/* Under the toolbar rather than inside it: these are notes about what the screen is not
          showing, and a note that looks like a control is the mistake the old counts line made. */}
      {(offMarketUnknown || refreshing) && (
        <p className="places-note dim">
          {/* Failing open is right — hiding flats on a read that did not answer is the worse of the
              two mistakes — but doing it silently makes the screen look authoritative about it. */}
          {offMarketUnknown && (
            <span className="error-inline" data-testid="off-market-unknown">
              {offMarketUnknown === 'unread'
                ? 'Which places are off the market could not be read, so they are drawn where their stage puts them.'
                : 'Which places are off the market could not be refreshed, so this may be out of date.'}
            </span>
          )}
          {refreshing && <span className="working"> · refreshing</span>}
        </p>
      )}

      {entries.length === 0 ? (
        <Empty lens={lens} setLens={setLens} total={all.length} />
      ) : view === 'cards' ? (
        <Cards
          entries={entries}
          grouped={lens.kind !== 'group'}
          places={places}
          travel={travel}
          prefs={prefs}
          scores={scores}
          onOpen={onOpen}
        />
      ) : view === 'table' ? (
        <Compare
          entries={entries}
          places={places}
          prefs={prefs}
          picked={picked}
          setPicked={setPicked}
          onHeadToHead={() => setDuel(true)}
          onOpen={onOpen}
          onSetStage={onSetStage}
        />
      ) : view === 'board' ? (
        <Board entries={boardEntries} onOpen={onOpen} onSetStage={onSetStage} />
      ) : (
        <ShortlistMap
          entries={entries}
          places={places}
          travel={travel}
          prefs={prefs}
          scores={scores}
          onOpen={onOpen}
        />
      )}
    </section>
  );
}

function Chip({
  chip,
  lens,
  setLens,
  quiet = false,
}: {
  chip: ReturnType<typeof chipsFor>['main'][number];
  lens: Lens;
  setLens: (next: Lens) => void;
  quiet?: boolean;
}) {
  const on = sameLens(chip.lens, lens);
  return (
    <button
      type="button"
      className={`chip${on ? ' chip-on' : ''}${quiet ? ' chip-quiet' : ''}`}
      aria-pressed={on}
      data-testid={`lens-${chip.lens.kind === 'stage' ? chip.lens.stage : chip.lens.kind === 'group' ? chip.lens.group : 'all'}`}
      // Clicking the chip you are on does nothing. There is no "everything" to fall back to, and a
      // control that empties the screen when pressed twice is worse than one that ignores you.
      onClick={() => (on ? undefined : setLens(chip.lens))}
    >
      {chip.label}
      {/* The chip keeps its weight and only the number dims. Greying the whole chip to near
          invisibility hid the shape of the funnel exactly where progress should be legible. */}
      <span className={chip.count === 0 ? 'chip-count chip-count-zero' : 'chip-count'}>{chip.count}</span>
    </button>
  );
}

/** Nothing to show, and which of the two reasons it is.
 *
 *  A hunt with nothing in it and a filter that matched nothing look identical and need opposite next
 *  actions — one is "go and open a listing", the other is "clear the filter" — so they get different
 *  sentences and the second gets the button. */
function Empty({ lens, setLens, total }: { lens: Lens; setLens: (next: Lens) => void; total: number }) {
  if (total === 0) {
    return (
      <p className="dim empty" data-testid="places-empty">
        Nothing here yet — open a Rightmove listing with the extension running and it lands here on
        its own.
      </p>
    );
  }
  // The way out names where it goes. "Show everything" used to be the way out and there is no
  // everything now; the shortlist is where the screen opens, so that is what it offers back.
  return (
    <p className="dim empty" data-testid="places-empty">
      Nothing at “{lensLabel(lens).toLowerCase()}”, of {total} in the hunt.{' '}
      {!sameLens(lens, DEFAULT_LENS) && (
        <button type="button" className="linkish" onClick={() => setLens(DEFAULT_LENS)}>
          Back to {lensLabel(DEFAULT_LENS).toLowerCase()}
        </button>
      )}
    </p>
  );
}

/** The default rendering: the photographs, three across, grouped by what you thought of them.
 *
 *  Grouped rather than one flat run because the first question on opening this screen is "what are
 *  we excited about", and a single grid sorted by anything at all buries that under the two hundred
 *  nobody has judged. When the lens is already one verdict the grouping would be a single heading
 *  over everything, so it goes. */
function Cards({
  entries,
  grouped,
  places,
  travel,
  prefs,
  scores,
  onOpen,
}: {
  entries: ShortlistEntry[];
  grouped: boolean;
  places: Place[];
  travel: Record<string, TravelTime[]> | undefined;
  prefs: HuntPreferences;
  scores: Map<string, number> | null;
  onOpen: (rightmoveId: string) => void;
}) {
  const piles = useMemo(() => {
    if (!grouped) return [{ group: null, entries }];
    const by: Record<Group, ShortlistEntry[]> = { excited: [], maybe: [], unrated: [], rejected: [] };
    for (const entry of entries) by[groupOf(entry.verdicts)].push(entry);
    // Both of you keen beats one of you keen; within that, most recently looked at first.
    for (const pile of Object.values(by)) {
      pile.sort(
        (a, b) =>
          enthusiasm(b.verdicts) - enthusiasm(a.verdicts) || b.lastSeenAt.localeCompare(a.lastSeenAt),
      );
    }
    return ORDER.filter((g) => by[g].length > 0).map((group) => ({ group, entries: by[group] }));
  }, [entries, grouped]);

  return (
    <>
      {piles.map((pile) => (
        <Pile
          key={pile.group ?? 'all'}
          group={pile.group}
          entries={pile.entries}
          places={places}
          travel={travel}
          prefs={prefs}
          scores={scores}
          onOpen={onOpen}
        />
      ))}
    </>
  );
}

/** The order the piles are read in: what you are keen on, then what is still open, then what is
 *  done with. `rejected` last because it is the only one that is not work. */
const ORDER: Group[] = ['excited', 'maybe', 'unrated', 'rejected'];

function Pile({
  group,
  entries,
  places,
  travel,
  prefs,
  scores,
  onOpen,
}: {
  group: Group | null;
  entries: ShortlistEntry[];
  places: Place[];
  travel: Record<string, TravelTime[]> | undefined;
  prefs: HuntPreferences;
  scores: Map<string, number> | null;
  onOpen: (rightmoveId: string) => void;
}) {
  // A page at a time. Two hundred cards, each with two photographs, is both slow and unreadable.
  const paging = usePaging(entries);
  return (
    <section className="pile">
      {group && (
        <h2 className="pile-head">
          <span>
            {GROUP_LABEL[group]} · {entries.length}
          </span>
          <span className="pile-rule" aria-hidden="true" />
        </h2>
      )}
      <div className="grid">
        {paging.shown.map((entry) => (
          <FlatCard
            key={entry.rightmoveId}
            entry={entry}
            places={places}
            travel={travel}
            prefs={prefs}
            score={scores?.get(entry.rightmoveId)}
            onOpen={onOpen}
          />
        ))}
      </div>
      <Pager {...paging} />
    </section>
  );
}
