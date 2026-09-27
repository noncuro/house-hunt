import { Easing, interpolate } from 'remotion';
import { ScoreGauge } from '@house-hunt/ui';
import { Chapter, Paper, Photo, Surface, useEnter, useFrame, type HomePhoto } from '../kit';
import { C, FONT } from '../theme';

/** This morning's new listings, in the order the sweep found them. */
const FOUND: Array<{ street: string; area: string; price: string; photo: HomePhoto; score: number; drop?: string }> = [
  { street: 'Wilberforce Road', area: 'N4', price: '£2,350', photo: 'street', score: 0.58 },
  { street: 'Ferndale Road', area: 'SW4', price: '£2,250', photo: 'bedroom', score: 0.33 },
  { street: 'Albion Drive', area: 'E8', price: '£2,300', photo: 'kitchen', score: 0.79, drop: '£150' },
  { street: 'Queen’s Crescent', area: 'NW5', price: '£2,150', photo: 'reading', score: 0.44 },
  { street: 'Formosa Street', area: 'W9', price: '£2,500', photo: 'canal', score: 0.91 },
];
const RANK = FOUND.map((_, i) => i).sort((a, b) => FOUND[b]!.score - FOUND[a]!.score);
const ROW = 124;
const ARRIVE = 16; // the first row lands
const EVERY = 12; // then one every this many frames
const SORT = ARRIVE + FOUND.length * EVERY + 26; // then they re-order, best first

/** 1. The morning sweep: new listings from saved searches, arriving, then ranked. */
export function Sweeps() {
  const frame = useFrame();
  const panel = useEnter(4, { damping: 22, stiffness: 90 });
  const sort = interpolate(frame, [SORT, SORT + 26], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.inOut(Easing.cubic) });
  const glow = useEnter(SORT + 22, { damping: 14, stiffness: 120 });
  const soon = useEnter(SORT + 30);
  const arrived = Math.min(FOUND.length, Math.max(0, Math.floor((frame - ARRIVE) / EVERY) + 1));

  return (
    <Paper>
      <div style={{ position: 'absolute', left: 140, top: 300 }}>
        <Chapter
          index="01"
          label="Sweeps"
          title="Wake up to | ranked flats."
          body="Every morning it sweeps your searches on Rightmove and London’s agents, pulls in each new listing and puts the likeliest yes on top."
          width={680}
        />
      </div>

      <Surface style={{ position: 'absolute', left: 930, top: 150, width: 860, opacity: panel, transform: `translateY(${(1 - panel) * 70}px)` }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '24px 30px', borderBottom: `1px solid ${C.line}` }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
            <Sun />
            <span style={{ fontFamily: FONT.serif, fontWeight: 600, fontSize: 34 }}>This morning</span>
          </div>
          <span style={{ fontFamily: FONT.mono, fontSize: 19, letterSpacing: '0.1em', color: sort > 0.5 ? C.green : C.muted }}>
            {sort > 0.5 ? 'BEST FIRST' : `${arrived} NEW · 3 SAVED SEARCHES`}
          </span>
        </div>
        <div style={{ position: 'relative', height: ROW * FOUND.length + 16 }}>
          {FOUND.map((flat, i) => (
            <Row key={flat.street} flat={flat} index={i} sort={sort} glow={glow} />
          ))}
        </div>
      </Surface>
      <div style={{ position: 'absolute', left: 930, top: 900, width: 860, textAlign: 'center', fontFamily: FONT.mono, fontSize: 21, letterSpacing: '0.12em', color: C.muted, opacity: soon }}>
        RIGHTMOVE + EIGHT LONDON AGENTS
      </div>
    </Paper>
  );
}

function Row({ flat, index, sort, glow }: { flat: (typeof FOUND)[number]; index: number; sort: number; glow: number }) {
  const t = useEnter(ARRIVE + index * EVERY, { damping: 16, stiffness: 140, mass: 0.7 });
  const y = interpolate(sort, [0, 1], [index, RANK.indexOf(index)]) * ROW + 8;
  const best = RANK[0] === index;
  return (
    <div
      style={{
        position: 'absolute',
        left: 16,
        right: 16,
        top: y,
        height: ROW - 12,
        display: 'flex',
        alignItems: 'center',
        gap: 22,
        padding: '0 14px',
        borderRadius: 14,
        opacity: Math.min(1, t),
        transform: `translateX(${(1 - t) * 80}px)`,
        background: best ? `color-mix(in oklch, ${C.green} ${glow * 9}%, ${C.raised})` : C.raised,
        boxShadow: best ? `inset 0 0 0 ${2 * glow}px color-mix(in oklch, ${C.green} 45%, transparent)` : 'none',
        zIndex: best ? 2 : 1,
      }}
    >
      <div style={{ width: 128, height: 88, borderRadius: 10, overflow: 'hidden', flex: 'none' }}>
        <Photo name={flat.photo} />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontFamily: FONT.serif, fontWeight: 600, fontSize: 30, whiteSpace: 'nowrap' }}>
          {flat.street}, {flat.area}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 6, fontFamily: FONT.mono, fontSize: 17, letterSpacing: '0.04em', color: C.muted }}>
          <span>{flat.price} PCM</span>
          <Pill color={C.green}>NEW</Pill>
          {flat.drop && <Pill color="#b3894a">{`↓ ${flat.drop}`}</Pill>}
        </div>
      </div>
      <div style={{ zoom: 1.5, flex: 'none' }}>
        <ScoreGauge score={flat.score} />
      </div>
    </div>
  );
}

function Pill({ color, children }: { color: string; children: string }) {
  return (
    <span style={{ color, border: `1px solid color-mix(in oklch, ${color} 40%, transparent)`, borderRadius: 99, padding: '2px 10px', fontSize: 14, fontWeight: 500 }}>
      {children}
    </span>
  );
}

function Sun() {
  const frame = useFrame();
  return (
    <svg width="40" height="40" viewBox="-20 -20 40 40" style={{ transform: `rotate(${frame * 0.6}deg)` }}>
      <circle r="7.5" fill="#ec9a36" />
      {Array.from({ length: 8 }, (_, i) => (
        <line key={i} x1="0" y1="11" x2="0" y2="16" stroke="#ec9a36" strokeWidth="2.6" strokeLinecap="round" transform={`rotate(${i * 45})`} />
      ))}
    </svg>
  );
}
