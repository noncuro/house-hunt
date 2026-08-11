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
import { groupOf, score as scoreModel, type Hub, type Model, type PredictInput } from '@house-hunt/core';
import type { ShortlistEntry } from '@house-hunt/core/db';

/** Nearest station distance in miles. Rightmove gives miles; a stray kilometre is converted rather
 *  than trusted, because an unconverted km reads as a much closer station than it is. */
function nearestStationMiles(entry: ShortlistEntry): number | null {
  const miles = entry.nearestStations
    .filter((s) => typeof s.distance === 'number')
    .map((s) => (s.unit === 'km' ? s.distance * 0.621371 : s.distance));
  return miles.length ? Math.min(...miles) : null;
}

export function predictInputFrom(entry: ShortlistEntry): PredictInput {
  const a = entry.analysis;
  return {
    price: entry.price,
    bedrooms: entry.bedrooms,
    bathrooms: entry.bathrooms,
    floorAreaSqft: entry.floorAreaSqft,
    lat: entry.lat,
    lon: entry.lon,
    nearestStationMiles: nearestStationMiles(entry),
    furnishType: entry.furnishType,
    naturalLight: a?.naturalLight ?? null,
    hasOutdoorSpace: a?.hasOutdoorSpace ?? null,
    hasDishwasher: a?.hasDishwasher ?? null,
    laundry: a?.laundry ?? null,
    hasBathtub: a?.hasBathtub ?? null,
  };
}

/** Every entry's P(yes) under the current model, keyed by rightmove id. Built once per render and
 *  handed down, so a card, the triage sort and the mismatch check all read the same number. */
export function scoreEntries(model: Model, entries: ShortlistEntry[], hubs: Hub[]): Map<string, number> {
  const scores = new Map<string, number>();
  for (const entry of entries) scores.set(entry.rightmoveId, scoreModel(model, predictInputFrom(entry), hubs));
  return scores;
}

/** How to order the triage pile. `yes` and `no` sort toward the two certainties; `uncertain`
 *  surfaces the genuine middle (nearest 0.5), which is where a human's attention is worth most. */
export type SortMode = 'yes' | 'no' | 'uncertain' | 'default';

export const SORT_LABEL: Record<SortMode, string> = {
  default: 'Newest first',
  yes: 'Most likely yes',
  no: 'Most likely no',
  uncertain: 'Most uncertain',
};

/** Order entries by score for a sort mode. `default` and a missing score leave the incoming order
 *  (newest first) untouched — an unscored pile still triages, just without the ranking. */
export function sortForTriage(
  entries: ShortlistEntry[],
  scores: Map<string, number> | null,
  mode: SortMode,
): ShortlistEntry[] {
  if (!scores || mode === 'default') return entries;
  const key = (e: ShortlistEntry) => scores.get(e.rightmoveId);
  const rank = (e: ShortlistEntry): number => {
    const s = key(e);
    if (s == null) return Infinity; // unscored sinks to the end, whichever end you asked for
    if (mode === 'yes') return -s;
    if (mode === 'no') return s;
    return Math.abs(s - 0.5);
  };
  return [...entries].sort((a, b) => rank(a) - rank(b));
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
