import { latestChange, type PricePoint } from '@house-hunt/core';
import { Hint } from './Hint';
import './pricemove.css';

/** "↓ was £3,100" — what a flat used to cost, next to what it costs now.
 *
 *  A reduction is the strongest signal a listing gives off without anybody saying anything. It
 *  means the place has been sitting, which is two pieces of news at once: a flat you passed on may
 *  now be inside your budget, and a flat you are about to enquire about has a landlord who has
 *  already moved once. Neither is visible from the current price alone, and until the price history
 *  existed neither was recoverable at all — the number was simply overwritten.
 *
 *  Only the last move is shown, and only when there is one. A flat we have seen once has not been
 *  observed changing, which is different from having held its price, so it gets nothing rather than
 *  a reassuring "no change". The full history is in the tooltip.
 */
export function PriceMove({ history }: { history: PricePoint[] | undefined }) {
  const change = latestChange(history ?? []);
  if (!change) return null;

  // The arrow carries the direction and the word carries it again, because an arrow alone is a
  // colour-and-shape distinction on a line of small text and this is the one figure on the card
  // somebody makes a decision on.
  const arrow = change.direction === 'down' ? '↓' : change.direction === 'up' ? '↑' : '·';
  const word = change.direction === 'down' ? 'Reduced' : change.direction === 'up' ? 'Increased' : 'Changed';

  return (
    <Hint text={`${word} on ${new Date(change.at).toLocaleDateString()} — was ${change.from}, now ${change.to}.`}>
      <span className={`price-move price-move-${change.direction}`} data-testid="price-move">
        {arrow} was {change.from}
      </span>
    </Hint>
  );
}
