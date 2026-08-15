'use client';

import {
  addressBesidePostcode,
  flagsFor,
  galleryFor,
  groupOf,
  resolveSize,
  sizeOf,
  stageSentence,
  stationDistance,
  travelDestinations,
  type Flag,
  type Hub,
  type HuntPreferences,
  type Place,
  type TravelTime,
} from '@house-hunt/core';
import type { ShortlistEntry } from '@house-hunt/core/db';
import {
  FlagChip,
  HubFact,
  Icon,
  ScoreGauge,
  VerdictStamp,
  formatDuration,
  readTravel,
} from '@house-hunt/ui';
import { isSurprise } from '@/lib/score';

/** One flat, condensed to what decides whether you look closer.
 *
 *  The card used to be the whole flat at the full width of the page — photos, the travel table, the
 *  verdict buttons, the stage picker, the note field — which was right while the shortlist was the
 *  only screen and is wrong now that there are four renderings of it. Seventeen of these down a
 *  single column is a lot of scrolling to answer "which of these is worth a viewing"; three across,
 *  each saying its rent, its size, its commute and the one thing against it, answers that in a
 *  glance, and the arrow opens the rest.
 *
 *  Six facts, in the order they decide anything: what it costs, how big it is, where it is, what
 *  the photos said, what we think of it, and how far it has got. Nothing else fits, and adding a
 *  seventh is what turned the old card into a page. */
export function FlatCard({
  entry,
  places,
  travel,
  hubs,
  prefs,
  score,
  onOpen,
}: {
  entry: ShortlistEntry;
  places: Place[];
  /** Every travel row we hold, keyed by postcode — the cache and nothing else. A card must never
   *  fire a journey lookup: a grid of twenty-five would be twenty-five TfL calls on scroll. */
  travel: Record<string, TravelTime[]> | undefined;
  /** The hunt's neighbourhoods, for the compass fix — same three states `HubFact` documents, and
   *  optional only because the grid can render before the places have been read. An unpassed one
   *  says "placing…" for good, which is loud rather than a blank pretending to be an answer. */
  hubs?: Hub[] | null;
  prefs: HuntPreferences;
  score?: number;
  onOpen: (rightmoveId: string) => void;
}) {
  const group = groupOf(entry.verdicts);
  const images = galleryFor(entry);
  const plan = entry.floorplanUrl;
  // The floorplan leads, because it is the thing that answers "is the second bedroom real" and the
  // one image Rightmove buries. Everything else after it, and the count says how many are left.
  const lead = images.find((url) => url !== plan) ?? null;
  const rest = images.length - (lead ? 1 : 0) - (plan ? 1 : 0);

  const stations = stationsLine(entry);
  const flags = flagsFor(
    { analysis: entry.analysis, bedrooms: entry.bedrooms, floorplanUrl: entry.floorplanUrl, size: sizeOf(entry) },
    prefs,
  );

  return (
    <article
      className={`flat flat-${group}`}
      id={`card-${entry.rightmoveId}`}
      data-testid="flat-card"
    >
      <button
        type="button"
        className="flat-shots"
        aria-label={`Open ${entry.displayAddress}`}
        onClick={() => onOpen(entry.rightmoveId)}
      >
        <span className="flat-shot flat-shot-photo">
          {lead ? <img src={lead} alt="" loading="lazy" /> : <span className="flat-shot-none">no photo</span>}
        </span>
        <span className="flat-shot flat-shot-plan">
          {plan ? <img src={plan} alt="" loading="lazy" /> : null}
          <span className="flat-shot-tag">{plan ? 'floorplan' : 'no floorplan'}</span>
          {rest > 0 && <span className="flat-shot-more">+{rest}</span>}
        </span>
      </button>

      <div className="flat-body">
        <div className="flat-head">
          <button type="button" className="flat-address" onClick={() => onOpen(entry.rightmoveId)}>
            {addressBesidePostcode(entry.displayAddress, entry.postcode)}
          </button>
          {entry.price && <span className="flat-rent">{entry.price}</span>}
        </div>

        <p className="flat-meta">{summarise(entry, places, travel)}</p>

        {/* Where it is, which the redesign moved to the detail pane and which turns out to be what
            you scan a card for: a postcode places nothing, and "0.4 mi NE of Angel · Angel 0.3 mi"
            is the whole answer without opening anything. */}
        <p className="flat-meta flat-where">
          <HubFact point={pointOf(entry)} hubs={hubs} approximate={!entry.exactLocation} />
          {stations && <span className="flat-stations">{stations}</span>}
        </p>

        {/* At most three. A card carrying every flag it has is a card whose flags are not read —
            and the two that matter are the worst one and the best one, which is what `pickFlags`
            chooses. The rest are on the flat itself, one click away. */}
        {flags.length > 0 && (
          <div className="flat-flags">
            {pickFlags(flags).map((flag) => (
              <FlagChip flag={flag} key={flag.key} />
            ))}
            {flags.length > 3 && <span className="flat-flags-more">+{flags.length - 3}</span>}
          </div>
        )}

        <div className="flat-foot">
          {/* The verdict as a stamp, said once. It used to be here as a coloured phrase, again as
              an attribution line, and a third time as the pressed rating button — three renderings
              of one fact, on a card whose whole job is to be scannable. */}
          {entry.verdicts[0] ? (
            <VerdictStamp verdict={entry.verdicts[0]} />
          ) : score !== undefined ? (
            <ScoreGauge score={score} surprise={isSurprise(entry, score)} />
          ) : (
            <span className="dim">Not rated</span>
          )}
          <span className="flat-stage">
            {entry.stage ? stageSentence(entry.stage) : <span className="dim">Not in the funnel</span>}
          </span>
          <button
            type="button"
            className="flat-open"
            aria-label={`Open ${entry.displayAddress}`}
            onClick={() => onOpen(entry.rightmoveId)}
          >
            <Icon name="forward" size={13} />
          </button>
        </div>
      </div>
    </article>
  );
}

/** The one line under the address: beds, size, and how far it is from the first place this hunt
 *  saved.
 *
 *  One commute rather than a table of them, because a card is a decision about whether to look
 *  closer and the first saved place is overwhelmingly the one that decides it — the office. The full
 *  grid is on the flat itself. A journey nobody has looked up is left out entirely rather than shown
 *  as a blank: a card is too small to distinguish four kinds of absence, and the flat's own view
 *  does exactly that. */
function summarise(
  entry: ShortlistEntry,
  places: Place[],
  travel: Record<string, TravelTime[]> | undefined,
): string {
  const bits: string[] = [];
  if (entry.bedrooms !== null) bits.push(`${entry.bedrooms} bed`);
  const size = resolveSize(sizeOf(entry));
  // The asterisk is the same caveat `SizeValue` draws — a figure read out of a paragraph rather
  // than off a plan may be measuring the garden.
  if (size) bits.push(`${size.value.toLocaleString()} sq ft${size.approximate ? '*' : ''}`);

  const first = travelDestinations(places)[0];
  const rows = first && entry.postcode ? (travel?.[entry.postcode] ?? []) : [];
  const best = readTravel(rows.filter((t) => t.placeId === first?.id)).best;
  if (best && first) bits.push(`${formatDuration(best.seconds)} ${verbFor(best.mode)} to ${first.label}`);

  return bits.join(' · ');
}

const pointOf = (entry: ShortlistEntry) =>
  entry.lat !== null && entry.lon !== null ? { lat: entry.lat, lon: entry.lon } : null;

/** The two nearest stations as one line: "Angel 0.3 mi · Old Street 0.5 mi".
 *
 *  Not the shared `Stations` component, which is right everywhere else and wrong here for two
 *  reasons: it fetches the walk and the lines per postcode, and a grid of twenty-five cards would
 *  fire twenty-five of those on scroll — the same thing the `travel` prop above refuses to do — and
 *  it draws a row per station where a card has room for a clause. The distance itself still goes
 *  through `stationDistance`, so the number is formatted in one place. */
function stationsLine(entry: ShortlistEntry): string {
  return entry.nearestStations
    .slice(0, 2)
    .map((s) => `${s.name.replace(/\s+Station$/, '')} ${stationDistance(s.distance, s.unit)}`)
    .join(' · ');
}

const VERB: Record<string, string> = { walking: 'walk', cycling: 'bike', transit: 'transit' };
const verbFor = (mode: string): string => VERB[mode] ?? mode;

/** Three flags, chosen rather than truncated: the worst thing against it, then the best thing for
 *  it, then whatever is next. Slicing the list instead would have shown three pieces of good news
 *  on a flat with a red flag underneath them, which is the one card where the flag matters. */
function pickFlags(flags: Flag[]): Flag[] {
  const rank: Record<Flag['severity'], number> = { red: 0, yellow: 1, good: 2 };
  const worst = [...flags].sort((a, b) => rank[a.severity] - rank[b.severity]);
  const best = flags.find((f) => f.severity === 'good');
  const chosen: Flag[] = [];
  for (const flag of [worst[0], best, ...worst]) {
    if (flag && !chosen.includes(flag)) chosen.push(flag);
    if (chosen.length === 3) break;
  }
  return chosen;
}
