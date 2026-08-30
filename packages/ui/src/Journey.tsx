import './journey.css';
import type { ReactNode } from 'react';
import { Hint } from './Hint';
import { Icon } from './Icon';
import { BUS_COLOUR, FALLBACK_LINE_COLOUR, LINE_COLOURS, textOn, travelDestinations, TRAVEL_MODES } from '@house-hunt/core';
import { WALKING_LIMIT_SECONDS, readTravel, type JourneyOption, type Leg, type Place, type TravelMode, type TravelTime, type TravelVerdict } from '@house-hunt/core';

/** How a journey is drawn — shared by the panel on Rightmove and the shortlist page.
 *
 *  These lived in Panel.tsx and were re-implemented, more crudely, in the shortlist: the panel
 *  grew leg-by-leg routes and a Google Maps button while the shortlist still made the bare
 *  minute count a link. Two renderings of the same fact is how the two views started
 *  disagreeing about what a place is, so there is now one.
 *
 *  The class names keep the `rm-` prefix they had in the panel's shadow-root stylesheet; the
 *  shortlist page imports the same rules from `journey.css`. */

/** What every transit number on screen actually measures.
 *
 *  Worth saying out loud because it is not what anyone assumes. TfL's planner, asked without a
 *  date, plans against right now — so before this was pinned, a flat opened on a Sunday evening
 *  carried a Sunday-evening commute forever, and the compare table ranked it against one measured
 *  on a Tuesday morning as though they answered the same question. Pinning it makes the numbers
 *  comparable, and saying so is what stops "17m to work" being read as "17m, whenever". */
/** Written down once. It was three identical emoji literals — Panel, Detail and Compare — which is
 *  three chances for the shortlist to caption a number differently from the panel, and three
 *  glyphs that rendered as a different picture on every operating system. */
export const MODE_LABEL: Record<TravelMode, string> = {
  walking: 'walk',
  cycling: 'cycle',
  transit: 'public transport',
};

/** The mode, as a picture. `label` names it for a screen reader, and is for the one place these
 *  stand alone: the travel grid's column heads, where there are no words beside them. */
export function ModeIcon({
  mode,
  size = 14,
  label = false,
}: {
  mode: TravelMode;
  size?: number;
  label?: boolean;
}) {
  return <Icon name={mode} size={size} label={label ? MODE_LABEL[mode] : undefined} />;
}

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
  // TfL's own leg modes, which are not our `TravelMode` — 'cycle' rather than 'cycling'.
  if (leg.mode === 'walking' || leg.mode === 'cycle') {
    return (
      <span className="rm-leg-walk">
        <Icon name={leg.mode === 'cycle' ? 'cycling' : 'walking'} size={12} />
        {leg.minutes}
      </span>
    );
  }

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
  // Coordinates first, then the postcode. A place with neither is not a destination at all — a
  // neighbourhood we sweep around — and never reaches here, but an empty `destination` would send
  // Google Maps a route to nowhere rather than failing, so it is spelled out.
  const destination =
    place.lat !== null && place.lon !== null ? `${place.lat},${place.lon}` : (place.postcode ?? '');
  const params = new URLSearchParams({
    api: '1',
    origin: postcode ?? '',
    destination,
    travelmode: MAPS_MODE[mode],
  });
  return `https://www.google.com/maps/dir/?${params}`;
}

/** Every destination against every mode, on a fixed grid.
 *
 *  The rows this replaces drew only the modes that had an answer, so each place showed a different
 *  number of figures in a different order — one row read "12m 34m", the next "48m", and the eye had
 *  to re-read the icons on every line to find out which was which. Nothing lined up, so the one
 *  comparison anybody actually makes — is work further than the shops, and by how much — could not
 *  be made down a column. Worse, a mode that was missing looked exactly like a mode we had not
 *  thought worth showing.
 *
 *  Three columns, always, headed once. A cell with no number gets an em dash in `--dash` and says
 *  why on hover, because the four ways a number can be missing are genuinely different facts: TfL
 *  was asked and says there is no such journey; TfL was asked and did not answer; nobody has asked
 *  yet; or the answer exists and is not a real option (an hour and a half on foot). Only the second
 *  is worth retrying and only the third will fill itself in, and a blank cell says none of that. */

/** One line of the grid, handed to `actions` so the caller decides what goes at the end of it. */
export interface TravelRow {
  place: Place;
  /** Every row we hold for this place — all three modes, failures included. */
  times: TravelTime[];
  /** Those rows read (`readTravel`). `transient` is what says a retry is worth offering. */
  verdict: TravelVerdict;
}

export function TravelGrid({
  places,
  travel,
  postcode,
  heading = (
    <>
      Travel · <TransitBasis />
    </>
  ),
  actions,
}: {
  places: Place[];
  /** Every travel row we hold for this flat's postcode. Null while they are still being read —
   *  which is not the same as an empty list, and must not draw a grid of dashes. */
  travel: TravelTime[] | null;
  postcode: string | null;
  /** What sits above the place column. Defaults to the label the shortlist has always drawn; pass
   *  `null` where the surrounding section heading already says it, as the panel's does. The cell
   *  is still emitted either way — see the auto-placement note on the head row. */
  heading?: ReactNode;
  /** A trailing cell per line — the panel's retry and Maps buttons. Absent means no fifth column
   *  exists at all, which is what keeps the website's grid exactly the width it is today. */
  actions?: (row: TravelRow) => ReactNode;
}) {
  // Routing is postcode to postcode, so a place without one has no journey rather than a failed
  // one — see `travelDestinations`.
  const destinations = travelDestinations(places);

  if (destinations.length === 0) {
    // Two reasons for an empty grid, and one sentence for both would send somebody off to add a
    // postcode when what they did was turn every place off. A blank that names the wrong
    // cause is the same failure as a blank that names none.
    return (
      <div className="rm-empty">
        {places.some((p) => p.postcode !== null)
          ? 'No place is timed — turn one on under Your Hunt'
          : 'Nowhere to measure to — add somewhere with a postcode, on the website'}
      </div>
    );
  }
  if (!postcode) return <div className="rm-empty">No postcode on this listing, so nothing can be routed from it</div>;
  if (travel === null) return <div className="rm-empty rm-working">Working…</div>;

  return (
    <div className={actions ? 'rm-travel rm-travel-wide' : 'rm-travel'}>
      <div className="rm-travel-head">
        <span className="rm-travel-label">{heading}</span>
        {TRAVEL_MODES.map((mode) => (
          <span className="rm-travel-mode" key={mode}>
            <ModeIcon mode={mode} label />
          </span>
        ))}
        {/* The rows are `display: contents`, so every child is auto-placed into the parent grid
            in document order. With a fifth column declared, a four-cell head would put the first
            place label in the head row's fifth cell — a one-off-looking layout glitch that is
            actually a rule — so the head emits a matching empty trailing cell. */}
        {actions && <span className="rm-travel-mode" aria-hidden="true" />}
      </div>

      {destinations.map((place) => {
        const rows = travel.filter((t) => t.placeId === place.id);
        const verdict = readTravel(rows);
        return (
          <div className="rm-travel-row" key={place.id}>
            <span className="rm-travel-place">{place.label}</span>
            {TRAVEL_MODES.map((mode) => (
              <TravelCell
                key={mode}
                mode={mode}
                row={rows.find((t) => t.mode === mode)}
                fastest={verdict.best?.mode === mode}
              />
            ))}
            {actions && <span className="rm-travel-acts">{actions({ place, times: rows, verdict })}</span>}
          </div>
        );
      })}
    </div>
  );
}

/** One number, or one honest dash. */
function TravelCell({
  mode,
  row,
  fastest,
}: {
  mode: TravelMode;
  row: TravelTime | undefined;
  fastest: boolean;
}) {
  if (row === undefined) {
    return <Dash why={`Nobody has looked up the ${MODE_LABEL[mode]} time to here yet — the backfill fills these in.`} />;
  }
  if (row.error) {
    return (
      <Dash
        why={
          row.transient
            ? `TfL did not answer when we asked for the ${MODE_LABEL[mode]} time: ${row.error}`
            : // Not "TfL says": the row carries who settled it and why, and TfL is no longer always
              // the answer. A walk further off than an hour on foot could cover is refused before
              // any call is made, and putting TfL's name on that verdict is a tooltip lying with
              // confidence about a thing that never happened.
              `No ${MODE_LABEL[mode]} time for this trip — ${row.error}`
        }
      />
    );
  }
  if (mode === 'walking' && row.seconds > WALKING_LIMIT_SECONDS) {
    return <Dash why={`${formatDuration(row.seconds)} on foot — over an hour, so not a real way of making this trip.`} />;
  }
  // A zero is not a journey; it is a lookup that came back with nothing in it, which the error
  // path above did not catch. Saying so beats printing "0m".
  if (row.seconds <= 0) {
    return <Dash why={`The ${MODE_LABEL[mode]} lookup came back with no duration at all.`} />;
  }

  // Only transit has a route worth explaining — walking and cycling are one leg, and "you walk,
  // for 15 minutes" is not worth a hover. The condition is the data, not a flag: `options` is
  // populated on both surfaces because both go through the same `travelTimes`, so a boolean prop
  // would be a second, weaker condition on top of a sufficient one. The class goes on the `Hint`
  // itself, not a nested span — `Hint` forwards it onto its own element, and that element has to
  // stay the grid item.
  const className = fastest ? 'rm-travel-time rm-travel-best' : 'rm-travel-time';
  if (mode === 'transit' && row.options && row.options.length > 0) {
    return (
      <Hint className={className} underline={false} text={<Routes options={row.options} />}>
        {formatDuration(row.seconds)}
      </Hint>
    );
  }
  return <span className={className}>{formatDuration(row.seconds)}</span>;
}

function Dash({ why }: { why: string }) {
  return (
    <Hint className="rm-travel-time rm-travel-dash" underline={false} text={why}>
      —
    </Hint>
  );
}
