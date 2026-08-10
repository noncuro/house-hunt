import { attribution, attributionDetail, ratingOf } from '@house-hunt/ui';
import { findCards, onPageChange } from '@/lib/cards';
import { send } from '@/lib/messages';
import type { Verdict } from '@house-hunt/core';
import './style.css';

/** Marks search-result cards with the verdict already recorded, so you stop reopening listings
 *  one of you has rejected, and offers a button to open each in the panel.
 *
 *  One badge per card, not one per person: a project holds a single rating for a property
 *  (design D6). The badge names the rating and who set it, because a shared verdict whose author
 *  is invisible turns one of you overruling the other into a silent overwrite.
 *
 *  Property ids come from each card's own link rather than from __NEXT_DATA__: the link survives
 *  soft SPA navigation, where a one-shot read of the page data does not. */
export default defineContentScript({
  matches: [
    'https://www.rightmove.co.uk/property-to-rent/*',
    // Saved-property lists (/user/lists/<uuid>) are the same card shape, and are exactly where
    // you want to see what the two of you already said.
    'https://www.rightmove.co.uk/user/lists/*',
    'https://www.rightmove.co.uk/user/saved*',
  ],
  cssInjectionMode: 'manifest',

  async main() {
    // Nothing at all when nobody is signed in, and nothing when no project is chosen (design
    // D13). This is the one surface where silence is right: a dimmed card asserts a verdict, and
    // a verdict implies a project. Marking cards from no project would be an opinion nobody held.
    const auth = await send({ type: 'auth:state' });
    if (!auth.ok || auth.data.status !== 'signed-in' || !auth.data.activeProject) return;

    /** id -> the project's verdict, or null for "asked, and there isn't one". Distinct from an
     *  absent key, which means never asked. */
    const known = new Map<string, Verdict | null>();

    async function pass(): Promise<void> {
      const cards = findCards();
      const unknown = [...cards.keys()].filter((id) => !known.has(id));
      if (unknown.length > 0) {
        const result = await send({ type: 'verdicts:get', rightmoveIds: unknown });
        if (!result.ok) return; // stay quiet here; the panel is where errors get shown
        for (const id of unknown) known.set(id, result.data.find((v) => v.rightmoveId === id) ?? null);
      }
      for (const [id, card] of cards) decorate(card, id, known.get(id) ?? null);
    }

    void pass();
    onPageChange(() => void pass());
  },
});

function decorate(card: HTMLElement, rightmoveId: string, verdict: Verdict | null): void {
  // Includes the timestamp so a re-rating by the other laptop repaints, and nothing else does.
  const key = verdict ? `${verdict.rating}:${verdict.person}:${verdict.updatedAt}` : '';
  if (card.dataset.rmKey === key) return; // already correct — don't rebuild on every mutation
  card.dataset.rmKey = key;

  card.classList.add('rm-verdict');
  // "Not our place" dims the card; the point is to stop reopening it.
  card.classList.toggle('rm-verdict-no', verdict?.rating === 'no');
  card.classList.toggle('rm-verdict-love', verdict?.rating === 'love');

  let bar = card.querySelector<HTMLElement>(':scope > .rm-verdict-bar');
  if (!bar) {
    bar = document.createElement('div');
    bar.className = 'rm-verdict-bar';
    card.prepend(bar);
  }
  bar.replaceChildren();

  // Read-only: changing your mind happens in the panel, where the note lives too.
  if (verdict) {
    const meta = ratingOf(verdict.rating);
    const pill = document.createElement('span');
    pill.className = `rm-pill rm-pill-${verdict.rating}`;
    // Rating first, then who: the rating is what you scan for, and the author is what stops the
    // scan from hiding a disagreement.
    pill.textContent = `${meta.emoji} ${meta.word} · ${attribution(verdict)}`;
    pill.title = attributionDetail(verdict);
    bar.append(pill);
  }

  const open = document.createElement('button');
  open.className = 'rm-pill rm-pill-open';
  open.type = 'button';
  open.textContent = verdict ? 'Open panel' : 'Rate this';
  open.title = 'Open this listing so the panel can read it';
  open.addEventListener('click', (event) => {
    // The card is itself a link; without this the click just navigates.
    event.preventDefault();
    event.stopPropagation();
    // A listing we have never opened has no stored data and no photo analysis, and the only way
    // to get them is for the page to be loaded so the content script can read __PAGE_MODEL. We
    // open it in a foreground tab rather than fetching it in the background: fetching pages
    // nobody asked for is the crawling behaviour this extension deliberately avoids.
    window.open(`https://www.rightmove.co.uk/properties/${rightmoveId}`, '_blank', 'noopener');
  });
  bar.append(open);
}
