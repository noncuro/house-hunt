import './journey.css';
import { Hint } from './Hint';
import { BUS_COLOUR, FALLBACK_LINE_COLOUR, LINE_COLOURS, textOn } from '@house-hunt/core';
import { WALKING_LIMIT_SECONDS, type JourneyOption, type Leg, type Place, type TravelMode, type TravelTime } from '@house-hunt/core';

/** How a journey is drawn — shared by the panel on Rightmove and the shortlist page.
 *
 *  These lived in Panel.tsx and were re-implemented, more crudely, in the shortlist: the panel
 *  grew leg-by-leg routes and a Google Maps button while the shortlist still made the bare
 *  minute count a link. Two renderings of the same fact is how the two views started
 *  disagreeing about what a place is, so there is now one.
 *
 *  The class names keep the `rm-` prefix they had in the panel's shadow-root stylesheet; the
 *  shortlist page imports the same rules from `journey.css`. */

/** Which modes are worth showing for one place, and what to say when none are.
 *
 *  Every view was deciding this for itself and reaching different answers. The panel and the card
 *  hid walks over an hour as unrealistic; the compare table did not, so a 61-minute walk showed
 *  there as the best route to somewhere the other views said was a 30-minute train. The table
 *  also called a cached "TfL says there is no journey" the same thing as "nobody has looked yet",
 *  which are opposite facts — one is settled and one is a gap you can fill by clicking. */
export interface TravelVerdict {
  /** The modes worth showing, fastest-first order left to the caller. */
  usable: TravelTime[];
  /** The fastest usable mode, or null. */
  best: TravelTime | null;
  /** A mode we asked about and never got an answer for — worth a retry. */
  transient: TravelTime | null;
  /** TfL was asked and said there is no such journey. Settled, not missing. */
  noRoute: boolean;
  /** Nothing has been computed for this pairing at all. */
  unknown: boolean;
}

/** What every transit number on screen actually measures.
 *
 *  Worth saying out loud because it is not what anyone assumes. TfL's planner, asked without a
 *  date, plans against right now — so before this was pinned, a flat opened on a Sunday evening
 *  carried a Sunday-evening commute forever, and the compare table ranked it against one measured
 *  on a Tuesday morning as though they answered the same question. Pinning it makes the numbers
 *  comparable, and saying so is what stops "17m to work" being read as "17m, whenever". */
/** Written down once. It was three identical literals — Panel, Detail and Compare — which is
 *  three chances for the shortlist to caption a number differently from the panel. */
export const MODE_ICON: Record<TravelMode, string> = { walking: '🚶', cycling: '🚲', transit: '🚇' };

/** Why the transit numbers are comparable at all, as an affordance rather than a paragraph.
 *
 *  It was three lines of body text at the top of the travel section in both views — the longest
 *  thing on screen, above the numbers it was explaining, and read once and then never again. The
 *  rule it states matters exactly when someone doubts a number, which is what a tooltip is for. */
export function TransitBasis() {
  return (
    <Hint className="rm-basis" text={TRANSIT_BASIS_NOTE}>
      weekday 09:00
    </Hint>
  );
}

export const TRANSIT_BASIS_NOTE =
  'Public transport times assume a weekday 09:00 departure, so every place is measured the same way.';

export function readTravel(rows: TravelTime[] | undefined): TravelVerdict {
  const all = rows ?? [];
  const usable = all.filter(
    (t) =>
      !t.error &&
      t.seconds > 0 &&
      // Walking anywhere over an hour away isn't a real option; showing it crowds out the numbers
      // that matter, and as a "best route" it is actively misleading.
      !(t.mode === 'walking' && t.seconds > WALKING_LIMIT_SECONDS),
  );
  const best = usable.length === 0 ? null : usable.reduce((a, b) => (b.seconds < a.seconds ? b : a));
  const transient = all.find((t) => t.error && t.transient) ?? null;
  return {
    usable,
    best,
    transient,
    noRoute: usable.length === 0 && all.some((t) => t.error && !t.transient),
    unknown: all.length === 0,
  };
}

export function formatDuration(seconds: number): string {
  const minutes = Math.round(seconds / 60);
  return minutes >= 60 ? `${Math.floor(minutes / 60)}h${minutes % 60 ? ` ${minutes % 60}m` : ''}` : `${minutes}m`;
}

/** The journeys behind a transit time: what you ride, and how much of it is on foot. Rendered
 *  as one line per route because that is how you compare them — "20 minutes but two changes"
 *  against "24 minutes direct". */
const ON_FOOT = new Set(['walking', 'cycle']);

/** The ways of making the trip, one per row.
 *
 *  This used to print every leg of every route in one wrapping row of chips, which on a Heathrow
 *  journey meant eleven chips across three wrapped lines with nothing marking where one route
 *  ended and the next began — you could not tell whether "Northern 11" belonged to the hour-two
 *  option or the hour-thirteen one. Half those chips were walking legs, and a walk between two
 *  platforms is not a thing you choose between routes on.
 *
 *  So each route is now a row with a fixed left column for the total, the lines you actually ride
 *  in order across the middle, and the walking summed into one figure at the end. What you are
 *  deciding is "an hour two changing at Baker Street, or an hour thirteen straight through" — the
 *  lines and the changes answer that; per-platform walks are noise dressed as detail. */
export function Routes({ options }: { options: JourneyOption[] }) {
  return (
    <span className="rm-routes">
      {options.map((option, i) => {
        const rides = option.legs.filter((leg) => !ON_FOOT.has(leg.mode));
        const onFoot = option.legs
          .filter((leg) => ON_FOOT.has(leg.mode))
          .reduce((total, leg) => total + leg.minutes, 0);
        // Changes are between rides, so two trains is one change. A journey with no ride at all
        // is a walk, and saying "-1 changes" about it would be worse than saying nothing.
        const changes = Math.max(0, rides.length - 1);

        return (
          <span className="rm-route" key={i}>
            <span className="rm-route-total">{formatDuration(option.minutes * 60)}</span>
            <span className="rm-route-lines">
              {rides.map((leg, j) => (
                <span className="rm-route-step" key={j}>
                  {j > 0 && <span className="rm-route-arrow">›</span>}
                  <LegChip leg={leg} />
                </span>
              ))}
              {rides.length === 0 && <span className="rm-route-quiet">on foot the whole way</span>}
            </span>
            {/* Nothing to summarise when there is no ride: "on foot the whole way" above already
                said it, and "direct · 23m walking" underneath said it again. */}
            {rides.length > 0 && (
              <span className="rm-route-quiet">
                {[
                  changes > 0 ? `${changes} change${changes === 1 ? '' : 's'}` : 'direct',
                  onFoot > 0 ? `${onFoot}m walking` : null,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
            )}
          </span>
        );
      })}
    </span>
  );
}

export function LegChip({ leg }: { leg: Leg }) {
  if (leg.mode === 'walking') return <span className="rm-leg-walk">🚶{leg.minutes}</span>;
  if (leg.mode === 'cycle') return <span className="rm-leg-walk">🚲{leg.minutes}</span>;

  // Buses are numbered rather than named, so they never match a line id and take bus red.
  const colour = leg.lineId
    ? (LINE_COLOURS[leg.lineId] ?? (leg.mode === 'bus' ? BUS_COLOUR : FALLBACK_LINE_COLOUR))
    : FALLBACK_LINE_COLOUR;
  return (
    <span className="rm-leg-line" style={{ background: colour, color: textOn(colour) }}>
      {leg.lineName ?? leg.mode}
      <span className="rm-leg-mins"> {leg.minutes}m</span>
    </span>
  );
}

/** The Google Maps pin, inline so the page needs no remote asset. */
export function MapsIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
      <path
        fill="currentColor"
        d="M12 2c-3.87 0-7 3.13-7 7 0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7m0 9.5A2.5 2.5 0 0 1 9.5 9 2.5 2.5 0 0 1 12 6.5 2.5 2.5 0 0 1 14.5 9a2.5 2.5 0 0 1-2.5 2.5"
      />
    </svg>
  );
}

/** One button per row rather than per mode: the map is the same place whichever way you'd
 *  travel, and the numbers stay numbers instead of turning into a row of links. */
export function MapsButton({
  postcode,
  place,
  mode = 'transit',
}: {
  postcode: string | null;
  place: Place;
  mode?: TravelMode;
}) {
  return (
    <button
      className="rm-maps"
      title="Open in Google Maps"
      onClick={() => window.open(mapsUrl(postcode, place, mode), '_blank', 'noopener')}
    >
      <MapsIcon />
    </button>
  );
}

/** Google Maps directions for a leg we already have a time for — the views answer "how long",
 *  and this is the one click to "which way". Origin is the postcode because that is the exact
 *  location; Rightmove's map pin is deliberately fuzzed. */
const MAPS_MODE: Record<TravelMode, string> = {
  transit: 'transit',
  walking: 'walking',
  cycling: 'bicycling',
};

export function mapsUrl(postcode: string | null, place: Place, mode: TravelMode): string {
  const destination = place.lat !== null && place.lon !== null ? `${place.lat},${place.lon}` : place.postcode;
  const params = new URLSearchParams({
    api: '1',
    origin: postcode ?? '',
    destination,
    travelmode: MAPS_MODE[mode],
  });
  return `https://www.google.com/maps/dir/?${params}`;
}
