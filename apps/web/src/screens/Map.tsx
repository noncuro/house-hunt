'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { Icon } from '@house-hunt/ui';
import {
  groupOf,
  type HuntPreferences,
  type Hub,
  type Place,
  type TravelTime,
} from '@house-hunt/core';
import type { ShortlistEntry } from '@house-hunt/core/db';
import { FlatCard } from '@/components/FlatCard';
import { pinColour } from '@/lib/pin';

/** Every place on one map, coloured by what the two of you said.
 *
 *  Leaflet is bundled rather than loaded from a CDN — MV3 forbade remote script outright, and the
 *  website's CSP says the same thing for its own reason (`script-src 'self'`, so that nothing
 *  third-party can read the credentials handed to the extension on this origin).
 *  Markers are circleMarkers — pure SVG — which sidesteps Leaflet's default icon, whose image
 *  URLs break under a bundler, and lets the verdict pick the colour.
 *
 *  Positions come from the postcode wherever we have it. Rightmove's own pin is deliberately
 *  fuzzed, which is invisible at their zoom level and misleading at ours.
 *
 *  What changed in the redesign is what happens when you click one. A pin used to navigate — to the
 *  shortlist, scrolled to a card — which threw the map away, and coming back re-fitted it. Since
 *  looking at a map is almost always looking at several flats in the same few streets, that was the
 *  gesture being punished. The card docks at the foot instead, the map stays where you put it, and
 *  the arrow keys walk the pins in the order they run west to east. */

const LONDON: [number, number] = [51.5074, -0.1278];

/** Where the map was when you last left it, per hunt. Module-level rather than state above, because
 *  it is the map's own business and nothing else on the page has an opinion about it — and because
 *  the whole app remounts on a change of hunt (`App` is keyed on the project), so state would not
 *  survive the trip to the table and back.
 *
 *  Keyed on the project for the same reason it survives that remount at all: one map position is one
 *  hunt's, and a single slot meant switching hunts opened the new one framed on the old one's
 *  neighbourhood with none of its pins in view — and, because a restored view deliberately skips
 *  `fitBounds`, staying there. */
const lastView = new Map<string, { center: L.LatLngLiteral; zoom: number }>();

/** Frame these flats, and say whether it counted.
 *
 *  It counts only if the container had a size to frame them in: Leaflet will happily fit bounds
 *  into a 0×0 map and the result is a view of nowhere. Returning that judgement rather than
 *  assuming it is what lets the caller try again when the container turns out to have a size after
 *  all — see `fitted` in the component. */
function fit(instance: L.Map, located: ShortlistEntry[]): boolean {
  const { x, y } = instance.getSize();
  if (x === 0 || y === 0 || located.length === 0) return false;
  instance.fitBounds(L.latLngBounds(located.map((e) => [e.lat!, e.lon!] as [number, number])), {
    padding: [40, 40],
    maxZoom: 15,
  });
  return true;
}

export function ShortlistMap({
  projectId,
  entries,
  places,
  travel,
  hubs,
  prefs,
  scores,
  onOpen,
  panel = 'card',
  selected,
  onSelect,
}: {
  /** Which hunt's map this is — see `lastView`. */
  projectId: string;
  entries: ShortlistEntry[];
  places: Place[];
  travel: Record<string, TravelTime[]> | undefined;
  /** The hunt's neighbourhoods, for the docked card's compass fix. Three states — see `HubFact`. */
  hubs: Hub[] | null | undefined;
  prefs: HuntPreferences;
  scores: Map<string, number> | null;
  /** Go to the flat in full. The card beside the map is the glance; this is the rest of it. */
  onOpen: (rightmoveId: string) => void;
  /** What sits beside the map. `card` is this screen's own: the same card the grid draws, in the
   *  right-hand column. `none` is for a caller that already has a pane there and wants the map to
   *  be only the map — triage, where the right half is the flat itself and the pins are one more
   *  way into it. */
  panel?: 'card' | 'none';
  /** Which pin is chosen, when the caller is the one holding that. Passing it makes this a
   *  controlled component: the map draws the selection and reports clicks, and the parent decides
   *  what is selected — which is what stops triage having two ideas of where you are. */
  selected?: string | null;
  onSelect?: (rightmoveId: string | null) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const markers = useRef(new Map<string, L.CircleMarker>());
  const firstRun = useRef(true);
  /** Whether the pins have been framed against a container that actually had a size.
   *
   *  Leaflet measures its container once, when the map is made, and `fitBounds` works off that
   *  measurement. Ask a map that believes it is 0×0 to fit anything and it computes a nonsense
   *  centre and the world's zoom — after which every marker is outside the renderer's bounds and
   *  drawn as the empty path `M0 0`. The map then looks like a map, draws two tiles of ocean, and
   *  has no pins on it, which is the most convincing way this component can fail.
   *
   *  That is not hypothetical here: the shortlist is restored from IndexedDB before the first
   *  render now (`lib/persist.ts`), so this mounts with its flats already in hand rather than a
   *  frame or two later, and it fits against whatever the container measured at that instant. */
  const fitted = useRef(false);

  const [ownAt, setOwnAt] = useState<string | null>(null);
  const controlled = selected !== undefined;
  const at = controlled ? selected : ownAt;
  // One setter whichever way round it is, so nothing below has to know.
  const setAt = useCallback(
    (next: string | null) => {
      if (!controlled) setOwnAt(next);
      onSelect?.(next);
    },
    [controlled, onSelect],
  );
  // How many pins are inside the current viewport. Recomputed on move, because the answer to "how
  // many of these are in this bit of London" is the question a map is being asked, and it used to
  // be unanswerable without counting dots.
  const [inView, setInView] = useState<number | null>(null);

  const located = useMemo(
    () =>
      entries
        .filter((e) => e.lat !== null && e.lon !== null)
        // West to east, so the arrow keys walk a street rather than jumping across the city in
        // whatever order the shortlist happened to be sorted in.
        .sort((a, b) => a.lon! - b.lon!),
    [entries],
  );

  // The handlers are recreated on every render of the page above. Reading them through refs means
  // the marker effect does not have to re-run (and refit the viewport) just to pick up a new
  // function identity, while still never calling a stale one.
  const walk = useRef<(delta: number) => void>(() => {});
  const choose = useRef<(id: string) => void>(() => {});
  choose.current = setAt;

  const countInView = useCallback(() => {
    const instance = map.current;
    if (!instance) return;
    const bounds = instance.getBounds();
    setInView(located.filter((e) => bounds.contains([e.lat!, e.lon!])).length);
  }, [located]);

  useEffect(() => {
    if (!host.current || map.current) return;
    const saved = lastView.get(projectId) ?? null;
    const instance = L.map(host.current, { scrollWheelZoom: true }).setView(
      saved ? saved.center : LONDON,
      saved ? saved.zoom : 12,
    );
    map.current = instance;
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '© OpenStreetMap contributors',
    }).addTo(instance);
    instance.on('moveend', () => {
      lastView.set(projectId, { center: instance.getCenter(), zoom: instance.getZoom() });
    });

    const pins = markers.current;
    return () => {
      instance.remove();
      map.current = null;
      pins.clear();
    };
  // `projectId` never changes inside a mount — `App` is keyed on the hunt — so this still runs
  // once. It is in the list because the map it builds is restored from that hunt's saved view.
  }, [projectId]);

  useEffect(() => {
    const instance = map.current;
    if (!instance) return;
    instance.on('moveend', countInView);
    countInView();
    return () => {
      instance.off('moveend', countInView);
    };
  }, [countInView]);

  useEffect(() => {
    const instance = map.current;
    if (!instance) return;

    for (const marker of markers.current.values()) marker.remove();
    markers.current.clear();

    for (const entry of located) {
      const group = groupOf(entry.verdicts);
      const marker = L.circleMarker([entry.lat!, entry.lon!], {
        radius: group === 'excited' ? 10 : 7,
        color: '#fff',
        weight: 2,
        fillColor: pinColour(group),
        fillOpacity: group === 'rejected' ? 0.45 : 0.95,
      })
        .addTo(instance)
        .bindTooltip(`${entry.displayAddress}${entry.price ? ` — ${entry.price}` : ''}`)
        .on('click', () => choose.current(entry.rightmoveId));
      markers.current.set(entry.rightmoveId, marker);
    }

    // Frame everything rather than leaving the reader to find the pins. Only on a change of
    // contents — refitting on every selection would fight the person panning around — and never
    // on the first run of a mount that restored where you were, which is the same fight one step
    // removed.
    const restored = firstRun.current && lastView.has(projectId);
    firstRun.current = false;
    if (restored) {
      // Where you left it, deliberately unfitted — and nothing below should undo that.
      fitted.current = true;
      return;
    }
    if (fit(instance, located)) fitted.current = true;
  }, [located, projectId]);

  /** Re-measure when the container's size changes, and frame the pins if that never happened.
   *
   *  `invalidateSize` is Leaflet's own answer to a container that was not its current size when the
   *  map was made — the map is told to look again. A `ResizeObserver` rather than a one-off timer
   *  because there is no single moment that is safe: the pane beside the map opens and closes, the
   *  window is resized, and the first measurement can land before the layout it is measuring.
   *
   *  The re-fit is the half that matters. A map that fit against a zero-sized container did not
   *  merely fit badly — it is looking at the wrong part of the world with every pin outside it, and
   *  no amount of re-measuring moves it back. `fitted` is only set once the fit ran against a real
   *  size, so this is what repairs that case and does nothing at all in the ordinary one. */
  const latest = useRef(located);
  latest.current = located;
  useEffect(() => {
    const element = host.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      const instance = map.current;
      if (!instance) return;
      instance.invalidateSize();
      if (!fitted.current) fit(instance, latest.current);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // The pin under the docked card, panned to and highlighted. `panTo` rather than `setView` on
  // purpose: walking the pins must not change the zoom you chose.
  useEffect(() => {
    const marker = at ? markers.current.get(at) : undefined;
    if (!marker || !map.current) return;
    marker.openTooltip();
    marker.setStyle({ color: 'var(--ink)', weight: 3 });
    map.current.panTo(marker.getLatLng());
    return () => {
      marker.setStyle({ color: '#fff', weight: 2 });
    };
  }, [at]);

  walk.current = (delta: number) => {
    if (located.length === 0) return;
    const from = at ? located.findIndex((e) => e.rightmoveId === at) : -1;
    // Stops at both ends rather than wrapping: coming back round to the far side of London reads as
    // the map having jumped rather than as the list having run out.
    const next = Math.max(0, Math.min(located.length - 1, from + delta));
    setAt(located[next]!.rightmoveId);
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // Not while somebody is typing — the note field on the card beside the map is a text input on
      // this very screen.
      if (event.target instanceof HTMLElement && event.target.closest('input, textarea, select')) return;
      if (event.key === 'ArrowRight') walk.current(1);
      else if (event.key === 'ArrowLeft') walk.current(-1);
      else if (event.key === 'Escape') setAt(null);
      else return;
      event.preventDefault();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [setAt]);

  const missing = entries.length - located.length;
  const fuzzed = located.filter((e) => !e.exactLocation).length;
  const current = at ? (located.find((e) => e.rightmoveId === at) ?? null) : null;

  return (
    <div className={panel === 'card' ? 'mapview-split' : 'mapview-only'}>
      <div className="mapview" data-testid="map">
        <div className="map" ref={host} />

        {/* Over the map at its top edge: what is under this viewport, and the two caveats about what
            is not drawn. These were three separate lines below the map, where the one number people
            wanted — how many are in this bit of London — was not among them. */}
        <div className="map-facts">
          <span className="map-count" data-testid="map-in-view">
            {inView === null ? '—' : inView} of {located.length} in view
          </span>
          {missing > 0 && (
            <span className="dim" title="No postcode and no pin from Rightmove.">
              {missing} not on the map
            </span>
          )}
          {fuzzed > 0 && (
            <span className="dim" title="Placed from Rightmove's approximate pin rather than the postcode.">
              {fuzzed} approximate
            </span>
          )}
        </div>
      </div>

      {/* Beside the map rather than floating over its foot. The dock covered the pins nearest the
          thing you had just clicked, which are the ones you are comparing it against — and it made
          the map narrower exactly when you wanted it wider. */}
      {panel === 'card' && (
        <aside className="map-side" data-testid="map-dock">
          {current ? (
            <>
              <div className="map-side-bar">
                <button
                  type="button"
                  className="key"
                  aria-label="Previous"
                  disabled={located[0]?.rightmoveId === current.rightmoveId}
                  onClick={() => walk.current(-1)}
                >
                  <Icon name="back" size={12} />
                </button>
                <button
                  type="button"
                  className="key"
                  aria-label="Next"
                  disabled={located.at(-1)?.rightmoveId === current.rightmoveId}
                  onClick={() => walk.current(1)}
                >
                  <Icon name="forward" size={12} />
                </button>
                <span className="dim map-side-hint">← → walks the pins</span>
                <button type="button" className="key" aria-label="Close" onClick={() => setAt(null)}>
                  <Icon name="close" size={12} />
                </button>
              </div>
              {/* The same card the grid draws. A map that summarised a flat its own way would be the
                  fifth renderer of the same six facts. */}
              <FlatCard
                entry={current}
                places={places}
                travel={travel}
                hubs={hubs}
                prefs={prefs}
                score={scores?.get(current.rightmoveId)}
                onOpen={onOpen}
              />
            </>
          ) : (
            <p className="dim map-side-empty">
              Pick a pin and the flat shows up here.{' '}
              {/* The clause rather than the keycaps: hiding the two `kbd`s alone would leave
                  "walk them west to east" hanging off the end of the sentence before it. */}
              <span className="keys-only">
                <kbd>←</kbd> <kbd>→</kbd> walk them west to east.
              </span>
            </p>
          )}
        </aside>
      )}
    </div>
  );
}
