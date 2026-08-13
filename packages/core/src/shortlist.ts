import type { Rating, Verdict } from './types';
import type { SizeSource } from './facts';
import type { ShortlistEntry } from './db/supabase';

/** Which pile a property is in, derived from what the two of you said.
 *
 *  The ordering is deliberate and not a majority vote: a "not our place" from either of you
 *  settles it, because there is no point one of you campaigning for a flat the other has ruled
 *  out. Above that, any enthusiasm outranks a shrug. */
export type Group = 'excited' | 'maybe' | 'rejected' | 'unrated';

export function groupOf(verdicts: Verdict[]): Group {
  if (verdicts.some((v) => v.rating === 'no')) return 'rejected';
  if (verdicts.some((v) => v.rating === 'love')) return 'excited';
  if (verdicts.some((v) => v.rating === 'maybe')) return 'maybe';
  return 'unrated';
}

/** Both of you keen is a stronger signal than one of you keen, and the page sorts on it. A place
 *  neither of you has rated yet scores nothing rather than negative — it is unknown, not bad. */
export function enthusiasm(verdicts: Verdict[]): number {
  const score: Record<Rating, number> = { love: 2, maybe: 1, no: -10 };
  return verdicts.reduce((total, v) => total + score[v.rating], 0);
}

/** What a view shows before anyone touches a filter: the places one of you has said something
 *  about. A shortlist of fifty is mostly flats nobody has looked at properly yet, and mixed in
 *  with the ones you're weighing up they drown the decision — a map of fifty dots or a compare
 *  table of fifty rows is not a shortlist. The unrated ones are one click back in every view
 *  that offers this, which is where you go when you want to work through them. */
export const DEFAULT_SHOWING: Record<Group, boolean> = {
  excited: true,
  maybe: true,
  unrated: false,
  rejected: false,
};

// The pile names follow the rating words in `packages/ui/src/ratings.ts`: a card that says "Love
// it" under a heading that says "Excited about" is two names for one judgement.
export const GROUP_LABEL: Record<Group, string> = {
  excited: 'Loved',
  maybe: 'Liked',
  rejected: 'Rejected',
  unrated: 'Not yet rated',
};

/** A shortlist row, in the shape the shared size resolver wants. Here rather than in a view, so
 *  the card, the compare table and anything later all feed it the same three sources. */
export function sizeOf(entry: ShortlistEntry): SizeSource {
  return {
    floorplanSqft: entry.analysis?.floorplanSqft,
    floorplanLegible: entry.analysis?.floorplanLegible,
    listedSqft: entry.floorAreaSqft,
    listedSource: entry.floorAreaSource,
  };
}

/** Listings that are the same flat under two Rightmove ids.
 *
 *  Not a bug in the sweep — it is what Rightmove looks like. Danbury Street turned up as 91355733
 *  ("Danbury Street, London, N1") and 91458819 ("Danbury Street, Angel, Islington, London, N1"),
 *  both £6,000, both two beds, both N1 8JU, recorded minutes apart. A flat gets relisted, or two
 *  agents carry it, and the two records then disagree about everything the model inferred: one had
 *  1,670 sq ft and a terrace, the other no floorplan at all. Left alone that is two viewings
 *  booked for one flat, or two verdicts that contradict each other.
 *
 *  Postcode plus price, and nothing looser. A postcode alone would merge the flats in one
 *  converted house, which are genuinely different places at genuinely different rents. Both
 *  matching is close enough to certainty to say so on screen, and where it is wrong the harm is a
 *  line of text rather than a merged record — these stay two rows, always. */
export function duplicateIds(entries: ShortlistEntry[]): Map<string, string[]> {
  const bucket = new Map<string, ShortlistEntry[]>();
  for (const entry of entries) {
    if (!entry.postcode || !entry.price) continue;
    const key = `${entry.postcode}|${entry.price}`;
    bucket.set(key, [...(bucket.get(key) ?? []), entry]);
  }

  const twins = new Map<string, string[]>();
  for (const group of bucket.values()) {
    if (group.length < 2) continue;
    for (const entry of group) {
      twins.set(
        entry.rightmoveId,
        group.filter((o) => o.rightmoveId !== entry.rightmoveId).map((o) => o.rightmoveId),
      );
    }
  }
  return twins;
}
