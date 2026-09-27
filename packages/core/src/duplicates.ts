import { parseMonthlyPrice } from './facts';
import type { SiteId } from './sites/types';

/** "This may be the same flat as that one."
 *
 *  Once the app reads eight agents' own websites as well as Rightmove, one flat can arrive twice:
 *  the agent's page and the portal listing are one CRM record rendered by two systems, and nothing
 *  in either names the other. Two rows, two analyses, and a verdict on one that the other does not
 *  show — which is the part that matters, because a shared verdict is the thing this app exists to
 *  get right.
 *
 *  **It notices and says so, and it never merges.** Merging would need this to be right every time,
 *  and it cannot be: two flats in one block share a postcode and a bedroom count, and the same
 *  building lets several at once. The consequence of a wrong merge is a verdict attached to a flat
 *  nobody wrote it about, which is worse than the duplicate it tidied. So the output is a sentence
 *  beside a flat, and a person decides.
 *
 *  It is also the mitigation for the two sites whose key is a URL slug rather than an id — Austin
 *  Homes and TK International name no id in their URLs, so an agent retitling a listing mints a
 *  second key for a flat already here. That arrives as a same-site duplicate with the same postcode
 *  and the same price, which is the loudest thing on this list.
 */
export interface PossibleDuplicate {
  rightmoveId: string;
  site: SiteId;
  displayAddress: string;
  /** Why these two are being put beside each other, in the words the interface shows. */
  why: string;
  /** How much the same they look. Only used to order the list — the highest is shown first, and
   *  nothing acts on the number. */
  strength: number;
}

/** What this needs to know about a flat. A subset of `ShortlistEntry`, so both the shortlist and a
 *  freshly-read `Listing` can be offered to it without either being converted first. */
export interface Comparable {
  rightmoveId: string;
  site: SiteId;
  displayAddress: string;
  postcode: string | null;
  bedrooms: number | null;
  price: string | null;
}

/** A full postcode is roughly fifteen addresses, and for a block of flats it is one building — so
 *  it is a strong signal and not a conclusive one, which is exactly why this advises. Anything
 *  weaker than a full postcode is not used at all: an outcode is thousands of homes, and matching
 *  on one would put a sentence under half the list. */
function samePostcode(a: Comparable, b: Comparable): boolean {
  return a.postcode !== null && b.postcode !== null && a.postcode === b.postcode;
}

/** Two counts that cannot both be right about one flat. A null on either side is not a mismatch —
 *  it is a site that did not say, which is common enough that treating it as a difference would
 *  silence the note on exactly the listings that are hardest to tell apart by hand. */
function contradictoryBedrooms(a: Comparable, b: Comparable): boolean {
  return a.bedrooms !== null && b.bedrooms !== null && a.bedrooms !== b.bedrooms;
}

/** Within a twentieth of each other. Two renderings of one CRM record usually agree to the pound,
 *  and where they do not it is because one quotes per week and the other per calendar month — which
 *  `parseMonthlyPrice` has already reconciled — or because the agent moved the rent on one system
 *  first. Five per cent covers the second without reaching the flat upstairs at a different rent. */
const PRICE_TOLERANCE = 0.05;

function priceAgrees(a: Comparable, b: Comparable): boolean | null {
  const one = parseMonthlyPrice(a.price);
  const two = parseMonthlyPrice(b.price);
  if (one === null || two === null) return null;
  return Math.abs(one - two) <= Math.max(one, two) * PRICE_TOLERANCE;
}

/** Everything in `others` that might be `entry` again, strongest first.
 *
 *  Ordered rather than filtered to one: a block where three flats share a postcode should show all
 *  three, because the reader is the one who can tell which is theirs. */
export function possibleDuplicates(entry: Comparable, others: readonly Comparable[]): PossibleDuplicate[] {
  const found: PossibleDuplicate[] = [];
  for (const other of others) {
    if (other.rightmoveId === entry.rightmoveId) continue;
    if (!samePostcode(entry, other)) continue;
    if (contradictoryBedrooms(entry, other)) continue;

    const agrees = priceAgrees(entry, other);
    // A price that disagrees beyond the tolerance is the one thing that takes a candidate off the
    // list. Two flats at one postcode with the same bed count and rents £900 apart are two flats.
    if (agrees === false) continue;

    const sameSite = other.site === entry.site;
    found.push({
      rightmoveId: other.rightmoveId,
      site: other.site,
      displayAddress: other.displayAddress,
      why: describe(entry, other, agrees, sameSite),
      // Three signals, weighted by how much each narrows the field. The postcode is the entry fee
      // and scores nothing; agreeing on price is the strongest of the rest, and coming from a
      // different site is what makes "one flat, two listings" the likely explanation rather than
      // "two flats, one building".
      strength: (agrees ? 3 : 0) + (sameSite ? 0 : 2) + (entry.bedrooms !== null && other.bedrooms !== null ? 1 : 0),
    });
  }
  return found.sort((a, b) => b.strength - a.strength || a.rightmoveId.localeCompare(b.rightmoveId));
}

/** The sentence shown beside the flat. Says what matched rather than how confident anything is —
 *  a percentage here would be a number nobody could check, and the reader can open both. */
function describe(entry: Comparable, other: Comparable, agrees: boolean | null, sameSite: boolean): string {
  const parts = [`same postcode (${entry.postcode})`];
  if (entry.bedrooms !== null && other.bedrooms !== null) parts.push(`${entry.bedrooms} bed`);
  if (agrees === true) parts.push('same rent');
  else if (agrees === null) parts.push('rent not comparable');
  // The same site twice is a different story to two sites once, and the likeliest cause of the
  // first is a listing that was retitled — which is worth saying, because the fix is different.
  return sameSite
    ? `${parts.join(', ')} — the same site twice, so one of these may be a re-listing`
    : parts.join(', ');
}
