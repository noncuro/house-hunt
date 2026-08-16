import { useEffect, useRef } from 'react';

/** The keys an overlay owns while it is the one on top.
 *
 *  Two overlays can be open at once — the photo gallery opens over the flat panel, which is open
 *  over the shortlist — and each used to listen for its own keys itself. One Escape reached both, so
 *  leaving a photo also threw away the flat you were reading, which is not what anybody pressed
 *  Escape for: they closed a photo and expected to be back where they were.
 *
 *  Ordering, rather than `stopPropagation`, is what fixes it. The listeners were on different nodes
 *  (`document` and `window`), so the inner one could not stop the outer one from hearing the same
 *  event — the outer one had already run. A stack does not care where anything listens: the last
 *  overlay to mount is the one on top, and it is the only one that gets the key.
 *
 *  That is also what makes j/k safe on the panel. The keys walk the list behind it, and while a
 *  photo is open they must do nothing at all: the gallery is on top and does not claim them, and an
 *  unclaimed key is not passed down. An overlay owns the keyboard or it does not.
 *
 *  Registering is the whole opt-in. Anything still listening on its own — a menu, a picker — keeps
 *  working exactly as before and is simply not part of the ordering, which is right while it cannot
 *  be open underneath one of these. */
type Keys = Record<string, () => void>;

const stack: Array<{ current: Keys }> = [];

/** Typing must not be read as a shortcut: the panel has a note field on it, and "j" is a letter
 *  somebody writing about a kitchen will use. Escape is exempt — it is not a character, and closing
 *  the panel from inside the note is what it has always done. */
function typing(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && !!target.closest('input, textarea, select, [contenteditable]');
}

function onKey(event: KeyboardEvent) {
  // Held modifiers mean a browser or OS shortcut, never one of ours.
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  const top = stack.at(-1);
  const handler = top?.current[event.key];
  if (!handler) return;
  if (event.key !== 'Escape' && typing(event.target)) return;
  handler();
  // Only where we acted, and not for Escape: it has meanings we are not overriding, like stopping a
  // page load.
  if (event.key !== 'Escape') event.preventDefault();
}

export function useOverlayKeys(keys: Keys): void {
  // The handlers are read through a ref so the effect can register exactly once per mount.
  // Registering on every change of them would push a panel that merely re-rendered back above the
  // gallery open over it, which is the bug this exists to fix wearing a different hat — and every
  // caller passes inline arrows.
  const latest = useRef(keys);
  latest.current = keys;

  useEffect(() => {
    if (stack.length === 0) document.addEventListener('keydown', onKey);
    stack.push(latest);
    return () => {
      // By identity, not by position: React can unmount two overlays in an order that is not the
      // reverse of the order they mounted in, and popping blindly would leave the survivor holding
      // somebody else's handlers.
      const at = stack.lastIndexOf(latest);
      if (at !== -1) stack.splice(at, 1);
      if (stack.length === 0) document.removeEventListener('keydown', onKey);
    };
  }, []);
}
