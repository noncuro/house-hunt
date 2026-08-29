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
 *  It refuses a container with no size: Leaflet will happily fit bounds into a 0×0 map and the
 *  result is a view of nowhere. The boolean is for a caller that wants to know whether anything
 *  happened; the observer below simply calls it again on the next resize, because a size Leaflet
 *  measured a frame ago is not evidence that the layout has finished — see `chosen`.
 *
 *  `invalidateSize()` first, because `Map.getSize()` is a cache rather than a measurement: Leaflet
 *  measures the container while the map is being built and then never again until it is told to
 *  look. Without this, the guard below means "the container had no size whenever Leaflet last
 *  looked", which for a map built one tick too early is a judgement it can never revise — it would
 *  answer 0×0 for the rest of its life and refuse to frame anything, forever. One forced layout
 *  buys the guard the only version of the question worth asking. The pan `invalidateSize` does on
 *  the way is irrelevant: `fitBounds` sets the view outright a line later.
 *
 *  That is insurance rather than a diagnosis, and it is worth saying so, because three attempts on
 *  this branch went looking for a map that was framed at the wrong moment and the browser check
 *  stayed red through all of them. What it turned out to be is below. The container measured
 *  740x800 and the renderer's viewBox agreed with it: Leaflet knew its size perfectly, and every
 *  pin was still the empty path.
 *
 *  `animate: false` is the fix. Framing the pins is not a gesture — it is where the map starts, and nobody is watching it
 *  arrive — so the animation buys nothing, and what it costs is a view change that does not happen
 *  when this function returns. Leaflet's animated zoom schedules itself in a
 *  `requestAnimationFrame` and closes itself with a 250ms timer, and `setView` reports success the
 *  moment it has scheduled that: for a quarter of a second afterwards the map is at the old view
 *  with the tile layer holding back its new tiles and every marker still projected against the zoom
 *  it has left, which Leaflet draws as the empty path `M0 0`. A frame that never comes — a loaded CI
 *  runner throttling `requestAnimationFrame` is the ordinary way — drops the view change on the
 *  floor entirely, and nothing retries it. Refusing the animation takes the synchronous path
 *  instead: the view, the tiles and the markers all move before the call returns. */
function fit(instance: L.Map, located: ShortlistEntry[]): boolean {
  if (located.length === 0) return false;
  instance.invalidateSize();
  const { x, y } = instance.getSize();
  if (x === 0 || y === 0) return false;
  instance.fitBounds(L.latLngBounds(located.map((e) => [e.lat!, e.lon!] as [number, number])), {
    padding: [40, 40],
    maxZoom: 15,
    animate: false,
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
  /** Whether the view on screen is one the reader chose — by panning, by zooming, or by having
   *  left the map here last time. Nothing may re-frame over it.
   *
   *  This is deliberately *not* "have the pins been framed once". Leaflet measures its container
   *  when it is told to and not otherwise, so a fit can succeed against a size that was true for a
   *  moment and wrong by the time the layout settled — and one that "worked" is then never
   *  corrected. Ask a map that believes it is 0×0 to fit anything and it computes a nonsense centre
   *  at the world's zoom, after which every marker is outside the renderer's bounds and drawn as
   *  the empty path `M0 0`: a map that looks like a map, draws two tiles of ocean, and has no pins
   *  on it. Framing again on the next resize is what repairs that, so the only thing that may stop
   *  it is the reader having taken over.
   *
   *  Not hypothetical, and not theory either: `smoke:web` passed twice and failed once on a tree
   *  where this was `fitted` — the same commit, byte for byte — because the two cases are a race.
   *  A container measured at exactly 0×0 is refused by `fit()` and repaired on the next resize; one
   *  measured mid-layout at some other wrong size is fitted, marked done, and never repaired,
   *  because `invalidateSize` corrects the size without touching the view. The shortlist now
   *  restores from IndexedDB before the first render (`lib/persist.ts`), so this mounts with its
   *  flats already in hand rather than a frame or two later, which is what made the race close
   *  enough to lose. */
  const chosen = useRef(false);

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
    // A mouse pan is the reader taking the view. Registered here, where there is certainly an
    // instance to register on, rather than beside the wheel and pinch listeners it belongs with.
    instance.on('dragstart', () => {
      chosen.current = true;
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
      // Where you left it, deliberately unfitted — and nothing below should undo that. A view you
      // left is a view you chose, so it counts the same as a pan.
      //
      // `firstRun` is cleared above rather than held back until a run has pins. Holding it back
      // reads better — it would keep a restored view when the flats arrive a frame late — and it
      // makes `restored` a condition that never becomes false, so with an empty first run the pins
      // are never framed at all. That is #55; it is not fixable here without the harness.
      chosen.current = true;
      return;
    }
    fit(instance, located);
  }, [located, projectId]);

  /** Re-measure when the container's size changes, and re-frame until the reader takes over.
   *
   *  `invalidateSize` is Leaflet's own answer to a container that was not its current size when the
   *  map was made — the map is told to look again. A `ResizeObserver` rather than a one-off timer
   *  because there is no single moment that is safe: the pane beside the map opens and closes, the
   *  window is resized, and the first measurement can land before the layout it is measuring.
   *
   *  The re-frame is the half that matters, and it repeats on purpose. Fitting once and stopping
   *  sounds tidier and is wrong: `getSize()` is whatever Leaflet last measured, so a fit can
   *  succeed against a size that was true for one frame, leave every pin outside the view, and mark
   *  itself done. Each resize is another chance to be right about a container that is still
   *  settling.
   *
   *  What stops it is `chosen` — the reader having panned, zoomed, or arrived on a view they left
   *  here before. That is the thing a re-frame must never overwrite, and it is a narrower and more
   *  honest test than "has this run once".
   *
   *  Which gestures count is the fiddly part, and all three of these are load-bearing. `zoomstart`
   *  and `movestart` are out: `fitBounds` fires both itself, so either would stop the repair on its
   *  own first success — the trap in a different shape. `dragstart` is Leaflet's own and comes only
   *  from `Map.Drag`, so it is safe, but it is a mouse pan and nothing else: pinch-zoom runs through
   *  `Map.TouchZoom`, which calls `_moveStart` and fires neither, and there is no `wheel` on touch.
   *  So a phone needs the two-finger `touchstart` too, or a reader who pinches and then rotates the
   *  phone has their view taken off them by the resize that follows. */
  const latest = useRef(located);
  latest.current = located;
  useEffect(() => {
    const element = host.current;
    if (!element) return;

    const take = () => {
      chosen.current = true;
    };
    const pinch = (event: TouchEvent) => {
      if (event.touches.length > 1) take();
    };
    element.addEventListener('wheel', take, { passive: true });
    element.addEventListener('touchstart', pinch, { passive: true });

    // `map.current` is read inside the callback rather than captured here. The map is built in an
    // effect above and so is normally in place by now, but "normally" is the word that made the
    // rest of this comment necessary: a null there would mean no observer at all, and no repair.
    const observer =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(() => {
            const instance = map.current;
            if (!instance) return;
            instance.invalidateSize();
            if (!chosen.current) fit(instance, latest.current);
          });
    observer?.observe(element);

    return () => {
      observer?.disconnect();
      element.removeEventListener('wheel', take);
      element.removeEventListener('touchstart', pinch);
    };
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
