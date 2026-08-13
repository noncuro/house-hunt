'use client';

import { useEffect, useState } from 'react';

/** Pages, and how many rows go on one.
 *
 *  A sweep leaves two or three hundred flats in the shortlist, and every view here renders all of
 *  them at once: two hundred cards, each with a photo strip and a travel-time block, or two hundred
 *  table rows carrying a column per saved place. It is slow, and worse than slow — a pile you cannot
 *  see the end of is one nobody works through.
 *
 *  Twenty-five is the default because it is about a screen and a half of cards, and because the
 *  first page is the one that matters: every list here is sorted so that what you want is at the
 *  top. Fifty and a hundred are there for the two people who would rather scroll than click, and the
 *  choice is remembered — it is a preference about how one person reads, not shared state, so it
 *  lives in `localStorage` alongside the compare table's columns rather than in Postgres.
 *
 *  One preference across every list. Setting it on the shortlist and finding the compare table still
 *  showing twenty-five would read as the setting not having taken. */
const KEY = 'list:page-size';

export const PAGE_SIZES = [25, 50, 100] as const;
export type PageSize = (typeof PAGE_SIZES)[number];
export const DEFAULT_PAGE_SIZE: PageSize = PAGE_SIZES[0];

/** The stored choice, read once per page load and shared by every list on screen. Held here rather
 *  than in each component so that changing it in one place moves all of them in the same frame:
 *  `localStorage` has no change event within a single tab. */
let stored: PageSize | null = null;
const listeners = new Set<(size: PageSize) => void>();

function readStored(): PageSize {
  if (stored !== null) return stored;
  try {
    const saved = Number(localStorage.getItem(KEY));
    stored = (PAGE_SIZES as readonly number[]).includes(saved) ? (saved as PageSize) : DEFAULT_PAGE_SIZE;
  } catch {
    // Private browsing, a blocked origin. The lists still page; they just forget the size.
    stored = DEFAULT_PAGE_SIZE;
  }
  return stored;
}

export function setPageSize(next: PageSize): void {
  stored = next;
  try {
    localStorage.setItem(KEY, String(next));
  } catch {
    // As above: not being able to remember it is no reason not to apply it.
  }
  for (const listener of listeners) listener(next);
}

/** What the pager draws itself from. */
export interface Paging {
  page: number;
  pages: number;
  size: PageSize;
  total: number;
  setPage: (page: number) => void;
}

/** One list's slice of its items, and the state the pager below needs to draw itself.
 *
 *  The page is clamped rather than reset. Filtering the shortlist down to "viewed" while sitting on
 *  page four must land on the last page of what is left, not on an empty table that looks like a
 *  filter matching nothing. */
export function usePaging<T>(items: T[]): Paging & { shown: T[] } {
  const [size, setSize] = useState<PageSize>(() =>
    typeof window === 'undefined' ? DEFAULT_PAGE_SIZE : readStored(),
  );
  const [page, setPage] = useState(0);

  useEffect(() => {
    const onChange = (next: PageSize) => {
      setSize(next);
      // Twenty-five to a hundred means page three no longer exists, and the row you were looking at
      // is on page one now anyway.
      setPage(0);
    };
    listeners.add(onChange);
    return () => {
      listeners.delete(onChange);
    };
  }, []);

  const pages = Math.max(1, Math.ceil(items.length / size));
  const at = Math.min(page, pages - 1);
  return {
    shown: items.slice(at * size, at * size + size),
    page: at,
    pages,
    size,
    total: items.length,
    setPage,
  };
}

/** The control under a list: which page, and how many to a page.
 *
 *  Renders nothing at all for a list that fits in the smallest page — a pager under nine flats is a
 *  control whose every option does the same thing. */
export function Pager({
  page,
  pages,
  size,
  total,
  setPage,
  /** What the numbers are counting, so the line reads "of 43 places" rather than "of 43". */
  noun = 'places',
}: Paging & { noun?: string }) {
  if (total <= PAGE_SIZES[0]) return null;

  const from = page * size + 1;
  const to = Math.min(total, (page + 1) * size);

  return (
    <div className="pager" data-testid="pager">
      <button className="key" disabled={page === 0} onClick={() => setPage(page - 1)}>
        ‹ Previous
      </button>
      <span className="dim">
        {from}–{to} of {total} {noun}
      </span>
      <button className="key" disabled={page >= pages - 1} onClick={() => setPage(page + 1)}>
        Next ›
      </button>
      <label className="pager-size">
        <span className="dim">Per page:</span>
        <select value={size} onChange={(e) => setPageSize(Number(e.target.value) as PageSize)}>
          {PAGE_SIZES.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
