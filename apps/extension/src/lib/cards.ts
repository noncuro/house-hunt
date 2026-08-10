/** Finding the property cards on a Rightmove list page.
 *
 *  Two content scripts now decorate the same cards — `search.content` badges them with verdicts,
 *  and `sweep.content` marks which ones are already in the database — and they must agree on what
 *  a card *is*. When this logic lived inside the verdict script, the sweep would have had to
 *  copy it, and the copy would have drifted the first time Rightmove changed a testid. */

/** Paid placements, which are not search results and must not be treated as any.
 *
 *  Rightmove puts a developer advert at the top of a results page — "FEATURED NEW HOME — BUILT FOR
 *  RENTERS" — and it links to a real listing, so it looked like a card to anything matching on
 *  `/properties/` links. It is not in `__NEXT_DATA__.searchResults.properties`, because it is not
 *  part of the search; and that mismatch is exactly what `staleAgainst` is built to notice. So on
 *  every Primrose Hill page, which carries one, the sweep panel announced that the page had moved
 *  on and refused to record a perfectly good freshly-loaded page. A warning that fires on a normal
 *  page stops being a warning.
 *
 *  It is also right to skip these for badging. A sponsored new-build is not something either of
 *  us went looking for, and putting our verdict on it implies it came out of our search. */
const ADVERT = '[data-testid="RDL-property-card"]';

/** Map property id -> the ONE element representing that card.
 *
 *  A card contains several links to the same listing (image, title, price), so keying by anchor
 *  produced a badge per anchor — the duplicate pills. We resolve to the card container and keep
 *  only the first, outermost match per id. */
export function findCards(root: Document = document): Map<string, HTMLElement> {
  const cards = new Map<string, HTMLElement>();
  // Map view renders at most one preview at a time; resolve its close button once per pass.
  const mapClose = root.querySelector('[data-testid="map-card-close-button"]');

  for (const anchor of root.querySelectorAll<HTMLAnchorElement>('a[href*="/properties/"]')) {
    const id = /\/properties\/(\d+)/.exec(anchor.getAttribute('href') ?? '')?.[1];
    if (!id || cards.has(id)) continue;
    if (anchor.closest(ADVERT)) continue;

    // Select on data-testid, never on the hashed CSS-module class names — those change on every
    // Rightmove deploy. Search results wrap each card in `propertyCard-vrt-<n>` around an inner
    // `propertyCard-<n>`, both numbered by position on the page rather than by property id (an
    // earlier comment here claimed the id, which a saved page from August disproves — so the
    // prefix match is doing real work and is not just defensive). Saved lists (/user/lists) use a
    // bare "property-card" on an <article>. Fall back to an ancestor big enough to hold a badge.
    const card =
      anchor.closest<HTMLElement>('[data-testid^="propertyCard"], [data-testid="property-card"]') ??
      mapPreviewCard(anchor, mapClose) ??
      anchor.closest<HTMLElement>('article, li') ??
      anchor;
    cards.set(id, card);
  }
  return cards;
}

/** The map view's pin preview has no testid and no article/li of its own — only hashed
 *  CSS-module classes, which we don't select on because they change every deploy. What it does
 *  have is a close button with a stable testid, so the card is the nearest ancestor of the link
 *  that contains that button. Without this the badge lands inside the bare <a>, which is an image
 *  link and lays out wrong. */
function mapPreviewCard(anchor: HTMLElement, close: Element | null): HTMLElement | null {
  if (!close) return null;
  let node: HTMLElement | null = anchor.parentElement;
  for (let depth = 0; depth < 10 && node; depth++) {
    if (node.contains(close)) return node;
    node = node.parentElement;
  }
  return null;
}

/** Re-run `fn` when the page mutates, at most once per `ms`.
 *
 *  Rightmove's pagination and filters re-render in place rather than reloading the document, so
 *  a single pass on load decorates cards that are gone a moment later. Both content scripts want
 *  the same treatment. */
export function onPageChange(fn: () => void, ms = 300): MutationObserver {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const observer = new MutationObserver(() => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(fn, ms);
  });
  observer.observe(document.body, { childList: true, subtree: true });
  return observer;
}
