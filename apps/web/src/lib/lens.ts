'use client';

import {
  FILTER_LABEL,
  GROUP_LABEL,
  funnelCounts,
  groupOf,
  matchesStage,
  STAGES,
  type FunnelCounts,
  type Group,
  type StageFilter,
} from '@house-hunt/core';
import type { ShortlistEntry } from '@house-hunt/core/db';

/** What Places is narrowed to — one chip row over two kinds of fact.
 *
 *  There were two rows of these, and they were the same shape and different things: a funnel bar
 *  filtering by stage, and a legend on the map (and a pair of include-switches on the compare table)
 *  filtering by verdict. Above both of them sat an inert line of the same four numbers that looked
 *  exactly like chips and could not be clicked. Three renderings of "which flats am I looking at",
 *  and only two of them did anything.
 *
 *  One row now, and one value. They are genuinely alternatives rather than two dimensions to combine:
 *  "the ones we loved" and "the ones with a viewing booked" are each a complete answer to what you
 *  want on screen, and stacking them produced empty screens with two controls to work out which had
 *  emptied it. Everything, or one stage, or one verdict. */
export type Lens =
  | { kind: 'all' }
  | { kind: 'stage'; stage: StageFilter }
  | { kind: 'group'; group: Group };

export const EVERYTHING: Lens = { kind: 'all' };

export function lensMatches(entry: ShortlistEntry, lens: Lens): boolean {
  if (lens.kind === 'all') return true;
  if (lens.kind === 'stage') return matchesStage(entry.stage, lens.stage);
  return groupOf(entry.verdicts) === lens.group;
}

export function sameLens(a: Lens, b: Lens): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'stage' && b.kind === 'stage') return a.stage === b.stage;
  if (a.kind === 'group' && b.kind === 'group') return a.group === b.group;
  return true;
}

export function lensLabel(lens: Lens): string {
  if (lens.kind === 'all') return FILTER_LABEL.all;
  if (lens.kind === 'stage') return FILTER_LABEL[lens.stage];
  return GROUP_LABEL[lens.group];
}

export interface Chip {
  lens: Lens;
  label: string;
  count: number;
}

/** Which chips the toolbar draws, and in what order.
 *
 *  Everything first, then the funnel in funnel order, then the two verdicts worth jumping straight
 *  to. `archived` and "not in the funnel" are held back for the quiet row at the right: one is done
 *  with and the other is a negation, and a negation sitting in a line of positive stages is read as
 *  a stage. That was the audit's point about "Not in the funnel 441" — it is the biggest number on
 *  the row and the least interesting thing on the screen.
 *
 *  Every chip is drawn even at zero. A funnel that hides its empty steps reads as a hunt with no
 *  "viewed" step rather than one with nothing viewed yet, and the shape of what is left to do is the
 *  reason to look at it at all. The count dims; the chip does not. */
export function chipsFor(entries: ShortlistEntry[]): { main: Chip[]; aside: Chip[] } {
  const funnel: FunnelCounts = funnelCounts(entries);
  const groups: Record<Group, number> = { excited: 0, maybe: 0, rejected: 0, unrated: 0 };
  for (const entry of entries) groups[groupOf(entry.verdicts)] += 1;

  const main: Chip[] = [
    { lens: EVERYTHING, label: FILTER_LABEL.all, count: entries.length },
    ...STAGES.filter((s) => s.value !== 'archived').map((s) => ({
      lens: { kind: 'stage', stage: s.value } as Lens,
      label: s.label,
      count: funnel[s.value],
    })),
    { lens: { kind: 'group', group: 'excited' }, label: GROUP_LABEL.excited, count: groups.excited },
    { lens: { kind: 'group', group: 'maybe' }, label: GROUP_LABEL.maybe, count: groups.maybe },
  ];

  const aside: Chip[] = [
    { lens: { kind: 'stage', stage: 'archived' }, label: FILTER_LABEL.archived, count: funnel.archived },
    { lens: { kind: 'stage', stage: 'none' }, label: FILTER_LABEL.none, count: funnel.none },
  ];

  return { main, aside };
}
