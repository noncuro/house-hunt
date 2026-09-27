import { siteById } from '@house-hunt/core';
import type { PossibleDuplicate } from '@house-hunt/core';

/** "This may be the same flat as…", under the address.
 *
 *  Reading eight agents' own websites as well as Rightmove means one flat can arrive twice — the
 *  agent's page and the portal listing are one CRM record rendered by two systems, and neither
 *  names the other. The cost is not the second card; it is that a verdict written on one does not
 *  show on the other, and a shared verdict is what this app is for.
 *
 *  It says so and does nothing else. Merging would need `possibleDuplicates` to be right every
 *  time, and two flats in one block share a postcode, a bed count and often a rent — so the wrong
 *  merge attaches somebody's verdict to a flat they never saw. A line and a link leaves the
 *  judgement with the person who can open both. */
export function Duplicates({
  duplicates,
  onOpen,
}: {
  duplicates: PossibleDuplicate[];
  /** Opens the other flat in the panel, where the reader can compare the two and decide. Absent on
   *  a surface with no panel to open, where the note is still worth saying. */
  onOpen?: (rightmoveId: string) => void;
}) {
  if (duplicates.length === 0) return null;

  return (
    <p className="detail-duplicates dim" data-testid="possible-duplicates">
      {duplicates.length === 1 ? 'This may be the same flat as' : 'This may be the same flat as one of'}{' '}
      {duplicates.map((d, i) => (
        <span key={d.rightmoveId}>
          {i > 0 && ', '}
          {onOpen ? (
            <button type="button" className="linklike" onClick={() => onOpen(d.rightmoveId)}>
              {label(d)}
            </button>
          ) : (
            label(d)
          )}
          {/* Why, on the element itself rather than in the sentence: the reason is the same for
              every candidate in the list and repeating it would be longer than the list. */}
          <span className="dim"> ({d.why})</span>
        </span>
      ))}
      .
    </p>
  );
}

/** The other flat, named by where it came from. The site matters more than the address here — the
 *  address is why these are beside each other, so repeating it says nothing, while "on Foxtons" is
 *  the whole reason there are two. */
function label(duplicate: PossibleDuplicate): string {
  const site = siteById(duplicate.site);
  return `${duplicate.displayAddress} on ${site?.name ?? duplicate.site}`;
}
