/** Cases for the PNG flattener.
 *
 *  These run offline against PNGs built here byte by byte, because the interesting inputs are the
 *  ones Rightmove has not served us yet: a 4-bit palette, a transparent-colour key, a file with a
 *  broken CRC. Waiting to meet those in production is how the original bug worked — a floorplan
 *  came back "almost entirely blackened" and the analysis said "no bathtub" with high confidence
 *  for a flat that has one.
 *
 *  Every case pins one of two things: that a transparent image comes back opaque with the right
 *  pixels, or that an image we cannot flatten says so instead of pretending. The second half is
 *  the half that used to be missing — `looksTransparent` reported alpha on files `flattenOntoWhite`
 *  returned untouched, so a caller that asked and then flattened believed it had a flat image.
 *
 *    pnpm check:png          # the offline cases
 *    pnpm check:png --live   # also fetch the real floorplan that started all this
 */
import { deflateSync, inflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { flattenOntoWhite, looksTransparent } from '../packages/core/src/png';

let failures = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) return console.log(`  ok   ${name}`);
  failures++;
  console.log(`  FAIL ${name}\n       expected ${e}\n       got      ${a}`);
}

function checkMatch(name: string, actual: string | undefined, pattern: RegExp) {
  if (actual && pattern.test(actual)) return console.log(`  ok   ${name}`);
  failures++;
  console.log(`  FAIL ${name}\n       expected /${pattern.source}/\n       got      ${actual}`);
}

// ---------------------------------------------------------------------------------------------
// Building PNGs by hand. Nothing here is clever; it exists so a case can state exactly which byte
// it is about, which a library-produced fixture cannot.

interface Ihdr {
  width: number;
  height: number;
  depth: number;
  colourType: number;
  interlaced?: boolean;
}

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let k = 0; k < 8; k++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array, breakCrc = false): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  const crc = crc32(out.subarray(4, 8 + data.length));
  view.setUint32(8 + data.length, breakCrc ? (crc ^ 0xffff) >>> 0 : crc);
  return out;
}

function bytes(...values: number[]): Uint8Array {
  return new Uint8Array(values);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** `raw` is the scanline data *including* each line's leading filter byte, exactly as it sits
 *  inside a decompressed IDAT. */
function png(
  header: Ihdr,
  raw: Uint8Array,
  extra: { palette?: Uint8Array; transparency?: Uint8Array; breakIdatCrc?: boolean } = {},
): Uint8Array {
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, header.width);
  view.setUint32(4, header.height);
  ihdr[8] = header.depth;
  ihdr[9] = header.colourType;
  ihdr[12] = header.interlaced ? 1 : 0;

  return concat([
    new Uint8Array(SIGNATURE),
    chunk('IHDR', ihdr),
    ...(extra.palette ? [chunk('PLTE', extra.palette)] : []),
    ...(extra.transparency ? [chunk('tRNS', extra.transparency)] : []),
    chunk('IDAT', new Uint8Array(deflateSync(raw)), extra.breakIdatCrc),
    chunk('IEND', new Uint8Array(0)),
  ]);
}

/** Read back a flattener output. It is always the same shape — truecolour, 8-bit, filter 0 — so
 *  this needs to understand only that one. */
function pixels(out: Uint8Array): number[][] {
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  let at = SIGNATURE.length;
  let width = 0;
  let height = 0;
  const idat: Uint8Array[] = [];
  while (at + 8 <= out.length) {
    const length = view.getUint32(at);
    const type = String.fromCharCode(out[at + 4]!, out[at + 5]!, out[at + 6]!, out[at + 7]!);
    const data = out.subarray(at + 8, at + 8 + length);
    if (type === 'IHDR') {
      width = new DataView(data.buffer, data.byteOffset).getUint32(0);
      height = new DataView(data.buffer, data.byteOffset).getUint32(4);
    }
    if (type === 'IDAT') idat.push(data);
    at += length + 12;
    if (type === 'IEND') break;
  }
  const raw = new Uint8Array(inflateSync(concat(idat)));
  const stride = width * 3;
  const result: number[][] = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = y * (stride + 1) + 1 + x * 3;
      result.push([raw[p]!, raw[p + 1]!, raw[p + 2]!]);
    }
  }
  return result;
}

const WHITE = [255, 255, 255];

async function flattened(name: string, file: Uint8Array, expected: number[][]) {
  const result = await flattenOntoWhite(file);
  if (!result.opaque) {
    failures++;
    return console.log(`  FAIL ${name}\n       expected a flattened image, got: ${result.reason}`);
  }
  check(name, pixels(result.png), expected);
  // The output must also read as opaque to the very function that decided flattening was needed,
  // or the caller would go round again forever.
  check(`${name} — output no longer reads as transparent`, looksTransparent(result.png), false);
}

async function refused(name: string, file: Uint8Array, pattern: RegExp, stillTransparent = true) {
  const result = await flattenOntoWhite(file);
  check(`${name} — reports itself unflattened`, result.opaque, false);
  checkMatch(`${name} — says why`, result.reason, pattern);
  // The bytes handed back are the input, untouched. Re-encoding a file we could not read would
  // stamp fresh valid CRCs onto pixels we got wrong, which is worse than leaving it alone.
  check(`${name} — hands back the original bytes`, result.png === file, true);
  // And `looksTransparent` must not have said "nothing to do here" — the two functions disagreeing
  // is the bug this whole file exists to prevent.
  check(`${name} — looksTransparent agrees there is alpha`, looksTransparent(file), stillTransparent);
}

// ---------------------------------------------------------------------------------------------

console.log('transparency we can flatten');

// A greyscale image whose transparency is a colour key rather than a channel. Colour types 0 and 2
// were previously dropped on the floor: `looksTransparent` saw the tRNS chunk and said yes, and
// the flattener saw no alpha channel and returned the file untouched.
await flattened(
  'greyscale (type 0) with a tRNS colour key',
  png({ width: 2, height: 1, depth: 8, colourType: 0 }, bytes(0, 0, 128), { transparency: bytes(0, 0) }),
  [WHITE, [128, 128, 128]],
);

// The same for truecolour: one nominated RGB triple is transparent, everything else is opaque.
await flattened(
  'truecolour (type 2) with a tRNS colour key',
  png({ width: 2, height: 1, depth: 8, colourType: 2 }, bytes(0, 255, 0, 0, 10, 20, 30), {
    transparency: bytes(0, 255, 0, 0, 0, 0),
  }),
  [WHITE, [10, 20, 30]],
);

// Paletted at 4 bits: two indices to a byte, high nibble first. Returned unchanged before, again
// while being reported transparent.
await flattened(
  'paletted at bit depth 4',
  png({ width: 3, height: 1, depth: 4, colourType: 3 }, bytes(0, 0x01, 0x20), {
    palette: bytes(0, 0, 0, 255, 0, 0, 0, 255, 0),
    transparency: bytes(0),
  }),
  [WHITE, [255, 0, 0], [0, 255, 0]],
);

// And at 1 bit, where a whole scanline of eight pixels is one byte.
await flattened(
  'paletted at bit depth 1',
  png({ width: 8, height: 1, depth: 1, colourType: 3 }, bytes(0, 0b10101010), {
    palette: bytes(0, 0, 0, 0, 0, 255),
    transparency: bytes(0),
  }),
  [[0, 0, 255], WHITE, [0, 0, 255], WHITE, [0, 0, 255], WHITE, [0, 0, 255], WHITE],
);

// The path that already worked, kept so widening the decoder cannot quietly break it.
await flattened(
  'paletted at bit depth 8 (the case that already worked)',
  png({ width: 2, height: 1, depth: 8, colourType: 3 }, bytes(0, 0, 1), {
    palette: bytes(0, 0, 0, 12, 34, 56),
    transparency: bytes(0),
  }),
  [WHITE, [12, 34, 56]],
);

// Partial alpha is where rounding shows: 200 over white at alpha 200 is 212.02, and the old
// truncating arithmetic wrote 211. One shade, every partially transparent pixel, always darker —
// which on grey floorplan line work is the direction that costs legibility.
await flattened(
  'grey+alpha composites with rounding, not truncation',
  png({ width: 2, height: 1, depth: 8, colourType: 4 }, bytes(0, 200, 200, 0, 255)),
  [[212, 212, 212], [0, 0, 0]],
);

console.log('nothing to do');

// An opaque file must come back byte-identical and claim opacity, so the caller does not re-encode
// every JPEG-equivalent PNG in a gallery for nothing.
const opaque = png({ width: 1, height: 1, depth: 8, colourType: 2 }, bytes(0, 1, 2, 3));
const opaqueResult = await flattenOntoWhite(opaque);
check('an opaque PNG is reported opaque', opaqueResult.opaque, true);
check('an opaque PNG is returned untouched', opaqueResult.png === opaque, true);
check('an opaque PNG never looked transparent', looksTransparent(opaque), false);

console.log('transparency we cannot flatten — and say so');

// Adam7 is a different decoder, not a branch in this one. It must fail out loud: the caller logs
// the reason and the model gets the original, rather than everyone assuming it was handled.
await refused(
  'interlaced',
  png({ width: 2, height: 1, depth: 8, colourType: 4, interlaced: true }, bytes(0, 1, 255, 2, 255)),
  /interlac/i,
);

// 16-bit samples, likewise out of scope and likewise stated rather than swallowed.
await refused(
  '16-bit samples',
  png({ width: 1, height: 1, depth: 16, colourType: 6 }, bytes(0, 0, 1, 0, 2, 0, 3, 0, 255)),
  /bit depth 16/,
);

// A corrupt input must not become an output with fresh, valid CRCs stamped over pixels we
// mis-decoded. That turns "obviously broken" into "confidently wrong", which is the failure this
// whole extension is arranged to avoid.
await refused(
  'a chunk whose CRC does not match its bytes',
  png({ width: 2, height: 1, depth: 8, colourType: 4 }, bytes(0, 1, 255, 2, 255), { breakIdatCrc: true }),
  /CRC/,
);

// Filter byte 5 does not exist. Treating it as "none" (the old behaviour) produced a full-size
// image of noise, which downstream looks exactly like a photo the model could not read.
await refused(
  'a scanline filter byte outside 0–4',
  png({ width: 2, height: 1, depth: 8, colourType: 4 }, bytes(5, 1, 255, 2, 255)),
  /did not decode/,
);

// An index past the end of PLTE has no colour. It used to read as undefined and coerce to black —
// invented pixels, in the one image whose pixels are the measurements.
await refused(
  'a palette index past the end of PLTE',
  png({ width: 2, height: 1, depth: 8, colourType: 3 }, bytes(0, 0, 7), {
    palette: bytes(0, 0, 0, 1, 1, 1),
    transparency: bytes(0),
  }),
  /did not decode/,
);

// Not a PNG at all: both functions must agree there is nothing here, and neither may throw.
await refused('bytes that are not a PNG', bytes(1, 2, 3, 4, 5, 6, 7, 8, 9), /not a PNG/, false);

if (process.argv.includes('--live')) {
  console.log('the real floorplan');
  const url =
    process.argv.find((a) => a.startsWith('http')) ??
    'https://media.rightmove.co.uk/property-floorplan/0f7cb9211/90193551/0f7cb9211dcdab01e25217600560fba9.png';
  const source = new Uint8Array(await (await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } })).arrayBuffer());
  console.log(`  ${source.length} bytes, transparent: ${looksTransparent(source)}`);
  const result = await flattenOntoWhite(source);
  check('the real floorplan flattens', result.opaque, true);
  check('the real floorplan comes back opaque', looksTransparent(result.png), false);
  check('the real floorplan was actually rewritten', result.png === source, false);
  writeFileSync('/tmp/flat.png', result.png);
  console.log('  wrote /tmp/flat.png');
}

if (failures > 0) {
  console.error(`\n${failures} failing`);
  process.exit(1);
}
console.log('\nall ok');
