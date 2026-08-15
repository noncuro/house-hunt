'use client';

import { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { nearestHub, type Hub, type Point } from '@house-hunt/core';
import { cssToken } from '@/lib/pin';

/** A map of one flat, in the pane that flat is being read in, behind a button.
 *
 *  `HubFact` a line above already says "0.4 mi NE of Angel", which is the sentence — this is the
 *  picture behind it: the flat, the hubs it sits between, and the streets in between them. Deciding
 *  whether somewhere is anywhere you would live is most of what triage is, and the full Map view
 *  answers it one flat at a time with a view change in each direction and the pile lost on the way.
 *
 *  Behind a button rather than always drawn, because the pane is re-pointed at a new flat every few
 *  seconds and a map on every one of them is several hundred tile requests for a walk past places
 *  you have already decided about. Asking is also the honest default: you want the streets for one
 *  flat at a time.
 *
 *  Same tiles, same colours and the same postcode-derived position as `screens/Map.tsx` — a picture
 *  that placed a flat somewhere the map screen doesn't would be worse than no picture. */

/** What the map opens on, in miles either side of the flat. Wide enough that a named hub within
 *  the usual mile is on screen with its label, tight enough that the streets are still streets —
 *  and only a starting point, since you can zoom. */
const HALF_SPAN_MILES = 0.45;

/** Degrees per mile. Latitude is near enough constant; longitude is divided by cos(lat) at the
 *  point itself, so the box stays square on screen at London's latitude rather than squashing. */
const MILES_PER_DEGREE_LAT = 69.05;

export function CardMap({
  point,
  hubs,
  colour,
  approximate,
  address,
}: {
  point: Point | null;
  hubs: Hub[] | null | undefined;
  /** The verdict's colour, so a card's dot and the same flat's pin on the Map view match. */
  colour: string;
  approximate: boolean;
  address: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const [open, setOpen] = useState(false);
  const [tilesFailed, setTilesFailed] = useState(false);

  // The coordinates, not the object. `point` is built fresh on every render of the card, so as an
  // effect dependency it changed every time anything on the page did — rating another flat tore
  // this map down and rebuilt it, throwing away wherever you had panned to and asking for every
  // tile again.
  const lat = point?.lat ?? null;
  const lon = point?.lon ?? null;

  useEffect(() => {
    if (!open || lat === null || lon === null || !host.current || map.current) return;
    const point = { lat, lon };
    const lonScale = Math.cos((point.lat * Math.PI) / 180);
    const dLat = HALF_SPAN_MILES / MILES_PER_DEGREE_LAT;
    const dLon = dLat / lonScale;

    // Zoom yes, pan yes; both are how you answer "and what is round the corner". Scroll-wheel zoom
    // is off and ctrl+wheel on instead: a map in the middle of a scrolling list that swallowed the
    // wheel would trap the page every time you passed one.
    const instance = L.map(host.current, {
      attributionControl: false,
      scrollWheelZoom: false,
    }).fitBounds(
      L.latLngBounds([point.lat - dLat, point.lon - dLon], [point.lat + dLat, point.lon + dLon]),
    );
    map.current = instance;

    // The attribution OpenStreetMap's licence asks for, same words as the Map view. Leaflet's own
    // control is off — it puts a link in the corner of a thumbnail the size of a postcard — so the
    // credit is rendered as a line under the map instead, where it is readable.
    //
    // A tile that will not load is reported. Leaflet's own answer to a refused or throttled tile is
    // to leave the square blank, so a rate-limited map and a map of somewhere with no streets look
    // the same, and the second one is a fact about the flat.
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 })
      .on('tileerror', () => setTilesFailed(true))
      .addTo(instance);

    // Every hub the flat could be placed against, named on the map rather than in a legend a card
    // has no room for. `nearestHub`'s own answer is marked, so the picture and the sentence beside
    // it agree about which neighbourhood this is. Drawn whether or not it is in the opening frame,
    // since zooming out is the point.
    const fix = hubs ? nearestHub(point, hubs) : null;
    for (const hub of hubs ?? []) {
      const isFix = hub.name === fix?.hub.name;
      L.circleMarker([hub.lat, hub.lon], {
        radius: 4,
        color: cssToken('--white', '#fff'),
        weight: 1.5,
        fillColor: isFix ? cssToken('--ink', '#241f1a') : cssToken('--faint', '#9a927f'),
        fillOpacity: 1,
      })
        .addTo(instance)
        .bindTooltip(hub.name, {
          permanent: true,
          direction: 'right',
          className: `card-map-hub${isFix ? ' card-map-hub-fix' : ''}`,
        });
    }

    L.circleMarker([point.lat, point.lon], {
      radius: 8,
      color: cssToken('--white', '#fff'),
      weight: 2.5,
      fillColor: colour,
      fillOpacity: 0.95,
    }).addTo(instance);

    return () => {
      instance.remove();
      map.current = null;
    };
  }, [open, lat, lon, hubs, colour]);

  // A missing location is a real fact about the listing rather than a hole in the page, and a
  // button that opened a blank grey square would say the opposite.
  if (!point) {
    return <p className="card-map-missing dim">No location for this listing — nothing to map.</p>;
  }

  return (
    <div className="card-map-wrap">
      <button className="card-map-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? 'Hide map' : 'Show map'}
      </button>
      {open && (
        <>
          <div className="card-map" ref={host} role="img" aria-label={`Map of ${address}`} />
          {tilesFailed && (
            <span className="card-map-note card-map-failed">
              The map tiles would not load — the streets below are missing, not absent.
            </span>
          )}
          {approximate && (
            <span className="card-map-note dim">Rightmove's approximate pin, not the postcode.</span>
          )}
          <span className="card-map-note dim">© OpenStreetMap contributors</span>
        </>
      )}
    </div>
  );
}
