import { useState } from 'react';
import { Hint } from './Hint';
import { agoLabel } from './ratings';
import './stage.css';
import {
  ARCHIVE_REASONS,
  STAGES,
  stageSentence,
  type ArchiveReason,
  type PropertyStage,
  type Stage,
} from '@house-hunt/core';

/** Where a place has got to, and who moved it there. The funnel's answer to `VerdictLine`, and
 *  rendered here for the same reason: the panel on Rightmove and the shortlist card both show it,
 *  and a fact worded twice is a fact that drifts. */
export function StageLine({ stage }: { stage: PropertyStage | null }) {
  if (!stage) {
    return (
      <div className="rm-stage-line rm-stage-none" data-testid="stage-none">
        Not in the funnel
      </div>
    );
  }

  const when = agoLabel(stage.updatedAt);
  return (
    <Hint
      as="div"
      className="rm-stage-line"
      underline={false}
      text={`${stageSentence(stage)} — moved by ${stage.person}${stage.note.trim() ? `. "${stage.note.trim()}"` : ''}. Where a place has got to, kept apart from what you think of it.`}
    >
      <span className={`rm-stage-now rm-stage-${stage.stage}`} data-testid="stage-now">
        {stageSentence(stage)}
      </span>
      <span className="rm-stage-by" data-testid="stage-by">
        {when ? `${stage.person}, ${when}` : stage.person}
      </span>
    </Hint>
  );
}

/** The funnel as a row of steps, wherever a place is moved along it.
 *
 *  Archiving is the one step that asks a question back, because "archived" on its own answers
 *  nothing a month later: whether a flat went because somebody outbid you or because you walked
 *  away is the difference between a near miss and something you have learned about your own taste.
 *  So it opens the reasons rather than writing immediately, and nothing is saved until one is
 *  picked. Every other step is one click.
 *
 *  What this control never touches is the rating. A place you loved and lost stays loved — that is
 *  the verdict the score is fitted on, and archiving is not a change of mind. */
export function StagePicker({
  stage,
  pending,
  onSet,
  disabled,
}: {
  stage: PropertyStage | null;
  /** The step clicked but not yet acknowledged by the database, drawn as pressed with a stripe —
   *  the same bargain the rating buttons make. */
  pending?: Stage | null;
  onSet: (stage: Stage, archiveReason: ArchiveReason | null) => void;
  /** A sentence saying *why* the funnel is unavailable, or undefined when it is available. Never a
   *  bare boolean: a dead control with no explanation is the fail-loudly rule inverted. */
  disabled?: string;
}) {
  const [archiving, setArchiving] = useState(false);
  const current = stage?.stage ?? null;

  return (
    <div className="rm-stage" data-testid="stage-picker">
      <div className="rm-stage-steps">
        {STAGES.map((step) => {
          const on = current === step.value;
          const isArchive = step.value === 'archived';
          return (
            <Hint key={step.value} underline={false} text={disabled ?? step.hint}>
              <button
                className={[
                  'rm-step',
                  on ? 'rm-step-on' : '',
                  pending === step.value ? 'rm-step-pending' : '',
                  isArchive ? 'rm-step-archive' : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
                disabled={Boolean(disabled)}
                aria-expanded={isArchive ? archiving : undefined}
                data-testid={`stage-${step.value}`}
                onClick={() => {
                  if (isArchive) setArchiving((open) => !open);
                  else {
                    setArchiving(false);
                    onSet(step.value, null);
                  }
                }}
              >
                {step.label}
                {isArchive && '…'}
              </button>
            </Hint>
          );
        })}
      </div>

      {archiving && (
        <div className="rm-stage-reasons" data-testid="stage-reasons">
          {ARCHIVE_REASONS.map((reason) => (
            <button
              key={reason.value}
              className={
                stage?.archiveReason === reason.value ? 'rm-reason rm-reason-on' : 'rm-reason'
              }
              data-testid={`archive-${reason.value}`}
              onClick={() => {
                setArchiving(false);
                onSet('archived', reason.value);
              }}
            >
              {reason.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
