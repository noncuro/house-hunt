import './flags.css';
import { Confidence } from './Confidence';
import { flagsFor, problemsOnly, type Flag, type FlagSource } from '@/lib/facts';

/** What the photos say, in one place, drawn the same way everywhere.
 *
 *  Severity is the point. Everything that was not good news used to take the same red, so a
 *  shower-only bathroom looked exactly as serious as a main room slightly under target. Red means
 *  do not bother viewing; amber means raise it at the viewing. The colours are the two the rest of
 *  the page already uses for bad and for caution, so nothing new has to be learned.
 *
 *  `only="problems"` drops the good news. That is for the compare table, where a column reading
 *  "bathtub" down fourteen of seventeen rows spends its width saying nothing — a table answers
 *  "which of these has something against it".
 *
 *  The confidence rings ride along on any flag the model inferred, because a claim about a flat
 *  you have not seen is worth exactly as much as the evidence behind it. One ring, two or three,
 *  and no words — see Confidence.tsx for why the words had to go. */
export function Flags({ source, only = 'all' }: { source: FlagSource; only?: 'all' | 'problems' }) {
  const flags = only === 'problems' ? problemsOnly(flagsFor(source)) : flagsFor(source);
  if (flags.length === 0) return null;

  return (
    <span className="rm-flags">
      {flags.map((flag) => (
        <FlagChip flag={flag} key={flag.key} />
      ))}
    </span>
  );
}

export function FlagChip({ flag }: { flag: Flag }) {
  return (
    <span className={`rm-flag rm-flag-${flag.severity}`}>
      {flag.icon} {flag.text}
      {flag.confidence !== null && <Confidence level={flag.confidence} />}
    </span>
  );
}
