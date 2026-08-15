/** Going back over flats we already know about, to find out what has changed since.
 *
 *  The sweep answers "what is out there"; this answers "is what we found still true". They are
 *  different questions and they go stale differently. A listing you opened three weeks ago has had
 *  three weeks to be taken, to be reduced, or to be quietly withdrawn — and nothing in this app
 *  would notice, because every fact about a flat is written once, when somebody opens it, and never
 *  looked at again. The shortlist can therefore show a flat at a price that no longer exists, on a
 *  market it has already left, and give no sign of it.
 *
 *  There is no cheap way to ask. Nothing on the server may fetch Rightmove (see AGENTS.md), so a
 *  re-check is the same act as a first look: open the page, let the panel read it, write down what
 *  it says. That costs a browser tab and about six seconds each, which is what makes the choice of
 *  *which* flats below the whole of the design.
 */
import { parseMonthlyPrice } from './predict';
import type { ShortlistEntry } from './db/supabase';
import type { Rating } from './types';

/** How long a reading stays good enough.
 *
 *  Three days, because that is roughly the shortest interval over which a London rental listing
 *  changes in a way worth a tab — and because the run has to be short enough that somebody actually
 *  starts it. Re-checking everything every time would mean two hundred tabs and twenty minutes, and
 *  a job that long is one nobody runs, which leaves every flat stale rather than a few. */
export const RECHECK_AFTER_DAYS = 3;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Most interested first, because a run gets interrupted.
 *
 *  This is the reason the order matters at all. An unattended run of a hundred tabs is one you
 *  stop halfway, close the laptop on, or lose to a browser restart — so whatever it did first is
 *  the part that actually happened. Doing the flats somebody loves first means the interruption
 *  costs you news about places you had already decided against, which is the cheapest news to
 *  miss. Ordering by staleness alone would spend the good half of the run on flats rated "not our
 *  place" eight weeks ago. */
const RATING_ORDER: Record<Rating | 'none', number> = { love: 0, maybe: 1, none: 2, no: 3 };

export interface RecheckTarget {
  rightmoveId: string;
  displayAddress: string;
  /** What we last saw it cost, so the run can say what changed rather than only that it did. */
  price: string | null;
  lastSeenAt: string;
  rating: Rating | null;
}

/** Which flats are worth reopening, in the order to do it.
 *
 *  Re-checked: what is in the funnel, not archived, and not read recently enough to still be
 *  believed. Everything else is skipped, for two different reasons.
 *
 *  **Archived** is a decision that has already been made — a flat you lost, or walked away from —
 *  and spending a tab to discover that a place you are not pursuing has been taken is the definition
 *  of a wasted six seconds. Note that this is a *stage*, not a verdict: a flat rated "not our place"
 *  is still re-checked, last, because a rejection at £3,100 is worth revisiting at £2,700 and that
 *  is exactly the change this exists to find.
 *
 *  **Not in the funnel at all** is the pile a sweep leaves behind, and it is most of the shortlist:
 *  four hundred flats nobody has liked, loved or staged. Liking or loving one enters it in the
 *  funnel automatically (`enter_funnel`, `FIRST_STAGE`), so `stage === null` is precisely "nobody
 *  has expressed any interest in this" — and re-checking those made a run of two hundred and eighty
 *  tabs out of a hunt with thirty-nine flats in play. That is a run measured in hours, which is a
 *  run nobody starts, which leaves the flats that *are* in play stale. The rule the ordering below
 *  already implies is now the rule the filter applies: spend the tabs on what you are pursuing.
 *
 *  `now` is a parameter so this can be tested against a fixed clock rather than against today. */
export function recheckTargets(entries: ShortlistEntry[], now: Date = new Date()): RecheckTarget[] {
  const cutoff = now.getTime() - RECHECK_AFTER_DAYS * DAY_MS;

  return entries
    .filter((entry) => {
      if (!entry.stage) return false;
      if (entry.stage.stage === 'archived') return false;
      const seen = Date.parse(entry.lastSeenAt);
      // A timestamp we cannot read is not a recent one. Treating an unparseable date as fresh would
      // silently exclude the flat for good, and it is the rows with something odd about them that
      // most want looking at.
      // `<=`, not `<`: the view says "three days or more", so a listing read exactly three days
      // ago is in. An exclusive bound would leave the one on the boundary invisible to both halves.
      return Number.isNaN(seen) || seen <= cutoff;
    })
    .map((entry) => ({
      rightmoveId: entry.rightmoveId,
      displayAddress: entry.displayAddress,
      price: entry.price,
      lastSeenAt: entry.lastSeenAt,
      rating: entry.verdicts[0]?.rating ?? null,
    }))
    .sort((a, b) => {
      const byRating = RATING_ORDER[a.rating ?? 'none'] - RATING_ORDER[b.rating ?? 'none'];
      if (byRating !== 0) return byRating;
      // Then the one we have looked at least recently, for the same reason as the ordering above:
      // if the run stops early, it should have spent itself on what it knew least about.
      return Date.parse(a.lastSeenAt) - Date.parse(b.lastSeenAt);
    });
}

/** A price that has moved, as the two numbers and when.
 *
 *  Kept as the strings Rightmove published rather than parsed pounds. Every renderer of a price in
 *  this app shows what the listing said — "£2,850 pcm", "£650 pw" — and a change rendered as
 *  parsed numbers would be the one place a price appears in a form nobody typed. `parseMonthlyPrice`
 *  is still what decides the *direction*, since "£650 pw" against "£2,850 pcm" is not a comparison
 *  a string can make. */
export interface PriceChange {
  from: string;
  to: string;
  at: string;
  direction: 'down' | 'up' | 'unknown';
}

/** One row of `property_price`, oldest or newest — the caller says which by how it sorts. */
export interface PricePoint {
  price: string;
  seenAt: string;
  /** `property_price.id`, monotonic, and the tie-break when two observations share a timestamp —
   *  `clock_timestamp()` does not promise two distinct readings. Without it the order of the last
   *  two decides "reduced" or "up" on a coin toss. */
  id?: number;
}

/** The most recent move in a flat's price, or null if it has only ever had the one.
 *
 *  Only the last move, not the whole history. "Reduced from £3,100" is a thing a card can say in
 *  four words; "£3,300 then £3,100 then £2,850" is a chart, and a chart per row is what the compare
 *  table is for. The rows behind this are kept either way — see the migration — so the fuller
 *  reading stays available without every card having to render it.
 *
 *  Direction is decided by the parsed monthly figure, since a listing can switch between "pcm" and
 *  "pw" without the amount moving at all, and comparing those as strings would call that a rise. A
 *  price neither parser can read is a change with no direction rather than no change: something
 *  moved, and saying so without an arrow is honest, where saying nothing is not. */
export function latestChange(points: PricePoint[]): PriceChange | null {
  if (points.length < 2) return null;
  // Then by id, which is what breaks a tie between two observations that share a timestamp. Their
  // order is the whole answer — it decides "reduced" from "up" — so leaving it to whatever the
  // database happened to return would be a coin toss printed as a fact.
  const ordered = [...points].sort(
    (a, b) => Date.parse(a.seenAt) - Date.parse(b.seenAt) || (a.id ?? 0) - (b.id ?? 0),
  );
  const to = ordered[ordered.length - 1]!;
  const from = ordered[ordered.length - 2]!;
  const before = parseMonthlyPrice(from.price);
  const after = parseMonthlyPrice(to.price);
  return {
    from: from.price,
    to: to.price,
    at: to.seenAt,
    direction:
      before === null || after === null || before === after
        ? 'unknown'
        : after < before
          ? 'down'
          : 'up',
  };
}
