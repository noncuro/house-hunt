import { availableFrom, councilTax, depositAmount, letLength } from '@house-hunt/core';
import type { ShortlistEntry } from '@house-hunt/core/db';

/** The tenancy's terms, as spans for the facts row.
 *
 *  A fragment rather than its own row: these belong beside the rent and the bed count, which are
 *  the other things a person weighs in the same glance, and giving them a line of their own would
 *  say they are a different kind of fact. Each is dropped when absent rather than rendered as a
 *  dash — roughly half of listings state no deposit and a third no council tax band, so a row of
 *  dashes would be the common case and would read as data we failed to fetch.
 *
 *  Deliberately not in the extension panel. Rightmove's own listing page already prints all four in
 *  its letting-details box, so the panel would be repeating the page it is sitting on; what the
 *  panel is for is the half Rightmove does not say. */
export function TermFacts({ entry }: { entry: ShortlistEntry }) {
  const terms = [
    availableFrom(entry.letAvailableDate),
    depositAmount(entry.deposit),
    councilTax(entry.councilTaxBand),
    letLength(entry.letType),
  ].filter((t): t is string => t !== null);

  return (
    <>
      {terms.map((term) => (
        <span key={term}>{term}</span>
      ))}
    </>
  );
}

/** Who is marketing the flat, and their number.
 *
 *  On the website rather than the panel for the opposite reason to the terms above: on Rightmove
 *  the agent is the most prominent thing on the page, and here the flat has been lifted out of that
 *  page entirely — a shortlist row otherwise gives no way to tell whether the six flats you are
 *  comparing come from six agents or one.
 *
 *  The number is a `tel:` link because reaching out is a stage in the funnel, and this is the only
 *  field on the flat anybody acts on rather than reads. */
export function AgentLine({ entry }: { entry: ShortlistEntry }) {
  const who = entry.agentBranch ?? entry.agentCompany;
  if (!who && !entry.agentPhone) return null;

  return (
    <p className="detail-agent">
      {who && <span>Marketed by {who}</span>}
      {entry.agentPhone && (
        <a href={`tel:${entry.agentPhone.replace(/\s+/g, '')}`} className="detail-agent-phone">
          {entry.agentPhone}
        </a>
      )}
    </p>
  );
}
