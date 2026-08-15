import './hub.css';
import { Hint } from './Hint';
import { NO_HUB_NEARBY, type Hub, hubLabel, nearestHub } from '@house-hunt/core';
import type { Point } from '@house-hunt/core';

/** Where a listing is, said the way you actually hold a city in your head: a neighbourhood you
 *  know, how far out of it, and which way.
 *
 *  A postcode is a lookup, not a location, and "0.3 miles from Angel station" leaves out the half
 *  of the answer that decides whether you'd live there — Upper Street or the far side of the City
 *  Road roundabout are the same distance and not the same place. So the direction is drawn as a
 *  compass needle rather than only spelled, because a bearing is a picture and reads as one.
 *
 *  One component for both views. The panel and the shortlist have twice now disagreed about the
 *  same fact by each rendering it themselves — the floor area, and the travel times — and a
 *  bearing is a worse thing to disagree about than either, because there is nothing on screen
 *  that would look wrong. */

/** The dial. Inline SVG because MV3 forbids remote assets outright, and because at this size a
 *  bitmap would need three of them for the displays these two laptops have between them.
 *
 *  Drawn in a 24-unit box and painted at 22px: a ring, a tick at north so the dial is readable
 *  without a legend, and a needle running along the bearing. The needle is rotated rather than
 *  computed point-by-point, so there is exactly one place the angle enters the drawing. */
export function Compass({ bearing, size = 22 }: { bearing: number; size?: number }) {
  return (
    <svg
      className="rm-hub-dial"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
    >
      <circle className="rm-hub-ring" cx="12" cy="12" r="9" />
      <line className="rm-hub-north" x1="12" y1="0.6" x2="12" y2="2.2" />
      {/* SVG rotates clockwise from the +y axis pointing down, which is the same convention a
          compass bearing uses once north is up — so the angle goes in unconverted. */}
      <g transform={`rotate(${bearing} 12 12)`}>
        <polygon className="rm-hub-needle" points="12,4.5 14.4,13 12,11.5 9.6,13" />
        <polygon className="rm-hub-tail" points="12,19.5 14.4,11 12,12.5 9.6,11" />
      </g>
    </svg>
  );
}

/** The fix for one listing.
 *
 *  `point` distinguishes three states that are easy to conflate and mean opposite things: still
 *  being looked up, looked up and not found, and found. A blank for the first two would read as
 *  "this place is nowhere near anywhere", which is a judgement we have not made. `hubs` carries
 *  the same three states for the same reason — see below. */
export function HubFact({
  point,
  hubs,
  approximate = false,
}: {
  point: Point | null | undefined;
  /** The places this hunt cares about, through `hubsFromProject` — which drops the ones with no
   *  coordinate and marks which are searched around rather than merely commuted to.
   *
   *  Required, and threaded from whichever view is rendering this, because there is no list this
   *  component could fall back to that would be right: hubs are a project's own rows now, and a
   *  default would put one house hunt's neighbourhood on another's flat and read as a fact.
   *
   *  Three states, like `point`. `undefined` is the list still being read; `null` is the read
   *  having failed, which is said out loud rather than collapsed into "nothing nearby" — the two
   *  look identical on screen and mean opposite things. An empty array is a real answer: a house
   *  hunt with no neighbourhoods yet. */
  hubs: Hub[] | null | undefined;
  /** True when the position came from Rightmove's map pin, which is deliberately fuzzed
   *  (`pinType: "APPROXIMATE_POINT"`). Fine for a distance, dubious for a bearing over a few
   *  hundred yards, so it is marked rather than presented as a measurement. */
  approximate?: boolean;
}) {
  if (point === undefined || hubs === undefined) {
    return <span className="rm-hub-none rm-hub-working">placing…</span>;
  }
  if (point === null) return <span className="rm-hub-none">no location</span>;

  // The neighbourhoods could not be read. Rendering "no hub within a mile" here would be a claim
  // about this flat's geography made on no evidence, and it is the claim a reader would believe.
  if (hubs === null) {
    return (
      <Hint
        className="rm-hub-none rm-hub-failed"
        text="This house hunt's places could not be read, so there is nothing to measure against. It is a failed read, not a flat in the middle of nowhere — reload, and check Your Hunt → Places if it persists."
      >
        places unavailable
      </Hint>
    );
  }

  // A brand new house hunt has no neighbourhoods and may have no places either (design D11). That
  // is not "nothing is nearby", it is nothing to be near — and the fix for it is a different one.
  if (hubs.length === 0) {
    return (
      <Hint
        className="rm-hub-none"
        text="This house hunt has no places with resolved coordinates, so there is nothing to fix this listing against. Add one in Your Hunt → Places."
      >
        nothing to place this against
      </Hint>
    );
  }

  const fix = nearestHub(point, hubs);
  if (!fix) {
    // Naming the closest hub anyway is the failure mode this exists to prevent: "Angel" on
    // somewhere two miles into Hackney is read as a fact and acted on.
    return (
      <Hint
        className="rm-hub-none"
        text={`None of ${hubs.map((h) => h.name).join(', ')} is within a mile of this postcode.`}
      >
        {NO_HUB_NEARBY}
      </Hint>
    );
  }

  const label = hubLabel(fix);
  return (
    <Hint
      className={approximate ? 'rm-hub rm-hub-approx' : 'rm-hub'}
      underline={false}
      text={
        `${label} — ${Math.round(fix.bearing)}° from the station, as the crow flies.` +
        (approximate
          ? '\n\nPlaced from Rightmove’s approximate pin rather than the postcode, so the direction is rough.'
          : '')
      }
    >
      <Compass bearing={fix.bearing} />
      <span className="rm-hub-name">
        {label}
        {approximate && '*'}
      </span>
    </Hint>
  );
}
