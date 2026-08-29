/** The website's own icons, drawn rather than stored.
 *
 *    pnpm icons
 *
 *  The mark is two letters and a rounded square — six rectangles and four corners — so drawing it is
 *  shorter than the alternatives and better than all of them. Scaling the extension's 128px icon up
 *  to 512 gives a blurred or blocky 512; keeping four hand-made PNGs in the repo gives four files
 *  that drift the day the colour changes; adding a rasteriser gives this repo an image dependency it
 *  has managed to avoid everywhere else (`packages/core/src/png.ts` decodes floorplans by hand for
 *  the same reason). Every size here is drawn at its own resolution, so 512 is crisp because it was
 *  never 128.
 *
 *  The proportions and both colours are measured off `apps/extension/public/icon/128.png`, so the
 *  icon on the phone's home screen and the icon in Chrome's toolbar are the same mark. They are
 *  written down here as fractions of the canvas rather than pixels, which is what lets any size be
 *  drawn — and it is why this file, not the PNGs beside it, is where the mark is edited.
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const GREEN = [0x1a, 0x7f, 0x5a] as const;
const WHITE = [0xfd, 0xfe, 0xfe] as const;

/** Every measurement, as a fraction of the canvas, from the 128px original. */
const RADIUS = 23 / 128;
const GLYPH_TOP = 40 / 128;
const GLYPH_BOTTOM = 87 / 128;
const GLYPH_LEFT = 21 / 128;
const STROKE = 9 / 128;
const LETTER = 38 / 128;
const GAP = 11 / 128;

/** Drawn at four times the size and averaged down. The only curves here are the four corners, and
 *  without this they are a staircase — which on a 192px icon is the first thing anybody sees. */
const SUPERSAMPLE = 4;

interface Icon {
  file: string;
  size: number;
  /** Maskable icons are cropped by the platform to whatever shape it likes — a circle on most
   *  Android launchers — so they are drawn full-bleed with the mark pulled into the middle 80%,
   *  which is the safe zone every launcher shape contains. An icon that is merely rounded gets its
   *  own corners cut off and its letters clipped; hence two files rather than one clever one. */
  maskable?: boolean;
  /** iOS composites the home-screen icon onto white and rounds it itself, so transparent corners
   *  come out as white triangles. Full-bleed, square, no alpha. */
  opaque?: boolean;
}

const ICONS: Icon[] = [
  { file: 'icon-192.png', size: 192 },
  { file: 'icon-512.png', size: 512 },
  { file: 'icon-maskable-512.png', size: 512, maskable: true },
  { file: 'apple-touch-icon.png', size: 180, opaque: true },
];

/** RGBA, one byte a channel, row-major. */
function draw({ size, maskable = false, opaque = false }: Icon): Uint8Array {
  const s = size * SUPERSAMPLE;
  // Full-bleed for the two the platform will crop or composite itself; rounded for the ones drawn
  // as they are.
  const radius = maskable || opaque ? 0 : RADIUS * s;
  // The safe zone, and the only thing `maskable` changes about the letters: same mark, 80% of the
  // size, still centred.
  const scale = maskable ? 0.8 : 1;
  const inset = ((1 - scale) * s) / 2;
  const at = (fraction: number) => inset + fraction * s * scale;

  const top = at(GLYPH_TOP);
  const bottom = at(GLYPH_BOTTOM);
  const stroke = STROKE * s * scale;
  const bar = (top + bottom - stroke) / 2;

  /** Both H's: two uprights and a crossbar each, laid out from the left edge. */
  const letters = [0, 1].map((n) => at(GLYPH_LEFT) + n * (LETTER + GAP) * s * scale);
  const glyph: Array<[number, number, number, number]> = letters.flatMap((x) => {
    const right = x + LETTER * s * scale - stroke;
    return [
      [x, top, stroke, bottom - top],
      [right, top, stroke, bottom - top],
      [x, bar, LETTER * s * scale, stroke],
    ] as Array<[number, number, number, number]>;
  });

  const big = new Uint8Array(s * s * 4);
  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      const inside = radius === 0 || withinRounded(x + 0.5, y + 0.5, s, radius);
      const on = glyph.some(([gx, gy, gw, gh]) => x >= gx && x < gx + gw && y >= gy && y < gy + gh);
      const o = (y * s + x) * 4;
      // Outside the corner: transparent, but still *green*. The colour of a fully transparent pixel
      // is supposed to be unobservable, and here it is not — `downsample` averages the four
      // channels independently, so a pixel that is half inside the corner takes half its colour
      // from whatever is written here. Left at the zeroes the array starts as, that is black, and
      // the rounded corners came out with a dark fringe: (13,64,45) at alpha 128 where the green
      // beside it is (26,127,90). Writing the green under the transparency is what makes the
      // average come back green.
      const [r, g, b] = on && inside ? WHITE : GREEN;
      big[o] = r;
      big[o + 1] = g;
      big[o + 2] = b;
      big[o + 3] = inside ? 255 : 0;
    }
  }

  return downsample(big, s, size, opaque);
}

/** Is this point inside a rounded square? Only the four corner discs need testing — everywhere else
 *  the square's own edges decide it. */
function withinRounded(x: number, y: number, s: number, r: number): boolean {
  const cx = Math.min(Math.max(x, r), s - r);
  const cy = Math.min(Math.max(y, r), s - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

/** Box filter, averaging in straight (non-premultiplied) RGBA.
 *
 *  Averaging straight RGBA is wrong in general — a transparent pixel's colour gets a vote it has not
 *  earned. It is right here only because `draw` writes the background green underneath the
 *  transparent corners rather than leaving them black, so the vote is for the colour that is
 *  actually there. That is a property of the caller, not of this function; see the note in `draw`. */
function downsample(big: Uint8Array, from: number, to: number, opaque: boolean): Uint8Array {
  const n = from / to;
  const out = new Uint8Array(to * to * 4);
  for (let y = 0; y < to; y++) {
    for (let x = 0; x < to; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let dy = 0; dy < n; dy++) {
        for (let dx = 0; dx < n; dx++) {
          const o = ((y * n + dy) * from + (x * n + dx)) * 4;
          r += big[o]!;
          g += big[o + 1]!;
          b += big[o + 2]!;
          a += big[o + 3]!;
        }
      }
      const count = n * n;
      const o = (y * to + x) * 4;
      out[o] = Math.round(r / count);
      out[o + 1] = Math.round(g / count);
      out[o + 2] = Math.round(b / count);
      out[o + 3] = opaque ? 255 : Math.round(a / count);
    }
  }
  return out;
}

/** A minimal PNG: one IHDR, one IDAT, one IEND, filter byte 0 on every row. No filtering because
 *  these are flat colours that zlib already compresses to nothing — the 512 comes out under 3kB. */
function encode(size: number, pixels: Uint8Array): Buffer {
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(pixels.subarray(y * stride, (y + 1) * stride)).copy(raw, y * (stride + 1) + 1);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function chunk(type: string, data: Buffer): Buffer {
  const out = Buffer.alloc(data.length + 12);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buffer: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// Last, not first: the tables below are `const`, and a top-level loop above them runs before
// they exist.
for (const icon of ICONS) {
  const pixels = draw(icon);
  writeFileSync(resolve(import.meta.dirname, '../apps/web/public', icon.file), encode(icon.size, pixels));
  console.log(`wrote apps/web/public/${icon.file} (${icon.size}px)`);
}
