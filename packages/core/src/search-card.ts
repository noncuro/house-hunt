/** One property as a Rightmove search-results page presents it.
 *
 *  The shape lives here and the parser that fills it lives in the extension: reading one off a
 *  page needs a Rightmove DOM, and storing one needs only the fields. `recordSightings` in the
 *  data layer takes these, so core has to know the shape without knowing the page.
 */
export interface SearchCard {
  rightmoveId: string;
  url: string;
  displayAddress: string;
  /** Rightmove's own formatting, "£4,800 pcm" — kept as text for the same reason `property.price`
   *  is text: the qualifier ("pcm", "pw") is part of the fact. */
  price: string | null;
  bedrooms: number | null;
  bathrooms: number | null;
  /** Rightmove's fuzzed pin. Good enough to tell which hub a card belongs to, and deliberately
   *  not used for anything finer — the postcode-derived point on the property row is the accurate
   *  one, and we do not have a postcode until the listing itself is opened. */
  latitude: number | null;
  longitude: number | null;
  /** When Rightmove first showed it, ISO. */
  firstVisibleAt: string | null;
  /** When it last changed, ISO — and **this, not `firstVisibleAt`, is what `maxDaysSinceAdded`
   *  filters on**. A saved Hampstead search with a 14-day window returned a flat first listed 27
   *  days earlier whose price had been cut 5 days before; every one of the 25 cards was inside
   *  the window by this date and only 24 were by the other. The filter means "added or changed
   *  since", which is worth knowing before trusting a sweep to have caught everything new. */
  listingUpdateAt: string | null;
  /** "new" or "price_reduced" on the page we checked. */
  listingUpdateReason: string | null;
  /** Their wording — "Added yesterday", "Reduced on 04/08/2026". Worth storing verbatim because
   *  "reduced" and "added" are different events and the date alone loses which one happened. */
  addedOrReduced: string | null;
}
