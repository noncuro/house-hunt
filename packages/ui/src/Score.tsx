import { Hint } from './Hint';
import { Icon } from './Icon';
import './score.css';

/** The verdict score, drawn as a gauge: the model's probability this project says yes to a flat.
 *
 *  It is a prediction, not a grade, and the wording keeps that honest — "likely yes" and "leaning
 *  no", never a star rating. The number learns the project's own past verdicts (see
 *  `packages/core/src/predict.ts`); it is deliberately kept OUT of the compare table, whose whole
 *  design is that nothing is scored or blended so you can see which trade you are making. Here, in
 *  triage, one predicted number is exactly the aid you want: it orders a pile of thirty unrated
 *  flats into "look first" and "probably not".
 *
 *  The percentage used to be the headline and is now in the hint, which is the audit's point and
 *  worth stating plainly: a model fitted on 187 verdicts cannot tell 0% from 3%, and printing both
 *  invites a reader to rank two flats on a difference that is noise. The gauge and the word carry
 *  what the model actually knows — roughly where in five bands this sits — and the number is there
 *  for anyone who wants to check.
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

export function ScoreGauge({
  score,
  surprise = false,
  word = true,
}: {
  /** P(yes) in [0, 1]. */
  score: number;
  surprise?: boolean;
  /** The words beside the gauge. Off in tight cells, where the track's fill and colour are
   *  already the comparison being made down a column. */
  word?: boolean;
}) {
  const band = scoreBand(score);
  const pct = Math.round(score * 100);
  // The Hint rather than a native `title`: the percentage now lives only here, and `title` shows
  // after a pause, only on a mouse, and not at all in the panel's shadow root. Underline off — the
  // gauge already reads as an object in its own right.
  return (
    <Hint
      underline={false}
      className={`score score-${band}${word ? '' : ' score-bare'}`}
      text={
        surprise
          ? `The model would guess ${WORD[band]} (${pct}%) — model disagrees with the rating, so it is worth a second look.`
          : `The model's guess from your past verdicts: ${WORD[band]} (${pct}%).`
      }
    >
      {/* A track filled to the score. Not a number, because the model cannot tell 0% from 3% and
          printing both invites ranking flats on the difference. */}
      <span className="score-track">
        <span className="score-fill" style={{ width: `${Math.max(2, Math.min(100, pct))}%` }} />
      </span>
      {word && <span className="score-word">{WORD[band]}</span>}
      {surprise && <Icon name="warning" size={12} className="score-surprise-mark" />}
    </Hint>
  );
}
