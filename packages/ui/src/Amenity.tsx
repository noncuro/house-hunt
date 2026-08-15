import './amenity.css';
import { Icon, type IconName } from './Icon';
import { AMENITIES, type AmenityKey } from '@house-hunt/core';

/** An amenity, wherever one is named: the triage filters, the collapsed filter summary, the Your
 *  Hunt preference rows, and — through `SUBJECT` in Flags.tsx — the flag chips.
 *
 *  It exists because the same amenity was drawn three ways. The filters had the word alone, Your
 *  Hunt had a glyph and a hue of its own, the flags had a second glyph table that disagreed with it
 *  about which hue a dishwasher and a washing machine take. Three tables of pictures for one list of
 *  six things is three chances to show somebody a leaf on one screen and nothing at all on the next
 *  for what is the same requirement. */

/** Not severity. A hue says what the icon is a picture *of* — water, a plant, something warm — which
 *  is the one job colour still does on a neutral chip. */
export type SubjectHue = 'water' | 'green' | 'warm' | 'muted';

export const AMENITY_SUBJECT: Record<AmenityKey, { icon: IconName; hue: SubjectHue }> = {
  outdoor: { icon: 'outdoor', hue: 'green' },
  dishwasher: { icon: 'dishwasher', hue: 'water' },
  bathtub: { icon: 'bathtub', hue: 'water' },
  inUnitLaundry: { icon: 'laundry', hue: 'water' },
  // The same picture as in-unit laundry, and deliberately: they are one subject asked at two bars,
  // and a different glyph would read as a different fixture.
  anyLaundry: { icon: 'laundry', hue: 'water' },
  brightLight: { icon: 'light', hue: 'warm' },
  billsIncluded: { icon: 'bills', hue: 'warm' },
  separateSleeping: { icon: 'bed', hue: 'muted' },
  wholeProperty: { icon: 'places', hue: 'muted' },
};

const BY_KEY = new Map(AMENITIES.map((a) => [a.key, a]));

export function AmenityLabel({
  amenity,
  /** `name` stands alone on a control ("Outdoor space"); `label` goes mid-sentence in a summary
   *  ("under £2,600 · outdoor space"). Core carries both words — see AMENITIES. */
  word = 'name',
  size = 13,
}: {
  amenity: AmenityKey;
  word?: 'name' | 'label';
  size?: number;
}) {
  const meta = BY_KEY.get(amenity);
  const subject = AMENITY_SUBJECT[amenity];
  return (
    <span className="rm-amenity">
      <Icon name={subject.icon} size={size} className={`rm-subject-${subject.hue}`} />
      <span>{meta ? meta[word] : amenity}</span>
    </span>
  );
}
