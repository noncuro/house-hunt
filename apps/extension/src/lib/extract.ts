import { decodePageModel, toListing } from '@house-hunt/core';
import type { Listing } from '@house-hunt/core';

/** Read + decode the page global. MAIN world only — an isolated content script sees a
 *  different `window` and would always get undefined here.
 *
 *  All this file is now. The decode and the field-by-field read moved to
 *  `packages/core/src/listing.ts` when the website learned to add a flat from a pasted URL: the
 *  server reads the same page out of its HTML, and one page shape read two ways is a fork waiting
 *  to happen. What is left here is the half that genuinely cannot move — a `Window` to read the
 *  global off, which exists only where a content script is standing. */
export function extractFromPage(win: Window & typeof globalThis, url: string): Listing {
  const model = (win as unknown as Record<string, unknown>).__PAGE_MODEL;
  if (model === undefined) {
    throw new Error('window.__PAGE_MODEL not found — Rightmove may have renamed the page global');
  }
  return toListing(decodePageModel(model), url);
}
