import { interpolate } from 'remotion';
import { C, FONT } from '../theme';

/** A two-bedroom floorplan that draws itself, with a scan line passing over it and the smallest
 *  bedroom measured. `draw`, `scan` and `measure` are 0→1 progress values owned by the scene. */
export function Floorplan({ draw, scan, measure, balcony }: { draw: number; scan: number; measure: number; balcony: number }) {
  const walls = [
    'M20 20 H580 V400 H20 Z',
    'M340 20 V230',
    'M340 230 H580',
    'M420 230 V400',
    'M180 260 V400',
    'M20 260 H340',
    'M340 260 V400',
  ];
  const doors = [
    { d: 'M300 260 A40 40 0 0 1 340 300', line: 'M300 260 L340 260' },
    { d: 'M340 150 A40 40 0 0 0 380 190', line: 'M340 190 L380 190' },
    { d: 'M420 290 A40 40 0 0 1 460 330', line: 'M420 290 L460 290' },
    { d: 'M180 330 A40 40 0 0 0 220 370', line: 'M180 370 L220 370' },
  ];
  const rooms = [
    { x: 180, y: 130, name: 'Living room', dims: '5.2 × 3.9 m' },
    { x: 460, y: 115, name: 'Bedroom 1', dims: '4.0 × 3.4 m' },
    { x: 100, y: 325, name: 'Kitchen', dims: '' },
    { x: 260, y: 335, name: 'Bath', dims: '' },
    { x: 500, y: 276, name: 'Bedroom 2', dims: '' },
  ];
  const scanY = interpolate(scan, [0, 1], [10, 470]);
  const labelOpacity = interpolate(draw, [0.6, 1], [0, 1], { extrapolateLeft: 'clamp' });

  return (
    <svg viewBox="0 0 600 480" style={{ width: '100%', height: '100%', display: 'block', overflow: 'visible' }}>
      <defs>
        <linearGradient id="scan" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={C.green} stopOpacity={0} />
          <stop offset="1" stopColor={C.green} stopOpacity={0.16} />
        </linearGradient>
        <pattern id="hatch" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <line x1="0" y1="0" x2="0" y2="8" stroke={C.warnInk} strokeWidth="1.2" opacity="0.35" />
        </pattern>
      </defs>

      {/* the "garden", which is a balcony */}
      <g opacity={labelOpacity}>
        <rect x={20} y={410} width={200} height={52} fill={balcony > 0 ? 'url(#hatch)' : 'none'} stroke={C.faint} strokeWidth={2} strokeDasharray="6 5" />
        <text x={120} y={442} textAnchor="middle" fontFamily={FONT.mono} fontSize={14} fill={C.muted} letterSpacing="0.08em">
          BALCONY 1.1 m DEEP
        </text>
      </g>

      {walls.map((d, i) => (
        <path
          key={i}
          d={d}
          pathLength={1}
          fill="none"
          stroke={C.ink}
          strokeWidth={i === 0 ? 9 : 6}
          strokeLinecap="square"
          strokeDasharray="1"
          strokeDashoffset={1 - Math.min(1, Math.max(0, draw * 1.3 - i * 0.05))}
        />
      ))}
      {doors.map((door, i) => (
        <g key={i} opacity={labelOpacity}>
          <path d={door.line} stroke={C.paper} strokeWidth={8} />
          <path d={door.d} fill="none" stroke={C.faint} strokeWidth={1.5} />
        </g>
      ))}
      {rooms.map((r) => (
        <g key={r.name} opacity={labelOpacity}>
          <text x={r.x} y={r.y} textAnchor="middle" fontFamily={FONT.sans} fontSize={17} fontWeight={500} fill={C.inkSoft}>
            {r.name}
          </text>
          {r.dims && (
            <text x={r.x} y={r.y + 22} textAnchor="middle" fontFamily={FONT.mono} fontSize={14} fill={C.faint}>
              {r.dims}
            </text>
          )}
        </g>
      ))}

      {/* the smallest bedroom, measured */}
      <g opacity={measure}>
        <rect x={426} y={236} width={148} height={158} fill={C.green} opacity={0.1} />
        <line x1={430} x2={430 + 140 * measure} y1={376} y2={376} stroke={C.green} strokeWidth={2.5} />
        <line x1={562} x2={562} y1={240} y2={240 + 150 * measure} stroke={C.green} strokeWidth={2.5} />
        <text x={490} y={366} textAnchor="middle" fontFamily={FONT.mono} fontSize={17} fontWeight={500} fill={C.green}>
          2.3 m
        </text>
        <text x={552} y={330} fontFamily={FONT.mono} fontSize={17} fontWeight={500} fill={C.green} transform="rotate(-90 552 330)">
          2.8 m
        </text>
      </g>

      {scan > 0 && scan < 1 && (
        <g>
          <rect x={0} y={scanY - 90} width={600} height={90} fill="url(#scan)" />
          <line x1={0} x2={600} y1={scanY} y2={scanY} stroke={C.green} strokeWidth={2.5} />
        </g>
      )}
    </svg>
  );
}
