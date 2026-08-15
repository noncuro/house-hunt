import { useEffect, useRef, useState } from 'react';

/** A name you can change where it is written, rather than in a form somewhere else.
 *
 *  Both names in this app — the hunt's and your own — were a labelled text field with a Save button
 *  under a paragraph explaining what the name was for. That is a lot of screen for a word that
 *  changes twice a year, and it puts the control a page away from the only place the name is ever
 *  read, so you go looking for "rename" under a heading that does not say rename. Here the name is
 *  the control: click the pencil and you are typing on the name itself.
 *
 *  Enter saves, Escape cancels, and blur saves — which is the one that matters, because an edit
 *  abandoned by clicking elsewhere is a rename someone believes they made. An unchanged or empty
 *  value saves nothing rather than clearing the name. */
export function InlineName({
  value,
  onSave,
  label,
  busy,
  className,
}: {
  value: string;
  /** Called only with a non-empty, changed name. Errors are the caller's to report. */
  onSave: (next: string) => void;
  /** What is being renamed, for the pencil's tooltip and the field's accessible name. */
  label: string;
  busy?: boolean;
  className?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const field = useRef<HTMLInputElement>(null);

  // The name can change from the other laptop while this is open. A draft left holding the old one
  // would rename it back on the next save, so an edit in progress is the only thing that keeps it.
  useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);

  useEffect(() => {
    if (editing) field.current?.select();
  }, [editing]);

  const commit = () => {
    setEditing(false);
    const next = draft.trim();
    if (next && next !== value) onSave(next);
    else setDraft(value);
  };

  if (!editing) {
    return (
      <span className={className}>
        {value}
        <button
          type="button"
          className="inline-name-edit"
          title={`Rename ${label}`}
          aria-label={`Rename ${label}`}
          disabled={busy}
          onClick={() => setEditing(true)}
        >
          ✎
        </button>
      </span>
    );
  }

  return (
    <span className={className}>
      <input
        ref={field}
        className="inline-name-field"
        aria-label={label}
        value={draft}
        disabled={busy}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
          if (e.key === 'Escape') {
            setDraft(value);
            setEditing(false);
          }
        }}
      />
    </span>
  );
}
