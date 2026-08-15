'use client';

import { useEffect, useRef, useState } from 'react';

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

/** A request to bring one item of a list into view: where it sits in that list, or -1 when it is
 *  not in this list at all, and a token identifying the *asking*.
 *
 *  Two dependencies because there are two ways this has to retrigger and neither covers the other.
 *  The index alone misses a second click on the same pin — the number is equal, so React sees
 *  nothing to do, and following a link back to a flat you had paged away from does nothing at all.
 *  The token alone misses the list moving underneath: a refetch that drops six earlier flats leaves
 *  the same request pointing at an index six too high, so the pager turns to a page the flat is not
 *  on and the scroll expires against a card that was never rendered.
 *
 *  So: the index is recomputed on every render and compared by value, which costs a `findIndex` on
 *  a list already in memory and is silent when nothing moved; the token is a fresh object per ask
 *  and compared by identity. */
export interface Reveal {
  index: number;
  /** Whatever the caller uses to mean "this particular ask". Compared by identity, never read. */
  token: unknown;
  /** Withdraw the request, because the reader has taken the wheel.
   *
   *  A request stays live until then, and that is deliberate: the list moves underneath — a refetch
   *  drops six earlier flats and the target is six rows up — and while the reader is still looking
   *  at where they were sent, following that shift is the whole job. Once they have turned a page
   *  themselves, the same shift would haul them back to a flat they had finished with.
   *
   *  Spending it belongs to whoever holds the request rather than to the list that answered it. The
   *  ask is one flat against four piles, only one of which has it; a pile that recorded "spent" for
   *  itself would leave the other three still willing to obey a request the reader had already
   *  overridden, and the flat only has to change verdict for one of them to act on it. */
  spend?: () => void;
}

/** One list's slice of its items, and the state the pager below needs to draw itself.
 *
 *  The page is clamped rather than reset. Filtering the shortlist down to "viewed" while sitting on
 *  page four must land on the last page of what is left, not on an empty table that looks like a
 *  filter matching nothing. */
export function usePaging<T>(
  items: T[],
  /** Bring one item onto the visible page — the answer to "jump to this flat" from somewhere that
   *  is not this list.
   *
   *  A list that pages is a list where most of its own contents are not in the document, and every
   *  jump into it was written before that was true. Clicking a map pin set the view to the list and
   *  scrolled to `#card-<id>`, which for anything past the first twenty-five is an element that
   *  does not exist — so the scroll found nothing, gave up after its second, and left you at the
   *  top of the shortlist looking like the click had done nothing but change tabs. Paging is state
   *  this hook owns, so reaching it has to be something the hook offers.
   *
   *  Carries an index rather than a predicate because the caller already knows where the item is —
   *  it has just searched the list to decide whether to jump at all — and -1/null is the natural
   *  "not in this list", which every pile but one will be answering. */
  reveal?: Reveal | null,
): Paging & { shown: T[] } {
  const [size, setSize] = useState<PageSize>(() =>
    typeof window === 'undefined' ? DEFAULT_PAGE_SIZE : readStored(),
  );
  const [page, setPage] = useState(0);

  /** Page to whatever has been asked for. A link into a list — a map pin, a compare row, a
   *  `#card-…` address — used to scroll to nothing whenever the flat was past the first page,
   *  because a card on page three is not in the document to scroll to. */
  const index = reveal?.index ?? -1;
  const token = reveal?.token;

  // Two values the effects below need but must not depend on: the page size, because changing it
  // would otherwise count as a fresh request to reveal something and undo the jump to page one, and
  // the withdrawal, because it is a fresh closure on every render.
  //
  // Written in an effect rather than during the render that produced them. A render can be started
  // and thrown away — React abandons one to serve something more urgent — and a ref assigned on the
  // way past keeps the value from a render that never happened. Assigning at commit means these
  // always hold what is actually on screen.
  const latest = useRef({ size, spend: reveal?.spend });
  useEffect(() => {
    latest.current = { size, spend: reveal?.spend };
  });

  /** The reader takes the wheel: turn to `next`, and withdraw whatever request is outstanding.
   *  Reads the withdrawal from this render rather than the ref — it runs from an event handler on a
   *  render that has certainly committed. */
  const spend = reveal?.spend;
  const steer = (next: number) => {
    setPage(next);
    spend?.();
  };

  useEffect(() => {
    if (index < 0) return;
    setPage(Math.floor(index / latest.current.size));
    // `reveal` itself is deliberately not a dependency: the caller builds it fresh on every render,
    // so depending on the object would page a reader back to the last flat anybody followed a link
    // to every time anything on the page changed. Its two halves are what actually mean something.
  }, [index, token]);

  useEffect(() => {
    const onChange = (next: PageSize) => {
      setSize(next);
      // Twenty-five to a hundred means page three no longer exists, and the row you were looking at
      // is on page one now anyway. That is the reader choosing a page, so it spends the request
      // too: without that, a later shift of the list would move them off the page they had just
      // asked to be on. Through the ref: this listener is registered once, so the withdrawal it
      // closed over at mount is the one from before anything had been asked.
      setPage(0);
      latest.current.spend?.();
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
    // Wrapped, so that turning a page by hand withdraws whatever request is outstanding — see
    // `Reveal.spend`. Everything that reaches this is the reader: the pager's own buttons.
    setPage: steer,
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
