import { createContext, useContext, type CSSProperties, type ReactNode } from 'react';
import { AbsoluteFill, Easing, Img, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
import { C, FONT, FONT_VARS } from './theme';
import { Mark, type SplashFrame } from '@house-hunt/ui';
import '@house-hunt/ui/tokens.css';

/** How fast a scene plays. Scenes are timed for the 60-second cut; a shorter cut runs them faster. */
const PaceContext = createContext(1);

export function Pace({ value, children }: { value: number; children: ReactNode }) {
  return <PaceContext.Provider value={value}>{children}</PaceContext.Provider>;
}

/** The scene's own clock: the current frame, scaled by its pace. Scenes read this, never
 *  `useCurrentFrame`, or they would ignore the cut they are in. */
export function useFrame() {
  return useCurrentFrame() * useContext(PaceContext);
}

/** A spring from 0 to 1 starting `delay` frames into the scene. */
export function useEnter(delay = 0, config: { damping?: number; stiffness?: number; mass?: number } = {}) {
  const frame = useFrame();
  const { fps } = useVideoConfig();
  return spring({ frame: frame - delay, fps, config: { damping: 200, stiffness: 90, ...config } });
}

/** Linear 0→1 between two frames, eased. */
export function useProgress(from: number, to: number, easing = Easing.bezier(0.33, 0, 0.2, 1)) {
  const frame = useFrame();
  return interpolate(frame, [from, to], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing,
  });
}

/** The warm paper ground every scene sits on: the app's --paper, a faint grain, a soft vignette. */
export function Paper({ children, style }: { children?: ReactNode; style?: CSSProperties }) {
  return (
    <AbsoluteFill style={{ background: C.paper, ...FONT_VARS, fontFamily: FONT.sans, color: C.ink, ...style }}>
      {children}
      <Grain />
    </AbsoluteFill>
  );
}

function Grain() {
  return (
    <AbsoluteFill style={{ pointerEvents: 'none' }}>
      <svg width="100%" height="100%" style={{ position: 'absolute', inset: 0, opacity: 0.22, mixBlendMode: 'multiply' }}>
        <filter id="grain">
          <feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="3" stitchTiles="stitch" />
          <feColorMatrix type="matrix" values="0 0 0 0 0.55  0 0 0 0 0.5  0 0 0 0 0.42  0 0 0 0.35 0" />
        </filter>
        <rect width="100%" height="100%" filter="url(#grain)" />
      </svg>
      <AbsoluteFill
        style={{
          background: 'radial-gradient(ellipse at 50% 45%, rgba(255,255,255,0) 55%, rgba(120,100,70,0.10) 100%)',
        }}
      />
    </AbsoluteFill>
  );
}

/** Fade and rise in. */
export function Rise({
  delay = 0,
  distance = 28,
  children,
  style,
}: {
  delay?: number;
  distance?: number;
  children: ReactNode;
  style?: CSSProperties;
}) {
  const t = useEnter(delay);
  return (
    <div style={{ opacity: t, transform: `translateY(${(1 - t) * distance}px)`, ...style }}>{children}</div>
  );
}

/** A headline set word by word: each word lifts out of a slight blur, staggered. */
export function Words({
  text,
  delay = 0,
  stagger = 3,
  style,
  italicWords = [],
}: {
  text: string;
  delay?: number;
  stagger?: number;
  style?: CSSProperties;
  italicWords?: string[];
}) {
  const frame = useFrame();
  const { fps } = useVideoConfig();
  const words = text.split(' ');
  return (
    <span style={style}>
      {words.map((w, i) => {
        if (w === '|') return <br key={i} />;
        const t = spring({ frame: frame - delay - i * stagger, fps, config: { damping: 200, stiffness: 110 } });
        return (
          <span
            key={i}
            style={{
              display: 'inline-block',
              opacity: t,
              filter: `blur(${(1 - t) * 8}px)`,
              transform: `translateY(${(1 - t) * 0.35}em)`,
              fontStyle: italicWords.includes(w) ? 'italic' : undefined,
              whiteSpace: 'pre',
            }}
          >
            {w}
            {i < words.length - 1 ? ' ' : ''}
          </span>
        );
      })}
    </span>
  );
}

/** The mono small-caps label the app puts over a group of facts, here over a chapter. */
export function Label({ children, delay = 0, color = C.muted }: { children: ReactNode; delay?: number; color?: string }) {
  const t = useEnter(delay);
  return (
    <div
      style={{
        fontFamily: FONT.mono,
        fontSize: 22,
        letterSpacing: '0.14em',
        textTransform: 'uppercase',
        color,
        opacity: t,
        display: 'flex',
        alignItems: 'center',
        gap: 18,
      }}
    >
      <span style={{ display: 'inline-block', height: 2, width: 56 * t, background: C.green }} />
      {children}
    </div>
  );
}

/** The app's icon, from `@house-hunt/ui` — the same component the app's splash uses. `at` is a frame
 *  of that splash (`splashAt`), for the magnifying glass. */
export function Logo({ size = 120, style, at }: { size?: number; style?: CSSProperties; at?: SplashFrame }) {
  return <Mark size={size} style={style} at={at} />;
}

/** One of the generated home photographs in `public/homes/`, filling its box. `zoom` and `pan` are
 *  for a slow push-in: 1 is the photograph as framed, and pan shifts the centre in % of the box. */
export function Photo({ name, zoom = 1, pan = [0, 0], style }: { name: HomePhoto; zoom?: number; pan?: [number, number]; style?: CSSProperties }) {
  return (
    <div style={{ position: 'relative', width: '100%', height: '100%', overflow: 'hidden', ...style }}>
      <Img
        src={staticFile(`homes/${name}.jpg`)}
        style={{ width: '100%', height: '100%', objectFit: 'cover', transform: `scale(${zoom}) translate(${pan[0]}%, ${pan[1]}%)` }}
      />
    </div>
  );
}

export type HomePhoto = 'street' | 'living' | 'kitchen' | 'bedroom' | 'canal' | 'stucco' | 'rooftop' | 'mansion' | 'reading';

/** A chapter's words: label, serif headline, a sentence underneath. */
export function Chapter({
  index,
  label,
  title,
  body,
  delay = 0,
  width = 700,
}: {
  index: string;
  label: string;
  title: string;
  body: ReactNode;
  delay?: number;
  width?: number;
}) {
  return (
    <div style={{ width, display: 'flex', flexDirection: 'column', gap: 34 }}>
      <Label delay={delay}>
        <span style={{ color: C.green }}>{index}</span>
        {label}
      </Label>
      <div
        style={{
          fontFamily: FONT.serif,
          fontWeight: 500,
          fontSize: 86,
          lineHeight: 1.02,
          letterSpacing: '-0.02em',
          color: C.ink,
        }}
      >
        <Words text={title} delay={delay + 6} />
      </div>
      <Rise delay={delay + 22}>
        <div style={{ fontSize: 31, lineHeight: 1.45, color: C.inkSoft, maxWidth: width - 40 }}>{body}</div>
      </Rise>
    </div>
  );
}

/** A floating surface in the app's own raised colour, with its hairline and the pop shadow. */
export function Surface({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return (
    <div
      style={{
        background: C.raised,
        border: `1px solid ${C.line}`,
        borderRadius: 18,
        boxShadow: '0 30px 80px rgba(36,31,26,0.14), 0 6px 18px rgba(36,31,26,0.06)',
        overflow: 'hidden',
        ...style,
      }}
    >
      {children}
    </div>
  );
}

/** A pointer with a name tag, for the two people sharing the hunt. */
export function Cursor({ x, y, name, color, pressed = 0 }: { x: number; y: number; name: string; color: string; pressed?: number }) {
  return (
    <div style={{ position: 'absolute', left: x, top: y, pointerEvents: 'none', zIndex: 50 }}>
      <svg width="34" height="40" viewBox="0 0 17 20" style={{ transform: `scale(${1 - pressed * 0.12})`, transformOrigin: '0 0' }}>
        <path d="M1 1 L1 16 L5 12.5 L8 19 L10.5 18 L7.6 11.6 L13 11.3 Z" fill={color} stroke="#fff" strokeWidth="1.4" strokeLinejoin="round" />
      </svg>
      <div
        style={{
          position: 'absolute',
          left: 26,
          top: 32,
          background: color,
          color: '#fff',
          fontSize: 20,
          fontWeight: 500,
          padding: '4px 12px',
          borderRadius: 99,
          whiteSpace: 'nowrap',
        }}
      >
        {name}
      </div>
    </div>
  );
}

/** Counts up to `to` as `t` goes 0→1. */
export function count(to: number, t: number) {
  return Math.round(to * Math.min(1, Math.max(0, t)));
}
