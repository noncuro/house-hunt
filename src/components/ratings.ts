import type { Rating, Verdict } from '@/lib/types';

// ------------------------------------------------------------------------------------------------
// One rating per property per project (design D6), and everything that renders it.
//
// Deliberately free of React so the search-page content script — plain DOM, no framework — can
// use the same words and the same attribution as the panel and the shortlist. The React half is
// `Verdict.tsx`, which imports from here. Nothing about a verdict is spelled out twice.
// ------------------------------------------------------------------------------------------------

export const RATINGS: Array<{ value: Rating; label: string; emoji: string; word: string }> = [
  { value: 'no', label: 'Not our place', emoji: '👎', word: 'rejected' },
  { value: 'maybe', label: 'Maybe', emoji: '🤔', word: 'maybe' },
  { value: 'love', label: 'Exciting', emoji: '😍', word: 'exciting' },
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

/** The sentence a hover gets: the same facts, unabbreviated, plus why there is only one of them. */
export function attributionDetail(verdict: Verdict): string {
  const at = new Date(verdict.updatedAt);
  const when = Number.isFinite(at.getTime())
    ? at.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })
    : 'an unrecorded time';
  const note = verdict.note.trim() ? ` — "${verdict.note.trim()}"` : '';
  return `${ratingOf(verdict.rating).label}, set by ${verdict.person} at ${when}${note}. One rating per property, shared by everyone in this project — changing it replaces theirs.`;
}
