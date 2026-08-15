import './flags.css';
import { Confidence } from './Confidence';
import { Icon, type IconName } from './Icon';
import { flagsFor, problemsOnly, type Flag, type FlagSource, type HuntPreferences } from '@house-hunt/core';

/** What the photos say, in one place, drawn the same way everywhere.
 *
 *  A chip is neutral by default and carries a picture of its *subject* — a bath, a plant, a lamp.
 *  Colour is spent only on trouble, because it was previously spent on everything: green on good
 *  news, amber on a reservation and red on a dealbreaker meant a card with eleven flags was eleven
 *  competing colours, and the one that mattered had no way to stand out from the eight that did
 *  not. So good news is white with a hairline, a reservation is amber, and an absence is a dashed
 *  outline with a ×. The dash is the point: every red flag here is a thing that is *not there*.
 *
 *  `only="problems"` drops the good news. That is for the compare table, where a column reading
 *  "bathtub" down fourteen of seventeen rows spends its width saying nothing — a table answers
 *  "which of these has something against it".
 *
 *  The confidence mark rides along only on a flag the model was not sure about — see
 *  Confidence.tsx for why it stopped appearing on the confident ones. */
export function Flags({
  source,
  only = 'all',
  prefs,
}: {
  source: FlagSource;
  only?: 'all' | 'problems';
  /** This hunt's preferences, so a must-have absence flags red and a great room clears the hunt's
   *  own bar. Omitted everywhere the preferences do not reach, which is exactly the default
   *  behaviour. */
  prefs?: HuntPreferences;
}) {
  const all = flagsFor(source, prefs);
  const flags = only === 'problems' ? problemsOnly(all) : all;
  if (flags.length === 0) return null;

  return (
    <span className="rm-flags">
      {flags.map((flag) => (
        <FlagChip flag={flag} key={flag.key} />
      ))}
    </span>
  );
}

/** A subject's picture and the hue that picture is drawn in. The hue is not severity — it says
 *  what the icon is a picture *of*, which is the one job colour still has on a neutral chip.
 *  Keyed on `Flag.key` rather than on the words, so rewording a claim cannot silently change its
 *  glyph. */
const SUBJECT: Record<string, { icon: IconName; hue: 'water' | 'green' | 'warm' | 'muted' }> = {
  bathtub: { icon: 'bathtub', hue: 'water' },
  rooms: { icon: 'room', hue: 'warm' },
  outdoor: { icon: 'outdoor', hue: 'green' },
  dishwasher: { icon: 'dishwasher', hue: 'muted' },
  laundry: { icon: 'laundry', hue: 'green' },
  light: { icon: 'light', hue: 'warm' },
  bills: { icon: 'bills', hue: 'warm' },
  floorplan: { icon: 'floorplan', hue: 'muted' },
  size: { icon: 'size', hue: 'muted' },
  // Neither of these is a fixture with a picture — they are things about how the flat is *lived
  // in*, and both are dealbreakers rather than amenities, so they take the warning glyph.
  share: { icon: 'warning', hue: 'muted' },
  'bed-in-kitchen': { icon: 'warning', hue: 'muted' },
};

/** Severity decides the glyph for everything that is not good news, so the two can never argue:
 *  a red flag is an absence and draws the ×, an amber one is a caution and draws the triangle. */
const SEVERITY_ICON = { red: 'absent', yellow: 'warning' } as const;

export function FlagChip({ flag }: { flag: Flag }) {
  const subject = SUBJECT[flag.key];
  // A key this build has not heard of still has a severity, and on good news there is no picture
  // to guess at — a tick says "this counts in its favour" without inventing a subject.
  const icon: IconName = flag.severity === 'good' ? (subject?.icon ?? 'tick') : SEVERITY_ICON[flag.severity];
  // Only the neutral chip has a subject to colour. On amber and red the glyph is severity, and a
  // second hue on it would be a colour arguing with the border around it.
  const hue = flag.severity === 'good' ? (subject?.hue ?? 'muted') : null;
  // High confidence draws nothing at all: a mark on every claim is a mark nobody reads.
  const unsure = flag.confidence === 'low' || flag.confidence === 'medium';

  return (
    <span className={`rm-flag rm-flag-${flag.severity}${hue ? ` rm-flag-hue-${hue}` : ''}`}>
      <Icon name={icon} size={13} className="rm-flag-icon" />
      {flag.text}
      {/* The bars and the word are one group behind one hairline, so the divider reads as
          separating the claim from the doubt rather than the bars from their own caption. */}
      {unsure && (
        <span className="rm-flag-doubt">
          <Confidence level={flag.confidence} />
          unsure
        </span>
      )}
    </span>
  );
}
