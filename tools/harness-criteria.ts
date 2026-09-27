/** The Rightmove filters the harnesses search with.
 *
 *  A hunt's criteria are project data — there is no built-in band to fall back on any more (see
 *  `RENTAL_SEARCH`) — so a harness has to state its own, with the same standing as its use of
 *  `SEED_HUBS`: fine for a tool, never to be read by a surface.
 *
 *  One constant with two readers, and they have to be the same one. `fixture:search` builds the
 *  URL it saves a page from, and `fixture-session` seeds them onto the project the panel then reads
 *  back — so a second copy that drifted would give a saved page and a seeded project whose
 *  `criteriaFingerprint`s disagree, and the panel would report a hub it had just swept as never
 *  swept. Its own file rather than either of theirs, because `fixture-session` opens a Supabase
 *  connection when it is imported and `pnpm fixture:search` must not need Docker to save a page.
 */
import type { SweepCriteria } from '../packages/core/src/sweep';

export const HARNESS_CRITERIA: SweepCriteria = {
  minPrice: '4000',
  maxPrice: '6000',
  minBedrooms: '1',
  maxBedrooms: '3',
  radius: '1.0',
  _includeLetAgreed: 'on',
};
