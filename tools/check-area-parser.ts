/** Cases for the description-prose floor-area fallback, which is the fiddliest bit of extraction
 *  and the one most likely to quietly regress. Run with `pnpm check:area`. */
import { parseAreaFromText } from '../packages/core/src/listing';

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

console.log(failed === 0 ? '\nall passed' : `\n${failed} failed`);
if (failed > 0) process.exit(1);
