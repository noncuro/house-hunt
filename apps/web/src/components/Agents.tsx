import { agentTally } from '@house-hunt/core';
import type { ShortlistEntry } from '@house-hunt/core/db';

/** Who is marketing the flats this hunt is looking at.
 *
 *  Collapsed, and under the flats rather than over them. It answers a question people ask a few
 *  times in a hunt and not on every visit — whether the pile is coming through one firm, and who to
 *  ring — so it earns a line, not a panel. Opening it is the whole interaction.
 *
 *  It counts what is on screen, so it narrows with the filter above it. That is the useful
 *  behaviour: "who are the agents for the flats we have actually shortlisted" is a different and
 *  better question than the same over everything the hunt has ever opened. */
export function Agents({ entries }: { entries: ShortlistEntry[] }) {
  const tally = agentTally(entries);
  if (tally.length === 0) return null;

  // Stated rather than left as a gap between two numbers that do not add up. These are listings
  // recorded before the agent was read off the page, not flats without an agent.
  const unread = entries.filter((e) => !e.agentCompany?.trim()).length;

  return (
    <details className="agents" data-testid="agent-tally">
      <summary>
        {tally.length === 1 ? '1 agent' : `${tally.length} agents`}
        {unread > 0 && <span className="dim"> · {unread} not read yet</span>}
      </summary>
      <ul className="agents-list">
        {tally.map((agent) => (
          <li key={agent.company}>
            <span className="agents-count">{agent.count}</span>
            <span className="agents-name">
              {agent.company}
              {agent.branches.length > 1 && (
                <span className="dim"> · {agent.branches.length} branches</span>
              )}
            </span>
            {agent.phone && (
              <a href={`tel:${agent.phone.replace(/\s+/g, '')}`} className="agents-phone">
                {agent.phone}
              </a>
            )}
          </li>
        ))}
      </ul>
    </details>
  );
}
