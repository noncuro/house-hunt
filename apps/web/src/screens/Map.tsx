'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { DEFAULT_SHOWING, groupOf, type Group } from '@house-hunt/core';
import type { ShortlistEntry } from '@house-hunt/core/db';

/** Every place on one map, coloured by what the two of you said.
 *
 *  Leaflet is bundled rather than loaded from a CDN — MV3 forbade remote script outright, and the
 *  website's CSP says the same thing for its own reason (`script-src 'self'`, so that nothing
 *  third-party can read the credentials handed to the extension on this origin).
 *  Markers are circleMarkers — pure SVG — which sidesteps Leaflet's default icon, whose image
 *  URLs break under a bundler, and lets the verdict pick the colour.
 *
 *  Positions come from the postcode wherever we have it. Rightmove's own pin is deliberately
 *  fuzzed, which is invisible at their zoom level and misleading at ours. */
const COLOUR: Record<Group, string> = {
  excited: '#1a7f5a',
  maybe: '#d8a33a',
  rejected: '#9aa7b2',
  unrated: '#4a7fb5',
};

/** What each colour means, in the order you care about them. Four unexplained shades of dot is
 *  a puzzle, not a map — and the legend doubles as the filter, so the thing that tells you what
 *  a colour means is also the thing that turns it off. */
const LEGEND: Array<{ group: Group; label: string }> = [
  { group: 'excited', label: 'Excited' },
  { group: 'maybe', label: 'Maybe' },
  { group: 'unrated', label: 'Not yet rated' },
  { group: 'rejected', label: 'Rejected' },
];

const LONDON: [number, number] = [51.5074, -0.1278];

export function ShortlistMap({
  entries,
  onSelect,
  selectedId,
}: {
  entries: ShortlistEntry[];
  onSelect: (rightmoveId: string) => void;
  selectedId: string | null;
}) {
  const host = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const markers = useRef(new Map<string, L.CircleMarker>());

  // Rejecting a place is how you get it out of your way, and a map that keeps showing it has
  // undone that. Rejected and unrated start off (see `DEFAULT_SHOWING`); the legend turns either
  // back on when you want to check whether you've already ruled out a whole street, or see where
  // the ones you haven't got to yet are.
  const [showing, setShowing] = useState<Record<Group, boolean>>(DEFAULT_SHOWING);

  // The click handler is recreated on every render of the page above. Reading it through a ref
  // means the marker effect doesn't have to re-run (and refit the viewport) just to pick up a
  // new function identity, while still never calling a stale one.
  const select = useRef(onSelect);
  select.current = onSelect;

  const counts = useMemo(() => {
    const tally: Record<Group, number> = { excited: 0, maybe: 0, rejected: 0, unrated: 0 };
    for (const entry of entries) tally[groupOf(entry.verdicts)] += 1;
    return tally;
  }, [entries]);

  const visible = useMemo(
    () => entries.filter((e) => showing[groupOf(e.verdicts)]),
    [entries, showing],
  );

  useEffect(() => {
    if (!host.current || map.current) return;
    map.current = L.map(host.current, { scrollWheelZoom: true }).setView(LONDON, 12);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '© OpenStreetMap contributors',
    }).addTo(map.current);

    const pins = markers.current;
    return () => {
      map.current?.remove();
      map.current = null;
      pins.clear();
    };
  }, []);

  useEffect(() => {
    const instance = map.current;
    if (!instance) return;

    for (const marker of markers.current.values()) marker.remove();
    markers.current.clear();

    const located = visible.filter((e) => e.lat !== null && e.lon !== null);
    for (const entry of located) {
      const group = groupOf(entry.verdicts);
      const marker = L.circleMarker([entry.lat!, entry.lon!], {
        radius: group === 'excited' ? 10 : 7,
        color: '#fff',
        weight: 2,
        fillColor: COLOUR[group],
        fillOpacity: group === 'rejected' ? 0.45 : 0.95,
      })
        .addTo(instance)
        .bindTooltip(`${entry.displayAddress}${entry.price ? ` — ${entry.price}` : ''}`)
        .on('click', () => select.current(entry.rightmoveId));
      markers.current.set(entry.rightmoveId, marker);
    }

    // Frame everything rather than leaving the reader to find the pins. Only on a change of
    // contents — refitting on every selection would fight the person panning around.
    if (located.length > 0) {
      instance.fitBounds(L.latLngBounds(located.map((e) => [e.lat!, e.lon!] as [number, number])), {
        padding: [40, 40],
        maxZoom: 15,
      });
    }
  }, [visible]);

  useEffect(() => {
    const marker = selectedId ? markers.current.get(selectedId) : undefined;
    if (marker && map.current) {
      marker.openTooltip();
      map.current.panTo(marker.getLatLng());
    }
  }, [selectedId]);

  const missing = visible.filter((e) => e.lat === null || e.lon === null).length;
  const fuzzed = visible.filter((e) => e.lat !== null && !e.exactLocation).length;

  return (
    <>
      <div className="legend">
        {LEGEND.map(({ group, label }) => (
          <button
            key={group}
            className={showing[group] ? 'key key-on' : 'key'}
            aria-pressed={showing[group]}
            onClick={() => setShowing((s) => ({ ...s, [group]: !s[group] }))}
          >
            <span className="key-dot" style={{ background: COLOUR[group] }} aria-hidden="true" />
            {label} <span className="dim">{counts[group]}</span>
          </button>
        ))}
      </div>

      <div className="map" ref={host} />

      {(missing > 0 || fuzzed > 0) && (
        <p className="dim map-note">
          {missing > 0 && `${missing} not shown — no location. `}
          {fuzzed > 0 && `${fuzzed} placed from Rightmove's approximate pin rather than the postcode.`}
        </p>
      )}
    </>
  );
}
