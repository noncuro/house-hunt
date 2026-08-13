'use client';

import { useRef } from 'react';

/** Ticking flats, and ticking a run of them with shift.
 *
 *  The box is a button rather than an `<input type="checkbox">`. A native checkbox inside its
 *  label does not reliably hand the modifier to the handler that toggles: shift-clicking one
 *  selected a single row, left the anchor where it was, and drew the box unticked while the row
 *  counted as selected — state and paint disagreeing about what a bulk rating would hit. A button
 *  has no activation state of its own to fight. The tick is drawn from `checked` and nothing else,
 *  the click carries its modifiers, and Space activates it with them too — which is the only way
 *  the range gesture is reachable from the keyboard at all. */

export interface Selection {
  chosen: Set<string>;
  toggle: (rightmoveId: string) => void;
  /** Set a whole run at once. Shift-picking needs this: toggling one at a time would read the
   *  same stale selection for every id in the range and keep only the last. */
  setMany: (rightmoveIds: string[], on: boolean) => void;
}

/** Shift-picks the whole run between the last tick and this one.
 *
 *  `order` is the order on screen, so a re-sorted table selects what you pointed at rather than
 *  what used to be there. The anchor is held as an id for the same reason — a remembered index
 *  means something different the moment the rows move.
 *
 *  Returns a picker to hand to `Tick` (and to a row's own click handler, so the row and the box
 *  behave identically): it ranges when it can, and otherwise toggles the one flat and remembers
 *  it as the next anchor. */
export function useRangePick(order: string[], selection: Selection | undefined) {
  const anchor = useRef<string | null>(null);
  return (id: string, shiftKey: boolean) => {
    if (!selection) return;
    const from = anchor.current;
    if (shiftKey && from && from !== id) {
      const a = order.indexOf(from);
      const b = order.indexOf(id);
      if (a !== -1 && b !== -1) {
        // The anchor's own state decides the run's, which is what makes a second shift-pick undo
        // the first rather than re-select what is already on. The anchor stays put, so widening
        // and narrowing the same run works the way it does in a file list.
        selection.setMany(order.slice(Math.min(a, b), Math.max(a, b) + 1), selection.chosen.has(from));
        return;
      }
    }
    anchor.current = id;
    selection.toggle(id);
  };
}

export function Tick({
  checked,
  label,
  onPick,
}: {
  checked: boolean;
  /** What this ticks, for a screen reader: 219 boxes all called "select" are 219 of nothing. */
  label: string;
  onPick: (shiftKey: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      className={checked ? 'tick tick-on' : 'tick'}
      // The row underneath handles clicks too — it opens the flat — and both would fire on the box.
      onClick={(event) => {
        event.stopPropagation();
        // Shift-clicking is also the browser's "extend the text selection", which leaves several
        // hundred characters of the table highlighted behind every range you tick. The rows are
        // unselectable in CSS; this clears anything the gesture started before that took effect.
        if (event.shiftKey) window.getSelection()?.removeAllRanges();
        onPick(event.shiftKey);
      }}
    >
      <span className="tick-box" aria-hidden="true">
        {checked ? '✓' : ''}
      </span>
      <span className="visually-hidden">Select {label}</span>
    </button>
  );
}
