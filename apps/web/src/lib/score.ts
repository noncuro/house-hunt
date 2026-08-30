/** Turning a shortlist entry into a verdict score, on the web side.
 *
 *  The maths lives in `@house-hunt/core` (`score`, `featuresFor`); this file only maps the web's
 *  `ShortlistEntry` shape into the `PredictInput` that expects. The extension does the same map from
 *  its own `Listing`/`Analysis` — one feature builder, two adapters — so the two surfaces can never
 *  disagree about what a flat's features are.
 *
 *  Nothing here is stored. A score is computed at render against the current model, so it is always
 *  the current model's opinion; the moment someone retrains, the next render reflects it.
 */
import {
  groupOf,
  nearestStationMiles,
  parseMonthlyPrice,
  readPlaceTravel,
  resolveSize,
  score as scoreModel,
  sizeOf,
  type Hub,
  type Model,
  type HuntPreferences,
  type PredictInput,
} from '@house-hunt/core';
import type { ShortlistEntry } from '@house-hunt/core/db';
import type { TravelTime } from '@house-hunt/core';

export function predictInputFrom(entry: ShortlistEntry): PredictInput {
  return {
    price: entry.price,
    bedrooms: entry.bedrooms,
    bathrooms: entry.bathrooms,
    // The listed area and its provenance, unresolved: `featuresFor` runs `resolveSize` over this
    // and the floorplan, so the model reads the same size the card prints.
    listedSqft: entry.floorAreaSqft,
    listedSource: entry.floorAreaSource,
    lat: entry.lat,
    lon: entry.lon,
    nearestStationMiles: nearestStationMiles(entry.nearestStations),
    furnishType: entry.furnishType,
    analysis: entry.analysis ?? null,
  };
}

/** Every entry's P(yes) under the current model, keyed by rightmove id. Built once per render and
 *  handed down, so a card, the triage sort and the mismatch check all read the same number.
 *
 *  `prefs` are the hunt's own answers, which the model was fitted against — pass the same set the
 *  retrain used, or the flat is scored on bars it was never trained on. */
export function scoreEntries(
  model: Model,
  entries: ShortlistEntry[],
  hubs: Hub[],
  prefs?: HuntPreferences,
): Map<string, number> {
  const scores = new Map<string, number>();
  for (const entry of entries) {
    scores.set(entry.rightmoveId, scoreModel(model, predictInputFrom(entry), hubs, prefs));
  }
  return scores;
}

/** How to order the triage pile.
 *
 *  Three of these ask the model: `yes` and `no` sort toward the two certainties, and `uncertain`
 *  surfaces the genuine middle (nearest 0.5), which is where a human's attention is worth most. The
 *  rest ask the listing, and are the ones that still work on the day a hunt starts — before there
 *  are enough verdicts to fit a model on, which is exactly when the pile is at its biggest. */
/** The sorts that exist whatever the hunt is. Every one of them reads a number off the flat. */
export type FixedSortMode =
  | 'yes' | 'no' | 'uncertain' | 'default' | 'cheapest' | 'biggest' | 'great-room' | 'station';

/** Plus one per place the hunt routes to.
 *
 *  Carried in the mode string rather than as a second piece of state, because a sort is one choice
 *  and splitting it into "which sort" and "which place" makes a pair that can disagree — a place id
 *  left behind by a sort that is no longer a place sort, restored from storage, picked up by the
 *  next one. `placeSort` and `placeIdOf` are the only two things that know the shape. */
export type SortMode = FixedSortMode | `place:${string}`;

export function placeSort(placeId: string): SortMode {
  return `place:${placeId}`;
}

/** The place a mode sorts by, or null for one of the fixed sorts. */
export function placeIdOf(mode: SortMode): string | null {
  return mode.startsWith('place:') ? mode.slice('place:'.length) : null;
}

export const SORT_LABEL: Record<FixedSortMode, string> = {
  default: 'Newest first',
  yes: 'Most likely yes',
  no: 'Most likely no',
  uncertain: 'Most uncertain',
  cheapest: 'Cheapest first',
  biggest: 'Biggest first',
  'great-room': 'Best main room',
  station: 'Nearest station',
};

/** The three that are meaningless without a fitted model. Listed rather than inferred, so the
 *  control can grey out exactly those and leave the others usable — disabling the whole select,
 *  which is what it used to do, took away the two sorts that never needed a model at all. */
export const NEEDS_MODEL: FixedSortMode[] = ['yes', 'no', 'uncertain'];

/** Order entries for a sort mode. `default` leaves the incoming order (newest first) untouched, and
 *  so does a model sort with no model — an unscored pile still triages, just without the ranking.
 *
 *  Missing values sink, whichever end you asked for. A flat with no floor area is not the smallest
 *  and a flat with no price is not the cheapest; sorting either to the top would put the listings we
 *  know least about in front of the ones the sort was meant to surface.
 *
 *  `travel` is whatever the cache held when the screen mounted, which is why a place sort leaves the
 *  pile alone when it is missing rather than ranking everything as unmeasured: the two look
 *  identical on screen, and only one of them is a claim about the flats. */
export function sortForTriage(
  entries: ShortlistEntry[],
  scores: Map<string, number> | null,
  mode: SortMode,
  travel?: Record<string, TravelTime[]>,
): ShortlistEntry[] {
  if (mode === 'default') return entries;

  const placeId = placeIdOf(mode);
  if (placeId !== null) {
    if (!travel) return entries;
    return [...entries].sort(
      (a, b) => journeySeconds(a, placeId, travel) - journeySeconds(b, placeId, travel),
    );
  }
  const fixed = mode as FixedSortMode;
  if (NEEDS_MODEL.includes(fixed) && !scores) return entries;

  const rank = (e: ShortlistEntry): number => {
    if (mode === 'cheapest') return parseMonthlyPrice(e.price) ?? Infinity;
    if (mode === 'biggest') return negate(resolveSize(sizeOf(e))?.value);
    if (mode === 'great-room') return negate(e.analysis?.biggestRoomSqft);
    // Ascending, and a flat with no stations listed still sinks: `??` catches the null the same way
    // `negate` does at the other end.
    if (mode === 'station') return nearestStationMiles(e.nearestStations) ?? Infinity;

    const s = scores!.get(e.rightmoveId);
    if (s == null) return Infinity; // unscored sinks to the end, whichever end you asked for
    if (mode === 'yes') return -s;
    if (mode === 'no') return s;
    return Math.abs(s - 0.5);
  };
  return [...entries].sort((a, b) => rank(a) - rank(b));
}

/** The best journey to a place in seconds, with every kind of absence sinking.
 *
 *  `readPlaceTravel` is the same reader the compare table's column draws from, so the order here and
 *  the numbers on screen cannot disagree — which they would the first time one of them decided for
 *  itself whether a ninety-minute walk counts as a way of getting there. */
function journeySeconds(
  entry: ShortlistEntry,
  placeId: string,
  travel: Record<string, TravelTime[]>,
): number {
  return readPlaceTravel(entry.postcode, placeId, travel).best?.seconds ?? Infinity;
}

/** Biggest-first as an ascending rank, with "no number" still sorting last rather than first —
 *  which is what `-null` would quietly do. */
function negate(value: number | null | undefined): number {
  return value == null ? Infinity : -value;
}

/** Whether the model strongly disagrees with a flat's existing rating — a loved place it scores
 *  low, or a rejected one it scores high. The interesting rows: worth a second look because one of
 *  you and the model is missing something. Unrated entries are never a surprise (nothing to
 *  disagree with). The 0.35 / 0.65 cuts match the "leaning" bands in the badge. */
export function isSurprise(entry: ShortlistEntry, score: number | undefined): boolean {
  if (score == null) return false;
  const group = groupOf(entry.verdicts);
  if (group === 'excited') return score < 0.35;
  if (group === 'rejected') return score > 0.65;
  return false; // maybe / unrated: no rating strong enough to contradict
}
