import { Hint } from './Hint';
import { RATINGS, attribution, attributionDetail, ratingOf } from './ratings';
import './ratings.css';
import type { Rating, Verdict } from '@house-hunt/core';

/** The project's one opinion about a property: what it is, who set it, when.
 *
 *  Rendered here rather than in each view because the panel and the shortlist have drifted apart
 *  on exactly this before — the panel said "Them", the card said a name and an emoji, and neither
 *  said when. `null` is a state with words of its own: a blank line reads as a rating that failed
 *  to load rather than as a flat nobody has judged. */
export function VerdictLine({ verdict }: { verdict: Verdict | null }) {
  if (!verdict) {
    return (
      <div className="rm-verdict-line rm-verdict-none" data-testid="verdict-none">
        No verdict yet
      </div>
    );
  }

  const meta = ratingOf(verdict.rating);
  return (
    <Hint as="div" className="rm-verdict-line" underline={false} text={attributionDetail(verdict)}>
      <span className={`rm-verdict-rating rm-rating-${verdict.rating}`} data-testid="verdict-rating">
        {meta.emoji} {meta.label}
      </span>
      {/* The author is the point, not a footnote: it is what keeps one person overruling the
          other from looking like the flat was always rated this way. */}
      <span className="rm-verdict-by" data-testid="verdict-by">
        {attribution(verdict)}
      </span>
    </Hint>
  );
}

/** The three buttons, wherever a rating is set. `pending` is the value clicked but not yet
 *  acknowledged by the database — it reads as pressed straight away, and the stripe says the
 *  other laptop has not seen it yet. */
export function RatingButtons({
  value,
  pending,
  onRate,
  disabled,
  compact,
}: {
  value: Rating | null | undefined;
  pending?: Rating | null;
  onRate: (rating: Rating) => void;
  /** Sit at the buttons' natural width rather than filling the row. The panel is a narrow column
   *  where three equal thirds are right; a shortlist card is a wide row shared with the note. */
  compact?: boolean;
  /** A sentence saying *why* rating is unavailable, or undefined when it is available. Never a
   *  bare boolean: a dead button with no explanation is the fail-loudly rule inverted. */
  disabled?: string;
}) {
  return (
    <div className={compact ? 'rm-ratings rm-ratings-compact' : 'rm-ratings'} data-testid="ratings">
      {RATINGS.map((r) => (
        <Hint
          key={r.value}
          underline={false}
          text={
            disabled
              ? disabled
              : pending === r.value
                ? 'Saving…'
                : `${r.label} — one shared rating for this project, replacing whatever is set now`
          }
        >
          <button
            className={[
              'rm-rate',
              value === r.value ? 'rm-rate-on' : '',
              pending === r.value ? 'rm-rate-pending' : '',
            ]
              .filter(Boolean)
              .join(' ')}
            disabled={Boolean(disabled)}
            data-testid={`rate-${r.value}`}
            onClick={() => onRate(r.value)}
          >
            {r.emoji} {r.label}
          </button>
        </Hint>
      ))}
    </div>
  );
}
