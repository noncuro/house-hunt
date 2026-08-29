'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  FlagChip,
  Hint,
  Icon,
  ModeIcon,
  Routes,
  SizeValue,
  StageSelect,
  formatDuration,
  readTravel,
} from '@house-hunt/ui';
import {
  dedupeStations,
  flagsFor,
  nearestStationMiles,
  problemsOnly,
  relativeUpdate,
  resolveSize,
  stationDistance,
  worstSeverity,
  type Flag,
  type HuntPreferences,
  type Stage,
} from '@house-hunt/core';
import {
  duplicateIds,
  groupOf,
  parseMonthlyPrice,
  sizeOf,
  stageRank,
} from '@house-hunt/core';
import type { ShortlistEntry } from '@house-hunt/core/db';
import {
  TRAVEL_MODES,
  travelDestinations,
  type Place,
  type TravelMode,
  type TravelTime,
} from '@house-hunt/core';
import { RightmoveLink } from '@/components/RightmoveLink';
import { Tick, useRangePick, type Selection } from '@/components/Tick';
import { Pager, usePaging } from '@/components/Pager';
import type { SetStage } from '@/lib/actions';
import { useCachedTravel } from '@/lib/queries';

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

/** How the table was left. Sorting by rent, opening a flat and coming back to a table sorted by
 *  price again is the table undoing the question you asked it. Module-level rather than lifted into
 *  the page, for the same reason as the map's viewport: nothing above has an opinion about it, and
 *  it is deliberately not persisted — a fresh visit starts at `DEFAULT_SORT`. */
let keptSort: { at: Sort | null } | null = null;

const DEFAULT_SORT: Sort = { key: 'price', descending: false };

export function Compare({
  entries,
  places,
  onOpen,
  onSetStage,
  stageSaving,
  picked,
  setPicked,
  onHeadToHead,
  prefs,
}: {
  entries: ShortlistEntry[];
  places: Place[];
  /** Go to this app's own view of a flat — the panel with the photos, the travel times and the
   *  verdict buttons. Both the address and the row it sits in do this. */
  onOpen: (rightmoveId: string) => void;
  /** Moving a flat along, in the row rather than by opening it. The table is where you see all six
   *  of them at once, which is where "these two are still just shortlisted" is noticed. */
  onSetStage: SetStage;
  /** The stage a click is currently writing, and for which flat — see Places. */
  stageSaving: { rightmoveId: string; stage: Stage } | null;
  /** The finalists, for the head-to-head. Ticking is the box and nothing else; the row itself opens
   *  the flat, here as everywhere — a click on an address used to add it to a batch that three
   *  buttons at the top would then rate for everybody in the hunt. */
  picked: string[];
  setPicked: (next: string[]) => void;
  onHeadToHead: () => void;
  /** This hunt's preferences, so the "Against it" column reflects a must-have absence and the
   *  great-room bar. */
  prefs: HuntPreferences;
}) {
  const [sort, setSort] = useState<Sort | null>(() => (keptSort ? keptSort.at : DEFAULT_SORT));
  const [chosen, setChosen] = useColumnChoice('compare');
  const [picking, setPicking] = useState(false);

  useEffect(() => {
    keptSort = { at: sort };
  }, [sort]);

  // The ticked set lives above this screen (going to the map and back must not throw the four
  // finalists you had just assembled), so the `Selection` the tick boxes want is assembled here
  // rather than held here.
  const selection: Selection = useMemo(
    () => ({
      chosen: new Set(picked),
      toggle: (id) => setPicked(picked.includes(id) ? picked.filter((p) => p !== id) : [...picked, id]),
      setMany: (ids, on) => {
        const next = new Set(picked);
        for (const id of ids) {
          if (on) next.add(id);
          else next.delete(id);
        }
        setPicked([...next]);
      },
    }),
    [picked, setPicked],
  );

  // How many of the picks the current lens is not drawing. `entries` is what this table was handed,
  // which is already the lens's answer, so this is the whole of the difference between the number in
  // the bar and the number of boxes with ticks in them.
  const hiddenPicks = useMemo(() => {
    if (picked.length === 0) return 0;
    const shown = new Set(entries.map((e) => e.rightmoveId));
    return picked.filter((id) => !shown.has(id)).length;
  }, [picked, entries]);

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

  // Every row the lens left. The table used to keep its own pair of include-unrated switches, which
  // meant the toolbar above it said one number and the table drew a different set — two filters over
  // the same list, one of them invisible from the other three renderings. The chips are the filter
  // now, everywhere.
  const shown = entries;

  // Travel comes from the cache alone — see `travel:cached`. A property nobody has opened since
  // a place was added simply has no number, and the table says so rather than making one up.
  const travel = useCachedTravel(shown.map((e) => e.postcode));

  // Two rows for one flat is the table's worst failure mode: it reads as two options at the same
  // rent rather than one listed twice, and the two rows disagree about everything the model read
  // off the photos, because they carry different photos.
  const twins = useMemo(() => duplicateIds(entries), [entries]);
  // Travel columns only for places we can actually route to. A place folded in from the old
  // neighbourhood list has no postcode, so its four columns would be blank down every row for as
  // long as the table exists — four widths spent saying nothing, and indistinguishable from a
  // journey nobody has looked up yet.
  const destinations = useMemo(() => travelDestinations(places), [places]);
  const all = useMemo(
    () => buildColumns(destinations, twins, onOpen, onSetStage, stageSaving, prefs),
    [destinations, twins, onOpen, onSetStage, stageSaving, prefs],
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
    // No sort at all means the order the rows arrived in is already the answer.
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

  // One picker for the row and for the box in it, over the order actually on screen, so the two
  // cannot disagree about what a shift-click means.
  const pick = useRangePick(
    useMemo(() => paging.shown.map((e) => e.rightmoveId), [paging.shown]),
    selection,
  );

  if (entries.length === 0) return <p className="dim">Nothing to compare yet.</p>;

  return (
    <>
      <div className="table-bar">
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
                          name goes with it — a bicycle is not a choice anybody can act on. */}
                      <span aria-hidden="true">
                        {column.place!.mode ? <ModeIcon mode={column.place!.mode} /> : 'fastest'}
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

        {/* The reason the tick boxes are there, and it only appears once they have been used. Two is
            the fewest that can be set beside each other; past four the head-to-head is a table
            again, which is the thing you are standing in. */}
        {picked.length > 0 && (
          <p className="table-picked" data-testid="picked">
            <span>{picked.length} picked</span>
            {/* A pick is held above the lens on purpose — tick four, filter to the loved ones, and
                the head-to-head still gives you four, because a tick is an act and changing which
                slice is on screen is not undoing it. What was missing was the sentence: the bar
                said "3 picked" over two ticked boxes, and Clear was the only thing that made the
                two numbers agree. */}
            {hiddenPicks > 0 && (
              <span className="dim" data-testid="picked-hidden">
                · {hiddenPicks} not in this view
              </span>
            )}
            <button
              type="button"
              className="key"
              disabled={picked.length < 2 || picked.length > 4}
              title={
                picked.length < 2
                  ? 'Pick at least two'
                  : picked.length > 4
                    ? 'Four at most — more than that is this table'
                    : undefined
              }
              data-testid="head-to-head"
              onClick={() => onHeadToHead()}
            >
              Set them side by side
            </button>
            <button type="button" className="linkish" onClick={() => setPicked([])}>
              Clear
            </button>
          </p>
        )}

        <span className="dim table-note">
          Travel times are the ones already worked out. Open a place to fill in the gaps.
        </span>
      </div>

      <div className="compare-scroll" ref={scroll} onScroll={measure} data-more={more ? 'yes' : 'no'}>
        <table className="compare">
          <thead>
            <tr>
              <th className="tick-col" />
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
              <tr
                key={entry.rightmoveId}
                className={selection.chosen.has(entry.rightmoveId) ? 'compare-ticked' : undefined}
                // A click on a row opens the flat, and never ticks it. Ticking used to be what a row
                // click did in triage, which made reading a row and choosing it the same gesture:
                // clicking an address to see the photos added it to a batch that three buttons at
                // the top would then rate for everybody in the hunt. Selecting is the box, and only
                // the box — a deliberate target you have to aim at.
                onClick={() => onOpen(entry.rightmoveId)}
              >
                {/* The cell as well as the box, because the cell is bigger than the box and a
                    click that lands beside a checkbox must not open the flat instead. */}
                <td className="tick-col" onClick={(event) => event.stopPropagation()}>
                  <Tick
                    checked={selection.chosen.has(entry.rightmoveId)}
                    label={entry.displayAddress}
                    onPick={(shiftKey) => pick(entry.rightmoveId, shiftKey)}
                  />
                </td>
                {columns.map((column) => (
                  <td
                    key={column.key}
                    className={column.numeric ? 'num' : undefined}
                    // The stage cell holds a menu; a click in it must not also open the flat behind.
                    onClick={column.interactive ? (event) => event.stopPropagation() : undefined}
                  >
                    {column.render(entry, travel.data)}
                  </td>
                ))}
              </tr>
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
  /** A node, not a string: the single-mode travel columns carry the mode's icon beside the place's
   *  name, and the icon is a drawn one rather than an emoji that would sit in a string. */
  label: React.ReactNode;
  numeric?: boolean;
  /** Sorting a column of "more is better" the useful way round on first click. */
  bigIsBetter?: boolean;
  /** Offered in the picker, absent until asked for. Everything place-by-mode is this: three modes
   *  across three saved places is nine columns, and a table that arrives that wide is unreadable
   *  before you have chosen anything. */
  offByDefault?: boolean;
  /** Set on the travel columns, so the picker can group them. Flat, the twelve of them ran across
   *  the general columns in reading order and "Work, by bike" ended up on a different line from
   *  "Work, by tube" — you had to hunt the grid for the place you were thinking about. */
  place?: { label: string; mode: TravelMode | null };
  /** The cell holds a control of its own, so a click in it stops rather than opening the flat. */
  interactive?: boolean;
  value: (e: ShortlistEntry, travel: Record<string, TravelTime[]> | undefined) => number | string | null;
  render: (e: ShortlistEntry, travel: Record<string, TravelTime[]> | undefined) => React.ReactNode;
}

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
  onSetStage: SetStage,
  stageSaving: { rightmoveId: string; stage: Stage } | null,
  prefs: HuntPreferences,
): Column[] {
  const columns: Column[] = [
    {
      key: 'address',
      label: 'Place',
      value: (e) => e.displayAddress,
      render: (e) => (
        <span className="compare-address">
          {/* A dot rather than the rating's emoji. Down two hundred rows a column of faces is the
              loudest thing in the table and the least precise — the colour is the whole fact, and
              the word for it is one column along on the row you are actually reading. */}
          <span
            className={`verdict-dot verdict-dot-${groupOf(e.verdicts)}`}
            title={e.verdicts[0] ? `${e.verdicts[0].rating} — ${e.verdicts[0].person}` : 'Not rated'}
          />
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
            <RightmoveLink url={e.url} />
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
      interactive: true,
      value: (e) => (e.stage ? stageRank(e.stage.stage) : null),
      // Editable in the row. Seeing all six steps at once is what makes "these two have been
      // shortlisted for a fortnight" noticeable, and having noticed it, moving one along should not
      // mean opening the flat, moving it, coming back and finding the sort has re-run.
      render: (e) => (
        <StageSelect
          stage={e.stage}
          pending={stageSaving?.rightmoveId === e.rightmoveId ? stageSaving.stage : null}
          disabled={stageSaving?.rightmoveId === e.rightmoveId ? 'Saving…' : undefined}
          onSet={(stage, reason) => onSetStage(e, stage, reason)}
        />
      ),
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

  // The analysis-derived features, each its own sortable column but every one off by default so the
  // table does not arrive nine columns wider — turn on the ones a hunt cares about from the Columns
  // picker. These are the neutral column form of the same fields `facts.ts` turns into flags; the
  // value comes straight off `entry.analysis`, so there is no second copy of what a fact is.
  columns.push(...featureColumns());

  // The one location column every flat can fill in. A journey time has to be looked up per flat
  // and mostly has not been, where the station and its distance arrive with the listing — so this
  // is the column that is actually populated on the day a sweep lands, which is why it is on by
  // default and the per-place ones are not. Sorted on miles, drawn in the unit Rightmove sent.
  columns.push({
    key: 'station',
    label: 'Nearest station',
    numeric: true,
    value: (e) => nearestStationMiles(e.nearestStations),
    render: (e) => {
      // Deduped, or a flat by King's Cross names whichever of its four entrances Rightmove happened
      // to list first — see `dedupeStations`.
      const nearest = dedupeStations(e.nearestStations)[0];
      if (!nearest) return dash('The listing named no station.');
      return (
        <span className="compare-station">
          {nearest.name.replace(/\s+Station$/, '')}{' '}
          <span className="dim">{stationDistance(nearest.distance, nearest.unit)}</span>
        </span>
      );
    },
  });

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
      // Ranked the way you would rather have it, and "practically separate" sits above "same
      // space" rather than beside it — a mezzanine is the answer this column exists to tell apart
      // from a hob at the foot of the bed.
      key: 'sleeping',
      label: 'Bed vs kitchen',
      offByDefault: true,
      bigIsBetter: true,
      value: (e) => SLEEPING_RANK[e.analysis?.sleepingSeparation ?? 'unknown'] ?? null,
      render: (e) => SLEEPING_WORDING[e.analysis?.sleepingSeparation ?? 'unknown'] ?? dash(),
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
const SLEEPING_RANK: Record<string, number> = { 'separate-room': 2, 'practically-separate': 1, 'same-space': 0 };
const SLEEPING_WORDING: Record<string, string> = {
  'separate-room': 'separate room',
  'practically-separate': 'practically separate',
  'same-space': 'same space',
};

/** A neutral present/absent cell for a boolean fact: a tick for yes, a muted "no" for no, a dash for
 *  unknown — the last never reads as a "no". */
function yesNo(value: boolean | null | undefined): React.ReactNode {
  if (value == null) return dash();
  return value ? (
    <Icon name="tick" size={12} label="yes" className="compare-clear" />
  ) : (
    <span className="dim">no</span>
  );
}

/* No score column, deliberately. The compare table is for seeing which trade you are making between
   flats, and one blended number is exactly what hides that — the argument `Score.tsx` makes at
   length. Triage is the opposite question ("is this worth a second look at all"), and that is where
   the score ranks the pile and the gauge is drawn beside each candidate. */

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
    label: mode ? (
      <>
        {place.label} <ModeIcon mode={mode} size={12} label />
      </>
    ) : (
      place.label
    ),
    numeric: true,
    offByDefault: mode !== null,
    place: { label: place.label, mode },
    value: (e, travel) => pick(e, place.id, mode, travel).winner?.seconds ?? null,
    render: (e, travel) => {
      const { verdict, winner } = pick(e, place.id, mode, travel);
      if (!winner) {
        // Four different absences, and calling them all "not worked out" would be a lie in three
        // of the four cases.
        //
        // A named column asks about one mode, so it answers from that mode's own row before
        // anything else. Everything below it answers for the *place*, and a place with a usable
        // train time is not "no route" — which is how a cycling column whose leg had been settled
        // came to read "not worked out yet" over a question that was decided.
        //
        // A settled row is shown in its own words, because not every settled negative is TfL's:
        // "too far to walk" is a different fact from "TfL could not route it" to whoever is reading
        // the column.
        const row = mode ? verdict.byMode[mode] : undefined;
        if (row?.error) return dash(row.transient ? 'TfL did not answer — open this place to retry.' : row.error);
        if (mode && verdict.usable.length > 0) return dash(`No ${mode} time — open this place to fetch it.`);
        if (verdict.noRoute) return dash(verdict.noRoute);
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
            {mode === null && <ModeIcon mode={winner.mode} size={12} />}
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
    flagsFor(
      { analysis: entry.analysis, bedrooms: entry.bedrooms, floorplanUrl: entry.floorplanUrl, size: sizeOf(entry) },
      prefs,
    ),
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
