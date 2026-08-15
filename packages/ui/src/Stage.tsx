import { useState } from 'react';
import { Hint } from './Hint';
import { Icon } from './Icon';
import { agoLabel } from './ratings';
import './stage.css';
import {
  ARCHIVE_REASONS,
  STAGES,
  stageMeta,
  stageRank,
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

/** The funnel as a track, wherever a place is moved along it.
 *
 *  A stage is progress, not an opinion, and the track is what says so. It used to be a row of
 *  buttons identical to the rating buttons sitting directly above it, which put "Viewed" and
 *  "Love it" in the same typeface, the same box and the same dark fill — two facts the whole design
 *  is built on keeping apart, drawn as one control repeated twice. So the steps behind where you
 *  are now are a hairline, the step you are on is filled, the next one is outlined and inviting,
 *  and the rest are quiet: you can read how far along a flat is without reading a word.
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
        {STAGES.map((step) => (
          <Hint key={step.value} underline={false} text={disabled ?? step.hint}>
            <button
              className={stepClass(step.value, current, pending)}
              disabled={Boolean(disabled)}
              aria-expanded={step.value === 'archived' ? archiving : undefined}
              aria-current={current === step.value ? 'step' : undefined}
              data-testid={`stage-${step.value}`}
              onClick={() => {
                if (step.value === 'archived') setArchiving((open) => !open);
                else {
                  setArchiving(false);
                  onSet(step.value, null);
                }
              }}
            >
              {step.label}
              {step.value === 'archived' && '…'}
            </button>
          </Hint>
        ))}
      </div>

      {archiving && <ArchiveReasons stage={stage} onPick={(reason) => {
        setArchiving(false);
        onSet('archived', reason);
      }} />}
    </div>
  );
}

/** Which of the four positions on the track a step is in. Archived is deliberately outside the
 *  scale — it is the end of the road rather than the finish line, so it is never "done" and never
 *  "next". */
function stepClass(step: Stage, current: Stage | null, pending: Stage | null | undefined): string {
  const at = current === null ? -1 : stageRank(current);
  const mine = stageRank(step);
  const where =
    current === step
      ? 'now'
      : step === 'archived' || current === 'archived'
        ? 'aside'
        : mine < at
          ? 'done'
          : mine === at + 1
            ? 'next'
            : 'ahead';
  return ['rm-step', `rm-step-${where}`, pending === step ? 'rm-step-pending' : ''].filter(Boolean).join(' ');
}

/** The four reasons a flat leaves the funnel. Shared by both controls so the question is asked the
 *  same way in a panel and in a table cell. */
function ArchiveReasons({
  stage,
  onPick,
}: {
  stage: PropertyStage | null;
  onPick: (reason: ArchiveReason) => void;
}) {
  return (
    <div className="rm-stage-reasons" data-testid="stage-reasons">
      {ARCHIVE_REASONS.map((reason) => (
        <button
          key={reason.value}
          className={stage?.archiveReason === reason.value ? 'rm-reason rm-reason-on' : 'rm-reason'}
          data-testid={`archive-${reason.value}`}
          onClick={() => onPick(reason.value)}
        >
          {reason.label}
        </button>
      ))}
    </div>
  );
}

/** The same funnel, in a table cell.
 *
 *  A table row is one line high and holds nine columns; the six-step track does not fit in one and
 *  drawing it there would be the second renderer of a fact this file exists to have one of. So the
 *  cell shows where the flat is and opens the identical list on a click — the steps carry the same
 *  testids, and archiving asks the same question before it writes anything.
 *
 *  Shaped as a `<select>` rather than being one, because a native option list cannot draw the
 *  track's own progression and cannot ask a follow-up question before committing — and archiving
 *  without recording why is the one thing the funnel must not let you do quietly. */
export function StageSelect({
  stage,
  pending,
  onSet,
  disabled,
}: {
  stage: PropertyStage | null;
  pending?: Stage | null;
  onSet: (stage: Stage, archiveReason: ArchiveReason | null) => void;
  disabled?: string;
}) {
  const [open, setOpen] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const current = stage?.stage ?? null;
  const shown = pending ?? current;

  return (
    <div className="rm-stage-select" data-testid="stage-select">
      <Hint underline={false} text={disabled}>
        <button
          className={pending ? 'rm-stage-current rm-step-pending' : 'rm-stage-current'}
          disabled={Boolean(disabled)}
          aria-expanded={open}
          onClick={() => {
            setArchiving(false);
            setOpen((was) => !was);
          }}
        >
          <span className={shown ? `rm-stage-${shown}` : 'rm-stage-unset'}>
            {shown ? stageMeta(shown).label : 'Not in the funnel'}
          </span>
          <Icon name="chevron" size={12} className="rm-stage-chevron" />
        </button>
      </Hint>

      {open && (
        <div className="rm-stage-menu">
          {archiving ? (
            <ArchiveReasons
              stage={stage}
              onPick={(reason) => {
                setArchiving(false);
                setOpen(false);
                onSet('archived', reason);
              }}
            />
          ) : (
            <div className="rm-stage-options">
              {STAGES.map((step) => (
                <button
                  key={step.value}
                  className={stepClass(step.value, current, pending)}
                  data-testid={`stage-${step.value}`}
                  aria-current={current === step.value ? 'step' : undefined}
                  onClick={() => {
                    if (step.value === 'archived') setArchiving(true);
                    else {
                      setOpen(false);
                      onSet(step.value, null);
                    }
                  }}
                >
                  {step.label}
                  {step.value === 'archived' && '…'}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
