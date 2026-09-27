import { AbsoluteFill, Easing, interpolate, useVideoConfig } from 'remotion';
import { SPLASH_MS, splashAt } from '@house-hunt/ui';
import { Logo, Paper, Photo, Rise, useEnter, useFrame, Words, type HomePhoto } from '../kit';
import { C, FONT } from '../theme';

/** The opening shots: when each starts (in frames, on the beat at 120 bpm, so every 15 frames),
 *  which photograph, and the line over it. The cuts speed up towards the last shot. */
const SHOTS: Array<{ at: number; photo: HomePhoto; line?: string; pan: [number, number] }> = [
  { at: 0, photo: 'living', line: 'That light.', pan: [-2, 0] },
  { at: 30, photo: 'rooftop', line: 'That terrace.', pan: [2, -1] },
  { at: 60, photo: 'kitchen', pan: [-1, 1] },
  { at: 75, photo: 'canal', pan: [2, 0] },
  { at: 90, photo: 'street', pan: [-2, 0] },
  { at: 98, photo: 'stucco', pan: [1, -1] },
  { at: 105, photo: 'mansion', pan: [-1, 0] },
  { at: 113, photo: 'bedroom', pan: [1, 1] },
  { at: 120, photo: 'reading', line: 'Let’s find yours.', pan: [0, -1] },
];
/** The scene's length, for the last shot's drift. Both cuts play the montage at this length, so
 *  the cuts stay on the beat. */
const END_OF_MONTAGE = 180;

/** 1. The pull: homes worth wanting, cut to the beat, before a word about software. */
export function Montage() {
  const frame = useFrame();
  const i = SHOTS.filter((shot) => frame >= shot.at).length - 1;
  const shot = SHOTS[i]!;
  const until = SHOTS[i + 1]?.at ?? END_OF_MONTAGE;
  const t = (frame - shot.at) / (until - shot.at);
  // Each shot lands a little too close and settles back: a punch on the cut, then a slow drift.
  const punch = interpolate(frame - shot.at, [0, 8], [1.14, 1.06], { extrapolateRight: 'clamp', easing: Easing.out(Easing.cubic) });
  const zoom = punch + t * 0.04;
  const flash = interpolate(frame - shot.at, [0, 4], [i === 0 ? 0 : 0.35, 0], { extrapolateRight: 'clamp' });
  return (
    <AbsoluteFill style={{ background: '#000' }}>
      <Photo name={shot.photo} zoom={zoom} pan={[shot.pan[0] * t, shot.pan[1] * t]} />
      <AbsoluteFill style={{ background: 'linear-gradient(180deg, rgba(0,0,0,0) 45%, rgba(10,8,6,0.55) 100%)' }} />
      <AbsoluteFill style={{ background: '#fff', opacity: flash }} />
      {shot.line && (
        <div
          key={shot.at}
          style={{
            position: 'absolute',
            left: 140,
            bottom: 130,
            fontFamily: FONT.serif,
            fontWeight: 500,
            fontSize: 150,
            letterSpacing: '-0.03em',
            color: '#fff',
            textShadow: '0 4px 40px rgba(0,0,0,0.35)',
          }}
        >
          <Words text={shot.line} delay={shot.at + 2} stagger={4} />
        </div>
      )}
    </AbsoluteFill>
  );
}

/** 2. The name, and what it is. */
export function Title() {
  const logo = useEnter(2, { damping: 11, stiffness: 120, mass: 0.7 });
  // The app's splash, played at the same speed it plays in the app: the glass finds the lit window.
  const { fps } = useVideoConfig();
  const glass = splashAt((useFrame() - 4) / ((SPLASH_MS / 1000) * fps));
  return (
    <Paper>
      <AbsoluteFill style={{ justifyContent: 'center', alignItems: 'center' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 48 }}>
          <Logo size={200} at={glass} style={{ transform: `scale(${logo}) rotate(${(1 - logo) * -10}deg)`, filter: 'drop-shadow(0 22px 40px rgba(26,127,90,0.25))' }} />
          <div style={{ fontFamily: FONT.serif, fontWeight: 600, fontSize: 176, letterSpacing: '-0.035em', lineHeight: 1 }}>
            <Words text="House hunt" delay={8} stagger={5} />
          </div>
        </div>
        <Rise delay={26} style={{ marginTop: 56 }}>
          <div style={{ fontSize: 48, color: C.inkSoft, textAlign: 'center' }}>Your London flat hunt, all together.</div>
        </Rise>
      </AbsoluteFill>
    </Paper>
  );
}

/** The end card. */
export function End() {
  const logo = useEnter(0, { damping: 14, stiffness: 100 });
  return (
    <Paper>
      <AbsoluteFill style={{ justifyContent: 'center', alignItems: 'center' }}>
        <Logo size={150} style={{ transform: `scale(${logo})` }} />
        <div style={{ fontFamily: FONT.serif, fontWeight: 500, fontSize: 110, letterSpacing: '-0.03em', marginTop: 44, lineHeight: 1 }}>
          <Words text="Find the flat worth moving for." delay={8} stagger={4} />
        </div>
        <Rise delay={26} style={{ marginTop: 34 }}>
          <div style={{ fontSize: 38, color: C.inkSoft, textAlign: 'center' }}>
            House hunt · shared shortlists for London renters · invite-only
          </div>
        </Rise>
        <Rise delay={40} style={{ marginTop: 70 }}>
          <div
            style={{
              fontFamily: FONT.mono,
              fontSize: 28,
              letterSpacing: '0.04em',
              color: C.muted,
              border: `1px solid ${C.line}`,
              background: C.raised,
              borderRadius: 99,
              padding: '14px 34px',
            }}
          >
            github.com/noncuro/house-hunt
          </div>
        </Rise>
      </AbsoluteFill>
    </Paper>
  );
}
