'use client';

import { useState } from 'react';

/** The 45-second film: a still from its first shot with a play button, swapped for the video on a
 *  click. `preload="none"` would do the same with no script, but a browser's own poster-and-controls
 *  look like a paused video player; this looks like an invitation. The file is `public/promo.mp4`,
 *  the same one `/promo` plays. */
export function Film() {
  const [playing, setPlaying] = useState(false);
  return (
    <div className="lp-film-frame">
      {playing ? (
        <video src="/promo.mp4" autoPlay controls playsInline />
      ) : (
        <>
          <img src="/welcome/film.jpg" alt="" />
          <button className="lp-play" aria-label="Play the film, 45 seconds" onClick={() => setPlaying(true)}>
            <span>
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M6 4l14 8-14 8z" />
              </svg>
            </span>
          </button>
        </>
      )}
    </div>
  );
}
