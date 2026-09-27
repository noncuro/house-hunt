import { interpolate } from 'remotion';
import { FlagChip } from '@house-hunt/ui';
import type { Flag } from '@house-hunt/core';
import { Floorplan } from '../art/Floorplan';
import { Chapter, Paper, Surface, useEnter, useFrame, useProgress } from '../kit';
import { C, FONT } from '../theme';

const FINDINGS: Array<{ at: number; flag: Flag }> = [
  { at: 72, flag: { key: 'size', severity: 'good', text: '54 m² usable', confidence: 'high' } },
  { at: 92, flag: { key: 'rooms', severity: 'good', text: 'Smallest bedroom 2.3 × 2.8 m', confidence: 'medium' } },
  { at: 114, flag: { key: 'outdoor', severity: 'yellow', text: 'The “garden” is a balcony', confidence: 'high' } },
  { at: 134, flag: { key: 'laundry', severity: 'good', text: 'Washing machine in the flat', confidence: 'high' } },
  { at: 150, flag: { key: 'bathtub', severity: 'red', text: 'No bathtub', confidence: 'high' } },
];

function Chip({ at, flag, pulse }: { at: number; flag: Flag; pulse?: number }) {
  const t = useEnter(at, { damping: 14, stiffness: 160, mass: 0.6 });
  return (
    <div style={{ opacity: Math.min(1, t), transform: `scale(${0.7 + 0.3 * t})`, transformOrigin: 'left center', position: 'relative' }}>
      <div style={{ zoom: 2.05 }}>
        <FlagChip flag={flag} />
      </div>
      {pulse !== undefined && pulse > 0 && (
        <div
          style={{
            position: 'absolute',
            inset: -8,
            borderRadius: 14,
            border: `3px solid ${C.green}`,
            opacity: Math.sin(pulse * Math.PI),
          }}
        />
      )}
    </div>
  );
}

export function Photos() {
  const frame = useFrame();
  const plan = useEnter(4, { damping: 22, stiffness: 90 });
  const quote = useEnter(14, { damping: 22, stiffness: 90 });
  const draw = useProgress(8, 48);
  const scan = useProgress(40, 92);
  const measure = useProgress(92, 116);
  const balcony = frame >= 114 ? 1 : 0;
  const spacious = useProgress(72, 88);
  const strike = useProgress(114, 126);
  const correction = useEnter(122, { damping: 16, stiffness: 140 });
  const pulse = interpolate(frame, [180, 204], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });

  return (
    <Paper>
      <div style={{ position: 'absolute', left: 140, top: 300 }}>
        <Chapter
          index="03"
          label="Details"
          title="Garden? Or | just a balcony?"
          body="It reads the photos and the floorplan for floor area, the smallest bedroom and the washing machine, and says how sure it is of each."
          width={680}
        />
      </div>

      <div style={{ position: 'absolute', left: 880, top: 180, opacity: plan, transform: `translateY(${(1 - plan) * 60}px)` }}>
        <Surface style={{ width: 600, height: 510, padding: '26px 34px 20px', boxSizing: 'border-box' }}>
          <div style={{ fontFamily: FONT.mono, fontSize: 15, letterSpacing: '0.12em', color: C.faint, marginBottom: 8 }}>FLOORPLAN</div>
          <div style={{ height: 420 }}>
            <Floorplan draw={draw} scan={scan} measure={measure} balcony={balcony} />
          </div>
        </Surface>
      </div>

      <div style={{ position: 'absolute', left: 1530, top: 220, width: 320, opacity: quote, transform: `translateY(${(1 - quote) * 60}px)` }}>
        <div style={{ fontFamily: FONT.mono, fontSize: 17, letterSpacing: '0.12em', color: C.faint }}>THE LISTING SAYS</div>
        <div style={{ fontFamily: FONT.serif, fontStyle: 'italic', fontSize: 50, lineHeight: 1.25, marginTop: 16, letterSpacing: '-0.01em' }}>
          “
          <span style={{ position: 'relative', backgroundImage: `linear-gradient(${C.green}, ${C.green})`, backgroundSize: `${spacious * 100}% 3px`, backgroundPosition: '0 92%', backgroundRepeat: 'no-repeat' }}>
            Spacious
          </span>{' '}
          two‑bedroom{' '}
          <span style={{ position: 'relative', display: 'inline-block' }}>
            <span style={{ color: strike > 0.5 ? C.faint : C.ink }}>garden</span>
            <span style={{ position: 'absolute', left: -4, top: '55%', height: 4, width: `calc(${strike * 100}% + 8px)`, background: C.badInk, borderRadius: 2 }} />
          </span>{' '}
          <span
            style={{
              display: 'inline-block',
              color: C.warnInk,
              opacity: correction,
              maxWidth: `${correction * 4.2}em`,
              overflow: 'hidden',
              verticalAlign: 'bottom',
              whiteSpace: 'nowrap',
            }}
          >
            balcony&nbsp;
          </span>
          flat”
        </div>
        <div style={{ marginTop: 22, fontFamily: FONT.mono, fontSize: 20, color: C.green, opacity: spacious, letterSpacing: '0.04em' }}>
          ↳ 54 m² usable
        </div>
      </div>

      <div style={{ position: 'absolute', left: 880, top: 730, width: 960, display: 'flex', flexWrap: 'wrap', gap: '16px 14px' }}>
        {FINDINGS.map((f, i) => (
          <Chip key={f.flag.key} {...f} pulse={i === 1 ? pulse : undefined} />
        ))}
      </div>
    </Paper>
  );
}
