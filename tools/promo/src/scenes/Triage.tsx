import { Easing, interpolate } from 'remotion';
import type { Rating } from '@house-hunt/core';
import { RatingButtons, ScoreGauge } from '@house-hunt/ui';
import { Chapter, Paper, useEnter, useFrame } from '../kit';
import { FlatCard, type Flat } from '../data';
import { C, FONT } from '../theme';

// The unrated pile, best guess first.
const PILE: Flat[] = [
  { id: 't1', street: 'Lauriston Road', area: 'E9', beds: 2, price: '£2,350', photo: 'reading', rating: null, score: 0.83, at: [0, 0] },
  { id: 't2', street: 'Lordship Lane', area: 'SE22', beds: 2, price: '£2,050', photo: 'stucco', rating: null, score: 0.52, at: [0, 0] },
  { id: 't3', street: 'Brixton Water Lane', area: 'SW2', beds: 2, price: '£2,200', photo: 'rooftop', rating: null, score: 0.31, at: [0, 0] },
];
// When each card is rated, with which key, and which way it leaves.
const PRESSES: Array<{ at: number; key: 1 | 2 | 3; rating: Rating; dir: 1 | -1 }> = [
  { at: 58, key: 3, rating: 'love', dir: 1 },
  { at: 112, key: 2, rating: 'maybe', dir: 1 },
];
const CARD_W = 580;
const LEFT = 1060;
const CAPTION = { '1': 'Not our place', '2': 'Like it', '3': 'Love it' } as const;

function Keycap({ label, pressed }: { label: string; pressed: number }) {
  return (
    <div
      style={{
        width: 74,
        height: 74,
        borderRadius: 14,
        background: C.raised,
        border: `1px solid ${C.line}`,
        boxShadow: `0 ${6 - pressed * 5}px 0 ${C.line}, 0 ${10 - pressed * 8}px 18px rgba(36,31,26,0.12)`,
        transform: `translateY(${pressed * 5}px)`,
        display: 'grid',
        placeItems: 'center',
        fontFamily: FONT.mono,
        fontSize: 34,
        fontWeight: 500,
        color: pressed > 0.3 ? C.green : C.inkSoft,
      }}
    >
      {label}
    </div>
  );
}

export function Triage() {
  const frame = useFrame();
  const stack = useEnter(8, { damping: 22, stiffness: 90 });
  const done = PRESSES.filter((p) => frame >= p.at + 16).length;
  const keysIn = useEnter(24);

  return (
    <Paper>
      <div style={{ position: 'absolute', left: 140, top: 300 }}>
        <Chapter
          index="05"
          label="Triage"
          title="Your taste | sets the order."
          body="The flats nobody has rated yet, likeliest yes first, learned from your own verdicts. Rate with 1, 2, 3."
          width={680}
        />
      </div>

      <div style={{ position: 'absolute', left: LEFT, top: 168, fontFamily: FONT.mono, fontSize: 20, letterSpacing: '0.1em', color: C.muted, opacity: stack }}>
        {12 - done} FLATS NOBODY HAS RATED
      </div>

      {PILE.map((flat, i) => {
        const press = PRESSES[i];
        const depth = Math.max(0, i - done);
        const rated = press && frame >= press.at;
        const leave = press
          ? interpolate(frame, [press.at + 8, press.at + 30], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.in(Easing.cubic) })
          : 0;
        const settle = interpolate(depth, [0, 2], [0, 1]);
        return (
          <div
            key={flat.id}
            style={{
              position: 'absolute',
              left: LEFT + leave * (press?.dir ?? 0) * 900,
              top: 220 + settle * 34,
              zIndex: 10 - i,
              opacity: stack * (1 - leave * 0.6) * (depth > 1 ? 0.6 : 1),
              transform: `translateY(${(1 - stack) * 60}px) scale(${1 - settle * 0.08}) rotate(${leave * (press?.dir ?? 0) * 14 + (depth === 1 ? 1.5 : depth === 2 ? -1.5 : 0)}deg)`,
              transformOrigin: 'center bottom',
            }}
          >
            <FlatCard flat={{ ...flat, rating: rated ? press.rating : null }} width={CARD_W} imageHeight={230}>
              <div style={{ zoom: 1.7, marginTop: 10 }}>
                <ScoreGauge score={flat.score} />
              </div>
              <div style={{ zoom: 1.3, marginTop: 14 }}>
                <RatingButtons value={rated ? press.rating : null} onRate={() => {}} />
              </div>
            </FlatCard>
          </div>
        );
      })}

      <div style={{ position: 'absolute', left: LEFT, top: 790, width: CARD_W, display: 'flex', justifyContent: 'center', gap: 40, opacity: keysIn }}>
        {(['1', '2', '3'] as const).map((k) => {
          const hit = PRESSES.find((p) => String(p.key) === k);
          const pressed = hit ? interpolate(frame, [hit.at - 3, hit.at, hit.at + 7], [0, 1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }) : 0;
          return (
            <div key={k} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16, width: 150 }}>
              <Keycap label={k} pressed={pressed} />
              <span style={{ fontSize: 19, color: pressed > 0.3 ? C.green : C.muted }}>{CAPTION[k]}</span>
            </div>
          );
        })}
      </div>
    </Paper>
  );
}
