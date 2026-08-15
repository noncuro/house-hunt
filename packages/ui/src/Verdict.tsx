import { Hint } from './Hint';
import { RATINGS, attribution, attributionDetail, ratingOf } from './ratings';
import './ratings.css';
import type { Rating, Verdict } from '@house-hunt/core';

/** The project's one opinion about a property: what it is, who set it, when.
 *
 *  Rendered here rather than in each view because the panel and the shortlist have drifted apart
 *  on exactly this before — the panel said "Them", the card said a name and an emoji, and neither
 *  said when.
 *
 *  The emoji are gone from every one of these. They were the only three glyphs on either surface
 *  that could not be recoloured or aligned, and a rating already has a shape and a colour of its
 *  own: the stamp carries the meaning, which is what makes it legible at the size a card gives it.
 *  `RATINGS[].emoji` survives in ratings.ts because the search-page badge is plain DOM injected
 *  into Rightmove's own card and has room for a character and not an SVG. */

/** The card's pill: the verdict and whose it is, in one mark.
 *
 *  Null renders nothing at all, unlike `VerdictLine`. A card is a wall of small facts and "No
 *  verdict yet" on every unrated one is a column of noise saying what the absence of a stamp
 *  already says. Where the verdict is the subject of the row — the panel, the detail page — the
 *  line below is the right renderer, and it does say so in words. */
export function VerdictStamp({ verdict }: { verdict: Verdict | null }) {
  if (!verdict) return null;
  const meta = ratingOf(verdict.rating);
  return (
    <Hint
      className={`rm-stamp rm-stamp-${verdict.rating}`}
      underline={false}
      text={attributionDetail(verdict)}
    >
      <span className="rm-stamp-word" data-testid="verdict-rating">
        {capitalise(meta.word)}
      </span>
      <span className="rm-stamp-dot" aria-hidden="true">
        ·
      </span>
      <span className="rm-stamp-by" data-testid="verdict-by">
        {verdict.person}
      </span>
    </Hint>
  );
}

function capitalise(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/** The verdict as a line of text, where it is the thing being read rather than a mark on a card.
 *
 *  `null` is a state with words of its own here: a blank line reads as a rating that failed to
 *  load rather than as a flat nobody has judged. */
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
        {meta.label}
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
  keys,
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
  /** Draw `1` `2` `3` on the buttons. Only triage passes it, and only because triage binds those
   *  keys — a keycap on a screen where the key does nothing is a lie about the interface, so this
   *  is opt-in rather than a default the caller has to remember to turn off. */
  keys?: boolean;
}) {
  return (
    <div className={compact ? 'rm-ratings rm-ratings-compact' : 'rm-ratings'} data-testid="ratings">
      {RATINGS.map((r, i) => (
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
              `rm-rate-${r.value}`,
              value === r.value ? 'rm-rate-on' : '',
              pending === r.value ? 'rm-rate-pending' : '',
            ]
              .filter(Boolean)
              .join(' ')}
            disabled={Boolean(disabled)}
            data-testid={`rate-${r.value}`}
            onClick={() => onRate(r.value)}
          >
            {r.label}
            {/* Aria-hidden: the shortcut is a hint to the hands, and read aloud after every label
                it is three characters of noise on a control that is already reachable by tab. */}
            {keys && (
              <span className="rm-rate-key" aria-hidden="true">
                {i + 1}
              </span>
            )}
          </button>
        </Hint>
      ))}
    </div>
  );
}
