import './offmarket.css';

/** Off the market: the flat keeps its verdict and its place in the funnel, but drops out of the
 *  shortlist's views and out of the verdict-score model's training — the model should not learn
 *  from a place nobody can rent, and deleting the verdict would lose that you ever liked it (see
 *  the verdict-score migration). Reversible from the line under the tally, which says how many are
 *  hidden.
 *
 *  Shown wherever a flat is — the website card and the Rightmove panel — so it lives here rather than
 *  being written twice and drifting. Only offered where there is a positive verdict to withhold
 *  (`canGoOffMarket`) or where it is already off: a rejection has nothing to withhold, and an unrated
 *  flat is not in training yet. Whichever surface uses it owns the write; this only renders the
 *  control and reports the click. */
export function OffMarketRow({
  isOff,
  canGoOffMarket,
  onToggle,
  busy = false,
}: {
  isOff: boolean;
  canGoOffMarket: boolean;
  onToggle: (next: boolean) => void;
  /** The write is in flight — the button disables so a double click cannot send two opposite
   *  updates that race. */
  busy?: boolean;
}) {
  if (!canGoOffMarket && !isOff) return null;
  return (
    <div className="rm-offmarket">
      {isOff && (
        <span className="rm-offmarket-tag" title="Hidden from the shortlist and withheld from the score's training.">
          Off the market
        </span>
      )}
      <button type="button" className="rm-offmarket-toggle" disabled={busy} onClick={() => onToggle(!isOff)}>
        {isOff ? 'Back on the market' : 'Mark off the market'}
      </button>
    </div>
  );
}
