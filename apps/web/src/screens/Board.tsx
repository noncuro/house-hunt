'use client';

import { useMemo, useState } from 'react';
import {
  ARCHIVE_REASONS,
  STAGES,
  addressBesidePostcode,
  archiveMeta,
  groupOf,
  type ArchiveReason,
  type Stage,
} from '@house-hunt/core';
import type { ShortlistEntry } from '@house-hunt/core/db';
import { Icon } from '@house-hunt/ui';
import { Menu } from '@/components/Menu';
import type { SetStage } from '@/lib/actions';

/** The funnel as columns, with the flats in them.
 *
 *  The other three renderings answer "which of these do we want"; this one answers "what is there to
 *  do this week", which is a different question and was previously only askable by setting a filter,
 *  reading the list, setting the next filter and remembering the first. Six columns side by side is
 *  the whole answer at once, and moving something along is a drag rather than a form.
 *
 *  Only the funnel is drawn. A first column for everything outside it would hold four hundred cards
 *  and be the widest thing on the screen while being the one part of it that is not progress. */
export function Board({
  entries,
  onOpen,
  onSetStage,
  stageSaving,
}: {
  entries: ShortlistEntry[];
  onOpen: (rightmoveId: string) => void;
  onSetStage: SetStage;
  /** The stage a click is currently writing, and for which flat — see Places. Both routes onto a
   *  card refuse a second move while the first is in flight, because the board is the surface where
   *  two moves in a row are the normal way to use it. */
  stageSaving: { rightmoveId: string; stage: Stage } | null;
}) {
  // Held while a drop onto Archived waits for its reason: the database requires one and inventing
  // `other` on the user's behalf would write an account of what happened that nobody gave.
  const [archiving, setArchiving] = useState<ShortlistEntry | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<Stage | null>(null);

  const columns = useMemo(() => {
    const by = new Map<Stage, ShortlistEntry[]>(STAGES.map((s) => [s.value, []]));
    let outside = 0;
    for (const entry of entries) {
      if (!entry.stage) outside += 1;
      else by.get(entry.stage.stage)?.push(entry);
    }
    // Most recently moved at the top of each column: a board is read for what changed.
    for (const pile of by.values()) pile.sort((a, b) => (b.stage?.updatedAt ?? '').localeCompare(a.stage?.updatedAt ?? ''));
    return { by, outside };
  }, [entries]);

  const drop = (stage: Stage) => {
    const entry = entries.find((e) => e.rightmoveId === dragging);
    setDragging(null);
    setOver(null);
    if (!entry || entry.stage?.stage === stage) return;
    if (stageSaving?.rightmoveId === entry.rightmoveId) return;
    if (stage === 'archived') setArchiving(entry);
    else onSetStage(entry, stage, null);
  };

  return (
    <div className="board" data-testid="board">
      {STAGES.map((stage) => {
        const pile = columns.by.get(stage.value) ?? [];
        return (
          <section
            key={stage.value}
            className={`board-col${over === stage.value ? ' board-col-over' : ''}`}
            data-testid={`board-${stage.value}`}
            onDragOver={(event) => {
              // Without this the browser refuses the drop, silently — the card springs back and the
              // column looks broken rather than closed.
              event.preventDefault();
              setOver(stage.value);
            }}
            onDragLeave={() => setOver((at) => (at === stage.value ? null : at))}
            onDrop={() => drop(stage.value)}
          >
            <h2 className="board-head" title={stage.hint}>
              {stage.label}
              <span className={pile.length === 0 ? 'board-count board-count-zero' : 'board-count'}>
                {pile.length}
              </span>
            </h2>

            {archiving && stage.value === 'archived' && (
              <WhyArchived
                entry={archiving}
                onPick={(reason) => {
                  onSetStage(archiving, 'archived', reason);
                  setArchiving(null);
                }}
                onCancel={() => setArchiving(null)}
              />
            )}

            <div className="board-pile">
              {pile.map((entry) => (
                <BoardCard
                  key={entry.rightmoveId}
                  entry={entry}
                  dragging={dragging === entry.rightmoveId}
                  onOpen={onOpen}
                  onDragStart={() => setDragging(entry.rightmoveId)}
                  onDragEnd={() => {
                    setDragging(null);
                    setOver(null);
                  }}
                  saving={stageSaving?.rightmoveId === entry.rightmoveId ? stageSaving.stage : null}
                  onMove={(to) =>
                    to === 'archived' ? setArchiving(entry) : onSetStage(entry, to, null)
                  }
                />
              ))}
              {pile.length === 0 && <p className="board-empty dim">—</p>}
            </div>
          </section>
        );
      })}

      {/* Said once, at the end, rather than as a column: it is the size of the pile this board is
          deliberately not about. */}
      {columns.outside > 0 && (
        <p className="board-outside dim">
          {columns.outside} not in the funnel — liking a place puts it in.
        </p>
      )}
    </div>
  );
}

function BoardCard({
  entry,
  dragging,
  saving,
  onOpen,
  onDragStart,
  onDragEnd,
  onMove,
}: {
  entry: ShortlistEntry;
  dragging: boolean;
  /** Where this card is being moved to, while the write is in flight. */
  saving: Stage | null;
  onOpen: (rightmoveId: string) => void;
  onDragStart: () => void;
  onDragEnd: () => void;
  onMove: (stage: Stage) => void;
}) {
  const group = groupOf(entry.verdicts);
  const reason = entry.stage?.archiveReason;
  const shown = saving ?? entry.stage?.stage ?? null;
  return (
    <article
      className={`board-card${dragging ? ' board-card-lifted' : ''}${saving ? ' board-card-saving' : ''}`}
      draggable={!saving}
      onDragStart={(event) => {
        // Firefox will not start a drag at all without data on the transfer.
        event.dataTransfer.setData('text/plain', entry.rightmoveId);
        event.dataTransfer.effectAllowed = 'move';
        onDragStart();
      }}
      onDragEnd={onDragEnd}
    >
      <span className={`verdict-dot verdict-dot-${group}`} aria-hidden="true" />
      <button type="button" className="board-address" onClick={() => onOpen(entry.rightmoveId)}>
        {addressBesidePostcode(entry.displayAddress, entry.postcode)}
      </button>
      {entry.price && <span className="board-rent">{entry.price}</span>}
      {reason && <span className="board-reason dim">{archiveMeta(reason).label}</span>}

      {/* Dragging is the quick way and works for nobody using a keyboard, so the same move is also a
          menu. Not a hover affordance: it is the only route for half the people who need it. */}
      <Menu
        align="right"
        className="board-move"
        label={<Icon name="forward" size={12} label={`Move ${entry.displayAddress}`} />}
      >
        {(close) => (
          <ul className="menu-list">
            {STAGES.filter((s) => s.value !== shown).map((s) => (
              <li key={s.value}>
                <button
                  type="button"
                  disabled={Boolean(saving)}
                  onClick={() => {
                    onMove(s.value);
                    close();
                  }}
                >
                  {s.label}
                </button>
              </li>
            ))}
          </ul>
        )}
      </Menu>
    </article>
  );
}

function WhyArchived({
  entry,
  onPick,
  onCancel,
}: {
  entry: ShortlistEntry;
  onPick: (reason: ArchiveReason) => void;
  onCancel: () => void;
}) {
  return (
    <div className="board-why" data-testid="board-why">
      <p className="label">Why is {addressBesidePostcode(entry.displayAddress, entry.postcode)} out?</p>
      {ARCHIVE_REASONS.map((reason) => (
        <button key={reason.value} type="button" className="board-why-pick" onClick={() => onPick(reason.value)}>
          {reason.label}
        </button>
      ))}
      <button type="button" className="linkish" onClick={onCancel}>
        Cancel
      </button>
    </div>
  );
}
