/** Cases for the description-prose floor-area fallback, which is the fiddliest bit of extraction
 *  and the one most likely to quietly regress. Run with `pnpm check:area`. */
import { parseAreaFromText, toListing } from '../packages/core/src/listing';

const cases: Array<[string, number | null]> = [
  ['A lovely flat extending to 1,234 sq ft over two floors.', 1234],
  ['Approximately 950 sqft of living space', 950],
  ['<p>Total area 115 sq m</p>', 1238],
  // The case that made this parser return the garden and the panel print it as the flat.
  ['800 sq ft of internal accommodation with a 1,200 sq ft garden', 800],
  ['A 1,200 sq ft garden behind the house', null],
  ['Extending to 1,258 sq ft, with a 400 sq ft roof terrace', 1258],
  // A sentence ends adjacency. Read across the full stop, the stated total is vetoed by the garden
  // that follows it and the garden is vetoed by itself, so the flat comes back with no size at all.
  ['Total floor area 1,200 sq ft. Garden 500 sq ft.', 1200],
  // And the same in the other direction, which the trailing window alone would still get wrong.
  ['Garden. Total 1,200 sq ft', 1200],
  // The abbreviation, which is why a sentence break needs the capital letter after it. The unit
  // pattern accepts "sq." and "ft.", so each of these puts a ". " directly after the match — the
  // same two characters that end a sentence. Read as one, the trailing window empties, nothing sees
  // the garden, and the third line hands back the garden as the flat: the case this file leads with,
  // merely spelled differently.
  ['A 1,200 sq. ft. garden behind the house', null],
  ['A 1,200 sq ft. garden behind the house', null],
  ['800 sq. ft. of internal accommodation with a 1,200 sq. ft. garden', 800],
  // A figure is not a capital either, so the full stop does not put the garden out of reach.
  ['Garden approx. 1,200 sq ft', null],
  ['Rear garden. 800 sq ft.', null],
  // Unless the number says what it is. "Garden." then a sentence starting on the number is the
  // shape #65 found dropped: the break needed a capital, the number is not one, and the garden
  // stayed in reach of a total that named itself. A bare "800 sq ft" after "Garden." could still be
  // the garden in an agent's shorthand, which is why the line above stays null.
  ['Garden. 1,200 sq ft of internal accommodation', 1200],
  ['Rear garden. Approximately 1,050 sq ft internal floor area.', 1050],
  ['800 sq ft of internal accommodation. 1,200 sq ft garden', 800],
  // Nothing names itself, so the largest that isn't obviously something else still wins.
  ['Two floors, 640 sq ft and 500 sq ft', 640],
  // Descriptions list room-by-room sizes; the total is what we want, so we take the largest.
  ['Reception 18 sq ft, kitchen 12 sq ft, total 1100 sq ft', 1100],
  ['110 m² of accommodation', 1184],
  ['No size mentioned here at all', null],
  ['A tiny 5 sq ft cupboard', null],
  ['Set in 3 acres', null],
];

let failed = 0;
for (const [text, want] of cases) {
  const got = parseAreaFromText(text);
  if (got !== want) failed++;
  console.log(`${got === want ? 'ok  ' : 'FAIL'} ${JSON.stringify(text).slice(0, 58)} -> ${got} (want ${want})`);
}

// The structured `sizings` array is trusted over the prose, so a bad value there is stored as the
// listing's own stated figure with nothing to warn a reader. Listing 92113695 (#90) reached the
// database as 1 sq ft while every floorplan reading said 1,238: a stated number that small is a
// placeholder, not a flat, and it has to be refused the way the prose parser already refuses one.
const sizingCases: Array<[string, unknown, number | null, 'sizings' | 'description' | null]> = [
  ['a stated size', [{ unit: 'sqft', minimumSize: 780, maximumSize: 780 }], 780, 'sizings'],
  ['a range takes the minimum', [{ unit: 'sqft', minimumSize: 780, maximumSize: 900 }], 780, 'sizings'],
  ['metric is converted', [{ unit: 'sqm', minimumSize: 115, maximumSize: 115 }], 1238, 'sizings'],
  ['a placeholder minimum yields the maximum', [{ unit: 'sqft', minimumSize: 1, maximumSize: 1238 }], 1238, 'sizings'],
  ['a placeholder alone falls through to the prose', [{ unit: 'sqft', minimumSize: 1, maximumSize: 1 }], 950, 'description'],
  ['a placeholder in metric too', [{ unit: 'sqm', minimumSize: 0.1, maximumSize: 0.1 }], 950, 'description'],
  ['an acreage is not a floor area', [{ unit: 'ac', minimumSize: 1, maximumSize: 1 }], 950, 'description'],
];
for (const [name, sizings, wantSqft, wantSource] of sizingCases) {
  const listing = toListing(
    { id: 1, sizings, text: { description: 'Approximately 950 sqft of living space' } },
    'https://www.rightmove.co.uk/properties/1',
  );
  const got = listing.floorArea;
  const ok = (got?.sqft ?? null) === wantSqft && (got?.source ?? null) === wantSource;
  if (!ok) failed++;
  console.log(
    `${ok ? 'ok  ' : 'FAIL'} sizings: ${name} -> ${got?.sqft ?? null} (${got?.source ?? null}) (want ${wantSqft} (${wantSource}))`,
  );
}

console.log(failed === 0 ? '\nall passed' : `\n${failed} failed`);
if (failed > 0) process.exit(1);
