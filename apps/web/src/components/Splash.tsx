'use client';

import { useEffect, useState } from 'react';
import { Mark, SPLASH_MS } from '@house-hunt/ui';

const SEEN = 'house-hunt-splash';
const FADE_MS = 280;

/** The launch screen: the magnifying glass finds the lit window, once per browser session.
 *
 *  An overlay, not a gate. It is in the server's HTML, so it is the first thing painted, and the app
 *  loads underneath it the whole time; it only decides when to get out of the way. The first open
 *  in a session plays the whole animation, and every later one in that session (a reload, the app
 *  switching back) fades it out the moment the page is interactive, so it never costs a second look.
 *  Reduced motion skips it too: the mark `Mark` draws for that is the finished one anyway. */
export function Splash() {
  const [phase, setPhase] = useState<'on' | 'fading' | 'gone'>('on');

  useEffect(() => {
    let seen = false;
    try {
      seen = sessionStorage.getItem(SEEN) !== null;
    } catch {
      // Storage refused (a private window with it switched off): play it, which is the safe side.
    }
    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (seen || still) {
      // Already painted by the server's HTML, so it leaves the same way it would have, only now.
      setPhase('fading');
      const gone = setTimeout(() => setPhase('gone'), FADE_MS);
      return () => clearTimeout(gone);
    }
    // Marked as seen when it has played, not when it starts: an effect can run twice (React's strict
    // mode does exactly that in development), and marking it up front made the second run skip it.
    const fade = setTimeout(() => {
      try {
        sessionStorage.setItem(SEEN, '1');
      } catch {
        // As above.
      }
      setPhase('fading');
    }, SPLASH_MS);
    const gone = setTimeout(() => setPhase('gone'), SPLASH_MS + FADE_MS);
    return () => {
      clearTimeout(fade);
      clearTimeout(gone);
    };
  }, []);

  if (phase === 'gone') return null;
  return (
    <div className={`splash${phase === 'fading' ? ' splash-out' : ''}`} aria-hidden="true">
      <Mark size={148} splash />
      <div className="splash-name">House hunt</div>
    </div>
  );
}
