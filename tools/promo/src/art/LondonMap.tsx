import { C, FONT } from '../theme';

/** A quiet, drawn London: the river, the big parks, a few arterial roads. Not a real map — the
 *  shortlist's map is OpenStreetMap, and this only has to say "London" at a glance. */
export function LondonMap({ reveal = 1 }: { reveal?: number }) {
  const roads = [
    'M60 120 C220 160 330 210 470 250 S720 300 880 290',
    'M120 520 C250 420 360 330 470 250',
    'M470 250 C520 170 560 90 600 10',
    'M470 250 C420 170 360 100 300 20',
    'M470 250 C560 320 640 400 700 540',
    'M0 300 C150 290 300 270 470 250',
    'M470 250 C600 220 740 170 900 150',
    'M200 20 C230 140 260 250 300 360',
  ];
  const parks = [
    { d: 'M300 40 C360 30 410 50 405 90 C400 125 340 130 310 110 C285 95 280 55 300 40 Z', name: 'Hampstead Heath' },
    { d: 'M370 170 C400 160 430 170 432 195 C434 220 400 228 378 215 C360 205 355 180 370 170 Z', name: "Regent's Park" },
    { d: 'M300 270 C350 262 400 268 402 288 C403 306 350 312 310 305 C290 300 285 276 300 270 Z', name: 'Hyde Park' },
    { d: 'M690 170 C720 160 760 168 760 188 C760 205 720 210 700 202 C684 195 680 176 690 170 Z', name: 'Victoria Park' },
    { d: 'M390 430 C430 420 470 430 470 452 C470 472 430 478 400 470 C380 462 376 438 390 430 Z', name: 'Clapham Common' },
  ];
  const thames =
    'M0 360 C80 350 150 400 220 395 C300 390 320 330 380 340 C440 350 430 390 500 380 C560 372 560 320 620 330 C680 340 690 400 760 395 C820 390 850 360 900 365';

  return (
    <svg viewBox="0 0 900 560" preserveAspectRatio="xMidYMid slice" style={{ width: '100%', height: '100%', display: 'block' }}>
      <rect width={900} height={560} fill="#f3efe6" />
      <g opacity={reveal}>
        {parks.map((p) => (
          <path key={p.name} d={p.d} fill="#dfe6d2" stroke="#cdd8bd" strokeWidth={1} />
        ))}
        {roads.map((d, i) => (
          <path key={i} d={d} fill="none" stroke="#fff" strokeWidth={i < 3 ? 7 : 5} strokeLinecap="round" />
        ))}
        {roads.map((d, i) => (
          <path key={`e${i}`} d={d} fill="none" stroke="#e6dfd1" strokeWidth={1} />
        ))}
        <path d={thames} fill="none" stroke="#c9d8de" strokeWidth={22} strokeLinecap="round" />
        <path d={thames} fill="none" stroke="#d7e3e7" strokeWidth={14} strokeLinecap="round" />
        {[
          ['NW3', 340, 140],
          ['N1', 520, 170],
          ['E5', 700, 110],
          ['W9', 250, 210],
          ['SE22', 610, 480],
          ['SW2', 470, 520],
          ['E8', 640, 215],
        ].map(([t, x, y]) => (
          <text key={t as string} x={x as number} y={y as number} fontFamily={FONT.mono} fontSize={13} letterSpacing="0.1em" fill={C.fainter}>
            {t}
          </text>
        ))}
      </g>
    </svg>
  );
}
