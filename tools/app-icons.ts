/** The website's own icons, drawn rather than stored.
 *
 *    pnpm icons
 *
 *  The mark itself — HH as two townhouses — is defined once in `packages/ui/src/mark.ts` as a list of
 *  shapes, and `Mark.tsx` draws the same list as SVG for the app and the video. This file only
 *  rasterises it. Keeping four hand-made PNGs in the repo gives four files that drift the day the
 *  colour changes; adding a rasteriser gives this repo an image dependency it has managed to avoid
 *  everywhere else (`packages/core/src/png.ts` decodes floorplans by hand for the same reason).
 *  Every size here is drawn at its own resolution, so 512 is crisp because it was never 128.
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CANVAS, TILE_RADIUS, houses, tile, type Fill, type RGBA, type Shape } from '../packages/ui/src/mark';

/** Drawn at four times the size and averaged down. Without it every curve — the tile's corners, the
 *  arches — is a staircase, which on a 192px icon is the first thing anybody sees. */
const SUPERSAMPLE = 4;

interface Icon {
  file: string;
  size: number;
  /** Maskable icons are cropped by the platform to whatever shape it likes — a circle on most
   *  Android launchers — so they are drawn full-bleed with the houses pulled into the middle 80%,
   *  which is the safe zone every launcher shape contains. An icon that is merely rounded gets its
   *  own corners cut off and its chimneys clipped; hence two files rather than one clever one. */
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
  const unit = CANVAS / s;
  // Full-bleed for the two the platform will crop or composite itself; rounded for the ones drawn
  // as they are.
  const shapes = [tile(maskable || opaque ? 0 : TILE_RADIUS), ...houses(maskable ? 0.8 : 1)];
  const background = colourAt(shapes[0]!.fill, CANVAS / 2);

  const big = new Uint8Array(s * s * 4);
  for (let y = 0; y < s; y++) {
    const cy = (y + 0.5) * unit;
    for (let x = 0; x < s; x++) {
      const cx = (x + 0.5) * unit;
      // Outside the tile's corner: transparent, but still *paper*. The colour of a fully
      // transparent pixel is supposed to be unobservable, and here it is not — `downsample`
      // averages the four channels independently, so a pixel half inside the corner takes half its
      // colour from whatever is written here. Left at zero that is black, and the corners come out
      // with a dark fringe. Writing the tile's own colour underneath is what makes the average
      // come back right.
      let [r, g, b] = background;
      let a = 0;
      for (const shape of shapes) {
        if (!inside(shape, cx, cy)) continue;
        const [sr, sg, sb, sa] = colourAt(shape.fill, cy);
        r = r + (sr - r) * sa;
        g = g + (sg - g) * sa;
        b = b + (sb - b) * sa;
        a = a + (1 - a) * sa;
      }
      const o = (y * s + x) * 4;
      big[o] = r;
      big[o + 1] = g;
      big[o + 2] = b;
      big[o + 3] = Math.round(a * 255);
    }
  }

  return downsample(big, s, size, opaque);
}

function colourAt(fill: Fill, y: number): RGBA {
  if (!('from' in fill)) return fill;
  const t = Math.min(1, Math.max(0, (y - fill.y0) / (fill.y1 - fill.y0)));
  return [0, 1, 2, 3].map((i) => fill.from[i]! + (fill.to[i]! - fill.from[i]!) * t) as unknown as RGBA;
}

function inside(shape: Shape, x: number, y: number): boolean {
  switch (shape.kind) {
    case 'rect':
      return withinRounded(x - shape.x, y - shape.y, shape.w, shape.h, shape.r);
    case 'disc':
      return (x - shape.cx) ** 2 + (y - shape.cy) ** 2 <= shape.r ** 2;
    case 'half':
      return y <= shape.cy && (x - shape.cx) ** 2 + (y - shape.cy) ** 2 <= shape.r ** 2;
    case 'arch': {
      const spring = shape.top + shape.r;
      if (y > shape.bottom || Math.abs(x - shape.cx) > shape.r) return false;
      return y >= spring || (x - shape.cx) ** 2 + (y - spring) ** 2 <= shape.r ** 2;
    }
    case 'poly': {
      // Even-odd crossings of a ray to the right.
      let within = false;
      const pts = shape.points;
      for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        const [xi, yi] = pts[i]!;
        const [xj, yj] = pts[j]!;
        if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) within = !within;
      }
      return within;
    }
  }
}

/** Is this point inside a rounded rectangle whose top-left is the origin? Only the four corner discs
 *  need testing — everywhere else the rectangle's own edges decide it. */
function withinRounded(x: number, y: number, w: number, h: number, r: number): boolean {
  if (x < 0 || y < 0 || x > w || y > h) return false;
  const cx = Math.min(Math.max(x, r), w - r);
  const cy = Math.min(Math.max(y, r), h - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

/** Box filter, averaging in straight (non-premultiplied) RGBA.
 *
 *  Averaging straight RGBA is wrong in general — a transparent pixel's colour gets a vote it has not
 *  earned. It is right here only because `draw` writes the tile's colour underneath the
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

/** A minimal PNG: one IHDR, one IDAT, one IEND, filter byte 0 on every row. No filtering: these are
 *  mostly flat colours and soft gradients, and zlib does well enough on them unaided. */
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
