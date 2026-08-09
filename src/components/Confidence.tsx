import './confidence.css';
import type { Confidence as Level } from '@/lib/types';

/** How sure the model was, drawn rather than described: one bar, two, or three.
 *
 *  Four things on a listing are the model's reading of the photos and the floorplan rather than
 *  anything Rightmove stated: whether there is a bathtub, how big the biggest room is, whether
 *  there is outdoor space, and the floor area. `claimLabel` hedges the wording when the model was
 *  unsure, which is right but easy to skim past — "bath possibly missing" and "no bathtub" are one
 *  word apart and look alike at 13px.
 *
 *  Three earlier attempts got this wrong in instructive ways, and the last two failed for the
 *  same underlying reason.
 *
 *  A 6px coloured dot said nothing about which level it was. Then concentric rings filled from the
 *  centre out, with a LOW MED HIGH legend beside them — which put those words next to the phrase
 *  "small rooms" and read, reasonably, as a grade being awarded to the rooms. Dropping the legend
 *  left the rings alone, and then the real fault showed: filling from the centre out makes the
 *  mark *shrink* as confidence falls, so a low reading rendered as a speck you had to hunt for.
 *  Exactly backwards. Low confidence is when the reader most needs to notice.
 *
 *  Five candidates were rendered at the real 15px and compared side by side, and the bars won.
 *  They win on two counts the rings could not. The footprint is identical at every level, so
 *  the mark never hides by being small — an unreached bar stays drawn in grey, which is what lets
 *  a single blue bar read as "one of three" rather than as a stray dot. And nobody has to be
 *  taught what they mean: ascending bars are already how everyone reads signal strength, which is
 *  what made the LOW MED HIGH legend unnecessary rather than merely unwelcome.
 *
 *  The mark appears on every model-read claim including the confident ones, because its presence
 *  is what says "a model worked this out" — the second thing you need to know, and the one no
 *  wording carried at all. A confident inference is still an inference.
 *
 *  Colour is deliberately not the signal. These claims sit in red warning text and green positive
 *  text, and a red/amber/green confidence ramp beside them would read as a second verdict on the
 *  flat — low confidence in a good thing is not bad news. One steel-blue hue that belongs to
 *  neither, and grey for what it has not reached. */
const BARS: Record<Level, number> = { low: 1, medium: 2, high: 3 };

/** x, and height, in the 24-unit viewBox. Ascending left to right, all sitting on the same
 *  baseline at y=22, which is what makes the shape read as a ramp rather than as three marks. */
const BAR = [
  { x: 2, height: 7 },
  { x: 9.5, height: 13 },
  { x: 17, height: 19 },
];

/** Three words, because the bars have already said everything else.
 *
 *  This tooltip used to run to three sentences — what the mark was, how sure the model was, and how
 *  to read the bars — on a glyph that appears forty-odd times on a shortlist page. Explaining the
 *  notation in every instance of the notation is what a legend is for, and the bars turned out not
 *  to need one. What is left is the one thing the shape cannot say on its own: which level it is,
 *  for anyone who would rather read it than count. */
const MEANING: Record<Level, string> = {
  low: 'Low confidence',
  medium: 'Medium confidence',
  high: 'High confidence',
};

export function Confidence({
  level,
}: {
  /** Absent means high — that is what the model returned before we started asking for a level,
   *  and it is what `claimLabel` assumes, so the bars and the wording can't disagree. */
  level: Level | null | undefined;
}) {
  const reached = level ?? 'high';
  const count = BARS[reached];

  return (
    <span
      className={`rm-cf rm-cf-${reached}`}
      role="img"
      aria-label={`Read from the photos. Model confidence: ${reached}.`}
      // A native title rather than the Hint tooltip: this mark repeats forty-odd times on a
      // shortlist page, and forty portalled tooltips is a great deal of DOM for two words.
      title={MEANING[reached]}
    >
      {/* Inline SVG because MV3 forbids remote assets, and because it scales to the panel's 13px
          without the blur a bitmap would pick up. */}
      <svg className="rm-cf-bars" viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
        {BAR.map((bar, i) => (
          <rect
            x={bar.x}
            y={22 - bar.height}
            width={5}
            height={bar.height}
            rx={1.5}
            className={i < count ? 'rm-cf-bar rm-cf-on' : 'rm-cf-bar rm-cf-off'}
            key={bar.x}
          />
        ))}
      </svg>
    </span>
  );
}
