import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Hint } from '@/components/Hint';
import { formatDuration, MODE_ICON, readTravel, Routes } from '@/components/Journey';
import {
  flagsFor,
  problemsOnly,
  relativeUpdate,
  resolveSize,
  worstSeverity,
  type Flag,
} from '@/lib/facts';
import { DEFAULT_SHOWING, duplicateIds, GROUP_LABEL, groupOf, sizeOf, type Group } from '@/lib/shortlist';
import type { ShortlistEntry } from '@/lib/supabase';
import { TRAVEL_MODES, type Place, type TravelMode, type TravelTime } from '@/lib/types';
import { FlagChip } from '@/components/Flags';
import { SizeValue } from '@/components/Size';
import { useCachedTravel } from './queries';

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

const MONEY = /[^0-9.]/g;

export function Compare({
  entries,
  places,
  onOpen,
  selection,
  filters = true,
  columnsKey = 'compare',
}: {
  entries: ShortlistEntry[];
  places: Place[];
  onOpen: (rightmoveId: string) => void;
  /** Which stored set of column choices this table uses. Compare and triage answer different
   *  questions — one is "which of these do we like best", the other is "is this worth a second
   *  look" — so they get their own, rather than one changing the other under you. */
  columnsKey?: string;
  /** Triage borrows this table and adds a tick column. A pile of tick boxes down the left of a
   *  stack of cards is a shape that argues with itself — you tick things you are comparing, and
   *  comparing is what the table is for. Rows toggle rather than jumping to a card when it is on. */
  selection?: {
    chosen: Set<string>;
    toggle: (rightmoveId: string) => void;
    /** Set a whole run at once. Shift-click needs this: toggling one at a time would read the
     *  same stale selection for every id in the range and keep only the last. */
    setMany: (rightmoveIds: string[], on: boolean) => void;
  };
  /** Triage is already one pile, so the include-unrated switches would only ever empty it. */
  filters?: boolean;
}) {
  const [showing, setShowing] = useState<Record<Group, boolean>>(DEFAULT_SHOWING);
  const [sort, setSort] = useState<Sort>({ key: 'price', descending: false });
  const [chosen, setChosen] = useColumnChoice(columnsKey);
  const [picking, setPicking] = useState(false);

  // The table is wider than the page whenever there is more than a place or two saved, and a
  // plain `overflow-x: auto` gives no sign of it: the audit found 191px — the whole "Listed"
  // column — sitting off the right edge looking like nothing at all. `more` drives a fade at that
  // edge, and it is measured rather than assumed, so a table that happens to fit shows no fade
  // claiming otherwise.
  // Where the last tick landed, so shift-click has an anchor. Held as an id rather than a row
  // number, because sorting reorders the rows under it and a remembered index would then select
  // a range nobody pointed at.
  const anchor = useRef<string | null>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const [more, setMore] = useState(false);
  const measure = useCallback(() => {
    const box = scroll.current;
    if (box) setMore(box.scrollLeft + box.clientWidth < box.scrollWidth - 1);
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
  const all = useMemo(() => buildColumns(places, twins), [places, twins]);
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

  const counts = useMemo(() => {
    const tally: Record<Group, number> = { excited: 0, maybe: 0, rejected: 0, unrated: 0 };
    for (const entry of entries) tally[groupOf(entry.verdicts)] += 1;
    return tally;
  }, [entries]);

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

      <div className="columns-pick">
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
            {places.map((place) => (
              <div className="columns-place" key={place.id}>
                <span className="columns-place-name">{place.label}</span>
                {all
                  .filter((c) => c.place?.label === place.label)
                  .map((column) => (
                    <label key={column.key}>
                      <input type="checkbox" checked={on(column.key)} onChange={() => flip(column.key)} />
                      {column.place!.mode ? MODE_ICON[column.place!.mode] : 'fastest'}
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
                  className={column.numeric ? 'num' : undefined}
                  aria-sort={
                    sort.key === column.key ? (sort.descending ? 'descending' : 'ascending') : 'none'
                  }
                >
                  <button
                    onClick={() =>
                      setSort((s) =>
                        s.key === column.key
                          ? { key: column.key, descending: !s.descending }
                          : // Numbers you'd rather have more of start high; everything else starts low.
                            { key: column.key, descending: column.bigIsBetter ?? false },
                      )
                    }
                  >
                    {column.label}
                    <span className="sort-mark">
                      {sort.key === column.key ? (sort.descending ? '▾' : '▴') : ''}
                    </span>
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.map((entry) => (
              <tr
                key={entry.rightmoveId}
                className={`compare-${groupOf(entry.verdicts)}${
                  selection?.chosen.has(entry.rightmoveId) ? ' compare-ticked' : ''
                }`}
                onClick={(event) => {
                  if (!selection) {
                    onOpen(entry.rightmoveId);
                    return;
                  }
                  const from = anchor.current;
                  if (event.shiftKey && from && from !== entry.rightmoveId) {
                    const order = sorted.map((e) => e.rightmoveId);
                    const a = order.indexOf(from);
                    const b = order.indexOf(entry.rightmoveId);
                    if (a !== -1 && b !== -1) {
                      // The anchor's own state decides the run's, which is what makes a second
                      // shift-click undo the first rather than re-select what is already on.
                      const run = order.slice(Math.min(a, b), Math.max(a, b) + 1);
                      selection.setMany(run, selection.chosen.has(from));
                      return;
                    }
                  }
                  anchor.current = entry.rightmoveId;
                  selection.toggle(entry.rightmoveId);
                }}
              >
                {selection && (
                  <td className="tick-col">
                    <label className="tick" onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        checked={selection.chosen.has(entry.rightmoveId)}
                        onChange={() => selection.toggle(entry.rightmoveId)}
                      />
                      <span className="visually-hidden">Select {entry.displayAddress}</span>
                    </label>
                  </td>
                )}
                {columns.map((column) => (
                  <td key={column.key} className={column.numeric ? 'num' : undefined}>
                    {column.render(entry, travel.data)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
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

const VERDICT_MARK: Record<Group, string> = {
  excited: '😍',
  maybe: '🤔',
  rejected: '👎',
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

function buildColumns(places: Place[], twins: Map<string, string[]>): Column[] {
  const columns: Column[] = [
    {
      key: 'address',
      label: 'Place',
      value: (e) => e.displayAddress,
      render: (e) => (
        <span className="compare-address">
          <span className="compare-mark">{VERDICT_MARK[groupOf(e.verdicts)]}</span>
          <a href={e.url} target="_blank" rel="noopener" onClick={(ev) => ev.stopPropagation()}>
            {e.displayAddress}
          </a>
          {(twins.get(e.rightmoveId)?.length ?? 0) > 0 && (
            <span className="twin" title="Listed twice — same postcode and rent">
              ⧉
            </span>
          )}
        </span>
      ),
    },
    {
      key: 'price',
      label: 'Rent',
      numeric: true,
      value: (e) => monthly(e.price),
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
        const rent = monthly(e.price);
        const area = resolveSize(sizeOf(e))?.value ?? null;
        return rent === null || area === null || area === 0 ? null : rent / area;
      },
      render: (e) => {
        const rent = monthly(e.price);
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
      value: (e) => worstSeverity(problems(e)),
      bigIsBetter: true,
      render: (e) => {
        const flags = problems(e);
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

/** "£4,250 pcm" -> 4250. Weekly rents are normalised so the column compares like with like —
 *  a "£980 pw" listing sorted as cheaper than everything else on the page. */
function monthly(price: string | null): number | null {
  if (!price) return null;
  const amount = Number(price.replace(MONEY, ''));
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return /\bpw\b|per week/i.test(price) ? (amount * 52) / 12 : amount;
}


/** Only the problems, from the one definition in facts.ts. */
function problems(entry: ShortlistEntry): Flag[] {
  return problemsOnly(flagsFor({ analysis: entry.analysis, floorplanUrl: entry.floorplanUrl }));
}

/** A blank cell should say "we don't know", not look like a zero. */
function dash(why = 'Not known for this listing.') {
  return (
    <Hint text={why}>
      <span className="dim">—</span>
    </Hint>
  );
}
