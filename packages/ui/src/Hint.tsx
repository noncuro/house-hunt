import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import './hint.css';

/** A tooltip we control.
 *
 *  The panel used the native `title` attribute, which turned out to show nothing at all inside
 *  the shadow root — and even where it works it can't be styled, can't wrap a paragraph readably,
 *  and appears on the browser's own schedule.
 *
 *  Positioned `fixed` against the viewport rather than nested in the panel, because the panel
 *  scrolls and clips, and a tooltip that gets cut off is worse than none.
 *
 *  Two ways in, because there are two kinds of device. A mouse hovers, after a delay, and leaves.
 *  A finger taps to open and taps somewhere else to close — there is no hover on a touchscreen, and
 *  this app is installed to phone home screens, so hover-only meant every explanation in the main
 *  loop was unreachable on the surface it was designed for. The two paths are told apart by
 *  `pointerType` rather than by a media query: one component, and the device says which it is. */
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
  const id = useId();

  useLayoutEffect(() => () => clearTimeout(timer.current), []);

  const place = () => {
    clearTimeout(timer.current);
    const box = anchor.current?.getBoundingClientRect();
    if (!box) return;
    // Clamp into the viewport: the panel sits at the right edge, so an unclamped tooltip
    // would hang off-screen almost every time.
    const left = Math.max(GAP, Math.min(box.left, window.innerWidth - MAX_WIDTH - GAP));
    const above = box.top > window.innerHeight / 2;
    setAt({ left, top: above ? box.top - GAP : box.bottom + GAP, above });
    setOpen(true);
  };

  /** The delay is a hover's own: it stops a bubble appearing under every word a mouse crosses on
   *  its way somewhere else. A tap has already said which word it means, so a tap calls `place`. */
  const show = () => {
    clearTimeout(timer.current);
    timer.current = setTimeout(place, SHOW_DELAY_MS);
  };

  const hide = () => {
    clearTimeout(timer.current);
    setOpen(false);
  };

  /** Tap somewhere else and it goes away — the other half of tap-to-open, and the only close
   *  gesture a finger has.
   *
   *  Listening on the anchor's root node rather than on `document`, for the reason `portalTarget`
   *  gives below: in the panel the anchor is inside a shadow root, and an event that leaves it is
   *  retargeted to the host, so a document listener cannot tell a tap on the hint from a tap on
   *  anything else in the panel and would close the bubble the tap had just opened. `composedPath`
   *  is what still sees through the boundary. `pointerdown` rather than `click` so the explanation
   *  is gone before whatever was tapped next gets on with its own job. */
  useEffect(() => {
    if (!open) return;
    const root = anchor.current?.getRootNode();
    if (!root) return;
    const away = (event: Event) => {
      const here = anchor.current;
      if (here && event.composedPath().includes(here)) return;
      clearTimeout(timer.current);
      setOpen(false);
    };
    root.addEventListener('pointerdown', away);
    return () => root.removeEventListener('pointerdown', away);
  }, [open]);

  if (!text) return <>{children}</>;

  const Tag = as;
  const classes = ['rm-hint', underline ? 'rm-hint-mark' : '', className].filter(Boolean).join(' ');

  return (
    <Tag
      ref={anchor as never}
      className={classes}
      tabIndex={0}
      aria-describedby={id}
      onPointerEnter={(event) => {
        if (event.pointerType === 'mouse') show();
      }}
      onPointerLeave={(event) => {
        if (event.pointerType === 'mouse') hide();
      }}
      // A tap opens it, and a second tap on the same mark puts it away. Not for a mouse: a mouse has
      // hover, and toggling on click would take the bubble away from somebody who clicked the word
      // they were already reading about, with no way back until they moved the pointer off and on.
      onPointerUp={(event) => {
        if (event.pointerType === 'mouse') return;
        // A tap that lands on a control inside the hint is a tap on the control. Several hints wrap
        // a button so the button's label can explain it — the stage steps, the verdict, the
        // copy-coordinates one — and there a tap means "do the thing", not "tell me about it".
        if (onControl(event.target, event.currentTarget)) return;
        if (open) hide();
        else place();
      }}
      onFocus={show}
      onBlur={hide}
    >
      {children}
      {/* The description a screen reader reads, always present and never drawn. The bubble is
          hover state — it exists only while open, and only after a delay — so pointing
          `aria-describedby` at it would name an element that is usually not there. This is the
          same text, said the other way. */}
      <span className="rm-hint-said" id={id}>
        {text}
      </span>
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

/** Whether the tap landed on something inside the hint that does its own job when tapped.
 *
 *  `[tabindex]` catches the ones that are interactive without being a `<button>`; the hint itself
 *  carries one, so it is excluded by name rather than by the selector. */
function onControl(target: EventTarget | null, hint: Element): boolean {
  if (!(target instanceof Element)) return false;
  const control = target.closest('button, a, input, select, textarea, [role="button"], [tabindex]');
  return control !== null && control !== hint && hint.contains(control);
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
