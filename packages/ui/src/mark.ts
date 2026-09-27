/** The house-hunt mark: "HH" drawn as two London townhouses, one with its window lit.
 *
 *  Each H is a house front. Its uprights are the party walls, rising into chimney stacks with a
 *  pair of pots; its crossbar is the first-floor cornice with a railing on it; below is an arched
 *  door with a fanlight, above a sash window. The strokes are heavy enough that at 16px, where the
 *  detail is gone, it still reads as HH.
 *
 *  Written down once, as a list of shapes on a 512-unit canvas, so everything that draws it agrees:
 *  `tools/app-icons.ts` rasterises it into the website's PNG icons, `Mark.tsx` draws it as SVG for
 *  the app's splash, and the promo video uses that same component. Change the mark here and all
 *  of them follow.
 *
 *  Only a few kinds of shape, because the rasteriser draws each by hand: rounded rectangles, discs,
 *  upper half-discs, arches (a rectangle with a half-disc on top) and polygons. Fills are flat or a
 *  top-to-bottom gradient. Shapes are painted in order, later over earlier.
 *
 *  The splash adds a magnifying glass that is not part of the mark: it sweeps the two houses and
 *  stops on the right-hand one, whose window lights. `SPLASH` is that path, shared by the CSS
 *  animation and by the video, which has to compute each frame itself.
 */

export type RGBA = readonly [number, number, number, number];
/** A top-to-bottom gradient between two canvas heights. */
export interface Gradient {
  from: RGBA;
  to: RGBA;
  y0: number;
  y1: number;
}
export type Fill = RGBA | Gradient;

export type Shape = (
  | { kind: 'rect'; x: number; y: number; w: number; h: number; r: number; fill: Fill }
  | { kind: 'disc'; cx: number; cy: number; r: number; fill: Fill }
  | { kind: 'half'; cx: number; cy: number; r: number; fill: Fill }
  | { kind: 'arch'; cx: number; top: number; bottom: number; r: number; fill: Fill }
  | { kind: 'poly'; points: Array<[number, number]>; fill: Fill }
) & {
  /** The lit window, which the splash turns on. Everything else ignores it. */
  lit?: true;
};

export const CANVAS = 512;
/** The tile's corner, for the icons that are drawn rounded rather than left to the platform. */
export const TILE_RADIUS = 112;

const rgb = (hex: string, a = 1): RGBA => [
  parseInt(hex.slice(1, 3), 16),
  parseInt(hex.slice(3, 5), 16),
  parseInt(hex.slice(5, 7), 16),
  a,
];

const TILE: Gradient = { from: rgb('#23946a'), to: rgb('#136648'), y0: 0, y1: CANVAS };
const STONE = rgb('#fbf7f0');
const DOOR = rgb('#0f4f38');
const POT = rgb('#c8643b');
const STEP = rgb('#fbf7f0', 0.5);
const AMBER = rgb('#f7c65a');
const lamp = (y0: number, y1: number): Gradient => ({ from: AMBER, to: rgb('#ec9a36'), y0, y1 });

/** The tile under the houses. Its own export because a maskable icon keeps the tile full-size and
 *  shrinks only what is on it into the safe zone. */
export function tile(radius: number): Shape {
  return { kind: 'rect', x: 0, y: 0, w: CANVAS, h: CANVAS, r: radius, fill: TILE };
}

const TOP = 150; // the parapet
const BOTTOM = 380; // the pavement
const WIDTH = 150; // one house
const GAP = 28; // between the two
const STROKE = 38; // the H's uprights
const LEFT = (CANVAS - 2 * WIDTH - GAP) / 2;

/** Where a house's upstairs window is, for the house and for the glass that looks at it. */
function windowOf(x: number) {
  const bar = TOP + (BOTTOM - TOP) * 0.44;
  const inner = WIDTH - 2 * STROKE;
  const w = inner * 0.62;
  const h = (bar - TOP) * 0.6;
  return { cx: x + WIDTH / 2, cy: TOP + (bar - TOP) / 2 + 4, y: TOP + (bar - TOP - h) / 2 + 4, w, h };
}

/** One H as a townhouse front, its left edge at `x`. */
function house(x: number, lit: boolean): Shape[] {
  const bar = TOP + (BOTTOM - TOP) * 0.44; // the cornice: the H's crossbar
  const barH = STROKE * 0.8;
  const cx = x + WIDTH / 2;
  const inner = WIDTH - 2 * STROKE;
  const shapes: Shape[] = [];

  for (const ux of [x, x + WIDTH - STROKE]) {
    shapes.push({ kind: 'rect', x: ux, y: TOP, w: STROKE, h: BOTTOM - TOP, r: 0, fill: STONE });
    shapes.push({ kind: 'rect', x: ux - 3, y: TOP, w: STROKE + 6, h: 7, r: 2, fill: STONE });
    for (const k of [0, 1]) shapes.push({ kind: 'rect', x: ux + 7 + k * (STROKE - 22), y: TOP - 16, w: 8, h: 18, r: 3, fill: POT });
  }
  shapes.push({ kind: 'rect', x, y: bar, w: WIDTH, h: barH, r: 0, fill: STONE });

  // The front door, and the fanlight over it.
  const door = (inner * 0.66) / 2;
  const doorTop = bar + barH + 18;
  shapes.push({ kind: 'arch', cx, top: doorTop, bottom: BOTTOM, r: door, fill: DOOR });
  shapes.push({ kind: 'half', cx, cy: doorTop + door, r: door - 5, fill: lamp(doorTop + 5, doorTop + door) });

  // The sash window, dark, then lit over the top in the house the glass finds, and its glazing bars.
  const { y: wy, w: ww, h: wh } = windowOf(x);
  shapes.push({ kind: 'rect', x: cx - ww / 2, y: wy, w: ww, h: wh, r: 3, fill: DOOR });
  if (lit) shapes.push({ kind: 'rect', x: cx - ww / 2, y: wy, w: ww, h: wh, r: 3, fill: lamp(wy, wy + wh), lit: true });
  shapes.push({ kind: 'rect', x: cx - ww / 2, y: wy + wh / 2 - 2, w: ww, h: 4, r: 0, fill: STONE });
  shapes.push({ kind: 'rect', x: cx - 2, y: wy, w: 4, h: wh, r: 0, fill: STONE });

  // The railing along the cornice.
  shapes.push({ kind: 'rect', x: x + STROKE, y: bar - 14, w: inner, h: 4, r: 0, fill: STONE });
  for (let k = 0; k < 5; k++) shapes.push({ kind: 'rect', x: x + STROKE + 4 + (k * (inner - 12)) / 4, y: bar - 12, w: 4, h: 12, r: 0, fill: STONE });

  // The front step.
  shapes.push({ kind: 'rect', x: x - 8, y: BOTTOM, w: WIDTH + 16, h: 10, r: 2, fill: STEP });
  return shapes;
}

/** The two houses, scaled about the centre of the canvas. */
export function houses(scale = 1): Shape[] {
  const shapes = [...house(LEFT, false), ...house(LEFT + WIDTH + GAP, true)];
  return scale === 1 ? shapes : shapes.map((shape) => scaled(shape, scale));
}

function scaled(shape: Shape, k: number): Shape {
  const c = CANVAS / 2;
  const p = (v: number) => c + (v - c) * k;
  const fill: Fill = 'from' in shape.fill ? { ...shape.fill, y0: p(shape.fill.y0), y1: p(shape.fill.y1) } : shape.fill;
  switch (shape.kind) {
    case 'rect':
      return { ...shape, x: p(shape.x), y: p(shape.y), w: shape.w * k, h: shape.h * k, r: shape.r * k, fill };
    case 'disc':
    case 'half':
      return { ...shape, cx: p(shape.cx), cy: p(shape.cy), r: shape.r * k, fill };
    case 'arch':
      return { ...shape, cx: p(shape.cx), top: p(shape.top), bottom: p(shape.bottom), r: shape.r * k, fill };
    case 'poly':
      return { ...shape, points: shape.points.map(([x, y]) => [p(x), p(y)]), fill };
  }
}

/** The whole mark as the promo video and the rounded icons draw it. */
export function mark(): Shape[] {
  return [tile(TILE_RADIUS), ...houses()];
}

/** The magnifying glass, drawn about its own centre: a lens that frames one window, a brass rim and
 *  a handle to the lower right. */
export const GLASS = { r: 62, rim: 14, handle: 66, grip: 24, colour: AMBER } as const;

/** One moment of the splash: where the glass is (canvas units), how big and how visible, and how far
 *  the found window is lit. */
export interface SplashFrame {
  t: number;
  x: number;
  y: number;
  scale: number;
  opacity: number;
  light: number;
}

const LEFT_WINDOW = windowOf(LEFT);
const RIGHT_WINDOW = windowOf(LEFT + WIDTH + GAP);

/** How long the splash runs. */
export const SPLASH_MS = 1400;

/** The glass comes in low on the left, looks in the first window, crosses to the second, finds it
 *  lit, and lifts away. `t` is the fraction of `SPLASH_MS`. */
export const SPLASH: SplashFrame[] = [
  { t: 0, x: LEFT_WINDOW.cx - 70, y: LEFT_WINDOW.cy + 120, scale: 0.7, opacity: 0, light: 0 },
  { t: 0.16, x: LEFT_WINDOW.cx, y: LEFT_WINDOW.cy, scale: 1, opacity: 1, light: 0 },
  { t: 0.36, x: LEFT_WINDOW.cx + 14, y: LEFT_WINDOW.cy + 4, scale: 1, opacity: 1, light: 0 },
  { t: 0.62, x: RIGHT_WINDOW.cx, y: RIGHT_WINDOW.cy, scale: 1, opacity: 1, light: 0 },
  { t: 0.7, x: RIGHT_WINDOW.cx, y: RIGHT_WINDOW.cy, scale: 1.06, opacity: 1, light: 1 },
  { t: 0.8, x: RIGHT_WINDOW.cx, y: RIGHT_WINDOW.cy, scale: 1, opacity: 1, light: 1 },
  { t: 1, x: RIGHT_WINDOW.cx + 60, y: RIGHT_WINDOW.cy - 70, scale: 1.3, opacity: 0, light: 1 },
];

/** The splash at `t` in [0, 1], eased between its keyframes the way the CSS animation eases them. */
export function splashAt(t: number): SplashFrame {
  const k = Math.min(1, Math.max(0, t));
  const i = Math.max(0, SPLASH.findIndex((f) => f.t >= k) - 1);
  const a = SPLASH[i]!;
  const b = SPLASH[Math.min(i + 1, SPLASH.length - 1)]!;
  const u = b.t === a.t ? 1 : (k - a.t) / (b.t - a.t);
  const e = u < 0.5 ? 4 * u ** 3 : 1 - (-2 * u + 2) ** 3 / 2; // ease-in-out, as `SPLASH_EASE`
  const mix = (p: number, q: number) => p + (q - p) * e;
  return { t: k, x: mix(a.x, b.x), y: mix(a.y, b.y), scale: mix(a.scale, b.scale), opacity: mix(a.opacity, b.opacity), light: mix(a.light, b.light) };
}

/** The CSS timing function that matches `splashAt`'s easing closely enough to be the same motion. */
export const SPLASH_EASE = 'cubic-bezier(0.65, 0, 0.35, 1)';
