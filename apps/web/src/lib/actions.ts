import type { ArchiveReason, Rating, Stage } from '@house-hunt/core';
import type { ShortlistEntry } from '@house-hunt/core/db';

/** The writes a screen can ask for, named once.
 *
 *  Four screens move a flat through the funnel — the board by dragging it, the table by a select in
 *  the row, the detail pane by its picker, triage by a keystroke — and every one of them was
 *  declaring its own callback type. They drifted: one took the stage alone and archived without a
 *  reason, which the database then rejected on a code path nobody had exercised. */
export type SetStage = (
  entry: ShortlistEntry,
  stage: Stage,
  /** Required exactly when the stage is `archived`, null otherwise — the same pairing the column
   *  constraint enforces, so a caller that gets it wrong fails here rather than at the database. */
  archiveReason: ArchiveReason | null,
) => void;

export type SetVerdict = (entry: ShortlistEntry, rating: Rating, note: string) => void;

export type SetOffMarket = (entry: ShortlistEntry, off: boolean) => void;
