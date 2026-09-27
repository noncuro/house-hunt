import { interpolate } from 'remotion';
import { LegChip, ModeIcon, formatDuration } from '@house-hunt/ui';
import type { TravelMode } from '@house-hunt/core';
import { Chapter, Paper, useEnter, useFrame } from '../kit';
import { FLATS, FlatCard, type Flat } from '../data';
import { C, FONT } from '../theme';

type Leg = { mode: string; lineId: string | null; lineName: string | null; minutes: number };
type Row = { place: string; times: Record<TravelMode, number | null>; legs: Leg[] };

const MODES: TravelMode[] = ['walking', 'cycling', 'transit'];

const TIMES: Record<string, Row[]> = {
  a: [
    { place: 'Work', times: { walking: 65, cycling: 22, transit: 28 }, legs: [{ mode: 'overground', lineId: 'mildmay', lineName: 'Mildmay', minutes: 6 }, { mode: 'tube', lineId: 'victoria', lineName: 'Victoria', minutes: 9 }] },
    { place: 'The gym', times: { walking: 9, cycling: 4, transit: null }, legs: [] },
    { place: 'Sunday lunch', times: { walking: null, cycling: 31, transit: 41 }, legs: [{ mode: 'overground', lineId: 'mildmay', lineName: 'Mildmay', minutes: 24 }] },
  ],
  b: [
    { place: 'Work', times: { walking: 58, cycling: 24, transit: 31 }, legs: [{ mode: 'tube', lineId: 'bakerloo', lineName: 'Bakerloo', minutes: 14 }] },
    { place: 'The gym', times: { walking: 21, cycling: 8, transit: 14 }, legs: [{ mode: 'bus', lineId: '31', lineName: '31', minutes: 8 }] },
    { place: 'Sunday lunch', times: { walking: null, cycling: 38, transit: 52 }, legs: [{ mode: 'tube', lineId: 'bakerloo', lineName: 'Bakerloo', minutes: 11 }, { mode: 'tube', lineId: 'northern', lineName: 'Northern', minutes: 19 }] },
  ],
};

function faster(flat: string, row: number, mode: TravelMode): boolean {
  const mine = TIMES[flat][row].times[mode];
  const other = TIMES[flat === 'a' ? 'b' : 'a'][row].times[mode];
  return mine !== null && (other === null || mine < other);
}

function TravelTable({ flat, start, compare }: { flat: Flat; start: number; compare: number }) {
  const frame = useFrame();
  const rows = TIMES[flat.id];
  return (
    <div style={{ marginTop: 22 }}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 74px 74px 74px', alignItems: 'center', paddingBottom: 10, borderBottom: `1px solid ${C.line}` }}>
        <span style={{ fontFamily: FONT.mono, fontSize: 14, letterSpacing: '0.1em', color: C.faint }}>TO</span>
        {MODES.map((m) => (
          <span key={m} style={{ justifySelf: 'end', zoom: 1.7, color: C.muted, display: 'flex' }}>
            <ModeIcon mode={m} />
          </span>
        ))}
      </div>
      {rows.map((row, i) => {
        const t = interpolate(frame, [start + i * 12, start + i * 12 + 22], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
        return (
          <div key={row.place} style={{ padding: '14px 0 12px', borderBottom: i < rows.length - 1 ? `1px solid ${C.line3}` : undefined, opacity: Math.min(1, t * 2), transform: `translateX(${(1 - t) * 20}px)` }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 74px 74px 74px', alignItems: 'baseline' }}>
              <span style={{ fontSize: 23, fontWeight: 500, color: C.ink }}>{row.place}</span>
              {MODES.map((m) => {
                const v = row.times[m];
                const win = compare > 0 && faster(flat.id, i, m);
                return (
                  <span
                    key={m}
                    style={{
                      justifySelf: 'end',
                      fontSize: 23,
                      fontVariantNumeric: 'tabular-nums',
                      fontWeight: win ? 600 : 400,
                      color: v === null ? C.fainter : win ? C.goodInk : C.inkSoft,
                      background: win ? `color-mix(in oklch, ${C.goodBg} ${compare * 100}%, transparent)` : undefined,
                      borderRadius: 7,
                      padding: '1px 7px',
                      marginRight: -7,
                    }}
                  >
                    {v === null ? '—' : formatDuration(Math.round(v * t) * 60 || 60)}
                  </span>
                );
              })}
            </div>
            {row.legs.length > 0 && (
              <div style={{ zoom: 1.45, marginTop: 5, display: 'flex', gap: 3, alignItems: 'center' }}>
                {row.legs.map((leg, j) => (
                  <span key={j} style={{ display: 'inline-flex', gap: 3, alignItems: 'center' }}>
                    {j > 0 && <span style={{ color: C.faint }}>›</span>}
                    <LegChip leg={leg} />
                  </span>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

export function Travel() {
  const frame = useFrame();
  const a = useEnter(6, { damping: 22, stiffness: 90 });
  const shift = useEnter(104, { damping: 200, stiffness: 60 });
  const b = useEnter(112, { damping: 22, stiffness: 90 });
  const compare = interpolate(frame, [165, 185], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const note = useEnter(40);

  const stageX = 890;
  const cardW = 430;
  const aX = interpolate(shift, [0, 1], [stageX + (900 - cardW) / 2, stageX]);

  return (
    <Paper>
      <div style={{ position: 'absolute', left: 140, top: 300 }}>
        <Chapter
          index="02"
          label="Travel"
          title="Love the flat? | Time the commute."
          body={
            <>
              Transport for London times to work, the gym and your mates, on foot, by bike and by Tube —
              all leaving at <b style={{ fontWeight: 600 }}>09:00 on a weekday</b>, so flats compare fairly.
            </>
          }
          width={720}
        />
      </div>

      <div style={{ position: 'absolute', left: aX, top: 150, opacity: a, transform: `translateY(${(1 - a) * 80}px)` }}>
        <FlatCard flat={FLATS[0]} width={cardW} imageHeight={190}>
          <TravelTable flat={FLATS[0]} start={22} compare={compare} />
        </FlatCard>
      </div>
      <div style={{ position: 'absolute', left: stageX + cardW + 40 + (1 - b) * 120, top: 150, opacity: b }}>
        <FlatCard flat={FLATS[1]} width={cardW} imageHeight={190} stamp={false}>
          <TravelTable flat={FLATS[1]} start={128} compare={compare} />
        </FlatCard>
      </div>

      <div
        style={{
          position: 'absolute',
          left: stageX,
          width: 900,
          top: 985,
          textAlign: 'center',
          fontFamily: FONT.mono,
          fontSize: 23,
          letterSpacing: '0.08em',
          color: C.muted,
          opacity: note,
        }}
      >
        TIMES FROM TRANSPORT FOR LONDON · WEEKDAY 09:00 DEPARTURE
      </div>
    </Paper>
  );
}
