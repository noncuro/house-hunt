import type { Group } from '@house-hunt/core';

/** The colours a map draws with, read off the tokens the rest of the app uses.
 *
 *  Leaflet takes a string for `fillColor` and cannot read a custom property, so a map is the one
 *  place in the app that has to resolve a token itself rather than write `var(--pin-loved)`. Doing
 *  it here rather than in each map is what stops the four hex literals coming back: a pin looking
 *  green on one screen and the chip for the same verdict looking a different green on the next is
 *  the app disagreeing with itself.
 *
 *  Its own module because there are two maps — the whole hunt on `screens/Map.tsx`, one flat in the
 *  pane beside triage — and the second reaching into the first for a colour would have a component
 *  importing a screen that already imports components.
 *
 *  The fallback is for the server render, where there is no `document` to compute against. Both maps
 *  are built in an effect, so nothing is ever painted with one; it exists so this has an honest
 *  answer rather than an empty string, which CSS would take as a colour. */
export function cssToken(name: string, fallback: string): string {
  if (typeof document === 'undefined') return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

/** What colour a flat is on a map, from what the hunt said about it. Resolved on each call rather
 *  than once at module load: a value cached before the stylesheet arrived would be the fallback for
 *  the life of the tab. */
export function pinColour(group: Group): string {
  switch (group) {
    case 'excited':
      return cssToken('--pin-loved', '#1a7f5a');
    case 'maybe':
      return cssToken('--pin-liked', '#d8a33a');
    case 'rejected':
      return cssToken('--pin-rejected', '#9aa7b2');
    case 'unrated':
      return cssToken('--pin-unrated', '#4a7fb5');
  }
}
