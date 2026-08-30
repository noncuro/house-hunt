'use client';

import { useEffect, useMemo } from 'react';
import {
  FlagChip,
  Hint,
  Icon,
  ModeIcon,
  SizeValue,
  VerdictStamp,
  formatDuration,
} from '@house-hunt/ui';
import {
  addressBesidePostcode,
  flagsFor,
  galleryFor,
  parseMonthlyPrice,
  problemsOnly,
  readPlaceTravel,
  resolveSize,
  sizeOf,
  stageSentence,
  travelDestinations,
  type HuntPreferences,
  type Place,
  type TravelTime,
} from '@house-hunt/core';
import type { ShortlistEntry } from '@house-hunt/core/db';
import { RightmoveLink } from '@/components/RightmoveLink';
import { useCachedTravel } from '@/lib/queries';

/** The last two to four, set against each other.
 *
 *  The table answers "which of these two hundred", and it answers it by being wide — nine columns,
 *  scrolling sideways, one row per flat. The question at the end of a hunt is the opposite shape:
 *  three flats, everything about each, and the differences between them findable without moving your
 *  eyes across a screen and back. So the axes swap. One column per flat, one row per fact, and the
 *  rows that differ carry a mark so the eye lands on them first.
 *
 *  Four at most. Past that the columns are too narrow to hold an address, and the thing you want is
 *  the table you came from. */
export function HeadToHead({
  entries,
  places,
  prefs,
  onOpen,
  onClose,
}: {
  entries: ShortlistEntry[];
  places: Place[];
  prefs: HuntPreferences;
  onOpen: (rightmoveId: string) => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const travel = useCachedTravel(entries.map((e) => e.postcode));
  const destinations = useMemo(() => travelDestinations(places), [places]);
  const rows = useMemo(
    () => buildRows(destinations, prefs, travel.data),
    [destinations, prefs, travel.data],
  );

  return (
    <div className="duel" role="dialog" aria-label="Side by side" data-testid="head-to-head-view">
      <div className="duel-bar">
        <h2>Side by side</h2>
        <button type="button" className="key" onClick={onClose} data-testid="duel-close">
          <Icon name="close" size={12} /> Back to the table
        </button>
      </div>

      <div className="duel-scroll">
        <table className="duel-table">
          <thead>
            <tr>
              <th scope="col" className="duel-spine" />
              {entries.map((entry) => {
                const lead = galleryFor(entry).find((url) => url !== entry.floorplanUrl) ?? null;
                return (
                  <th key={entry.rightmoveId} scope="col">
                    <button type="button" className="duel-shot" onClick={() => onOpen(entry.rightmoveId)}>
                      {lead ? <img src={lead} alt="" loading="lazy" /> : <span className="dim">no photo</span>}
                    </button>
                    <button type="button" className="duel-address" onClick={() => onOpen(entry.rightmoveId)}>
                      {addressBesidePostcode(entry.displayAddress, entry.postcode)}
                    </button>
                    <RightmoveLink url={entry.url} />
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              // A row where every column says the same thing is not what anybody is here to read.
              // It stays — dropping it would leave a comparison that silently omits what they have
              // in common — but it is quiet, and the ones that differ are not.
              const same = agrees(entries, row.same);
              return (
                <tr key={row.key} className={same ? 'duel-same' : 'duel-differs'}>
                  <th scope="row" className="duel-spine">
                    {row.label}
                  </th>
                  {entries.map((entry) => (
                    <td key={entry.rightmoveId}>{row.render(entry)}</td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** True when every column would read the same. Compared on a value the row nominates rather than on
 *  the rendered node: two flats both at "£2,400 pcm" agree, and two both showing a dash for an
 *  unknown size do not — not knowing twice is not agreement. */
function agrees(entries: ShortlistEntry[], same: (e: ShortlistEntry) => string | number | null): boolean {
  const first = same(entries[0]!);
  if (first === null) return false;
  return entries.every((entry) => same(entry) === first);
}

interface Row {
  key: string;
  label: React.ReactNode;
  same: (e: ShortlistEntry) => string | number | null;
  render: (e: ShortlistEntry) => React.ReactNode;
}

function buildRows(
  places: Place[],
  prefs: HuntPreferences,
  travel: Record<string, TravelTime[]> | undefined,
): Row[] {
  const rows: Row[] = [
    {
      key: 'price',
      label: 'Rent',
      same: (e) => parseMonthlyPrice(e.price),
      render: (e) => e.price ?? dash(),
    },
    {
      key: 'sqft',
      label: 'Size',
      same: (e) => resolveSize(sizeOf(e))?.value ?? null,
      render: (e) => {
        const size = resolveSize(sizeOf(e));
        return size === null ? dash() : <SizeValue size={size} />;
      },
    },
    {
      key: 'ppsf',
      label: '£/sq ft',
      same: (e) => perFoot(e),
      render: (e) => {
        const v = perFoot(e);
        return v === null ? dash() : `£${v.toFixed(2)}`;
      },
    },
    { key: 'beds', label: 'Beds', same: (e) => e.bedrooms, render: (e) => e.bedrooms ?? dash() },
    { key: 'baths', label: 'Baths', same: (e) => e.bathrooms, render: (e) => e.bathrooms ?? dash() },
    {
      key: 'furnish',
      label: 'Furnished',
      same: (e) => e.furnishType,
      render: (e) => e.furnishType ?? dash('Not stated on the listing.'),
    },
  ];

  // The fastest way to each saved place. Only the fastest: the per-mode breakdown is a column
  // picker's worth of detail, and this screen is three flats and a decision.
  for (const place of places) {
    rows.push({
      key: `place:${place.id}`,
      label: place.label,
      same: (e) => best(e, place.id, travel)?.seconds ?? null,
      render: (e) => {
        const winner = best(e, place.id, travel);
        if (!winner) return dash('Not worked out yet — open this place to fetch it.');
        return (
          <span className={winner.stale ? 'stale-time' : undefined}>
            <ModeIcon mode={winner.mode} size={12} /> {formatDuration(winner.seconds)}
          </span>
        );
      },
    });
  }

  rows.push(
    {
      key: 'flags',
      label: 'Against it',
      // Never "the same": two flats with problems have different problems, and the point of the row
      // is to read both lists.
      same: () => null,
      render: (e) => {
        const flags = problemsOnly(
          flagsFor({ analysis: e.analysis, floorplanUrl: e.floorplanUrl, size: sizeOf(e) }, prefs),
        );
        if (flags.length === 0) return <span className="dim">nothing</span>;
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
      key: 'verdict',
      label: 'Verdict',
      same: (e) => e.verdicts[0]?.rating ?? null,
      // Said, not left blank. A stamp is nothing when there is no verdict, which in a grid of cells
      // reads as a fact that failed to render rather than one nobody has recorded.
      render: (e) =>
        e.verdicts[0] ? (
          <VerdictStamp verdict={e.verdicts[0]} />
        ) : (
          <span className="dim">Not rated</span>
        ),
    },
    {
      key: 'stage',
      label: 'Stage',
      same: (e) => e.stage?.stage ?? null,
      // Read-only here. Moving a flat along is a decision about one flat, and this screen is the
      // moment before that decision — the table and the flat's own view both write it.
      render: (e) => (e.stage ? stageSentence(e.stage) : <span className="dim">Not in the funnel</span>),
    },
  );

  return rows;
}

function perFoot(entry: ShortlistEntry): number | null {
  const rent = parseMonthlyPrice(entry.price);
  const area = resolveSize(sizeOf(entry))?.value ?? null;
  return rent === null || area === null || area === 0 ? null : rent / area;
}

function best(entry: ShortlistEntry, placeId: string, travel: Record<string, TravelTime[]> | undefined) {
  return readPlaceTravel(entry.postcode, placeId, travel).best;
}

function dash(why = 'Not known for this listing.') {
  return (
    <Hint text={why}>
      <span className="dim">—</span>
    </Hint>
  );
}
