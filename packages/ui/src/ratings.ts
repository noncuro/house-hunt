import type { Rating, Verdict } from '@house-hunt/core';

// ------------------------------------------------------------------------------------------------
// One rating per property per project (design D6), and everything that renders it.
//
// Deliberately free of React so the search-page content script — plain DOM, no framework — can
// use the same words and the same attribution as the panel and the shortlist. The React half is
// `Verdict.tsx`, which imports from here. Nothing about a verdict is spelled out twice.
// ------------------------------------------------------------------------------------------------

/** The words, in the order the buttons draw them: worst first, so the two positives sit together
 *  and the click that ends a flat's life is at the far end from the one that advances it.
 *
 *  The stored values stay `no` / `maybe` / `love` and the labels moved to "like it" / "love it".
 *  Renaming the values would mean rewriting every verdict, every archived verdict in
 *  `verdict_history` and the label modes the score is fitted under, all to change three strings
 *  nobody reads out of the database. What the value is called and what it is *called on screen* are
 *  different questions, and only the second one was ever asked. */
export const RATINGS: Array<{ value: Rating; label: string; emoji: string; word: string }> = [
  { value: 'no', label: 'Not our place', emoji: '👎', word: 'rejected' },
  { value: 'maybe', label: 'Like it', emoji: '👍', word: 'liked' },
  { value: 'love', label: 'Love it', emoji: '😍', word: 'loved' },
];

const BY_VALUE = new Map(RATINGS.map((r) => [r.value, r]));

/** The full description of a rating. Falls back rather than returning undefined: a rating the
 *  database holds and this build has never heard of should read as itself, not as a blank. */
export function ratingOf(rating: Rating): { value: Rating; label: string; emoji: string; word: string } {
  return BY_VALUE.get(rating) ?? { value: rating, label: String(rating), emoji: '•', word: String(rating) };
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "just now" / "14m ago" / "2h ago" / "3 days ago" / "12 Jun". Null when the timestamp cannot be
 *  read at all — the caller then says who without pretending to know when, because "— , 2h ago"
 *  and "on Invalid Date" both read as a bug in the renderer rather than as missing data. */
export function agoLabel(iso: string, now: Date = new Date()): string | null {
  const then = new Date(iso);
  const at = then.getTime();
  if (!Number.isFinite(at)) return null;

  const elapsed = now.getTime() - at;
  // A clock skew of a few minutes between two laptops is ordinary; "in 3 minutes" beside a rating
  // somebody just set is not. Anything slightly ahead reads as now.
  if (elapsed < MINUTE) return 'just now';
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)}m ago`;
  if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)}h ago`;
  if (elapsed < 7 * DAY) {
    const days = Math.floor(elapsed / DAY);
    return days === 1 ? 'yesterday' : `${days} days ago`;
  }
  return then.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

/** "Alex, 2h ago" — who set the project's one rating, and when.
 *
 *  This is the whole mitigation for a shared verdict (design D6): last-write-wins is honest only
 *  while the last writer is visible. A rating with no author turns one person overruling the
 *  other into a silent overwrite. */
export function attribution(verdict: Verdict, now?: Date): string {
  const when = agoLabel(verdict.updatedAt, now);
  return when ? `${verdict.person}, ${when}` : verdict.person;
}

/** The sentence a hover gets: the same facts, unabbreviated.
 *
 *  No longer explains that a project has one shared verdict. That was a rule of the product being
 *  restated on every hover of every rating on every screen, long after anybody using it had learned
 *  it — and it was the longer half of the sentence, so the two facts a hover is actually for, who
 *  and when, arrived after a clause nobody was reading. */
export function attributionDetail(verdict: Verdict): string {
  const at = new Date(verdict.updatedAt);
  const when = Number.isFinite(at.getTime())
    ? at.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })
    : 'an unrecorded time';
  const note = verdict.note.trim() ? ` — "${verdict.note.trim()}"` : '';
  return `${ratingOf(verdict.rating).label}, set by ${verdict.person} at ${when}${note}`;
}
