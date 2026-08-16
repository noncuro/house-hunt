'use client';

import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AmenityLabel, Icon, RATINGS, ScoreGauge, ratingOf } from '@house-hunt/ui';
import {
  addressBesidePostcode,
  applyFilter,
  destinationsFor,
  placePoints,
  resolveSize,
  sizeOf,
  splitByHuntFloor,
  unknownBars,
  type ArchiveReason,
  type Hub,
  type HuntPreferences,
  type Place,
  type PricePoint,
  type Rating,
  type Stage,
  type TriageFilter,
} from '@house-hunt/core';
import type { ShortlistEntry, StoredModel } from '@house-hunt/core/db';
import { FlatDetail } from '@/components/FlatDetail';
import { Tick, useRangePick } from '@/components/Tick';
import { TriageFilters } from '@/components/TriageFilters';
import { ShortlistMap } from '@/screens/Map';
import { NEEDS_MODEL, SORT_LABEL, isSurprise, sortForTriage, type SortMode } from '@/lib/score';
import { useCachedTravel, useRetrain } from '@/lib/queries';

/** The pile nobody has an opinion on, and the one screen built for changing that.
 *
 *  It was a table: nine columns, a tick box on each row, and a card that expanded underneath the one
 *  you clicked — so deciding on a flat meant opening it, reading down, collapsing it and finding the
 *  next row. The work is one flat at a time and always the same three keys, and a table is the shape
 *  for the opposite job.
 *
 *  So: the pile down the left, the flat itself on the right, and `j` `k` `1` `2` `3` under your
 *  fingers. Rating advances to the next one, because the only reason to stay is to write a note and
 *  the note field is where you already are. Everything else — the filters, the sort, the model — is
 *  collapsed to one line, because it is set once at the start of a sitting and then never touched.
 *
 *  Ticking survives, and so does the bulk bar, for the half of the pile that is a "no" from the
 *  address alone. It appears when something is ticked and not before: it used to sit there all
 *  session saying "Nothing selected" beside three buttons that write a verdict for the whole hunt. */
const CONFIRM_BULK_ABOVE = 5;

export function Triage({
  projectId,
  entries,
  places,
  hubs,
  prices,
  prefs,
  scores,
  offMarket,
  storedModel,
  filter,
  setFilter,
  sortMode,
  setSortMode,
  selected,
  setSelected,
  onRate,
  onRateMany,
  onSetStage,
  onSetOffMarket,
  stageSaving,
  notify,
}: {
  /** Which hunt this is, for the map's saved viewport — one map position is one hunt's. */
  projectId: string;
  /** Everything unrated. The filter narrows it; the sort orders what is left. */
  entries: ShortlistEntry[];
  places: Place[];
  hubs: Hub[] | null | undefined;
  prices: Map<string, PricePoint[]> | undefined;
  prefs: HuntPreferences;
  scores: Map<string, number> | null;
  offMarket: ReadonlySet<string>;
  storedModel: StoredModel | null;
  filter: TriageFilter;
  setFilter: (next: TriageFilter) => void;
  sortMode: SortMode;
  setSortMode: (next: SortMode) => void;
  selected: string[];
  setSelected: (next: string[]) => void;
  onRate: (entry: ShortlistEntry, rating: Rating, note: string) => void;
  onRateMany: (rating: Rating) => void;
  onSetStage: (entry: ShortlistEntry, stage: Stage, archiveReason: ArchiveReason | null) => void;
  onSetOffMarket: (entry: ShortlistEntry, off: boolean) => void;
  stageSaving: { rightmoveId: string; stage: Stage } | null;
  notify: (message: string) => void;
}) {
  const retrain = useRetrain();
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState<Rating | null>(null);
  const [at, setAt] = useState<string | null>(null);
  const [showBelowFloor, setShowBelowFloor] = useState(false);
  // The pile as a list or as a map. The list is the default because triage is a queue and a queue
  // has an order; the map answers the question the order cannot — "which of these are near each
  // other", which is most of what makes two flats comparable at all.
  const [asMap, setAsMap] = useState(false);

  // The cache and nothing else, for the same reason the compare table reads it that way: a
  // read-through here would fire a journey-planner request for every gap in a pile of two hundred,
  // on every keystroke in the minutes box.
  const travel = useCachedTravel(entries.map((e) => e.postcode));
  const points = useMemo(() => placePoints(places), [places]);

  // The hunt's own must-haves come off the pile before this sitting's filter touches it — a flat
  // under a bar everybody agreed on is not work waiting to be done, and it was being counted as
  // some. Gone rather than merely marked, but never silently: the line below says how many and
  // hands them back, which is the same bargain `unknowns` strikes.
  const { above, below } = useMemo(() => splitByHuntFloor(entries, prefs), [entries, prefs]);
  const pile = showBelowFloor ? entries : above;

  // Narrowed first, then ordered: sorting the pile and then throwing most of it away would leave the
  // ranking meaning something about flats no longer on screen.
  // Memoised because the map reads it: a fresh `kept` on every render is a fresh `shown`, and the
  // map refits its viewport whenever the flats it is drawing change identity. Selecting a pin
  // rerenders this screen, so without this, clicking a flat threw away the pan and zoom you had
  // just used to find it.
  const { kept, unknowns } = useMemo(
    () => applyFilter(pile, filter, travel.data, points),
    [pile, filter, travel.data, points],
  );
  // Per row rather than per pile: the same question `unknowns` counts, asked of one flat.
  const unknownFor = (entry: ShortlistEntry) => unknownBars(entry, filter, travel.data, points);
  const shown = useMemo(() => sortForTriage(kept, scores, sortMode), [kept, scores, sortMode]);

  // The flat on the right. Follows the pile when what you were reading leaves it — which is what
  // happens the instant you rate one, since a rated flat is no longer unrated.
  const current = useMemo(
    () => shown.find((e) => e.rightmoveId === at) ?? shown[0] ?? null,
    [shown, at],
  );

  const step = (delta: number) => {
    if (shown.length === 0) return;
    const from = shown.findIndex((e) => e.rightmoveId === current?.rightmoveId);
    const next = Math.max(0, Math.min(shown.length - 1, (from === -1 ? 0 : from) + delta));
    setAt(shown[next]!.rightmoveId);
  };

  // Rating moves on. Not to the top and not to a fresh sort — to whatever is now where this one was,
  // which is what makes the pile feel like a pile rather than a queue that reshuffles under you.
  const rateHere = (rating: Rating) => {
    if (!current) return;
    const index = shown.findIndex((e) => e.rightmoveId === current.rightmoveId);
    onRate(current, rating, '');
    setAt(shown[index + 1]?.rightmoveId ?? null);
  };

  // Written at commit rather than during the render that produced them, for the reason `Pager`
  // gives: React can start a render and throw it away, and a ref assigned on the way past keeps
  // the closures of a render that never happened. Here that means `j` and a rating key acting on
  // the flat a discarded render was about to show rather than the one on screen — which for a
  // rating is a verdict for the whole hunt, written against the wrong flat.
  const keys = useRef({ step, rateHere, has: Boolean(current) });
  useEffect(() => {
    keys.current = { step, rateHere, has: Boolean(current) };
  });

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // Never while somebody is typing. The note field is on this screen and "no" is two of its
      // letters away from a verdict for the whole hunt.
      if (event.target instanceof HTMLElement && event.target.closest('input, textarea, select')) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const { step: go, rateHere: rate, has } = keys.current;
      if (event.key === 'j' || event.key === 'ArrowDown') go(1);
      else if (event.key === 'k' || event.key === 'ArrowUp') go(-1);
      else if (has && KEY_RATING[event.key]) rate(KEY_RATING[event.key]!);
      else return;
      event.preventDefault();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const chosen = new Set(selected);
  const pick = useRangePick(
    useMemo(() => shown.map((e) => e.rightmoveId), [shown]),
    {
      chosen,
      toggle: (id) => setSelected(chosen.has(id) ? selected.filter((s) => s !== id) : [...selected, id]),
      setMany: (ids, on) => {
        const run = new Set(ids);
        setSelected(on ? [...new Set([...selected, ...ids])] : selected.filter((s) => !run.has(s)));
      },
    },
  );

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

  return (
    <section className="triage" data-testid="triage">
      {/* One line, and it stays one line. The filters were a four-bar panel permanently open above
          the pile, taking a third of the screen to say what it had already done — so they collapse
          to their own summary, and open on the word that says they will. */}
      <div className="triage-bar">
        <span className="triage-count" data-testid="triage-count">
          <strong>{shown.length}</strong> of {pile.length} waiting
          {unknowns > 0 && (
            <span className="dim" title="Kept because we could not tell either way — never dropped for a number we do not have.">
              {' '}
              · {unknowns} on unknowns
            </span>
          )}
        </span>

        {/* Never a silent removal. The count is the hunt's own bars doing what they were set to do,
            and the button beside it is the check on that — a must-have somebody set too high shows
            up here as a number that is too big, and is one click from being read. */}
        {below.length > 0 && (
          <span className="triage-floor dim" data-testid="triage-floor">
            {showBelowFloor
              ? `${below.length} under your hunt's must-haves, shown`
              : `${below.length} hidden by your hunt's must-haves`}{' '}
            <button
              type="button"
              className="linkish"
              data-testid="triage-floor-toggle"
              aria-pressed={showBelowFloor}
              onClick={() => {
                setShowBelowFloor(!showBelowFloor);
                // Same reason changing a filter clears them: a tick left on a flat that has just
                // left the pile is a verdict for the whole hunt on something nobody can see.
                setSelected([]);
              }}
            >
              {showBelowFloor ? 'Hide them' : 'Show them'}
            </button>
          </span>
        )}

        <button
          type="button"
          className={editing ? 'key key-on' : 'key'}
          aria-expanded={editing}
          data-testid="triage-filters-toggle"
          onClick={() => setEditing(!editing)}
        >
          <Icon name="filter" size={12} />
          <span className="triage-summary">{summarise(filter, places)}</span>
        </button>

        <label className="triage-sort">
          <span className="dim">Work from</span>
          {/* Per option, not per control: disabling the whole select when there is no model took
              away "cheapest first" and "biggest first" too, and the day a hunt starts is the day the
              pile is biggest and the model does not exist yet. */}
          <select
            value={sortMode}
            onChange={(e) => setSortMode(e.target.value as SortMode)}
            disabled={pile.length === 0}
          >
            {(Object.keys(SORT_LABEL) as SortMode[]).map((mode) => (
              <option key={mode} value={mode} disabled={NEEDS_MODEL.includes(mode) && !scores}>
                {SORT_LABEL[mode]}
                {NEEDS_MODEL.includes(mode) && !scores ? ' — needs a model' : ''}
              </option>
            ))}
          </select>
        </label>

        {/* Two drawings of one pile, not two screens: the filter, the sort and the ticks all carry
            across, and the pane on the right is the same pane. */}
        <span className="triage-views">
          <button
            type="button"
            className={asMap ? 'key' : 'key key-on'}
            aria-pressed={!asMap}
            data-testid="triage-as-list"
            onClick={() => setAsMap(false)}
          >
            <Icon name="places" size={12} /> List
          </button>
          <button
            type="button"
            className={asMap ? 'key key-on' : 'key'}
            aria-pressed={asMap}
            data-testid="triage-as-map"
            onClick={() => setAsMap(true)}
          >
            <Icon name="map" size={12} /> Map
          </button>
        </span>

        {/* The model and the button that rebuilds it, as one group at the far end of the bar: what
            Rescore acts on is the line beside it, not the filters it used to sit next to. Grouped
            rather than merely adjacent so the pair wraps together on a narrow window.

            The button is the whole of the retraining story — a click refits the model server-side on
            every verdict in the hunt, and nothing else ever does (design: explicit on purpose). It
            says so on hover, because "Rescore" beside a percentage reads like a re-sort. */}
        <span className="triage-modelling">
          <span className="dim triage-model">
            {metrics
              ? `${metrics.n} verdicts, ${Math.round(metrics.cvAuc * 100)}% AUC`
              : scores
                ? 'Model ready'
                : 'No model yet — rate a few, then rescore'}
          </span>
          <button
            type="button"
            className="key"
            onClick={onRerun}
            disabled={retrain.isPending}
            title="Refit the model on every verdict in this hunt, then re-score the pile."
            data-testid="triage-rescore"
          >
            {retrain.isPending ? 'Rescoring…' : 'Rescore'}
          </button>
        </span>
      </div>

      {editing && (
        <TriageFilters
          filter={filter}
          setFilter={(next) => {
            setFilter(next);
            // Anything ticked and then filtered away would still be rated by the bulk buttons — a
            // verdict for everybody in the hunt, on flats no longer on screen.
            setSelected([]);
          }}
          kept={kept.length}
          unknowns={unknowns}
          total={pile.length}
          places={places}
        />
      )}

      {/* Only once something is ticked. */}
      {selected.length > 0 && (
        <div className="triage-bulk" data-testid="triage-bulk">
          {confirming ? (
            <>
              <span>
                Mark all {selected.length} “{ratingOf(confirming).label}”?
              </span>
              <button
                type="button"
                className={`rate rate-${confirming}`}
                onClick={() => {
                  onRateMany(confirming);
                  setConfirming(null);
                }}
              >
                Yes, mark {selected.length}
              </button>
              <button type="button" className="key" onClick={() => setConfirming(null)}>
                Cancel
              </button>
            </>
          ) : (
            <>
              <span>{selected.length} ticked</span>
              <div className="triage-rate">
                {RATINGS.map((r) => (
                  <button
                    key={r.value}
                    type="button"
                    className={`rate rate-${r.value}`}
                    title={`Mark all ${selected.length} ticked “${r.label}”, with no note.`}
                    onClick={() =>
                      // A verdict on a batch this size is worth one more click: each is a write for
                      // everybody in the hunt, and there is nothing that puts them back.
                      selected.length > CONFIRM_BULK_ABOVE ? setConfirming(r.value) : onRateMany(r.value)
                    }
                  >
                    {r.label}
                  </button>
                ))}
              </div>
              <button
                type="button"
                className="key"
                onClick={() => setSelected(shown.map((e) => e.rightmoveId))}
              >
                Tick all {shown.length}
              </button>
              <button type="button" className="linkish" onClick={() => setSelected([])}>
                Clear
              </button>
            </>
          )}
        </div>
      )}

      {entries.length === 0 ? (
        <p className="dim">Nothing waiting — every place either of you has opened has a verdict.</p>
      ) : pile.length === 0 ? (
        // Not "nothing waiting": there are flats, and the hunt's own must-haves are why none of them
        // is here. Saying the first would be the screen taking credit for a filter it did not name.
        <p className="dim">
          All {entries.length} waiting are under your hunt&rsquo;s must-haves — “Show them” above puts
          them back, or loosen one on Your Hunt.
        </p>
      ) : shown.length === 0 ? (
        <p className="dim">
          None of the {pile.length} waiting clears those bars.{' '}
          <button type="button" className="linkish" onClick={() => setEditing(true)}>
            Loosen one
          </button>
          .
        </p>
      ) : (
        <div className={asMap ? 'triage-split triage-split-map' : 'triage-split'}>
          {asMap ? (
            <ShortlistMap
              projectId={projectId}
              entries={shown}
              places={places}
              travel={travel.data}
              hubs={hubs}
              prefs={prefs}
              scores={scores}
              // The map is only the map here: the right-hand column is triage's own pane, and the
              // selection is triage's — a pin and a row are two ways of saying the same thing.
              panel="none"
              selected={current?.rightmoveId ?? null}
              onSelect={setAt}
              // Opening a flat *is* choosing it on this screen; there is nowhere further to go.
              onOpen={setAt}
            />
          ) : (
          <ol className="triage-pile" data-testid="triage-pile">
            {shown.map((entry) => (
              <li key={entry.rightmoveId}>
                <div
                  className={`triage-row${entry.rightmoveId === current?.rightmoveId ? ' triage-row-at' : ''}`}
                >
                  <Tick
                    checked={chosen.has(entry.rightmoveId)}
                    label={entry.displayAddress}
                    onPick={(shiftKey) => pick(entry.rightmoveId, shiftKey)}
                  />
                  <button
                    type="button"
                    className="triage-pick"
                    aria-current={entry.rightmoveId === current?.rightmoveId ? 'true' : undefined}
                    onClick={() => setAt(entry.rightmoveId)}
                  >
                    <span className="triage-address">
                      {addressBesidePostcode(entry.displayAddress, entry.postcode)}
                    </span>
                    <span className="triage-line dim">{oneLine(entry)}</span>
                    {/* Why this one is still here when a bar it does not obviously clear is set.
                        The count under the filter says how many are kept on a shrug; this says
                        which, and which figure is the missing one — "no size" is the row to open
                        the floorplan on, and without it it is drawn exactly like a measured one. */}
                    {unknownFor(entry).length > 0 && (
                      <span className="triage-unknowns" data-testid="triage-unknown">
                        {unknownFor(entry).map((what) => (
                          <span className="triage-unknown" key={what}>
                            {what}
                          </span>
                        ))}
                      </span>
                    )}
                  </button>
                  {scores?.has(entry.rightmoveId) && (
                    <ScoreGauge
                      score={scores.get(entry.rightmoveId)!}
                      surprise={isSurprise(entry, scores.get(entry.rightmoveId)!)}
                      word={false}
                    />
                  )}
                </div>
              </li>
            ))}
          </ol>
          )}

          <div className="triage-pane">
            {current && (
              <>
                <p className="triage-keys dim">
                  <kbd>j</kbd> <kbd>k</kbd> move · <kbd>1</kbd> not our place · <kbd>2</kbd> like it ·{' '}
                  <kbd>3</kbd> love it · <kbd>space</kbd> photos
                </p>
                <FlatDetail
                  key={current.rightmoveId}
                  keys
                  verdictFirst
                  entry={current}
                  places={places}
                  hubs={hubs}
                  prices={prices}
                  prefs={prefs}
                  score={scores?.get(current.rightmoveId)}
                  offMarket={offMarket}
                  onRate={(rating, note) => {
                    // A note means this one was worth stopping on, so it does not advance — the
                    // sentence you just wrote would scroll away under a different flat.
                    if (note) onRate(current, rating, note);
                    else rateHere(rating);
                  }}
                  onSetStage={(stage, reason) => onSetStage(current, stage, reason)}
                  onSetOffMarket={(off) => onSetOffMarket(current, off)}
                  stageSaving={
                    stageSaving?.rightmoveId === current.rightmoveId ? stageSaving.stage : null
                  }
                />
              </>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

/** The three keys, in the order the buttons are in. Numbers rather than letters because the
 *  buttons show them, and `n`/`l`/`y` would each be the first letter of something else. */
const KEY_RATING: Record<string, Rating | undefined> = { '1': 'no', '2': 'maybe', '3': 'love' };

/** What the collapsed filter button says it is doing. Names the bars that are set rather than
 *  counting them: "under £2,600 · 2+ beds" is legible where "3 filters" is a number you have to
 *  open the panel to understand.
 *
 *  Nodes rather than a string because an amenity is drawn, not spelled: it wears the same glyph here
 *  as it does on the control that set it and on the flag that answers it. */
function summarise(filter: TriageFilter, places: Place[]): ReactNode {
  const bits: ReactNode[] = [];
  if (filter.maxPrice !== null) bits.push(`under £${filter.maxPrice.toLocaleString()}`);
  if (filter.minBedrooms !== null) bits.push(`${filter.minBedrooms}+ beds`);
  if (filter.minSqft !== null) bits.push(`${filter.minSqft}+ sq ft`);
  if (filter.minGreatRoomSqft !== null) bits.push(`main room ${filter.minGreatRoomSqft}+ sq ft`);
  // Through the same list the picker offers, so the nearest station reads as itself here rather
  // than as a bar naming a place this hunt does not have.
  const destinations = destinationsFor(places);
  for (const bar of filter.travel) {
    const place = destinations.find((p) => p.id === bar.placeId);
    // A bar naming a place that has since been deleted is silently dropped from the summary; the
    // filter itself is pruned the same way one level up (`withKnownPlaces`).
    if (place) bits.push(`${bar.max}${bar.mode === 'crow' ? ' mi' : ' min'} to ${place.label}`);
  }
  for (const key of filter.amenities) {
    bits.push(<AmenityLabel amenity={key} word="label" size={12} />);
  }
  if (bits.length === 0) return 'No filters';
  return bits.map((bit, i) => (
    // The index is the identity: the list is rebuilt whole on every filter change and never
    // reordered in place.
    <Fragment key={i}>
      {i > 0 && <span className="dim">·</span>}
      {bit}
    </Fragment>
  ));
}

/** The one line under an address in the pile: rent, beds, size. Everything else about the flat is
 *  on the right-hand side, an arrow key away. */
function oneLine(entry: ShortlistEntry): string {
  const bits: string[] = [];
  if (entry.price) bits.push(entry.price);
  if (entry.bedrooms !== null) bits.push(`${entry.bedrooms} bed`);
  const size = resolveSize(sizeOf(entry));
  if (size) bits.push(`${size.value.toLocaleString()} sq ft${size.approximate ? '*' : ''}`);
  return bits.join(' · ');
}
