'use client';

import { useEffect, useId, useRef, useState } from 'react';

/** A button that opens a small panel under itself, and shuts when you look away.
 *
 *  Written once because the header grew two of them in the same row — the hunt switcher and the
 *  account — and the compare table already had a third hand-rolled inside it, each with its own
 *  copy of the outside-click listener and only some of them with the Escape key. A popover you can
 *  only close by pressing the button that opened it is a trap, and the header's two sit over the
 *  first rows of the thing they configure.
 *
 *  Focus is not trapped. These hold two or three links, not a form, and a trap on a menu this small
 *  costs more than it buys — Escape and a click elsewhere are the two ways out, and both work. */
export function Menu({
  label,
  className,
  panelClassName,
  align = 'left',
  title,
  children,
}: {
  /** What the button shows. A node rather than a string: the hunt switcher's is a serif name and a
   *  chevron, the account's is a pair of initials. */
  label: React.ReactNode;
  className?: string;
  panelClassName?: string;
  /** Which edge the panel lines up with. The account menu is at the right of the row, so a
   *  left-aligned panel would hang off the page. */
  align?: 'left' | 'right';
  title?: string;
  /** Rendered inside the panel, and handed the way to shut it — every item in these menus does
   *  something and then wants the menu gone. */
  children: (close: () => void) => React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const host = useRef<HTMLDivElement>(null);
  const id = useId();

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (!host.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className={className ? `menu ${className}` : 'menu'} ref={host}>
      <button
        type="button"
        className="menu-button"
        aria-expanded={open}
        aria-haspopup="menu"
        aria-controls={open ? id : undefined}
        title={title}
        onClick={() => setOpen((was) => !was)}
      >
        {label}
      </button>
      {open && (
        <div
          id={id}
          role="menu"
          className={panelClassName ? `menu-panel menu-${align} ${panelClassName}` : `menu-panel menu-${align}`}
        >
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}
