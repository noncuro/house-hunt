import { Hint } from './Hint';
import {
  APPROXIMATE_SIZE_HELP,
  explainReading,
  resolveSize,
  type Size,
  type SizeSource,
} from '@house-hunt/core';

/** The floor area, rendered the same way in every view.
 *
 *  It used to be resolved three times, three ways: the panel discounted the model's figure when
 *  the plan was unreadable, the card always preferred it, and the compare table did its own
 *  third thing. The same flat read 750 sq ft in one place and 1,082 in another. Worse, only the
 *  panel marked a number that had been read out of a paragraph rather than measured — the card
 *  printed the garden's area as the flat's with no hint anything was uncertain.
 *
 *  So: one resolver in facts.ts, one renderer here, and the caveat travels with the number. */
export function sqft(n: number): string {
  return `${n.toLocaleString()} sq ft`;
}

export function SizeFact({ source, missing = 'no size given' }: { source: SizeSource; missing?: string }) {
  const size = resolveSize(source);
  if (!size) return <span className="rm-dim">{missing}</span>;
  return <SizeValue size={size} />;
}

export function SizeValue({ size }: { size: Size }) {
  // Prose is the weakest source and the only one that can silently be measuring something else,
  // so it is marked even when nothing contradicts it.
  if (size.approximate && size.conflicts.length === 0) {
    return (
      <Hint className="rm-approx" text={APPROXIMATE_SIZE_HELP}>
        {sqft(size.value)}*
      </Hint>
    );
  }
  if (size.conflicts.length === 0) return <>{sqft(size.value)}</>;

  // Sources disagree. Show the one we trust most, mark it, and put the rest a hover away —
  // showing all of them is noise, showing one silently hides that a check is warranted.
  return (
    <Hint
      className="rm-approx"
      text={
        explainReading(size, sqft) + (size.approximate ? `\n\n${APPROXIMATE_SIZE_HELP}` : '')
      }
    >
      {sqft(size.value)}*
    </Hint>
  );
}
