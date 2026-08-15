'use client';

import { useState } from 'react';

/** A piece of state that survives a refresh, in `localStorage`.
 *
 *  The same reasoning as the compare table's columns and the pager's page size, which is where this
 *  pattern was already written twice: how one person has arranged their own screen is a preference,
 *  not shared state, and syncing it through Postgres would mean one of you re-sorting the other's
 *  table mid-scroll. Everything genuinely shared — verdicts, stages, hub definitions — is in the
 *  database, and nothing here ever should be.
 *
 *  `revive` rather than a bare `JSON.parse`, because stored state outlives the code that wrote it.
 *  A value saved by last week's build can be missing a field this week's requires, and a `catch`
 *  around the parse does not help with that: the JSON is perfectly valid, it is just the wrong
 *  shape. Handing the raw parse to a validator makes the fallback per-field rather than
 *  all-or-nothing, so gaining a filter does not silently clear somebody's other four.
 *
 *  Reading in the initialiser is deliberate and matches `useColumnChoice`: the alternative is an
 *  effect after mount, which renders the default first and then replaces it, and a filter panel that
 *  visibly flickers from "any" to what you set is worse than one that arrives right. Nothing that
 *  uses this renders on the server — the screens behind it all wait on a query first.
 */
export function useStoredState<T>(
  key: string,
  revive: (raw: unknown) => T,
): [T, (next: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const saved = localStorage.getItem(key);
      return revive(saved === null ? null : JSON.parse(saved));
    } catch {
      // No storage at all (private browsing, a blocked origin), or a value that is not JSON. Both
      // mean the same thing here: start from whatever `revive` makes of nothing.
      return revive(null);
    }
  });

  return [
    value,
    (next: T) => {
      setValue(next);
      try {
        localStorage.setItem(key, JSON.stringify(next));
      } catch {
        // A full quota, or storage the browser refuses to write. The screen still works; it just
        // forgets — which is the right way round for a preference.
      }
    },
  ];
}
