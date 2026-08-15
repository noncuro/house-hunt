'use client';

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Hint } from '@house-hunt/ui';
import { formatDuration, MODE_ICON, readTravel, Routes } from '@house-hunt/ui';
import {
  flagsFor,
  problemsOnly,
  relativeUpdate,
  resolveSize,
  worstSeverity,
  type Flag,
  type HuntPreferences,
} from '@house-hunt/core';
import {
  DEFAULT_SHOWING,
  duplicateIds,
  GROUP_LABEL,
  groupOf,
  parseMonthlyPrice,
  sizeOf,
  stageRank,
  stageSentence,
  type Group,
} from '@house-hunt/core';
import type { ShortlistEntry } from '@house-hunt/core/db';
import {
  TRAVEL_MODES,
  travelDestinations,
  type Place,
  type TravelMode,
  type TravelTime,
} from '@house-hunt/core';
import { FlagChip } from '@house-hunt/ui';
import { SizeValue } from '@house-hunt/ui';
import { ScoreBadge } from '@house-hunt/ui';
import { ratingOf } from '@house-hunt/ui';
import { RightmoveLink } from '@/components/RightmoveLink';
import { Tick, useRangePick, type Selection } from '@/components/Tick';
import { Pager, usePaging } from '@/components/Pager';
import { useCachedTravel } from '@/lib/queries';
import { isSurprise } from '@/lib/score';

/** One row per place, one column per thing you'd compare it on.
 *
 *  The cards are how you look at a place; this is how you look at all of them at once. Deciding
 *  between four flats means asking "which is cheapest per square foot" and "which is furthest
 *  from work" — questions a stack of cards can't answer, because the numbers are never adjacent
 *  and never in the same order twice.
 *
 *  Every column sorts, and nothing is scored or blended. A single weighted number was rejected
 *  twice over in one of our own analyses, and rightly so: what matters this week isn't
 *  what mattered last week, and a "match score" hides which trade you're actually making. */

type Sort = { key: string; descending: boolean };

/** How the table was left, per table — compare and triage keep their own. Sorting by rent, opening
 *  a flat and coming back to a table sorted by price again is the table undoing the question you
 *  asked it. Module-level rather than lifted into the page, for the same reason as the map's
 *  viewport: nothing above has an opinion about it, and it is deliberately not persisted — a fresh
 *  visit starts at the caller's `defaultSort`.
 *
 *  Which piles are shown rides along: it is the same gesture ("show me the rejected ones too")
 *  thrown away by the same trip. */
const kept = new Map<string, { sort: Sort | null; showing: Record<Group, boolean> }>();

export function Compare({
  entries,
  places,
  onOpen,
  selection,
  filters = true,
  columnsKey = 'compare',
  defaultSort = { key: 'price', descending: false },
  scores = null,
  prefs,
  expand,
}: {
  entries: ShortlistEntry[];
  places: Place[];
  /** Go to this app's own view of a flat — the shortlist card, which carries the photos, the
   *  travel times and the verdict buttons. Both the address and the row it sits in do this, unless
   *  `expand` is set, in which case they open the card underneath the row instead. */
  onOpen: (rightmoveId: string) => void;
  /** Which stored set of column choices this table uses. Compare and triage answer different
   *  questions — one is "which of these do we like best", the other is "is this worth a second
   *  look" — so they get their own, rather than one changing the other under you. */
  columnsKey?: string;
  /** Triage borrows this table and adds a tick column. A pile of tick boxes down the left of a
   *  stack of cards is a shape that argues with itself — you tick things you are comparing, and
   *  comparing is what the table is for. Ticking is the box and nothing else; the row itself opens
   *  the flat, here as everywhere. */
  selection?: Selection;
  /** Triage is already one pile, so the include-unrated switches would only ever empty it. */
  filters?: boolean;
  /** What the table sorts by before anyone clicks a header. `null` means "leave the rows as they
   *  came" — the caller has already put them in a meaningful order and would lose it. Triage does
   *  exactly that: it hands the rows over ranked by the verdict score. */
  defaultSort?: Sort | null;
  /** The verdict score per flat, P(yes) under the current model — only ever passed by triage. The
   *  score is deliberately absent from the compare table (see the header note, and `Score.tsx`):
   *  compare is for seeing which trade you are making, and a blended number hides that. Triage is
   *  the opposite question — "is this worth a second look" — where one predicted number is exactly
   *  the aid you want, and the sort control already ranks the pile by it. Showing it as a column
   *  there, and nowhere else, is why this is gated rather than a plain column. */
  scores?: Map<string, number> | null;
  /** This hunt's preferences, so the "Against it" column reflects a must-have absence and the
   *  great-room bar. Absent everywhere the preferences do not reach — the default flag behaviour. */
  prefs?: HuntPreferences;
  /** Triage opens a row's full card in place rather than jumping to the list. When set, clicking the
   *  row (or its address) toggles the inline card instead of navigating, and the expanded row renders
   *  that card beneath its own — the whole of what the flat is, without leaving the pile you are
   *  working. `onOpen` is still what a click does everywhere this is absent. */
  expand?: {
    isOpen: (rightmoveId: string) => boolean;
    toggle: (rightmoveId: string) => void;
    render: (entry: ShortlistEntry) => React.ReactNode;
  };
}) {
  const [showing, setShowing] = useState<Record<Group, boolean>>(
    () => kept.get(columnsKey)?.showing ?? DEFAULT_SHOWING,
  );
  const [sort, setSort] = useState<Sort | null>(() =>
    kept.has(columnsKey) ? kept.get(columnsKey)!.sort : defaultSort,
  );
  const [chosen, setChosen] = useColumnChoice(columnsKey);
  const [picking, setPicking] = useState(false);

  useEffect(() => {
    kept.set(columnsKey, { sort, showing });
  }, [columnsKey, sort, showing]);

  // The table is wider than the page whenever there is more than a place or two saved, and a
  // plain `overflow-x: auto` gives no sign of it: the audit found 191px — the whole "Listed"
  // column — sitting off the right edge looking like nothing at all. `more` drives a fade at that
  // edge, and it is measured rather than assumed, so a table that happens to fit shows no fade
  // claiming otherwise.
  const scroll = useRef<HTMLDivElement>(null);
  const [more, setMore] = useState(false);
  const measure = useCallback(() => {
    const box = scroll.current;
    if (!box) return;
    setMore(box.scrollLeft + box.clientWidth < box.scrollWidth - 1);
    // How much of the table is actually on screen. A card opened under a row is sized from this
    // rather than from the row it belongs to — a row is as wide as the table, which on a phone is
    // several screens, and a card that width is one nobody can read without scrolling it sideways.
    // Measured rather than assumed from the viewport: the box is inset by the page's own margins,
    // and on a desktop the difference is a hundred pixels of card hanging past the table's edge.
    box.style.setProperty('--compare-view', `${box.clientWidth}px`);
  }, []);
  useEffect(() => {
    measure();
    const box = scroll.current;
    if (!box) return;
    // Sorting and the pile toggles both change the row set, and adding a place changes the
    // column count, so remeasuring only on scroll would leave the fade stale.
    const watch = new ResizeObserver(measure);
    watch.observe(box);
    return () => watch.disconnect();
  }, [measure]);

  // The column picker is a popover, and a popover that only closes by pressing the button that
  // opened it is a trap — it sits over the first rows of the table it configures, which is exactly
  // what you want to look at while changing them.
  const picker = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!picking) return;
    const onDown = (event: MouseEvent) => {
      if (!picker.current?.contains(event.target as Node)) setPicking(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setPicking(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [picking]);

  // Only the places one of you has said something about, unless you ask for more. The table is
  // for weighing up flats against each other, and a row nobody has an opinion on is not yet in
  // that argument — see `DEFAULT_SHOWING`.
  const shown = useMemo(
    () => (filters ? entries.filter((e) => showing[groupOf(e.verdicts)]) : entries),
    [entries, showing, filters],
  );

  // Travel comes from the cache alone — see `travel:cached`. A property nobody has opened since
  // a place was added simply has no number, and the table says so rather than making one up.
  const travel = useCachedTravel(shown.map((e) => e.postcode));

  // Two rows for one flat is the table's worst failure mode: it reads as two options at the same
  // rent rather than one listed twice, and the two rows disagree about everything the model read
  // off the photos, because they carry different photos.
  const twins = useMemo(() => duplicateIds(entries), [entries]);
  // The score is a triage-only column (see the `scores` prop). Anywhere but triage it stays out of
  // the table on purpose, so `buildColumns` is handed the map only there.
  const scoreColumn = columnsKey === 'triage' ? scores : null;
  // Where the address goes: to the list card (`onOpen`) normally, or — in triage — to the card
  // that opens inline beneath the row, so working the pile never leaves it.
  const openRow = expand ? expand.toggle : onOpen;
  const inline = Boolean(expand);
  // Travel columns only for places we can actually route to. A place folded in from the old
  // neighbourhood list has no postcode, so its four columns would be blank down every row for as
  // long as the table exists — four widths spent saying nothing, and indistinguishable from a
  // journey nobody has looked up yet.
  const destinations = useMemo(() => travelDestinations(places), [places]);
  const all = useMemo(
    () => buildColumns(destinations, twins, openRow, scoreColumn, prefs, inline),
    [destinations, twins, openRow, scoreColumn, prefs, inline],
  );
  // The first column is the address and never hides — a row you cannot identify is not a row.
  // Before the picker has ever been touched, `chosen` is null and the defaults decide. After, the
  // stored set is the whole answer, so a place added later does not silently appear in a table
  // somebody had arranged.
  const columns = useMemo(
    () => all.filter((c, i) => i === 0 || (chosen ? chosen.has(c.key) : !c.offByDefault)),
    [all, chosen],
  );
  const on = (key: string) => columns.some((c) => c.key === key);
  const flip = (key: string) => {
    // Built from what is currently shown rather than from the stored set, so the first flip after
    // a Reset starts from the defaults instead of from an empty table.
    const next = new Set(columns.slice(1).map((c) => c.key));
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setChosen(next);
  };
  const sorted = useMemo(() => {
    // No sort at all means the caller's order is already the answer — see `defaultSort`.
    if (!sort) return shown;
    const column = columns.find((c) => c.key === sort.key);
    if (!column) return shown;
    return [...shown].sort((a, b) => {
      const av = column.value(a, travel.data);
      const bv = column.value(b, travel.data);
      // Missing always sinks, whichever way the column is pointing — a blank is not "cheapest".
      if (av === null && bv === null) return 0;
      if (av === null) return 1;
      if (bv === null) return -1;
      const order = typeof av === 'string' ? av.localeCompare(bv as string) : (av as number) - (bv as number);
      return sort.descending ? -order : order;
    });
  }, [shown, columns, sort, travel.data]);

  // A page of rows, after the sort — the order is the whole answer here, so paging can only ever be
  // the last thing applied. Sorting a page rather than paging a sort would put the cheapest flat of
  // twenty-five at the top of a shortlist of two hundred and call it the cheapest.
  const paging = usePaging(sorted);

  const counts = useMemo(() => {
    const tally: Record<Group, number> = { excited: 0, maybe: 0, rejected: 0, unrated: 0 };
    for (const entry of entries) tally[groupOf(entry.verdicts)] += 1;
    return tally;
  }, [entries]);

  // One picker for the row and for the box in it, over the order actually on screen, so the two
  // cannot disagree about what a shift-click means.
  const pick = useRangePick(
    useMemo(() => paging.shown.map((e) => e.rightmoveId), [paging.shown]),
    selection,
  );

  if (entries.length === 0) return <p className="dim">Nothing to compare yet.</p>;

  return (
    <>
      {filters && (
      <div className="legend">
        {/* Only the two piles that start hidden get a switch. "Include excited" would be a button
            whose only use is to empty the table of the flats it exists to compare. */}
        {(['unrated', 'rejected'] as const).map((group) => (
          <button
            key={group}
            className={showing[group] ? 'key key-on' : 'key'}
            aria-pressed={showing[group]}
            onClick={() => setShowing((s) => ({ ...s, [group]: !s[group] }))}
          >
            Include {GROUP_LABEL[group].toLowerCase()} <span className="dim">{counts[group]}</span>
          </button>
        ))}
        <span className="dim compare-note">
          Travel times are the ones already worked out. Open a place to fill in the gaps.
        </span>
      </div>
      )}

      <div className="columns-pick" ref={picker}>
        <button className="key" aria-expanded={picking} onClick={() => setPicking(!picking)}>
          Columns <span className="dim">{columns.length} of {all.length}</span>
        </button>
        {picking && (
          <div className="columns-list">
            <div className="columns-general">
              {all.slice(1).filter((c) => !c.place).map((column) => (
                <label key={column.key}>
                  <input type="checkbox" checked={on(column.key)} onChange={() => flip(column.key)} />
                  {column.label}
                </label>
              ))}
            </div>

            {/* One line per place, its modes together. A place is the thing you think in — "how
                far is Work" — and the mode is a detail within it, so the grouping matches the
                question rather than the order the columns happen to be built in. */}
            {destinations.map((place) => (
              <div className="columns-place" key={place.id}>
                <span className="columns-place-name">{place.label}</span>
                {all
                  .filter((c) => c.place?.label === place.label)
                  .map((column) => (
                    <label key={column.key}>
                      <input type="checkbox" checked={on(column.key)} onChange={() => flip(column.key)} />
                      {/* The icon is the label on screen and says nothing out loud, so the mode's
                          name goes with it — "🚲" is not a choice anybody can act on. */}
                      <span aria-hidden="true">
                        {column.place!.mode ? MODE_ICON[column.place!.mode] : 'fastest'}
                      </span>
                      <span className="visually-hidden">
                        {place.label} {column.place!.mode ?? 'fastest'}
                      </span>
                    </label>
                  ))}
              </div>
            ))}

            <button className="key columns-reset" onClick={() => setChosen(null)} disabled={chosen === null}>
              Reset
            </button>
          </div>
        )}
      </div>

      <div className="compare-scroll" ref={scroll} onScroll={measure} data-more={more ? 'yes' : 'no'}>
        <table className="compare">
          <thead>
            <tr>
              {selection && <th className="tick-col" />}
              {columns.map((column) => (
                <th
                  key={column.key}
                  scope="col"
                  className={column.numeric ? 'num' : undefined}
                  aria-sort={
                    sort?.key === column.key ? (sort.descending ? 'descending' : 'ascending') : 'none'
                  }
                >
                  <button
                    onClick={() =>
                      setSort((s) =>
                        s?.key === column.key
                          ? { key: column.key, descending: !s.descending }
                          : // Numbers you'd rather have more of start high; everything else starts low.
                            { key: column.key, descending: column.bigIsBetter ?? false },
                      )
                    }
                  >
                    {column.label}
                    <span className="sort-mark">
                      {sort?.key === column.key ? (sort.descending ? '▾' : '▴') : ''}
                    </span>
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {paging.shown.map((entry) => (
              <Fragment key={entry.rightmoveId}>
              <tr
                className={`compare-${groupOf(entry.verdicts)}${
                  selection?.chosen.has(entry.rightmoveId) ? ' compare-ticked' : ''
                }${expand?.isOpen(entry.rightmoveId) ? ' compare-expanded' : ''}`}
                // A click on a row opens the flat, and never ticks it. Ticking used to be what a row
                // click did in triage, which made reading a row and choosing it the same gesture:
                // clicking an address to see the photos added it to a batch that three buttons at
                // the top would then rate for everybody in the hunt. Selecting is the box, and only
                // the box — a deliberate target you have to aim at.
                onClick={() => openRow(entry.rightmoveId)}
              >
                {selection && (
                  // The cell as well as the box, because the cell is bigger than the box and a
                  // click that lands beside a checkbox must not open the card instead.
                  <td className="tick-col" onClick={(event) => event.stopPropagation()}>
                    <Tick
                      checked={selection.chosen.has(entry.rightmoveId)}
                      label={entry.displayAddress}
                      onPick={(shiftKey) => pick(entry.rightmoveId, shiftKey)}
                    />
                  </td>
                )}
                {columns.map((column) => (
                  <td key={column.key} className={column.numeric ? 'num' : undefined}>
                    {column.render(entry, travel.data)}
                  </td>
                ))}
              </tr>
              {expand?.isOpen(entry.rightmoveId) && (
                <tr className="compare-expanded-row">
                  {/* One cell across the whole row, holding the flat's own card — the same
                      renderer the list uses, so the two never disagree about what a place is.
                      The card is pinned to the left of the scroll box and sized to what is
                      actually visible (`--compare-view`), so a table twelve columns wide does not
                      make its own cards twelve columns wide: on a phone the row scrolls sideways
                      and the card, which is a column of prose and photographs, does not. */}
                  <td colSpan={columns.length + (selection ? 1 : 0)}>
                    <div className="compare-card">{expand.render(entry)}</div>
                  </td>
                </tr>
              )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>

      {/* Outside the scroll box: a pager that scrolled sideways with the table would be off the
          screen exactly when the table is wide enough to need one. */}
      <Pager {...paging} />
    </>
  );
}

interface Column {
  key: string;
  label: string;
  numeric?: boolean;
  /** Sorting a column of "more is better" the useful way round on first click. */
  bigIsBetter?: boolean;
  /** Offered in the picker, absent until asked for. Everything place-by-mode is this: three modes
   *  across three saved places is nine columns, and a table that arrives that wide is unreadable
   *  before you have chosen anything. */
  offByDefault?: boolean;
  /** Set on the travel columns, so the picker can group them. Flat, the twelve of them ran across
   *  the general columns in reading order and "Work 🚲" ended up on a different line from "Work
   *  🚇" — you had to hunt the grid for the place you were thinking about. */
  place?: { label: string; mode: TravelMode | null };
  value: (e: ShortlistEntry, travel: Record<string, TravelTime[]> | undefined) => number | string | null;
  render: (e: ShortlistEntry, travel: Record<string, TravelTime[]> | undefined) => React.ReactNode;
}

// The same emoji the rating buttons carry, read from the same table — this column used to keep its
// own copy, so relabelling a rating changed it in the panel and left the table saying the old thing.
const VERDICT_MARK: Record<Group, string> = {
  excited: ratingOf('love').emoji,
  maybe: ratingOf('maybe').emoji,
  rejected: ratingOf('no').emoji,
  unrated: '',
};

/** Which columns this table carries, remembered per table and surviving a refresh.
 *
 *  Null means "nobody has chosen", which is a different state from "everything off" and has to
 *  stay distinguishable: the defaults have to keep applying until someone actually picks, and
 *  Reset has to be able to get back there.
 *
 *  `localStorage` rather than `chrome.storage`, deliberately. This is a preference about how one
 *  person's screen is arranged, not shared state, and syncing it would mean one of them
 *  rearranging the other's table mid-scroll. Everything genuinely shared lives in Postgres. */
function useColumnChoice(key: string): [Set<string> | null, (next: Set<string> | null) => void] {
  const name = `columns:${key}`;
  const [chosen, setChosen] = useState<Set<string> | null>(() => {
    try {
      const saved = localStorage.getItem(name);
      return saved === null ? null : new Set(JSON.parse(saved) as string[]);
    } catch {
      // A corrupt preference is not worth an error boundary; fall back to the defaults.
      return null;
    }
  });
  return [
    chosen,
    (next) => {
      setChosen(next);
      try {
        if (next === null) localStorage.removeItem(name);
        else localStorage.setItem(name, JSON.stringify([...next]));
      } catch {
        // Private browsing, a full quota. The table still works; it just forgets.
      }
    },
  ];
}

function buildColumns(
  places: Place[],
  twins: Map<string, string[]>,
  onOpen: (rightmoveId: string) => void,
  scores: Map<string, number> | null = null,
  prefs?: HuntPreferences,
  /** True where the card opens underneath the row rather than in another view. The row then carries
   *  the address and nothing else: the way out to Rightmove is at the foot of the card, one line
   *  below, and a link to somewhere else sitting in a row whose job is to open the thing beside it
   *  is the one click on the row that leaves. */
  inline = false,
): Column[] {
  const columns: Column[] = [
    {
      key: 'address',
      label: 'Place',
      value: (e) => e.displayAddress,
      render: (e) => (
        <span className="compare-address">
          <span className="compare-mark">{VERDICT_MARK[groupOf(e.verdicts)]}</span>
          <span className="compare-address-lines">
            {/* A real href rather than a bare button, so the address can be copied, opened in a
                second tab and sent to the other laptop — `#card-<id>` is the deep link the
                shortlist already honours on load. The click is handled here instead of letting the
                browser jump, because the pile you are looking at is a different view from the one
                the card lives in, and the card is not on the page yet to jump to. */}
            <a
              className="compare-open"
              href={`#card-${e.rightmoveId}`}
              onClick={(ev) => {
                ev.stopPropagation();
                // A cmd-click means "open it in a tab", and swallowing it made a liar of the href
                // above: the link existed to be openable in a second tab and was the one thing on
                // the page that could not be. Only a plain click is ours to handle.
                if (ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey || ev.button !== 0) return;
                ev.preventDefault();
                onOpen(e.rightmoveId);
              }}
            >
              {e.displayAddress}
            </a>
            {!inline && <RightmoveLink url={e.url} />}
          </span>
          {(twins.get(e.rightmoveId)?.length ?? 0) > 0 && (
            <span className="twin" title="Listed twice — same postcode and rent">
              ⧉
            </span>
          )}
        </span>
      ),
    },
    // How far each place has got, sorted in funnel order rather than alphabetically — which is what
    // makes "everything past a viewing, in order" one click on a header. A flat outside the funnel
    // sorts last whichever way the column points, the same as any other blank.
    {
      key: 'stage',
      label: 'Stage',
      value: (e) => (e.stage ? stageRank(e.stage.stage) : null),
      render: (e) => (e.stage ? stageSentence(e.stage) : dash('Nobody has liked this one yet.')),
    },
    {
      key: 'price',
      label: 'Rent',
      numeric: true,
      value: (e) => parseMonthlyPrice(e.price),
      render: (e) => e.price ?? dash(),
    },
    {
      key: 'sqft',
      label: 'Size',
      numeric: true,
      bigIsBetter: true,
      value: (e) => resolveSize(sizeOf(e))?.value ?? null,
      render: (e) => {
        const size = resolveSize(sizeOf(e));
        return size === null ? dash() : <SizeValue size={size} />;
      },
    },
    {
      // The number that actually decides between two flats at the same rent, and the one nobody
      // can do in their head across seventeen listings.
      key: 'ppsf',
      label: '£/sq ft',
      numeric: true,
      value: (e) => {
        const rent = parseMonthlyPrice(e.price);
        const area = resolveSize(sizeOf(e))?.value ?? null;
        return rent === null || area === null || area === 0 ? null : rent / area;
      },
      render: (e) => {
        const rent = parseMonthlyPrice(e.price);
        const area = resolveSize(sizeOf(e))?.value ?? null;
        if (rent === null || area === null || area === 0) return dash();
        return `£${(rent / area).toFixed(2)}`;
      },
    },
    {
      key: 'beds',
      label: 'Beds',
      numeric: true,
      bigIsBetter: true,
      value: (e) => e.bedrooms,
      render: (e) => e.bedrooms ?? dash(),
    },
    {
      key: 'baths',
      label: 'Baths',
      numeric: true,
      bigIsBetter: true,
      value: (e) => e.bathrooms,
      render: (e) => e.bathrooms ?? dash(),
    },
    {
      // Sorts on the word, which puts every Furnished together and every Unfurnished together.
      // That is the only ordering anyone wants from it — there is no "more furnished".
      key: 'furnish',
      label: 'Furnished',
      value: (e) => e.furnishType,
      render: (e) => e.furnishType ?? dash('Not stated on the listing.'),
    },
  ];

  // Right after the address, so it is the first thing you read across the row — this is the column
  // you work the pile by in triage. Present only when triage passed a score map; null everywhere
  // else keeps it out of the compare table entirely.
  if (scores) columns.splice(1, 0, scoreColumnDef(scores));

  // The analysis-derived features, each its own sortable column but every one off by default so the
  // table does not arrive nine columns wider — turn on the ones a hunt cares about from the Columns
  // picker. These are the neutral column form of the same fields `facts.ts` turns into flags; the
  // value comes straight off `entry.analysis`, so there is no second copy of what a fact is.
  columns.push(...featureColumns());

  // Per place: the fastest way there, and then each mode on its own.
  //
  // The fastest is what you want while scanning, and it is the only one on by default. The single
  // modes answer the question it cannot — "how far is this by bike, specifically" — which is what
  // decides it when the fastest is a fifty-minute transit journey and the bike is twenty. Three
  // modes across three places is nine columns nobody asked for, so they stay off until picked.
  for (const place of places) {
    columns.push(travelColumn(place, null));
    for (const mode of TRAVEL_MODES) columns.push(travelColumn(place, mode));
  }

  columns.push(
    {
      // Only what is against a place. A column reading "bathtub" down fourteen of seventeen rows
      // spends its width saying nothing; the question a table answers is which of these has a
      // problem. Red first, so the sort puts the ones to rule out at one end.
      key: 'flags',
      label: 'Against it',
      value: (e) => worstSeverity(problems(e, prefs)),
      bigIsBetter: true,
      render: (e) => {
        const flags = problems(e, prefs);
        if (flags.length === 0) return <span className="dim compare-clear">nothing</span>;
        // Rings without the scale here: the column repeats down every row, so the reader learns
        // the mark once and then only needs to compare how full the rings are.
        return (
          <span className="rm-flags">
            {flags.map((flag) => (
              <FlagChip flag={flag} key={flag.key} />
            ))}
          </span>
        );
      },
    },
    {
      key: 'seen',
      label: 'Listed',
      value: (e) => e.listingUpdate ?? null,
      render: (e) => (e.listingUpdate ? relativeUpdate(e.listingUpdate) : dash()),
    },
  );

  return columns;
}


/** The analysis features as neutral, sortable columns. All off by default (`offByDefault`), so they
 *  live in the Columns picker and never widen the table unasked. Each reads one field off
 *  `entry.analysis` — the same fields `flagsFor` reads — and sorts big-is-better (has it / more of it
 *  at the top). A listing with no analysis, or a field the model left null, gets a dash, never a
 *  false "no". */
function featureColumns(): Column[] {
  const has = (v: boolean | null | undefined): number | null => (v == null ? null : v ? 1 : 0);
  return [
    {
      key: 'dishwasher',
      label: 'Dishwasher',
      offByDefault: true,
      bigIsBetter: true,
      value: (e) => has(e.analysis?.hasDishwasher),
      render: (e) => yesNo(e.analysis?.hasDishwasher),
    },
    {
      key: 'bathtub',
      label: 'Bathtub',
      offByDefault: true,
      bigIsBetter: true,
      value: (e) => has(e.analysis?.hasBathtub),
      render: (e) => yesNo(e.analysis?.hasBathtub),
    },
    {
      // Ranked in-unit > in-building > none, which is the order you would rather have it.
      key: 'laundry',
      label: 'Laundry',
      offByDefault: true,
      bigIsBetter: true,
      value: (e) => LAUNDRY_RANK[e.analysis?.laundry ?? 'unknown'] ?? null,
      render: (e) => e.analysis?.laundry ?? dash(),
    },
    {
      key: 'outdoor',
      label: 'Outdoor',
      offByDefault: true,
      bigIsBetter: true,
      value: (e) => {
        const a = e.analysis;
        if (!a || a.hasOutdoorSpace == null) return null;
        if (a.hasOutdoorSpace === false) return 0;
        // A measured area sorts above a bare "yes"; a "yes" with no number still beats "no".
        return a.outdoorSqft ?? 1;
      },
      render: (e) => {
        const a = e.analysis;
        if (!a || a.hasOutdoorSpace == null) return dash();
        if (a.hasOutdoorSpace === false) return <span className="dim">none</span>;
        return [a.outdoorKind ?? 'yes', a.outdoorSqft != null ? `${a.outdoorSqft} sq ft` : null]
          .filter(Boolean)
          .join(' · ');
      },
    },
    {
      key: 'light',
      label: 'Light',
      offByDefault: true,
      bigIsBetter: true,
      value: (e) => LIGHT_RANK[e.analysis?.naturalLight ?? 'unknown'] ?? null,
      render: (e) => e.analysis?.naturalLight ?? dash(),
    },
    {
      // The single largest habitable room — the "great room" a hunt can set a bar for in settings.
      key: 'biggest-room',
      label: 'Biggest room',
      numeric: true,
      offByDefault: true,
      bigIsBetter: true,
      value: (e) => e.analysis?.biggestRoomSqft ?? null,
      render: (e) => {
        const sqft = e.analysis?.biggestRoomSqft;
        return sqft == null ? dash() : `${sqft} sq ft`;
      },
    },
  ];
}

const LAUNDRY_RANK: Record<string, number> = { 'in-unit': 2, 'in-building': 1, none: 0 };
const LIGHT_RANK: Record<string, number> = { high: 3, medium: 2, low: 1 };

/** A neutral present/absent cell for a boolean fact: a tick for yes, a muted "no" for no, a dash for
 *  unknown — the last never reads as a "no". */
function yesNo(value: boolean | null | undefined): React.ReactNode {
  if (value == null) return dash();
  return value ? <span className="compare-clear">✓</span> : <span className="dim">no</span>;
}

/** The verdict score as a table column — P(yes) under the current model, drawn with the same badge
 *  the cards use so the two surfaces read as one number. Sorts big-first (most likely yes at the
 *  top) and surfaces the model/rating disagreements with the ⚡ mark, exactly as `isSurprise`
 *  defines them. A flat with no score yet (no model, or unscorable) gets a dash, never a zero —
 *  the same rule the other columns follow. */
function scoreColumnDef(scores: Map<string, number>): Column {
  return {
    key: 'score',
    label: 'Score',
    numeric: true,
    bigIsBetter: true,
    value: (e) => scores.get(e.rightmoveId) ?? null,
    render: (e) => {
      const s = scores.get(e.rightmoveId);
      if (s === undefined) return dash('No score for this flat yet — rerun ratings.');
      return <ScoreBadge score={s} surprise={isSurprise(e, s)} />;
    },
  };
}

/** The quickest way to a place, by the same rules every other view uses. Which mode it is matters
 *  less in a table than how long it takes — you want to know whether this flat is far. */
/** One place, either at its best or by one named mode. `mode` null means "however is fastest".
 *
 *  Written once rather than twice: the two differ only in which row they pick and what the header
 *  says, and everything underneath — the three distinct kinds of absence, the stale-basis note,
 *  the route hover — is the part that took the longest to get right. */
function travelColumn(place: Place, mode: TravelMode | null): Column {
  return {
    key: mode ? `place:${place.id}:${mode}` : `place:${place.id}`,
    label: mode ? `${place.label} ${MODE_ICON[mode]}` : place.label,
    numeric: true,
    offByDefault: mode !== null,
    place: { label: place.label, mode },
    value: (e, travel) => pick(e, place.id, mode, travel).winner?.seconds ?? null,
    render: (e, travel) => {
      const { verdict, winner } = pick(e, place.id, mode, travel);
      if (!winner) {
        // Three different absences, and calling them all "not worked out" would be a lie in two
        // of the three cases.
        if (mode && verdict.usable.length > 0) return dash(`No ${mode} time — open this place to fetch it.`);
        if (verdict.noRoute) return dash('No journey between these two points.');
        if (verdict.transient) return dash('TfL did not answer — open this place to retry.');
        return dash('Not worked out yet — open this place to fetch it.');
      }
      const routes = winner.mode === 'transit' ? winner.options : undefined;
      // A number measured on a basis we no longer use is still worth showing — it is roughly
      // right — and it must not be ranked silently against current ones. The table cannot refetch
      // it (that would be a journey-planner request per gap, on open), so it says so instead.
      const detail =
        routes && routes.length > 0 ? (
          <Routes options={routes} />
        ) : (
          `${formatDuration(winner.seconds)} by ${winner.mode}.`
        );
      return (
        <Hint
          underline={false}
          text={
            winner.stale ? (
              <>
                {detail}
                <div className="compare-stale-note">Measured at an unknown time of day. Open it to refresh.</div>
              </>
            ) : (
              detail
            )
          }
        >
          <span className={winner.stale ? 'stale-time' : undefined}>
            {/* The header already carries the icon on a single-mode column, so repeating it down
                every row would be the same glyph seventeen times. */}
            {mode ? '' : `${MODE_ICON[winner.mode]} `}
            {formatDuration(winner.seconds)}
          </span>
        </Hint>
      );
    },
  };
}

function pick(
  entry: ShortlistEntry,
  placeId: string,
  mode: TravelMode | null,
  travel: Record<string, TravelTime[]> | undefined,
) {
  const verdict = forPlace(entry, placeId, travel);
  const winner = mode ? (verdict.usable.find((t) => t.mode === mode) ?? null) : verdict.best;
  return { verdict, winner };
}

function forPlace(entry: ShortlistEntry, placeId: string, travel: Record<string, TravelTime[]> | undefined) {
  const rows = (entry.postcode && travel?.[entry.postcode]) || [];
  return readTravel(rows.filter((t) => t.placeId === placeId));
}

/* The price column reads a listing through the model's own parser (`parseMonthlyPrice`): weekly
   rents are normalised so "£980 pw" doesn't sort as cheaper than everything on the page, and there
   is no second copy of that logic here to drift from the price feature the score is fitted on. */

/** Only the problems, from the one definition in facts.ts. */
function problems(entry: ShortlistEntry, prefs?: HuntPreferences): Flag[] {
  return problemsOnly(
    flagsFor({ analysis: entry.analysis, floorplanUrl: entry.floorplanUrl, size: sizeOf(entry) }, prefs),
  );
}

/** A blank cell should say "we don't know", not look like a zero. */
function dash(why = 'Not known for this listing.') {
  return (
    <Hint text={why}>
      <span className="dim">—</span>
    </Hint>
  );
}
