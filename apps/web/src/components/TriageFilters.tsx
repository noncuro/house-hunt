'use client';

import { AMENITIES, NO_FILTER, filterIsOn, type AmenityKey, type TriageFilter } from '@house-hunt/core';

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
}: {
  filter: TriageFilter;
  setFilter: (next: TriageFilter) => void;
  kept: number;
  unknowns: number;
  total: number;
}) {
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
