/** Narrowing a pile of flats down to the ones worth looking at.
 *
 *  Triage is the one screen where you work through everything nobody has judged, and after a sweep
 *  that is two or three hundred places. Most of them fail on something you would have written down
 *  in advance: under 600 sq ft, over £3,000, no outdoor space at all. Reading each of those as a row
 *  and deciding it again is the work this exists to skip.
 *
 *  **A filter drops a flat only when it is known not to qualify.** Unknown is kept, every time. Most
 *  of what is filtered on here is read off photographs by a model — a floor area, a main room, a
 *  dishwasher — and "we could not tell" is a genuine and common answer. Dropping those would hide
 *  exactly the flats nobody has looked at properly, which is the pile triage *is*; and it would do
 *  it invisibly, since a filtered-out row leaves nothing behind to notice. `unknowns` counts them,
 *  so the screen can say how many are still there only because we do not know.
 */
import { amenityPresent, resolveSize, type AmenityKey } from './facts';
import { parseMonthlyPrice } from './predict';
import type { ShortlistEntry } from './db/supabase';
import { sizeOf } from './shortlist';

export interface TriageFilter {
  /** Monthly rent in pounds. A flat whose price cannot be parsed is unknown, not free. */
  maxPrice: number | null;
  minBedrooms: number | null;
  /** Floor area, resolved by the same rule every view shows it with (`resolveSize`) — so a filter
   *  can never be answering about a different number from the one on screen. */
  minSqft: number | null;
  /** The biggest room the model measured. "Great room" on the Your Hunt page is the same figure
   *  against a bar; this is the bar as a filter. */
  minGreatRoomSqft: number | null;
  /** Amenities the flat must be *known* to have. Absent from the list means "don't mind" — there is
   *  deliberately no "must not have": nothing here is something a hunt wants less of. */
  amenities: AmenityKey[];
}

export const NO_FILTER: TriageFilter = {
  maxPrice: null,
  minBedrooms: null,
  minSqft: null,
  minGreatRoomSqft: null,
  amenities: [],
};

export function filterIsOn(filter: TriageFilter): boolean {
  return (
    filter.maxPrice !== null ||
    filter.minBedrooms !== null ||
    filter.minSqft !== null ||
    filter.minGreatRoomSqft !== null ||
    filter.amenities.length > 0
  );
}

/** Does this flat clear every bar the filter sets? Unknown clears them all — see the note above. */
export function matchesFilter(entry: ShortlistEntry, filter: TriageFilter): boolean {
  if (filter.maxPrice !== null) {
    const price = parseMonthlyPrice(entry.price);
    if (price !== null && price > filter.maxPrice) return false;
  }
  if (filter.minBedrooms !== null && entry.bedrooms !== null && entry.bedrooms < filter.minBedrooms) {
    return false;
  }
  if (filter.minSqft !== null) {
    const size = resolveSize(sizeOf(entry));
    if (size && size.value < filter.minSqft) return false;
  }
  if (filter.minGreatRoomSqft !== null) {
    const room = entry.analysis?.biggestRoomSqft ?? null;
    if (room !== null && room < filter.minGreatRoomSqft) return false;
  }
  for (const key of filter.amenities) {
    // `false` is the only answer that drops a flat. `null` is the model saying it could not tell,
    // and a flat with no photos analysed yet would otherwise fail every amenity at once — which is
    // to say the filter would hide precisely the listings nobody has looked at.
    if (amenityPresent(key, entry.analysis) === false) return false;
  }
  return true;
}

/** What the filter left, and how much of that is only there because we could not tell.
 *
 *  The second number is the honest half. A pile of forty that is thirty-one unmeasured flats is not
 *  a pile of forty places over 700 sq ft, and a screen that says "40" alone has claimed it is. */
export function applyFilter(
  entries: ShortlistEntry[],
  filter: TriageFilter,
): { kept: ShortlistEntry[]; unknowns: number } {
  const kept = entries.filter((entry) => matchesFilter(entry, filter));
  if (!filterIsOn(filter)) return { kept, unknowns: 0 };
  const unknowns = kept.filter((entry) => unknownTo(entry, filter)).length;
  return { kept, unknowns };
}

/** True when this flat clears the filter with a shrug rather than an answer — at least one bar it
 *  was measured against has no measurement. */
function unknownTo(entry: ShortlistEntry, filter: TriageFilter): boolean {
  if (filter.maxPrice !== null && parseMonthlyPrice(entry.price) === null) return true;
  if (filter.minBedrooms !== null && entry.bedrooms === null) return true;
  if (filter.minSqft !== null && !resolveSize(sizeOf(entry))) return true;
  if (filter.minGreatRoomSqft !== null && (entry.analysis?.biggestRoomSqft ?? null) === null) return true;
  return filter.amenities.some((key) => amenityPresent(key, entry.analysis) === null);
}
