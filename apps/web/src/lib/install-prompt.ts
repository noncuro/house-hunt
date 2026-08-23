'use client';

import { useSyncExternalStore } from 'react';

/** Chromium's own "install this app" prompt, caught and held until somebody asks for it.
 *
 *  Chrome fires `beforeinstallprompt` once, early, and calling `preventDefault()` on it is what
 *  stops the browser showing its own bar and hands us the right to show the prompt later instead.
 *  That is the whole reason this listener is at module scope rather than in an effect: the event
 *  arrives as soon as the manifest and the service worker have been read, which is routinely before
 *  React has mounted anything, and a listener added afterwards catches nothing at all. A module a
 *  client component imports is evaluated when the bundle loads, which is early enough.
 *
 *  Nothing here is the only way in. Safari fires no such event and never will — an iPhone installs
 *  through Share → Add to Home Screen, by hand — so the Install screen always draws the written
 *  steps and treats this as the shortcut it is.
 */

interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

let deferred: InstallPromptEvent | null = null;
const listeners = new Set<() => void>();

function announce(): void {
  for (const listener of listeners) listener();
}

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    deferred = event as InstallPromptEvent;
    announce();
  });
  // The prompt is single-use, and the browser will not fire another for an app that is already
  // installed. Dropping it here is what stops the button outliving the thing it does.
  window.addEventListener('appinstalled', () => {
    deferred = null;
    announce();
  });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Whether the browser has offered us its install prompt, and how to show it.
 *
 *  `false` on the server and on the first client render, which is correct rather than merely safe:
 *  the event has not been answered for at that point either, and the written steps below the button
 *  are what the reader gets in the meantime. */
export function useInstallPrompt(): { available: boolean; install: () => Promise<void> } {
  const available = useSyncExternalStore(
    subscribe,
    () => deferred !== null,
    () => false,
  );

  return {
    available,
    install: async () => {
      const event = deferred;
      if (!event) return;
      // Consumed whatever the answer is: the same event cannot be shown twice, and leaving the
      // button live after a dismissal gives a button that silently does nothing.
      deferred = null;
      announce();
      await event.prompt();
    },
  };
}
