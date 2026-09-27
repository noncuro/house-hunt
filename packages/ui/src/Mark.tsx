import { useId, type CSSProperties } from 'react';
import { CANVAS, GLASS, SPLASH, SPLASH_EASE, SPLASH_MS, mark, type Fill, type RGBA, type Shape, type SplashFrame } from './mark';

const css = ([r, g, b, a]: RGBA) => `rgba(${r},${g},${b},${a})`;

/** The app's mark — HH as two townhouses (`mark.ts`) — as SVG.
 *
 *  Three ways to draw it. Plain, the icon as it is. `splash`, which plays the magnifying glass across
 *  it once with CSS, for the app's launch screen. Or `at`, one frame of that same splash, for a
 *  renderer that computes its own frames (the promo video, via `splashAt`). The keyframes come from
 *  `SPLASH` either way, so the video and the app move the same.
 */
export function Mark({
  size,
  splash = false,
  at,
  style,
}: {
  size: number;
  splash?: boolean;
  at?: SplashFrame;
  style?: CSSProperties;
}) {
  const id = useId().replace(/[^\w-]/g, '');
  const shapes = mark();
  const glass = splash || at !== undefined;
  const paint = (fill: Fill, i: number) => ('from' in fill ? `url(#${id}-${i})` : css(fill));

  return (
    <svg width={size} height={size} viewBox={`0 0 ${CANVAS} ${CANVAS}`} style={style} aria-hidden="true">
      {splash && <style>{keyframes(id)}</style>}
      <defs>
        {shapes.map(({ fill }, i) =>
          'from' in fill ? (
            <linearGradient key={i} id={`${id}-${i}`} gradientUnits="userSpaceOnUse" x1="0" x2="0" y1={fill.y0} y2={fill.y1}>
              <stop offset="0" stopColor={css(fill.from)} />
              <stop offset="1" stopColor={css(fill.to)} />
            </linearGradient>
          ) : null,
        )}
      </defs>
      {shapes.map((shape, i) => (
        <ShapeOf
          key={i}
          shape={shape}
          fill={paint(shape.fill, i)}
          className={shape.lit && splash ? `${id}-light` : undefined}
          opacity={shape.lit && at ? at.light : undefined}
        />
      ))}
      {glass && (
        <g
          className={splash ? `${id}-glass` : undefined}
          transform={at ? `translate(${at.x} ${at.y}) scale(${at.scale})` : undefined}
          opacity={at?.opacity}
        >
          <line
            x1={GLASS.r * 0.7}
            y1={GLASS.r * 0.7}
            x2={GLASS.r * 0.7 + GLASS.handle}
            y2={GLASS.r * 0.7 + GLASS.handle}
            stroke="rgba(36,31,26,0.25)"
            strokeWidth={GLASS.grip}
            strokeLinecap="round"
            transform="translate(4 7)"
          />
          <circle r={GLASS.r} fill={css([GLASS.colour[0], GLASS.colour[1], GLASS.colour[2], 0.14])} stroke={css(GLASS.colour)} strokeWidth={GLASS.rim} />
          <path d={`M${-GLASS.r * 0.55},${-GLASS.r * 0.2} A${GLASS.r * 0.6},${GLASS.r * 0.6} 0 0 1 ${-GLASS.r * 0.15},${-GLASS.r * 0.58}`} fill="none" stroke="rgba(255,255,255,0.7)" strokeWidth="7" strokeLinecap="round" />
          <line
            x1={GLASS.r * 0.7}
            y1={GLASS.r * 0.7}
            x2={GLASS.r * 0.7 + GLASS.handle}
            y2={GLASS.r * 0.7 + GLASS.handle}
            stroke={css(GLASS.colour)}
            strokeWidth={GLASS.grip}
            strokeLinecap="round"
          />
        </g>
      )}
    </svg>
  );
}

function ShapeOf({ shape, fill, className, opacity }: { shape: Shape; fill: string; className?: string; opacity?: number }) {
  const common = { fill, className, opacity };
  switch (shape.kind) {
    case 'rect':
      return <rect x={shape.x} y={shape.y} width={shape.w} height={shape.h} rx={shape.r} {...common} />;
    case 'disc':
      return <circle cx={shape.cx} cy={shape.cy} r={shape.r} {...common} />;
    case 'half':
      return <path d={`M${shape.cx - shape.r},${shape.cy} A${shape.r},${shape.r} 0 0 1 ${shape.cx + shape.r},${shape.cy} Z`} {...common} />;
    case 'arch': {
      const { cx, r, top, bottom } = shape;
      return <path d={`M${cx - r},${bottom} V${top + r} A${r},${r} 0 0 1 ${cx + r},${top + r} V${bottom} Z`} {...common} />;
    }
    case 'poly':
      return <polygon points={shape.points.map((pt) => pt.join(',')).join(' ')} {...common} />;
  }
}

/** `SPLASH` as two CSS animations, named after this instance so two marks on a page do not share
 *  them. SVG user units are CSS pixels inside the viewBox, so the glass's `translate` is in canvas
 *  units. Reduced motion gets the finished mark: the window lit and no glass. */
function keyframes(id: string): string {
  const pct = (t: number) => `${(t * 100).toFixed(1)}%`;
  const glass = SPLASH.map((f) => `${pct(f.t)}{transform:translate(${f.x}px,${f.y}px) scale(${f.scale});opacity:${f.opacity}}`).join('');
  const light = SPLASH.map((f) => `${pct(f.t)}{opacity:${f.light}}`).join('');
  const run = `${SPLASH_MS}ms ${SPLASH_EASE} both`;
  return (
    `@keyframes ${id}-glass{${glass}}@keyframes ${id}-light{${light}}` +
    `.${id}-glass{animation:${id}-glass ${run}}.${id}-light{animation:${id}-light ${run}}` +
    `@media (prefers-reduced-motion: reduce){.${id}-glass{animation:none;opacity:0}.${id}-light{animation:none}}`
  );
}
