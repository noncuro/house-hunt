import { interpolate } from 'remotion';
import { ScoreGauge, VerdictStamp } from '@house-hunt/ui';
import { LondonMap } from '../art/LondonMap';
import { Chapter, Paper, useEnter, useFrame } from '../kit';
import { FLATS, FlatCard, PIN, verdictOf } from '../data';
import { C, FONT } from '../theme';

const TABS = ['Cards', 'Table', 'Map', 'Board'];
const TO_MAP = 96;
const WIN = { x: 880, y: 150, w: 930, h: 790 };
const MAP_H = WIN.h - 130;

function Tabs({ active }: { active: number }) {
  return (
    <div style={{ display: 'flex', gap: 10 }}>
      {TABS.map((t, i) => {
        const on = active > i - 0.5 && active < i + 0.5;
        return (
          <span
            key={t}
            style={{
              fontSize: 21,
              padding: '8px 20px',
              borderRadius: 10,
              border: `1px solid ${on ? C.ink : C.line}`,
              background: on ? C.ink : C.raised,
              color: on ? '#fff' : C.inkSoft,
            }}
          >
            {t}
          </span>
        );
      })}
    </div>
  );
}

function Pin({ flat, delay, scale }: { flat: (typeof FLATS)[number]; delay: number; scale: [number, number] }) {
  const t = useEnter(delay, { damping: 11, stiffness: 150, mass: 0.6 });
  const colour = PIN[flat.rating ?? 'none'];
  return (
    <div
      style={{
        position: 'absolute',
        left: flat.at[0] * scale[0] - 15,
        top: flat.at[1] * scale[1] - 15 - (1 - Math.min(1, t)) * 60,
        width: 30,
        height: 30,
        borderRadius: 99,
        background: colour,
        border: '4px solid #fff',
        boxShadow: '0 4px 10px rgba(36,31,26,0.25)',
        opacity: Math.min(1, t * 2),
        boxSizing: 'border-box',
      }}
    />
  );
}

function GridCard({ flat, delay }: { flat: (typeof FLATS)[number]; delay: number }) {
  const t = useEnter(delay, { damping: 18, stiffness: 120 });
  return (
    <div style={{ opacity: t, transform: `translateY(${(1 - t) * 30}px)` }}>
      <FlatCard flat={flat} width={277} imageHeight={130} style={{ boxShadow: '0 2px 6px rgba(36,31,26,0.06)' }}>
        <div style={{ zoom: 1.35, marginTop: 8 }}>
          <ScoreGauge score={flat.score} />
        </div>
      </FlatCard>
    </div>
  );
}

export function Shortlist() {
  const frame = useFrame();
  const win = useEnter(6, { damping: 22, stiffness: 90 });
  const toMap = interpolate(frame, [TO_MAP, TO_MAP + 16], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const docked = useEnter(TO_MAP + 70, { damping: 18, stiffness: 120 });
  const work = useEnter(TO_MAP + 50);
  const scale: [number, number] = [WIN.w / 900, MAP_H / 560];

  return (
    <Paper>
      <div style={{ position: 'absolute', left: 140, top: 300 }}>
        <Chapter
          index="06"
          label="Decide"
          title="A shortlist you | can decide from."
          body="Cards, a table, a map and a board under one filter, with a pile for the flats nobody has judged yet."
          width={680}
        />
      </div>

      <div
        style={{
          position: 'absolute',
          left: WIN.x,
          top: WIN.y,
          width: WIN.w,
          height: WIN.h,
          opacity: win,
          transform: `translateY(${(1 - win) * 60}px)`,
          background: C.paper,
          border: `1px solid ${C.line}`,
          borderRadius: 18,
          overflow: 'hidden',
          boxShadow: '0 30px 80px rgba(36,31,26,0.14), 0 6px 18px rgba(36,31,26,0.06)',
        }}
      >
        <div style={{ height: 74, display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 26px', background: C.raised, borderBottom: `1px solid ${C.line}` }}>
          <div style={{ fontFamily: FONT.serif, fontWeight: 600, fontSize: 28 }}>Our hunt</div>
          <Tabs active={toMap * 2} />
        </div>
        <div style={{ height: 56, display: 'flex', alignItems: 'center', gap: 12, padding: '0 26px', borderBottom: `1px solid ${C.line}`, fontFamily: FONT.mono, fontSize: 16, color: C.muted, letterSpacing: '0.04em' }}>
          {['2+ BED', 'UNDER £2,600', '≤ 35 MIN TO WORK', 'NOT REJECTED'].map((f) => (
            <span key={f} style={{ border: `1px solid ${C.line}`, borderRadius: 99, padding: '4px 12px', background: C.raised }}>
              {f}
            </span>
          ))}
          <span style={{ marginLeft: 'auto' }}>6 FLATS</span>
        </div>

        {/* cards */}
        <div style={{ position: 'absolute', top: 150, left: 26, right: 26, display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 22, opacity: 1 - toMap, transform: `scale(${1 - toMap * 0.05})` }}>
          {FLATS.map((f, i) => (
            <GridCard key={f.id} flat={f} delay={10 + i * 5} />
          ))}
        </div>

        {/* map */}
        <div style={{ position: 'absolute', top: 130, left: 0, width: WIN.w, height: MAP_H, opacity: toMap }}>
          <LondonMap />
          {toMap > 0 && FLATS.map((f, i) => <Pin key={f.id} flat={f} delay={TO_MAP + 10 + i * 6} scale={scale} />)}
          {toMap > 0 && (
            <div style={{ position: 'absolute', left: 470 * scale[0] - 50, top: 318 * scale[1] - 18, display: 'flex', alignItems: 'center', gap: 8, opacity: work }}>
              <span style={{ width: 22, height: 22, background: C.ink, transform: 'rotate(45deg)', borderRadius: 4, border: '3px solid #fff', boxSizing: 'border-box' }} />
              <span style={{ fontSize: 20, fontWeight: 600, color: C.ink, background: 'rgba(253,252,250,0.9)', padding: '2px 8px', borderRadius: 6 }}>Work</span>
            </div>
          )}
          <div style={{ position: 'absolute', left: 22, bottom: 20, display: 'flex', gap: 18, background: 'rgba(253,252,250,0.92)', border: `1px solid ${C.line}`, borderRadius: 10, padding: '10px 16px', fontSize: 18, color: C.inkSoft }}>
            {[
              ['Love it', PIN.love],
              ['Like it', PIN.maybe],
              ['Not rated yet', PIN.none],
              ['Not our place', PIN.no],
            ].map(([label, colour]) => (
              <span key={label} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ width: 14, height: 14, borderRadius: 99, background: colour }} />
                {label}
              </span>
            ))}
          </div>
          {/* the docked card for the flat under the pointer */}
          <div
            style={{
              position: 'absolute',
              right: 22,
              top: 22,
              width: 330,
              background: C.raised,
              border: `1px solid ${C.line}`,
              borderRadius: 14,
              boxShadow: '0 6px 20px rgb(36 31 26 / 18%)',
              padding: 18,
              opacity: docked,
              transform: `translateX(${(1 - docked) * 40}px)`,
            }}
          >
            <div style={{ zoom: 1.4 }}>
              <VerdictStamp verdict={verdictOf('love') as never} />
            </div>
            <div style={{ fontFamily: FONT.serif, fontWeight: 600, fontSize: 28, marginTop: 10 }}>Mildmay Grove, N1</div>
            <div style={{ fontFamily: FONT.mono, fontSize: 16, color: C.muted, marginTop: 4, letterSpacing: '0.04em' }}>2 BED · £2,450 PCM</div>
            <div style={{ display: 'flex', gap: 18, marginTop: 12, fontSize: 19, color: C.inkSoft }}>
              <span>
                Work <b style={{ fontWeight: 600, color: C.ink }}>28m</b>
              </span>
              <span>
                Gym <b style={{ fontWeight: 600, color: C.ink }}>9m</b>
              </span>
            </div>
          </div>
        </div>
      </div>
    </Paper>
  );
}
