import { Easing, interpolate } from 'remotion';
import { RatingButtons, VerdictLine, VerdictStamp } from '@house-hunt/ui';
import { Chapter, Cursor, Paper, Photo, useEnter, useFrame } from '../kit';
import { FLATS } from '../data';
import { C, FONT } from '../theme';

const FLAT = FLATS[1];
const CLICK = 80;

function DeviceLabel({ children, opacity }: { children: string; opacity: number }) {
  return (
    <div style={{ fontFamily: FONT.mono, fontSize: 22, letterSpacing: '0.12em', color: C.muted, opacity, marginTop: 18, textAlign: 'center' }}>
      {children}
    </div>
  );
}

export function Verdict() {
  const frame = useFrame();
  const laptop = useEnter(4, { damping: 22, stiffness: 90 });
  const phone = useEnter(16, { damping: 22, stiffness: 90 });
  const rated = frame >= CLICK;
  const verdict = rated ? { rating: 'no' as const, person: 'Jo', updatedAt: new Date().toISOString(), note: '' } : null;

  const travel = interpolate(frame, [26, 74], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.bezier(0.45, 0, 0.2, 1) });
  const cx = interpolate(travel, [0, 1], [1330, 985]);
  const cy = interpolate(travel, [0, 1], [880, 588]) - Math.sin(travel * Math.PI) * 60;
  const pressed = interpolate(frame, [CLICK - 4, CLICK, CLICK + 6], [0, 1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const cursorIn = useEnter(22);

  const sync = interpolate(frame, [CLICK + 2, CLICK + 22], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.inOut(Easing.cubic) });
  const arrived = useEnter(CLICK + 20, { damping: 12, stiffness: 150, mass: 0.6 });
  const ring = interpolate(frame, [CLICK + 20, CLICK + 50], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });

  // The arc the rating travels along, laptop to phone.
  const p0 = [1380, 620];
  const p2 = [1660, 520];
  const p1 = [1540, 420];
  const bx = (1 - sync) ** 2 * p0[0] + 2 * (1 - sync) * sync * p1[0] + sync ** 2 * p2[0];
  const by = (1 - sync) ** 2 * p0[1] + 2 * (1 - sync) * sync * p1[1] + sync ** 2 * p2[1];

  return (
    <Paper>
      <div style={{ position: 'absolute', left: 140, top: 300 }}>
        <Chapter
          index="04"
          label="Verdict"
          title="One flat. | One verdict."
          body="Shared by everyone in the hunt, with who set it and when, so nobody books a viewing the other has already turned down."
          width={680}
        />
      </div>

      {/* Jo's laptop */}
      <div style={{ position: 'absolute', left: 870, top: 290, opacity: laptop, transform: `translateY(${(1 - laptop) * 60}px)` }}>
        <div
          style={{
            width: 700,
            background: C.raised,
            border: `1px solid ${C.line}`,
            borderRadius: 18,
            overflow: 'hidden',
            boxShadow: '0 30px 80px rgba(36,31,26,0.14), 0 6px 18px rgba(36,31,26,0.06)',
          }}
        >
          <div style={{ height: 40, background: C.line3, borderBottom: `1px solid ${C.line}`, display: 'flex', alignItems: 'center', gap: 8, padding: '0 16px' }}>
            {['#e8a39a', '#e9cf8f', '#a9cf9e'].map((c) => (
              <span key={c} style={{ width: 12, height: 12, borderRadius: 99, background: c }} />
            ))}
          </div>
          <div style={{ padding: 26, display: 'flex', gap: 26 }}>
            <div style={{ width: 250, height: 190, borderRadius: 10, overflow: 'hidden', flex: 'none' }}>
              <Photo name={FLAT.photo} />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div style={{ fontFamily: FONT.serif, fontWeight: 600, fontSize: 36, lineHeight: 1.1 }}>
                {FLAT.street}, {FLAT.area}
              </div>
              <div style={{ fontFamily: FONT.mono, fontSize: 17, color: C.muted, letterSpacing: '0.04em' }}>
                {FLAT.beds} BED · {FLAT.price} PCM
              </div>
              <div style={{ zoom: 1.8, marginTop: 8 }}>
                <VerdictLine verdict={verdict as never} />
              </div>
            </div>
          </div>
          <div style={{ padding: '0 16px 16px', zoom: 1.6 }}>
            <RatingButtons value={rated ? 'no' : null} onRate={() => {}} />
          </div>
        </div>
        <DeviceLabel opacity={laptop}>JO’S LAPTOP</DeviceLabel>
      </div>

      {/* Sam's phone */}
      <div style={{ position: 'absolute', left: 1580, top: 370, opacity: phone, transform: `translateY(${(1 - phone) * 80}px)` }}>
        <div
          style={{
            width: 290,
            height: 590,
            borderRadius: 48,
            background: '#1f1b17',
            padding: 11,
            boxSizing: 'border-box',
            boxShadow: '0 40px 90px rgba(36,31,26,0.28)',
            position: 'relative',
          }}
        >
          <div style={{ width: '100%', height: '100%', borderRadius: 38, background: C.paper, overflow: 'hidden', position: 'relative' }}>
            <div style={{ height: 44, display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 26px 0', fontSize: 15, fontWeight: 600 }}>
              <span>9:41</span>
              <span style={{ width: 80, height: 22, background: '#1f1b17', borderRadius: 99 }} />
              <span style={{ fontSize: 12, letterSpacing: 1 }}>●●●</span>
            </div>
            <div style={{ padding: '10px 18px', fontFamily: FONT.serif, fontWeight: 600, fontSize: 21, borderBottom: `1px solid ${C.line}` }}>House hunt</div>
            <div style={{ padding: 14 }}>
              <div style={{ background: C.raised, border: `1px solid ${C.line}`, borderRadius: 14, overflow: 'hidden', position: 'relative' }}>
                <div style={{ height: 150, position: 'relative' }}>
                  <Photo name={FLAT.photo} />
                  {rated && (
                    <div style={{ position: 'absolute', left: 10, top: 10, zoom: 1.35, transform: `scale(${arrived})`, transformOrigin: 'left top' }}>
                      <VerdictStamp verdict={verdict as never} />
                    </div>
                  )}
                </div>
                <div style={{ padding: '12px 14px 14px' }}>
                  <div style={{ fontFamily: FONT.serif, fontWeight: 600, fontSize: 21 }}>
                    {FLAT.street}, {FLAT.area}
                  </div>
                  <div style={{ zoom: 1.2, marginTop: 6, opacity: rated ? arrived : 1 }}>
                    <VerdictLine verdict={verdict as never} />
                  </div>
                </div>
                {ring > 0 && ring < 1 && (
                  <div style={{ position: 'absolute', inset: 0, borderRadius: 14, boxShadow: `inset 0 0 0 ${3 * (1 - ring)}px ${C.badInk}`, opacity: 1 - ring }} />
                )}
              </div>
              {[FLATS[2], FLATS[4]].map((f) => (
                <div key={f.id} style={{ marginTop: 12, display: 'flex', gap: 10, alignItems: 'center', background: C.raised, border: `1px solid ${C.line}`, borderRadius: 12, padding: 8 }}>
                  <div style={{ width: 64, height: 48, borderRadius: 6, overflow: 'hidden', flex: 'none' }}>
                    <Photo name={f.photo} />
                  </div>
                  <div style={{ fontFamily: FONT.serif, fontWeight: 600, fontSize: 16 }}>{f.street}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
        <DeviceLabel opacity={phone}>SAM’S PHONE</DeviceLabel>
      </div>

      {sync > 0 && sync < 1 && (
        <div style={{ position: 'absolute', left: bx - 9, top: by - 9, width: 18, height: 18, borderRadius: 99, background: C.badInk, boxShadow: `0 0 0 8px color-mix(in oklch, ${C.badInk} 20%, transparent)` }} />
      )}

      <div style={{ opacity: cursorIn * interpolate(frame, [CLICK + 40, CLICK + 60], [1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }) }}>
        <Cursor x={cx} y={cy} name="Jo" color="#b3894a" pressed={pressed} />
      </div>
    </Paper>
  );
}
