/** Reading a saved listing page the way the extension reads a live one.
 *
 *  Shared rather than copied because two harnesses now need it and they must agree: `check:extractor`
 *  reports what the panel would show, and `smoke` needs the same listing's postcode and stations so
 *  it can pre-cache the travel this listing will ask for. A second brace-matcher that drifted from
 *  this one would make the smoke harness cache journeys for a postcode the panel never asks about,
 *  and the symptom would be the panel hanging on "Working…" with everything apparently seeded.
 */
import { readFileSync } from 'node:fs';
import { decodePageModel } from '../apps/extension/src/lib/decode';
import { toListing } from '../apps/extension/src/lib/extract';
// Relative, like `fixture-session.ts` reaching for `hubs`: these tools run under plain tsx and do
// not resolve the workspace's package names.
import type { Listing } from '../packages/core/src/types';

/** Pull the `window.__PAGE_MODEL = {...}` object out of the HTML by brace matching.
 *
 *  Brace matching rather than a regex because the blob contains braces inside strings, and rather
 *  than a DOM parse because there is no DOM here and the whole point is to avoid needing one. */
export function readPageModel(html: string): unknown {
  const marker = /window\.__PAGE_MODEL\s*=\s*\{/.exec(html);
  if (!marker) throw new Error('no window.__PAGE_MODEL in this HTML');

  const start = marker.index + marker[0].length - 1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < html.length; i++) {
    const c = html[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return JSON.parse(html.slice(start, i + 1));
  }
  throw new Error('unbalanced braces in __PAGE_MODEL');
}

/** The decoded listing, from the same two functions the content script uses. */
export function listingFromHtml(path: string, url = `file://${path}`): Listing {
  return toListing(decodePageModel(readPageModel(readFileSync(path, 'utf8'))), url);
}
