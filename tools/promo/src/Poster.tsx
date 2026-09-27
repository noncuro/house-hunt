import { End } from './scenes/Intro';
import { C } from './theme';

/** The end card, taken at frame 40 (see `pnpm poster`): the site's `<video poster>` and, with
 *  `play`, the README's link. */
export function Poster({ play }: { play: boolean }) {
  return (
    <>
      <End />
      {play && (
        <svg width={170} height={170} viewBox="0 0 100 100" style={{ position: 'absolute', left: 875, top: 800, filter: 'drop-shadow(0 12px 24px rgba(36,31,26,0.25))' }}>
          <circle cx={50} cy={50} r={50} fill={C.ink} />
          <path d="M40 31 L40 69 L71 50 Z" fill={C.paper} />
        </svg>
      )}
    </>
  );
}
