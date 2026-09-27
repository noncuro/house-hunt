import { FlagChip, RatingButtons } from '@house-hunt/ui';
import { Logo, Paper, Photo, Words, useEnter } from '../kit';
import { FLATS } from '../data';
import { C, FONT } from '../theme';

function Lines({ widths, height = 12, gap = 12 }: { widths: number[]; height?: number; gap?: number }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap }}>
      {widths.map((w, i) => (
        <div key={i} style={{ width: `${w}%`, height, borderRadius: 6, background: '#e7e2d8' }} />
      ))}
    </div>
  );
}

function Label({ children, opacity }: { children: string; opacity: number }) {
  return (
    <div style={{ fontFamily: FONT.mono, fontSize: 22, letterSpacing: '0.12em', color: C.muted, opacity, marginTop: 26, textAlign: 'center' }}>{children}</div>
  );
}

export function Everywhere() {
  const laptop = useEnter(6, { damping: 22, stiffness: 90 });
  const panel = useEnter(32, { damping: 20, stiffness: 110 });
  const phone = useEnter(20, { damping: 22, stiffness: 90 });
  const offline = useEnter(58, { damping: 16, stiffness: 140 });
  const flat = FLATS[0];

  return (
    <Paper>
      <div style={{ position: 'absolute', top: 92, width: '100%', textAlign: 'center', fontFamily: FONT.serif, fontWeight: 500, fontSize: 76, letterSpacing: '-0.02em' }}>
        <Words text="From Rightmove to the Northern line." delay={0} stagger={4} />
      </div>

      {/* laptop with the extension's panel on a listing */}
      <div style={{ position: 'absolute', left: 230, top: 250, opacity: laptop, transform: `translateY(${(1 - laptop) * 60}px)` }}>
        <div style={{ width: 1080, background: '#1f1b17', borderRadius: '26px 26px 0 0', padding: '16px 16px 0' }}>
          <div style={{ height: 600, background: '#fff', borderRadius: '12px 12px 0 0', overflow: 'hidden', position: 'relative' }}>
            <div style={{ height: 44, background: '#f1eee8', display: 'flex', alignItems: 'center', gap: 8, padding: '0 16px', borderBottom: '1px solid #e2ddd3' }}>
              {['#e8a39a', '#e9cf8f', '#a9cf9e'].map((c) => (
                <span key={c} style={{ width: 11, height: 11, borderRadius: 99, background: c }} />
              ))}
              <span style={{ marginLeft: 18, flex: 1, background: '#fff', borderRadius: 8, padding: '5px 14px', fontFamily: FONT.mono, fontSize: 14, color: C.muted }}>
                rightmove.co.uk/properties/…
              </span>
            </div>
            <div style={{ padding: 26, display: 'flex', gap: 26 }}>
              <div style={{ width: 560 }}>
                <div style={{ height: 330, borderRadius: 8, overflow: 'hidden' }}>
                  <Photo name={flat.photo} />
                </div>
                <div style={{ marginTop: 20 }}>
                  <Lines widths={[70, 40]} height={18} />
                </div>
                <div style={{ marginTop: 22 }}>
                  <Lines widths={[95, 90, 92, 60]} />
                </div>
              </div>
              <div style={{ flex: 1, paddingTop: 4 }}>
                <Lines widths={[80, 60, 70, 50, 65]} />
              </div>
            </div>

            {/* the panel */}
            <div
              style={{
                position: 'absolute',
                right: 18,
                top: 60,
                width: 380,
                background: C.raised,
                border: `1px solid ${C.line}`,
                borderRadius: 14,
                boxShadow: '0 6px 20px rgb(36 31 26 / 18%)',
                padding: 20,
                fontFamily: FONT.sans,
                opacity: panel,
                transform: `translateX(${(1 - panel) * 80}px)`,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <Logo size={30} />
                <span style={{ fontFamily: FONT.serif, fontWeight: 600, fontSize: 22 }}>House hunt</span>
                <span style={{ marginLeft: 'auto', fontFamily: FONT.mono, fontSize: 13, color: C.goodInk, letterSpacing: '0.06em' }}>SAVED</span>
              </div>
              <div style={{ fontFamily: FONT.serif, fontWeight: 600, fontSize: 26, marginTop: 14 }}>
                {flat.street}, {flat.area}
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', rowGap: 6, marginTop: 12, fontSize: 19, color: C.inkSoft }}>
                <span>Work</span>
                <b style={{ fontWeight: 600, color: C.ink }}>28m</b>
                <span>The gym</span>
                <b style={{ fontWeight: 600, color: C.ink }}>9m</b>
                <span>Sunday lunch</span>
                <b style={{ fontWeight: 600, color: C.ink }}>41m</b>
              </div>
              <div style={{ zoom: 1.3, display: 'flex', flexWrap: 'wrap', gap: 5, marginTop: 10 }}>
                <FlagChip flag={{ key: 'size', severity: 'good', text: '54 m² usable', confidence: 'high' }} />
                <FlagChip flag={{ key: 'bathtub', severity: 'red', text: 'No bathtub', confidence: 'high' }} />
              </div>
              <div style={{ zoom: 1.2, marginTop: 12 }}>
                <RatingButtons value="love" onRate={() => {}} />
              </div>
            </div>
          </div>
        </div>
        <div style={{ width: 1200, height: 22, marginLeft: -60, background: 'linear-gradient(#d8d2c6, #bdb6a8)', borderRadius: '0 0 18px 18px' }} />
        <Label opacity={laptop}>THE EXTENSION, ON A LISTING</Label>
      </div>

      {/* phone, offline */}
      <div style={{ position: 'absolute', left: 1470, top: 290, opacity: phone, transform: `translateY(${(1 - phone) * 80}px)` }}>
        <div style={{ width: 300, height: 610, borderRadius: 48, background: '#1f1b17', padding: 11, boxSizing: 'border-box', boxShadow: '0 40px 90px rgba(36,31,26,0.28)' }}>
          <div style={{ width: '100%', height: '100%', borderRadius: 38, background: C.paper, overflow: 'hidden' }}>
            <div style={{ height: 44, display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 26px 0', fontSize: 15, fontWeight: 600 }}>
              <span>8:52</span>
              <span style={{ width: 80, height: 22, background: '#1f1b17', borderRadius: 99 }} />
              <span style={{ fontSize: 12, color: C.faint }}>No signal</span>
            </div>
            <div
              style={{
                margin: '8px 12px 0',
                background: C.warnBg,
                border: '1px solid #ecd9a8',
                color: C.warnInk,
                borderRadius: 10,
                padding: '8px 12px',
                fontSize: 14,
                lineHeight: 1.35,
                opacity: offline,
                transform: `translateY(${(1 - offline) * -16}px)`,
              }}
            >
              No connection — this is the hunt as it was at 08:40.
            </div>
            <div style={{ padding: '10px 12px' }}>
              {FLATS.slice(0, 4).map((f) => (
                <div key={f.id} style={{ marginBottom: 10, background: C.raised, border: `1px solid ${C.line}`, borderRadius: 12, overflow: 'hidden' }}>
                  <div style={{ height: 66 }}>
                    <Photo name={f.photo} />
                  </div>
                  <div style={{ padding: '6px 10px 8px', fontFamily: FONT.serif, fontWeight: 600, fontSize: 16 }}>
                    {f.street}, {f.area}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
        <Label opacity={phone}>THE APP, UNDERGROUND</Label>
      </div>

    </Paper>
  );
}
