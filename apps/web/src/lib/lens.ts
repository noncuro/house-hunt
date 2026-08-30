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

/** Where Places opens: everything in the funnel that is still moving through it.
 *
 *  It opened on `shortlisted` before, which is a single step and an exact match — so the screen
 *  showed the flats nobody had done anything about yet, and dropped each one at the moment somebody
 *  did. Ring the agent and it left the view; book a viewing and it stayed gone. The places furthest
 *  along, which are the ones with something at stake, were the hardest to find, and the only way
 *  back to them was to know which step to click.
 *
 *  This is still the working set the shortlist default was reaching for — it is not the whole hunt,
 *  which on a swept project is hundreds of listings nobody has opened. It is the same idea with the
 *  bug taken out: liking a place puts it in the funnel, and it stays on this screen until it is
 *  archived or gone. */
export const DEFAULT_LENS: Lens = { kind: 'stage', stage: 'live' };

/** How the cards pile themselves up under a lens.
 *
 *  Two questions, and which one the screen is answering depends on what it is showing. Under the
 *  funnel lens the piles are the steps, newest-first, because "how far has this got" is the whole
 *  reason those flats are on screen together. Anywhere else the piles are the verdicts, which is
 *  the question the cards were always grouped by. Under a verdict lens there is nothing to group:
 *  a single heading over everything says less than no heading at all. */
export type Grouping = 'stage' | 'verdict' | null;

export function groupingFor(lens: Lens): Grouping {
  if (lens.kind === 'group') return null;
  return lens.kind === 'stage' && lens.stage === 'live' ? 'stage' : 'verdict';
}

/** The board draws the funnel as columns, so a stage lens would leave it one populated column and
 *  five empty ones — there the filter and the layout are the same fact. A verdict lens is a
 *  different question and still applies. */
export function forBoard(lens: Lens): Lens {
  return lens.kind === 'stage' ? EVERYTHING : lens;
}

/** Whether a flat belongs on screen under this lens.
 *
 *  Off the market is folded in here rather than filtered separately. It is not a stage — nobody
 *  writes it to mean progress — but it is the one thing people record to mean "this one is gone",
 *  and gone is what Archived is for. So a flat that is off the market is drawn under Archived
 *  whatever its stage says, and nowhere else. It still writes nothing: the verdict and the stage
 *  are untouched, which is what keeps a flat you loved and lost readable as loved.
 *
 *  A null set has not loaded, which is not the same as empty. Hiding on a fact we do not have yet
 *  would blank flats for the first frame of every load and, after a failed read, show a shortlist
 *  quietly missing things — so not knowing draws them where they would otherwise be. */
export function lensMatches(
  entry: ShortlistEntry,
  lens: Lens,
  offMarket: ReadonlySet<string> | null,
): boolean {
  const gone = offMarket?.has(entry.rightmoveId) ?? false;
  if (lens.kind === 'stage' && lens.stage === 'archived') {
    return gone || matchesStage(entry.stage, 'archived');
  }
  if (gone) return false;
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
 *  The funnel in funnel order, then the two verdicts worth jumping straight to. `archived` and "not
 *  in the funnel" are held back for the quiet row at the right: one is done with and the other is a
 *  negation, and a negation sitting in a line of positive stages is read as a stage. That was the
 *  audit's point about "Not in the funnel 441" — it is the biggest number on the row and the least
 *  interesting thing on the screen.
 *
 *  There is no "Everything" chip. The screen always shows one slice, because a hunt's whole list is
 *  every listing anybody has ever opened and that is not a view of anything.
 *
 *  Every chip is drawn even at zero. A funnel that hides its empty steps reads as a hunt with no
 *  "viewed" step rather than one with nothing viewed yet, and the shape of what is left to do is the
 *  reason to look at it at all. The count dims; the chip does not.
 *
 *  The counts agree with what clicking the chip produces, which means the off-the-market ones are
 *  counted under Archived and nowhere else. A count taken over the raw list would have every other
 *  chip promising flats it will not then draw. */
export function chipsFor(
  entries: ShortlistEntry[],
  offMarket: ReadonlySet<string> | null,
): { main: Chip[]; aside: Chip[] } {
  const gone = entries.filter((e) => offMarket?.has(e.rightmoveId) ?? false);
  // Still listed, which is a different question from `funnel.live` below — that one is about the
  // stage somebody set, this one about whether the flat is still on the market at all.
  const onMarket = entries.filter((e) => !(offMarket?.has(e.rightmoveId) ?? false));
  const funnel: FunnelCounts = funnelCounts(onMarket);
  const groups: Record<Group, number> = { excited: 0, maybe: 0, rejected: 0, unrated: 0 };
  for (const entry of onMarket) groups[groupOf(entry.verdicts)] += 1;

  const main: Chip[] = [
    // First, and pressed when the screen opens. It is the union of the steps after it rather than a
    // seventh step, so it sits at the head of the row the way a total does.
    { lens: { kind: 'stage', stage: 'live' }, label: FILTER_LABEL.live, count: funnel.live },
    ...STAGES.filter((s) => s.value !== 'archived').map((s) => ({
      lens: { kind: 'stage', stage: s.value } as Lens,
      label: s.label,
      count: funnel[s.value],
    })),
    { lens: { kind: 'group', group: 'excited' }, label: GROUP_LABEL.excited, count: groups.excited },
    { lens: { kind: 'group', group: 'maybe' }, label: GROUP_LABEL.maybe, count: groups.maybe },
  ];

  const aside: Chip[] = [
    {
      lens: { kind: 'stage', stage: 'archived' },
      label: FILTER_LABEL.archived,
      count: funnel.archived + gone.length,
    },
    { lens: { kind: 'stage', stage: 'none' }, label: FILTER_LABEL.none, count: funnel.none },
  ];

  return { main, aside };
}
