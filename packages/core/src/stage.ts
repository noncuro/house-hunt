/** How far a place has got, as opposed to how much you like it.
 *
 *  These are two independent facts about one flat and the whole point of this file is that they stay
 *  that way. A verdict is taste ("like it" / "love it" / "not our place") and it is what the
 *  verdict-score model learns from; a stage is progress through the funnel. A flat you loved, made
 *  an offer on and lost is still a flat you loved — its stage becomes `archived`, its rating does
 *  not move, and the model keeps learning the right thing from it. Folding the two into one status
 *  would teach the model that you dislike precisely the places you liked most.
 *
 *  The one coupling runs in a single direction and lives in the database (`enter_funnel`, in
 *  `20260813000000_property_stage.sql`): liking or loving a place puts it in the funnel at
 *  `shortlisted`. Nothing here re-implements that — a stage is read, never inferred.
 */

export type Stage = 'shortlisted' | 'enquired' | 'viewing_booked' | 'viewed' | 'offer_made' | 'archived';

/** In funnel order, which is also the order every control here draws them in. `archived` is last
 *  and is the only one you can be in without having passed through the others. */
export const STAGES: Array<{ value: Stage; label: string; hint: string }> = [
  {
    value: 'shortlisted',
    label: 'Shortlisted',
    hint: 'In the running, and nobody has done anything about it yet.',
  },
  { value: 'enquired', label: 'Reached out', hint: 'We have asked the agent about it.' },
  { value: 'viewing_booked', label: 'Viewing booked', hint: 'A viewing is in the diary.' },
  { value: 'viewed', label: 'Viewed', hint: 'We have been round it.' },
  { value: 'offer_made', label: 'Offer in', hint: 'An offer is in, or being negotiated.' },
  { value: 'archived', label: 'Archived', hint: 'Out of the running, for a reason worth recording.' },
];

/** The funnel a flat can still be moving through — every step except the one that means it has
 *  stopped. Latest first, which is the order a hunt is actually read in: an offer in is the thing
 *  you want to see before the fourteen places nobody has rung about yet.
 *
 *  Derived from `STAGES` rather than written out again, so a new step joins both orders at once. */
export const FUNNEL_LATEST_FIRST: Stage[] = STAGES.filter((s) => s.value !== 'archived')
  .map((s) => s.value)
  .reverse();

/** Where an archived flat went. Deliberately a small closed set rather than free text: "gone" and
 *  "we passed" are the two that mean opposite things about your taste, and a funnel that cannot
 *  tell them apart cannot answer the only question anybody asks it a month later. The note beside
 *  it carries the particulars. */
export type ArchiveReason = 'offer_rejected' | 'gone' | 'passed' | 'other';

export const ARCHIVE_REASONS: Array<{ value: ArchiveReason; label: string }> = [
  { value: 'offer_rejected', label: 'Our offer was rejected' },
  { value: 'gone', label: 'Gone — taken by someone else' },
  { value: 'passed', label: 'We passed on it' },
  { value: 'other', label: 'Something else' },
];

/** The stage a like or a love enters a flat at. Mirrors `enter_funnel`'s insert so a view can say
 *  what a rating is about to do; it never writes the row itself. */
export const FIRST_STAGE: Stage = 'shortlisted';

/** One project's position on one property. `person` is who last moved it, on the same reasoning as
 *  a verdict's author: a shared record that nobody signed turns one person overruling another into
 *  a silent change. */
export interface PropertyStage {
  rightmoveId: string;
  stage: Stage;
  /** Set exactly when `stage` is `archived`, and null otherwise — the database enforces both
   *  halves, so a view can read one to know the other. */
  archiveReason: ArchiveReason | null;
  note: string;
  person: string;
  updatedAt: string;
}

const STAGE_BY_VALUE = new Map(STAGES.map((s) => [s.value, s]));
const REASON_BY_VALUE = new Map(ARCHIVE_REASONS.map((r) => [r.value, r]));

/** The full description of a stage. Falls back rather than returning undefined, for the same
 *  reason `ratingOf` does: a value the database holds and this build has not heard of should read
 *  as itself rather than as a blank. */
export function stageMeta(stage: Stage): { value: Stage; label: string; hint: string } {
  return STAGE_BY_VALUE.get(stage) ?? { value: stage, label: String(stage), hint: '' };
}

export function archiveMeta(reason: ArchiveReason): { value: ArchiveReason; label: string } {
  return REASON_BY_VALUE.get(reason) ?? { value: reason, label: String(reason) };
}

/** How far down the funnel a stage sits. The compare table sorts on this, which is what makes
 *  "show me everything past a viewing" a sort rather than four filters. */
export function stageRank(stage: Stage): number {
  const at = STAGES.findIndex((s) => s.value === stage);
  // An unknown stage sorts after everything known rather than before it: a row this build cannot
  // place must not push the flats it can place down the table.
  return at === -1 ? STAGES.length : at;
}

/** What a stage says on one line — "Viewing booked", "Archived — our offer was rejected". */
export function stageSentence(stage: PropertyStage): string {
  const label = stageMeta(stage.stage).label;
  return stage.archiveReason ? `${label} — ${archiveMeta(stage.archiveReason).label.toLowerCase()}` : label;
}

/** Which slice of the funnel a view is showing. `none` is the pile outside it — everything nobody
 *  has liked yet, which on a fresh sweep is most of the shortlist. `live` is the opposite end of
 *  the same question: everything that is in the funnel and has not stopped moving through it.
 *
 *  `live` exists because the single-step filters could not answer "what is on". Each of them is an
 *  exact match, so a flat you rang about left `shortlisted` the moment you rang — and the screen
 *  that opens on `shortlisted` hid it. The further a place got, the less likely you were to see it,
 *  which is precisely backwards. */
export type StageFilter = 'all' | 'live' | 'none' | Stage;

export const STAGE_FILTERS: StageFilter[] = ['all', 'live', ...STAGES.map((s) => s.value), 'none'];

export const FILTER_LABEL: Record<StageFilter, string> = {
  all: 'Everything',
  live: 'In play',
  none: 'Not in the funnel',
  ...(Object.fromEntries(STAGES.map((s) => [s.value, s.label])) as Record<Stage, string>),
};

export function matchesStage(stage: PropertyStage | null, filter: StageFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'none') return stage === null;
  // In the funnel and not finished with. Archived is the one step that means it has stopped, and it
  // is deliberately not "everything with a stage": a flat you lost is in the funnel for good, and a
  // list of what is on cannot be a list that grows forever.
  if (filter === 'live') return stage !== null && stage.stage !== 'archived';
  return stage?.stage === filter;
}

export type FunnelCounts = Record<StageFilter, number>;

/** How many places sit at each step, for the bar you filter the shortlist with. Every step is
 *  counted, including the empty ones: a funnel that hides its zeroes is a funnel that reads as
 *  though it has no viewings stage rather than no viewings. */
export function funnelCounts(entries: Array<{ stage: PropertyStage | null }>): FunnelCounts {
  const counts = Object.fromEntries(STAGE_FILTERS.map((f) => [f, 0])) as FunnelCounts;
  for (const entry of entries) {
    counts.all += 1;
    if (entry.stage) counts[entry.stage.stage] += 1;
    else counts.none += 1;
    // Through `matchesStage` rather than repeating the rule, so the chip's number and the list it
    // produces cannot come apart — a count that promised flats the filter then withheld is the
    // failure this whole file is arranged to avoid.
    if (matchesStage(entry.stage, 'live')) counts.live += 1;
  }
  return counts;
}
