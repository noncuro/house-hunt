'use client';

import {
  AMENITIES,
  BAR_MODES,
  CROW,
  NO_FILTER,
  filterIsOn,
  type AmenityKey,
  type BarMode,
  type Place,
  type TravelBar,
  type TriageFilter,
} from '@house-hunt/core';
import { MODE_ICON } from '@house-hunt/ui';

/** The bars a flat has to clear to stay in the triage pile.
 *
 *  Deliberately the things you would have written down before the hunt started — a rent, a size, a
 *  main room, somewhere to sit outside — rather than everything the table has a column for. Triage
 *  is about getting through a pile, and a filter panel you have to *decide* about is one more thing
 *  between you and the pile.
 *
 *  What it never does is hide a flat we have no number for; `matchesFilter` carries that rule, and
 *  the line under the bar says how many are being kept on that basis. Most of these figures are read
 *  off photographs, so "we could not tell" is common, and a filter that dropped those would hide the
 *  least-known listings — which are the ones triage exists to look at. */
export function TriageFilters({
  filter,
  setFilter,
  /** How many flats the filter left, and how many of those cleared it only because something was
   *  unknown. Passed in rather than computed here: the pile is filtered once, above. */
  kept,
  unknowns,
  total,
  places,
}: {
  filter: TriageFilter;
  setFilter: (next: TriageFilter) => void;
  kept: number;
  unknowns: number;
  total: number;
  /** The places this hunt saved, which is the whole vocabulary of a travel bar. No places means no
   *  travel row at all — an empty picker is a control that cannot be used and does not say why. */
  places: Place[];
}) {
  // Every place we can measure to at all. A postcode is what TfL is asked with and a coordinate is
  // what a straight line is drawn between, so a neighbourhood folded in from the old hub list has
  // no journey time and does have a distance — filtering it out of the picker entirely was how it
  // disappeared from this control without explanation. The mode select below is what narrows it.
  const destinations = places.filter((p) => p.postcode !== null || (p.lat !== null && p.lon !== null));
  const on = filterIsOn(filter);
  const set = (patch: Partial<TriageFilter>) => setFilter({ ...filter, ...patch });

  const toggleAmenity = (key: AmenityKey) =>
    set({
      amenities: filter.amenities.includes(key)
        ? filter.amenities.filter((a) => a !== key)
        : [...filter.amenities, key],
    });

  return (
    <div className="triage-filters" data-testid="triage-filters">
      <div className="triage-filter-row">
        <Bar label="Max rent" prefix="£" value={filter.maxPrice} step={100} onChange={(v) => set({ maxPrice: v })} />
        <Bar label="Min beds" value={filter.minBedrooms} step={1} onChange={(v) => set({ minBedrooms: v })} />
        <Bar label="Min size" suffix="sq ft" value={filter.minSqft} step={50} onChange={(v) => set({ minSqft: v })} />
        <Bar
          label="Min main room"
          suffix="sq ft"
          value={filter.minGreatRoomSqft}
          step={25}
          onChange={(v) => set({ minGreatRoomSqft: v })}
        />
        <button
          className="key triage-filter-clear"
          disabled={!on}
          onClick={() => setFilter(NO_FILTER)}
          data-testid="clear-filters"
        >
          Clear filters
        </button>
      </div>

      {/* Must have, not "would like" — the Your Hunt page is where a preference lives, and it
          changes how a flat is flagged rather than whether it is shown. This is the blunt version,
          for one pass through one pile. */}
      <div className="triage-filter-row">
        <span className="dim">Must have:</span>
        {AMENITIES.map((amenity) => (
          <button
            key={amenity.key}
            className={filter.amenities.includes(amenity.key) ? 'key key-on' : 'key'}
            aria-pressed={filter.amenities.includes(amenity.key)}
            data-testid={`want-${amenity.key}`}
            onClick={() => toggleAmenity(amenity.key)}
          >
            {amenity.name}
          </button>
        ))}
      </div>

      {/* How far it is from the places you saved. A row per bar rather than a column per place,
          because a hunt has one or two journeys it actually cares about and a picker per place
          would put six controls on screen to express one requirement. Absent when there are no
          places: the answer then is to go and save one, which Settings is for. */}
      {destinations.length > 0 && (
        <div className="triage-filter-row triage-filter-travel">
          <span className="dim">Within:</span>
          {filter.travel.map((entry, index) => (
            <TravelRow
              key={index}
              bar={entry}
              places={destinations}
              onChange={(next) =>
                set({ travel: filter.travel.map((t, i) => (i === index ? next : t)) })
              }
              onRemove={() => set({ travel: filter.travel.filter((_, i) => i !== index) })}
            />
          ))}
          <button
            className="key"
            data-testid="add-travel-filter"
            // Thirty minutes on public transport to the first saved place: the commute is what
            // people save a place for, and a bar that starts at "any" is one you have to fill in
            // twice before it does anything.
            onClick={() =>
              set({
                travel: [
                  ...filter.travel,
                  { placeId: destinations[0]!.id, ...startingBar(destinations[0]!) },
                ],
              })
            }
          >
            + Travel time
          </button>
        </div>
      )}

      {on && (
        <p className="dim triage-filter-count">
          {kept} of {total} left
          {unknowns > 0 && (
            <>
              {' '}
              — {unknowns} of them because we have no number for something you filtered on. A missing
              figure is not a small one, so nothing is dropped for it.
            </>
          )}
        </p>
      )}
    </div>
  );
}

/** One "within N minutes of X, by Y" bar.
 *
 *  All three parts are always set — there is no "any place" or "any mode", because a travel bar
 *  with either missing is not a weaker filter, it is a different question, and neither surface has
 *  a number that answers it. A bar you no longer want is removed rather than blanked. */
function TravelRow({
  bar,
  places,
  onChange,
  onRemove,
}: {
  bar: TravelBar;
  places: Place[];
  onChange: (next: TravelBar) => void;
  onRemove: () => void;
}) {
  const miles = bar.mode === CROW;
  // Whether this place can be routed to at all. A place saved without a postcode — every
  // neighbourhood folded in from the old hub list — has a coordinate and nothing to ask TfL with,
  // so the straight line is the only honest option and the journeys are not offered.
  const routable = places.find((p) => p.id === bar.placeId)?.postcode !== null;
  return (
    <span className="triage-travel-bar" data-testid={`travel-filter-${bar.placeId}-${bar.mode}`}>
      <input
        type="number"
        min={miles ? 0.1 : 1}
        // Quarter-mile steps, because that is the granularity the distance is any use at: half a
        // mile and three quarters are different neighbourhoods, five minutes of a bus ride is not.
        step={miles ? 0.25 : 5}
        className="triage-travel-minutes"
        value={bar.max}
        aria-label={miles ? 'Miles' : 'Minutes'}
        onChange={(e) => {
          const next = Number(e.target.value);
          // Kept as it was rather than falling back to a default: a half-typed box is on its way to
          // a number, and snapping it back mid-keystroke fights whoever is typing.
          if (Number.isFinite(next) && next > 0) onChange({ ...bar, max: next });
        }}
      />
      <span className="dim">{bar.mode === CROW ? 'mi of' : 'min of'}</span>
      <select
        value={bar.placeId}
        aria-label="Place"
        onChange={(e) => {
          const place = places.find((p) => p.id === e.target.value);
          // Moving a bar onto a place with no postcode has to move the mode too, or it would sit
          // there asking for a journey time that can never be answered and keeping the whole pile
          // on the unknown rule — filtering nothing while looking like it was.
          onChange(
            place && place.postcode === null
              ? { placeId: place.id, ...startingBar(place) }
              : { ...bar, placeId: e.target.value },
          );
        }}
      >
        {places.map((place) => (
          <option key={place.id} value={place.id}>
            {place.label}
          </option>
        ))}
      </select>
      <select
        value={bar.mode}
        aria-label="How"
        onChange={(e) => onChange({ ...bar, mode: e.target.value as BarMode })}
      >
        {BAR_MODES.filter((mode) => mode === CROW || routable).map((mode) => (
          <option key={mode} value={mode}>
            {BAR_ICON[mode]} {BAR_LABEL[mode]}
          </option>
        ))}
      </select>
      <button className="key triage-travel-remove" onClick={onRemove} aria-label="Remove this travel filter">
        ×
      </button>
    </span>
  );
}

/** The modes in words. `MODE_ICON` is the shared symbol both surfaces draw; a picker needs the
 *  name as well, since an emoji alone in a dropdown is a guess. */
const BAR_LABEL: Record<BarMode, string> = {
  walking: 'walk',
  cycling: 'cycle',
  transit: 'public transport',
  [CROW]: 'straight line',
};

const BAR_ICON: Record<BarMode, string> = { ...MODE_ICON, [CROW]: '📏' };

/** What a new bar against this place starts as.
 *
 *  Thirty minutes on public transport where there is a postcode to route from — the commute is what
 *  people save a place for. A mile as the crow flies where there is not, because that is the only
 *  question answerable about it, and a bar that starts on a mode with no numbers behind it looks
 *  broken rather than empty. */
function startingBar(place: Place): { mode: BarMode; max: number } {
  return place.postcode === null ? { mode: CROW, max: 1 } : { mode: 'transit', max: 30 };
}

/** One numeric bar. Empty is "don't mind", which is a different thing from nought — typing a zero
 *  into "min size" is a filter that passes everything and looks like one that is off. */
function Bar({
  label,
  value,
  step,
  prefix,
  suffix,
  onChange,
}: {
  label: string;
  value: number | null;
  step: number;
  prefix?: string;
  suffix?: string;
  onChange: (value: number | null) => void;
}) {
  return (
    <label className="triage-filter">
      <span className="dim">{label}</span>
      {prefix && <span className="dim">{prefix}</span>}
      <input
        type="number"
        min={0}
        step={step}
        value={value ?? ''}
        placeholder="any"
        data-testid={`filter-${label.toLowerCase().replace(/\s+/g, '-')}`}
        onChange={(e) => {
          const next = Number(e.target.value);
          onChange(e.target.value === '' || !Number.isFinite(next) ? null : next);
        }}
      />
      {suffix && <span className="dim">{suffix}</span>}
    </label>
  );
}
