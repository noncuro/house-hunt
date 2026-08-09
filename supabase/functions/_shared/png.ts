// GENERATED — do not edit. Copied from src/lib/ by tools/sync-edge-function.ts.
// Edit the original and run `pnpm sync:function`.

/** Flatten a transparent PNG onto white before showing it to a vision model.
 *
 *  Why this exists: Rightmove serves floorplans as greyscale-plus-alpha PNGs. One verified case
 *  was 74% fully transparent with dark line work, and the model reported it as "almost entirely
 *  obscured/blackened" — it had been composited onto black. The same plan flattened onto white
 *  read perfectly: 1082 sq ft, two bathrooms, bath present. Which is to say this bug silently
 *  produced "no bathtub", with high confidence, for a flat that has one.
 *
 *  Rightmove serves no flattened rendition (every JPEG variant 404s), so we do it here. Written
 *  against Compression Streams rather than node:zlib or a native module, because this module has
 *  to keep working when the analyser moves to a Supabase Edge Function.
 *
 *  What is handled: non-interlaced 8-bit images of every colour type, plus the sub-byte depths
 *  (1, 2 and 4) that greyscale and paletted images can use, plus transparency expressed either as
 *  an alpha channel (colour types 4 and 6), a tRNS palette (type 3), or a single transparent
 *  colour key (types 0 and 2). What is not: 16-bit samples and Adam7 interlacing, neither of which
 *  has ever turned up on a floorplan and both of which are a different decoder rather than a
 *  branch in this one.
 *
 *  The out-of-scope cases are the reason this returns a result object rather than bytes. An
 *  earlier version returned the input unchanged for anything it could not handle while
 *  `looksTransparent` went on reporting the file as transparent, so a caller that asked "is this
 *  transparent?" and then flattened believed it had a flat image and had not. Saying "here are
 *  your bytes, they are still transparent, and here is why" is the whole point: everything
 *  downstream of a floorplan is a measurement someone reads as fact. */

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

interface Header {
  width: number;
  height: number;
  depth: number;
  colourType: number;
  interlaced: boolean;
}

export interface FlattenResult {
  /** The bytes to send onward: a freshly encoded opaque PNG when we could flatten, otherwise the
   *  original input untouched. Never a partially rewritten file. */
  png: Uint8Array;
  /** True when the returned bytes carry no transparency — either because we flattened it away or
   *  because there was none to begin with. False means we are knowingly sending alpha, and the
   *  model will composite it onto whatever it likes. */
  opaque: boolean;
  /** Why the image is still transparent. Set only when `opaque` is false, and phrased to be worth
   *  putting in a log line. */
  reason?: string;
}

/** Composite a PNG onto opaque white. Never throws — a floorplan we can't flatten is still worth
 *  sending as-is — but never claims success it did not have either. */
export async function flattenOntoWhite(png: Uint8Array): Promise<FlattenResult> {
  try {
    if (!hasSignature(png)) return { png, opaque: false, reason: 'not a PNG' };

    // CRCs are verified here and not in `looksTransparent`: re-encoding a corrupt file would stamp
    // fresh, valid CRCs onto pixels we mis-decoded, turning "obviously broken" into "confidently
    // wrong". Reading the header to answer a yes/no question does no such damage.
    const chunks = readChunks(png, true);
    const ihdr = chunks.find((c) => c.type === 'IHDR');
    if (!ihdr || ihdr.data.length < 13) return { png, opaque: false, reason: 'no readable IHDR' };

    const header = readHeader(ihdr.data);
    const transparency = chunks.find((c) => c.type === 'tRNS')?.data;
    if (!carriesAlpha(header.colourType, transparency)) return { png, opaque: true };

    if (header.interlaced) {
      return { png, opaque: false, reason: 'Adam7 interlacing is out of scope for this decoder' };
    }
    if (!supportedDepth(header)) {
      return {
        png,
        opaque: false,
        reason: `bit depth ${header.depth} on colour type ${header.colourType} is out of scope for this decoder`,
      };
    }

    const palette = chunks.find((c) => c.type === 'PLTE')?.data;
    if (header.colourType === 3 && !palette) {
      return { png, opaque: false, reason: 'paletted image with no PLTE chunk' };
    }

    const idat = concat(chunks.filter((c) => c.type === 'IDAT').map((c) => c.data));
    if (idat.length === 0) return { png, opaque: false, reason: 'no IDAT data' };

    const rgb = compositeOntoWhite(await inflate(idat), header, palette, transparency);
    if (!rgb) return { png, opaque: false, reason: 'the pixel data did not decode' };

    return { png: await encodeRgb(rgb, header.width, header.height), opaque: true };
  } catch (error) {
    return { png, opaque: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

/** True when the file carries transparency we would want flattened — used to decide whether the
 *  work is worth doing at all. It answers only "does this file have alpha", never "can we deal
 *  with it": that second question belongs to `flattenOntoWhite`, which answers it honestly in the
 *  result rather than by quietly agreeing there was nothing to do. */
export function looksTransparent(png: Uint8Array): boolean {
  if (!hasSignature(png)) return false;
  try {
    const chunks = readChunks(png, false);
    const ihdr = chunks.find((c) => c.type === 'IHDR');
    if (!ihdr || ihdr.data.length < 13) return false;
    const { colourType } = readHeader(ihdr.data);
    return carriesAlpha(colourType, chunks.find((c) => c.type === 'tRNS')?.data);
  } catch {
    return false;
  }
}

/** Types 4 and 6 carry a per-pixel alpha channel. The other three carry transparency only when a
 *  tRNS chunk is present: an alpha byte per palette entry for type 3, and a single fully
 *  transparent colour key for types 0 and 2. */
function carriesAlpha(colourType: number, transparency: Uint8Array | undefined): boolean {
  if (colourType === 4 || colourType === 6) return true;
  return transparency !== undefined && (colourType === 0 || colourType === 2 || colourType === 3);
}

/** Sub-byte depths exist only for greyscale and palette; everything else is 8 or 16 bits, and 16
 *  is out of scope. */
function supportedDepth({ depth, colourType }: Header): boolean {
  if (depth === 8) return true;
  return (depth === 1 || depth === 2 || depth === 4) && (colourType === 0 || colourType === 3);
}

function hasSignature(png: Uint8Array): boolean {
  return SIGNATURE.every((byte, i) => png[i] === byte);
}

interface Chunk {
  type: string;
  data: Uint8Array;
}

/** Walk the chunk list. With `verify`, a chunk whose stored CRC disagrees with its bytes throws
 *  rather than being decoded — see the note at the call site for why that matters here and not in
 *  `looksTransparent`. */
function readChunks(png: Uint8Array, verify: boolean): Chunk[] {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const chunks: Chunk[] = [];
  let at = SIGNATURE.length;

  while (at + 8 <= png.length) {
    const length = view.getUint32(at);
    const type = String.fromCharCode(png[at + 4]!, png[at + 5]!, png[at + 6]!, png[at + 7]!);
    const start = at + 8;
    if (start + length + 4 > png.length) break;
    if (verify && crc32(png.subarray(at + 4, start + length)) !== view.getUint32(start + length)) {
      throw new Error(`the ${type} chunk failed its CRC — the file is corrupt`);
    }
    chunks.push({ type, data: png.subarray(start, start + length) });
    at = start + length + 4; // skip the CRC
    if (type === 'IEND') break;
  }
  return chunks;
}

function readHeader(ihdr: Uint8Array): Header {
  const view = new DataView(ihdr.buffer, ihdr.byteOffset, ihdr.byteLength);
  return {
    width: view.getUint32(0),
    height: view.getUint32(4),
    depth: ihdr[8]!,
    colourType: ihdr[9]!,
    interlaced: ihdr[12] === 1,
  };
}

const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

/** Undo the per-scanline filters and composite over white in one pass. Returns packed RGB, or
 *  null when the stream contradicts its own header — a wrong-sized IDAT, a filter byte that is
 *  not a filter, a palette index past the end of the palette. Those are all corruption, and the
 *  useful response to corruption is to hand back the original file rather than a picture of
 *  plausible-looking garbage. */
function compositeOntoWhite(
  raw: Uint8Array,
  header: Header,
  palette: Uint8Array | undefined,
  transparency: Uint8Array | undefined,
): Uint8Array | null {
  const { width, height, depth, colourType } = header;
  const channels = CHANNELS[colourType];
  if (!channels || width <= 0 || height <= 0) return null;

  const stride = Math.ceil((width * channels * depth) / 8);
  if (raw.length < height * (stride + 1)) return null;
  // The filters look back one whole pixel, rounded up to a byte — so every sub-byte depth looks
  // back exactly one byte, which is why this is not simply `channels`.
  const step = Math.ceil((channels * depth) / 8);

  // Sub-byte samples are fractions of full brightness, not small numbers: at depth 2, a sample of
  // 3 is white. 255/max is exact for every depth PNG allows here (255, 85, 17, 1).
  const scale = 255 / ((1 << depth) - 1);
  const key = colourKey(colourType, transparency);
  const paletteEntries = palette ? Math.floor(palette.length / 3) : 0;

  const out = new Uint8Array(width * height * 3);
  // The filters reference the pixel above, so the previous *unfiltered* scanline is kept.
  let previous = new Uint8Array(stride);
  let line = new Uint8Array(stride);

  for (let y = 0; y < height; y++) {
    const at = y * (stride + 1);
    if (!unfilter(raw[at]!, raw.subarray(at + 1, at + 1 + stride), previous, line, step)) return null;

    for (let x = 0; x < width; x++) {
      let r: number, g: number, b: number, a: number;

      if (colourType === 0) {
        const value = sampleAt(line, x, depth);
        r = g = b = Math.round(value * scale);
        a = key && value === key[0] ? 0 : 255;
      } else if (colourType === 2) {
        r = line[x * 3]!;
        g = line[x * 3 + 1]!;
        b = line[x * 3 + 2]!;
        a = key && r === key[0] && g === key[1] && b === key[2] ? 0 : 255;
      } else if (colourType === 3) {
        // Paletted, with alpha carried in tRNS (which may be shorter than the palette; entries
        // past its end are fully opaque). An index past the end of PLTE has no colour at all —
        // reading it used to yield undefined and coerce to black, painting invented pixels.
        const index = sampleAt(line, x, depth);
        if (index >= paletteEntries) return null;
        r = palette![index * 3]!;
        g = palette![index * 3 + 1]!;
        b = palette![index * 3 + 2]!;
        a = transparency && index < transparency.length ? transparency[index]! : 255;
      } else if (colourType === 4) {
        r = g = b = line[x * 2]!;
        a = line[x * 2 + 1]!;
      } else {
        r = line[x * 4]!;
        g = line[x * 4 + 1]!;
        b = line[x * 4 + 2]!;
        a = line[x * 4 + 3]!;
      }

      // Source-over onto opaque white: out = src*a + 255*(1-a). Rounded, not truncated: the
      // truncating version shifted every partially transparent pixel a shade dark, which on a
      // floorplan is exactly the direction that makes thin grey line work harder to read.
      const inverse = 255 - a;
      const p = (y * width + x) * 3;
      out[p] = Math.round((r * a + 255 * inverse) / 255);
      out[p + 1] = Math.round((g * a + 255 * inverse) / 255);
      out[p + 2] = Math.round((b * a + 255 * inverse) / 255);
    }

    [previous, line] = [line, previous];
  }
  return out;
}

/** The single fully transparent colour a type 0 or type 2 image can nominate in tRNS. Samples are
 *  stored as 16-bit big-endian regardless of the file's bit depth, and compared against the raw
 *  sample value rather than the scaled one. */
function colourKey(colourType: number, transparency: Uint8Array | undefined): number[] | null {
  if (!transparency) return null;
  if (colourType === 0 && transparency.length >= 2) {
    return [(transparency[0]! << 8) | transparency[1]!];
  }
  if (colourType === 2 && transparency.length >= 6) {
    return [0, 2, 4].map((i) => (transparency[i]! << 8) | transparency[i + 1]!);
  }
  return null;
}

/** One sample out of a packed scanline. Depths below 8 pack 8, 4 or 2 samples into each byte,
 *  most significant bits first. */
function sampleAt(line: Uint8Array, index: number, depth: number): number {
  if (depth === 8) return line[index]!;
  const perByte = 8 / depth;
  const shift = 8 - depth * ((index % perByte) + 1);
  return (line[Math.floor(index / perByte)]! >> shift) & ((1 << depth) - 1);
}

/** PNG's five scanline filters (RFC 2083 §6). Returns false for a filter byte outside 0–4, which
 *  is not a filter we failed to recognise but a stream that is not the PNG it says it is; the old
 *  behaviour of falling back to "none" produced a full-size image of noise that looked, to
 *  everything downstream, like a photograph the model simply could not read. */
function unfilter(
  type: number,
  source: Uint8Array,
  previous: Uint8Array,
  into: Uint8Array,
  step: number,
): boolean {
  if (type > 4) return false;

  const length = source.length;
  for (let i = 0; i < length; i++) {
    const left = i >= step ? into[i - step]! : 0;
    const up = previous[i]!;
    const upLeft = i >= step ? previous[i - step]! : 0;
    const value = source[i]!;

    switch (type) {
      case 0:
        into[i] = value;
        break;
      case 1:
        into[i] = (value + left) & 0xff;
        break;
      case 2:
        into[i] = (value + up) & 0xff;
        break;
      case 3:
        into[i] = (value + ((left + up) >> 1)) & 0xff;
        break;
      default: // 4 — the guard above is what makes this Paeth and not "anything else"
        into[i] = (value + paeth(left, up, upLeft)) & 0xff;
    }
  }
  return true;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/** Re-encode packed RGB as a minimal PNG: one IHDR, one IDAT, one IEND, every scanline
 *  unfiltered. Bigger than an optimised encoder would produce, and this is a throwaway image on
 *  its way to an API. */
async function encodeRgb(rgb: Uint8Array, width: number, height: number): Promise<Uint8Array> {
  const stride = width * 3;
  const rawWithFilters = new Uint8Array(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    rawWithFilters[y * (stride + 1)] = 0; // filter type: none
    rawWithFilters.set(rgb.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }

  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour, no alpha

  return concat([
    new Uint8Array(SIGNATURE),
    chunk('IHDR', ihdr),
    chunk('IDAT', await deflate(rawWithFilters)),
    chunk('IEND', new Uint8Array(0)),
  ]);
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

let crcTable: Uint32Array | null = null;

function crc32(bytes: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** "deflate" in the Compression Streams spec is zlib-wrapped, which is exactly what a PNG IDAT
 *  holds — so no separate zlib dependency, in any runtime. */
async function inflate(data: Uint8Array): Promise<Uint8Array> {
  return await pump(data, new DecompressionStream('deflate'));
}

async function deflate(data: Uint8Array): Promise<Uint8Array> {
  return await pump(data, new CompressionStream('deflate'));
}

async function pump(
  data: Uint8Array,
  // The DOM lib types these streams as accepting BufferSource, which doesn't unify with a
  // TransformStream<Uint8Array, Uint8Array>; the runtime behaviour is identical.
  transform: CompressionStream | DecompressionStream,
): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(transform);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}
