import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useOverlayKeys } from './overlay-keys';
import './gallery.css';

/** How far a finger has to travel before it counts as a swipe rather than a tap that wandered.
 *  Below this the photo springs back, which is the feedback that says "that was not a swipe". */
const SWIPE_MIN_PX = 45;

/** Photos in place, rather than a new tab per click.
 *
 *  Looking through a gallery is a rapid back-and-forth — you flick through fifteen photos and
 *  form an impression — and a tab per photo turns that into fifteen tabs and no impression.
 *
 *  Images are rendered straight from Rightmove's CDN. We link and display; we never copy or
 *  re-host, which is the line their terms draw (13.4).
 *
 *  Shared by the shortlist and the panel, which is why it takes a `container`. On the shortlist it
 *  portals to `<body>`; in the panel it has to portal *inside the shadow root*, because the
 *  panel's stylesheet is injected there and nowhere else — portalled to the page's own body it
 *  would render as a column of unstyled full-size photos over Rightmove. */
export function Gallery({
  images,
  startAt,
  onClose,
  caption,
  container,
}: {
  images: string[];
  startAt: number;
  onClose: () => void;
  caption: string;
  /** Where the overlay is portalled. Defaults to `<body>`; the panel passes its shadow root. */
  container?: Element | DocumentFragment | null;
}) {
  const [at, setAt] = useState(startAt);
  /** How far the finger has moved since it went down, or null when nothing is being dragged. The
   *  photo follows it, which is the only thing that tells you a swipe is a gesture this gallery
   *  understands before you have finished making it. */
  const [drag, setDrag] = useState<number | null>(null);
  const from = useRef<{ x: number; y: number; id: number } | null>(null);

  const step = (by: number) => setAt((i) => (i + by + images.length) % images.length);

  // Only worth swiping through more than one photo, and `step` would be a no-op anyway.
  const swipeable = images.length > 1;

  /** The photos either side, which are on screen the moment a swipe starts.
   *
   *  A drag used to move the current photo alone across an empty backdrop: the gallery took the
   *  gesture and gave back no sign of what was coming, so a swipe was a guess that something was
   *  over there. Since `step` wraps, there is always a photo on both sides — the ends of the list
   *  are not ends — so both are always drawn and neither has to be a special case. With two photos
   *  they are the same photo, which is what wrapping means and reads correctly either way. */
  const before = swipeable ? (at - 1 + images.length) % images.length : null;
  const after = swipeable ? (at + 1) % images.length : null;

  /** Pointer events rather than touch events: one set of handlers covers a finger, a stylus and a
   *  mouse dragged across the photo, and the panel's gallery opens inside a shadow root where the
   *  fewer listeners the better. The pointer is captured so a finger that leaves the image mid-swipe
   *  still ends the gesture here rather than dropping it half-done. */
  function onPointerDown(event: React.PointerEvent) {
    if (!swipeable || !event.isPrimary) return;
    from.current = { x: event.clientX, y: event.clientY, id: event.pointerId };
    (event.currentTarget as Element).setPointerCapture(event.pointerId);
  }

  function onPointerMove(event: React.PointerEvent) {
    const start = from.current;
    if (!start || event.pointerId !== start.id) return;
    const dx = event.clientX - start.x;
    // A gesture that is mostly vertical is not a swipe through the photos — on a phone it is
    // somebody trying to scroll or dismiss, and grabbing it would make the gallery feel stuck.
    if (Math.abs(dx) < Math.abs(event.clientY - start.y)) return;
    setDrag(dx);
  }

  function onPointerUp(event: React.PointerEvent) {
    const start = from.current;
    if (!start || event.pointerId !== start.id) return;
    from.current = null;
    setDrag(null);

    // Measured from the event rather than from the `drag` state. They are the same number in every
    // ordinary swipe, and different in the one that matters: a release in the same frame as the
    // last move reads a `drag` React has not committed yet, which loses the last few pixels — or,
    // for a flick fast enough to produce one move and an immediate up, the whole gesture.
    const dx = event.clientX - start.x;
    // The same "is this even a horizontal gesture" test the moves apply, applied again to the
    // gesture as a whole: a swipe that ended up mostly vertical is somebody scrolling.
    if (Math.abs(dx) < Math.abs(event.clientY - start.y)) return;
    // Left means forward, the way every photo gallery on a phone works: the next photo comes in
    // from the right as the current one leaves.
    if (Math.abs(dx) >= SWIPE_MIN_PX) step(dx < 0 ? 1 : -1);
  }

  /** The gesture was taken away rather than finished — an edge swipe the browser claimed as a
   *  back-navigation, a phone call, a palm on the screen. It has to put the photo back and must not
   *  advance: cancelling is the one outcome that means "pretend this never happened", and a gallery
   *  that flicked onward as the OS pulled the page out from under it would move while you were
   *  looking somewhere else. */
  function onPointerCancel(event: React.PointerEvent) {
    if (from.current?.id !== event.pointerId) return;
    from.current = null;
    setDrag(null);
  }

  // Arrow keys are how anyone actually flicks through photos; Escape is how they leave. Claimed as
  // the overlay on top, so leaving a photo no longer also closes the flat panel underneath it, and
  // the panel's own j/k stay the panel's while a photo is up.
  useOverlayKeys({
    Escape: onClose,
    ArrowRight: () => step(1),
    ArrowLeft: () => step(-1),
  });

  useEffect(() => {
    // The page behind must not scroll while the overlay is up.
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  if (images.length === 0) return null;

  // Portalled to <body> rather than rendered where it sits in the tree. The card gives every
  // one of its children `position: relative; z-index: 1` so links stay clickable above the
  // full-card button — and that makes a stacking context, inside which the overlay's z-index
  // means nothing to the cards further down the page. They painted straight over the photo.
  // The same rule sets `pointer-events: none` on that wrapper, so clicking the backdrop to
  // dismiss was dead too. Neither is reachable from body.
  return createPortal(
    <div className="lightbox" onClick={onClose} role="dialog" aria-label={caption}>
      <button className="lightbox-close" onClick={onClose} aria-label="Close">
        ×
      </button>

      <button
        className="lightbox-step lightbox-prev"
        aria-label="Previous photo"
        onClick={(e) => {
          e.stopPropagation();
          step(-1);
        }}
      >
        ‹
      </button>

      {/* Three slides a viewport wide each, the middle one centred, so the neighbours sit exactly
          off either edge until a drag brings them in. Moving the whole track rather than the photo
          is the entire point: a swipe now shows what it is swiping to.

          Stop propagation here so clicking a photo doesn't dismiss the gallery — only the backdrop
          around it does. On the track rather than on each image, because a neighbour is on screen
          and clickable the moment a drag begins, and a tap that lands on one must not be read as a
          tap on the backdrop asking to leave. */}
      <div
        className={drag === null ? 'lightbox-track' : 'lightbox-track lightbox-dragging'}
        // One-to-one with the finger now, where a lone photo was damped to keep it from being
        // dragged off the screen and left there. The damping was what stopped the neighbours ever
        // lining up with the gesture; the track cannot be stranded, because a released swipe either
        // completes or springs back.
        //
        // When it completes there is no separate animation: `at` moves on and `drag` clears in the
        // same commit, so the transition below runs from the offset the finger left to zero while
        // the middle slide already holds the new photo — which draws it arriving from the side the
        // swipe came from, and is why finishing needs no state of its own.
        style={drag === null ? undefined : { transform: `translateX(${drag}px)` }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="lightbox-slide">
          {before !== null && <img className="lightbox-image" src={images[before]} alt="" draggable={false} />}
        </div>
        <div className="lightbox-slide">
          <img
            className="lightbox-image"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            // A gesture the browser takes over ends as a cancel and never as an up. Its own handler,
            // not this one: without any handler the drag would stick and the photo would sit held
            // mid-swipe, and with `onPointerUp` here it would advance on a gesture that was abandoned.
            onPointerCancel={onPointerCancel}
            src={images[at]}
            alt=""
            // The browser's own image drag starts about thirty pixels into a mouse swipe and takes
            // the pointer stream with it — no more moves, no `pointerup`, and the photo left sitting
            // where the finger stopped. Nothing here wants a draggable image; the CSS stops the
            // long-press menu, and this stops the drag.
            draggable={false}
          />
        </div>
        <div className="lightbox-slide">
          {after !== null && <img className="lightbox-image" src={images[after]} alt="" draggable={false} />}
        </div>
      </div>

      <button
        className="lightbox-step lightbox-next"
        aria-label="Next photo"
        onClick={(e) => {
          e.stopPropagation();
          step(1);
        }}
      >
        ›
      </button>

      <div className="lightbox-bar" onClick={(e) => e.stopPropagation()}>
        <span>{caption}</span>
        <span className="dim">
          {at + 1} / {images.length}
        </span>
      </div>
    </div>,
    container ?? document.body,
  );
}
