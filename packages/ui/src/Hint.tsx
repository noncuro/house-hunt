import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import './hint.css';

/** A tooltip we control.
 *
 *  The panel used the native `title` attribute, which turned out to show nothing at all inside
 *  the shadow root — and even where it works it can't be styled, can't wrap a paragraph readably,
 *  and appears on the browser's own schedule.
 *
 *  Positioned `fixed` against the viewport rather than nested in the panel, because the panel
 *  scrolls and clips, and a tooltip that gets cut off is worse than none. */
const SHOW_DELAY_MS = 200;
const GAP = 8;
const MAX_WIDTH = 300;

export function Hint({
  text,
  children,
  className,
  as = 'span',
  underline = true,
}: {
  /** Blank or absent means no tooltip and no underline — callers can pass a maybe-empty string. */
  text?: ReactNode;
  children: ReactNode;
  className?: string;
  as?: 'span' | 'div';
  /** A dotted underline is what tells you something is hoverable at all. Turn it off only where
   *  the element is obviously interactive on its own — the line-colour dots, a whole row. */
  underline?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [at, setAt] = useState<{ left: number; top: number; above: boolean } | null>(null);
  const anchor = useRef<HTMLElement | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useLayoutEffect(() => () => clearTimeout(timer.current), []);

  if (!text) return <>{children}</>;

  const show = () => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      const box = anchor.current?.getBoundingClientRect();
      if (!box) return;
      // Clamp into the viewport: the panel sits at the right edge, so an unclamped tooltip
      // would hang off-screen almost every time.
      const left = Math.max(GAP, Math.min(box.left, window.innerWidth - MAX_WIDTH - GAP));
      const above = box.top > window.innerHeight / 2;
      setAt({ left, top: above ? box.top - GAP : box.bottom + GAP, above });
      setOpen(true);
    }, SHOW_DELAY_MS);
  };

  const hide = () => {
    clearTimeout(timer.current);
    setOpen(false);
  };

  const Tag = as;
  const classes = ['rm-hint', underline ? 'rm-hint-mark' : '', className].filter(Boolean).join(' ');

  return (
    <Tag
      ref={anchor as never}
      className={classes}
      tabIndex={0}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
    >
      {children}
      {open && at && portalTarget(anchor.current) &&
        createPortal(
          <span
            className="rm-tip"
            role="tooltip"
            style={{
              left: at.left,
              // Anchoring the bottom edge when we flipped above keeps the bubble off the trigger.
              ...(at.above ? { bottom: window.innerHeight - at.top } : { top: at.top }),
            }}
          >
            {typeof text === 'string' ? paragraphs(text) : text}
          </span>,
          portalTarget(anchor.current)!,
        )}
    </Tag>
  );
}

/** Where the bubble is actually rendered. `position: fixed` is measured against the viewport,
 *  but it is still *painted* inside the nearest ancestor stacking context — and the shortlist
 *  card gives every child `z-index: 1` so links sit above the full-card button, which is one.
 *  Nested there, the tooltip was painted under the cards further down the page.
 *
 *  Not always `document.body`, though: in the panel the anchor lives in a shadow root, and
 *  leaving it would strand the bubble in the host page where none of these styles exist. The
 *  root node is the right target in both cases. */
function portalTarget(anchor: HTMLElement | null): Element | null {
  const root = anchor?.getRootNode();
  if (root instanceof ShadowRoot) return root as unknown as Element;
  if (root instanceof Document) return root.body;
  return null;
}

/** Blank lines in the source become real paragraphs with a small gap, rather than an actual
 *  empty line — which reads as a hole in a box this size. */
function paragraphs(text: string): ReactNode {
  const parts = text.split(/\n{2,}/);
  if (parts.length === 1) return text;
  return parts.map((part, i) => (
    <span className="rm-tip-p" key={i}>
      {part}
    </span>
  ));
}
