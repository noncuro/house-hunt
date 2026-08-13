import { Hint } from './Hint';
import './score.css';

/** The verdict score, drawn as a pill: the model's probability this project says yes to a flat.
 *
 *  It is a prediction, not a grade, and the wording keeps that honest — "likely yes" and "leaning
 *  no", never a star rating. The number learns the project's own past verdicts (see
 *  `packages/core/src/predict.ts`); it is deliberately kept OUT of the compare table, whose whole
 *  design is that nothing is scored or blended so you can see which trade you are making. Here, in
 *  triage, one predicted number is exactly the aid you want: it orders a pile of thirty unrated
 *  flats into "look first" and "probably not".
 *
 *  Colour carries meaning here, unlike the confidence mark next door — because the thing being
 *  coloured IS a yes/no leaning, so the love-green / maybe-amber / no-red ramp reads as the same
 *  three verdicts the rating buttons use, not as a second opinion on the flat.
 *
 *  `surprise` is the interesting case: a flat already rated where the model strongly disagrees with
 *  the rating (a loved place the model scores low, a rejected one it scores high). Those are worth
 *  a second look — either the model is missing something you saw, or you are. */
export type ScoreBand = 'yes' | 'lean-yes' | 'unsure' | 'lean-no' | 'no';

/** Five bands from the probability. The two outer cuts (0.2, 0.8) are where "leaning" becomes
 *  "likely"; the inner pair (0.4, 0.6) fence off the genuinely uncertain middle that the
 *  sort-by-uncertainty order is built to surface. */
export function scoreBand(score: number): ScoreBand {
  if (score >= 0.8) return 'yes';
  if (score >= 0.6) return 'lean-yes';
  if (score > 0.4) return 'unsure';
  if (score > 0.2) return 'lean-no';
  return 'no';
}

const WORD: Record<ScoreBand, string> = {
  yes: 'likely yes',
  'lean-yes': 'leaning yes',
  unsure: 'unsure',
  'lean-no': 'leaning no',
  no: 'likely no',
};

export function ScoreBadge({
  score,
  surprise = false,
  showWord = true,
}: {
  /** P(yes) in [0, 1]. */
  score: number;
  surprise?: boolean;
  /** The words beside the percentage. Off in tight rows where the colour and number are enough. */
  showWord?: boolean;
}) {
  const band = scoreBand(score);
  const pct = Math.round(score * 100);
  // The Hint rather than a native `title`: a percentage with no stated provenance is the one number
  // here somebody could read as a grade, and `title` says so only after a pause, only on a mouse,
  // and not at all in the panel's shadow root. Underline off — the pill already reads as an object
  // in its own right, and a dotted line under a coloured badge is noise.
  return (
    <Hint
      underline={false}
      className={`score score-${band}${surprise ? ' score-surprise' : ''}`}
      text={
        surprise
          ? `The model would guess ${WORD[band]} (${pct}%) — worth a second look, it disagrees with the rating.`
          : `The model's guess from your past verdicts: ${WORD[band]} (${pct}%).`
      }
    >
      {surprise && <span className="score-surprise-mark" aria-hidden="true">⚡</span>}
      <span className="score-pct">{pct}%</span>
      {showWord && <span className="score-word">{WORD[band]}</span>}
    </Hint>
  );
}
