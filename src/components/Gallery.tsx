import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import './gallery.css';

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

  useEffect(() => {
    // Arrow keys are how anyone actually flicks through photos; Escape is how they leave.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowRight') setAt((i) => (i + 1) % images.length);
      if (e.key === 'ArrowLeft') setAt((i) => (i - 1 + images.length) % images.length);
    };
    window.addEventListener('keydown', onKey);
    // The page behind must not scroll while the overlay is up.
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = previous;
    };
  }, [images.length, onClose]);

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
          setAt((i) => (i - 1 + images.length) % images.length);
        }}
      >
        ‹
      </button>

      {/* Stop propagation on the image itself so clicking the photo doesn't dismiss it — only
          clicking the backdrop around it does. */}
      <img className="lightbox-image" src={images[at]} alt="" onClick={(e) => e.stopPropagation()} />

      <button
        className="lightbox-step lightbox-next"
        aria-label="Next photo"
        onClick={(e) => {
          e.stopPropagation();
          setAt((i) => (i + 1) % images.length);
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
