/** Reading a saved listing page the way the extension reads a live one.
 *
 *  Shared rather than copied because two harnesses now need it and they must agree: `check:extractor`
 *  reports what the panel would show, and `smoke` needs the same listing's postcode and stations so
 *  it can pre-cache the travel this listing will ask for. A second brace-matcher that drifted from
 *  this one would make the smoke harness cache journeys for a postcode the panel never asks about,
 *  and the symptom would be the panel hanging on "Working…" with everything apparently seeded.
 *
 *  The brace-matcher itself is no longer here — `packages/core/src/listing.ts` owns it, along with
 *  the decode and the field read, because the `listing` Edge Function does exactly this to a page it
 *  has just fetched. All that is left here is `readFileSync`, which is the one thing Deno-clean core
 *  cannot have.
 */
import { readFileSync } from 'node:fs';
// Relative, like `fixture-session.ts` reaching for `hubs`: these tools run under plain tsx and do
// not resolve the workspace's package names.
import { listingFromHtml as parse } from '../packages/core/src/listing';
import type { Listing } from '../packages/core/src/types';

/** The decoded listing, from the same function the server and the harnesses use. */
export function listingFromHtml(path: string, url = `file://${path}`): Listing {
  return parse(readFileSync(path, 'utf8'), url);
}
