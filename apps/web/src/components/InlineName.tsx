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
  /** Called only with a non-empty, changed name. Errors are the caller's to report.
   *
   *  Awaited, and the control stays busy until it settles. Two renames in flight at once can land
   *  out of order, leaving the stored name and the one on screen disagreeing with nothing to say
   *  so — and a rename is the kind of thing you retype immediately when the first attempt looks
   *  like it did nothing. */
  onSave: (next: string) => void | Promise<unknown>;
  /** What is being renamed, for the pencil's tooltip and the field's accessible name. */
  label: string;
  busy?: boolean;
  className?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [saving, setSaving] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  const locked = busy || saving;

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
    if (!next || next === value) {
      setDraft(value);
      return;
    }
    setSaving(true);
    void Promise.resolve(onSave(next)).finally(() => setSaving(false));
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
          disabled={locked}
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
        disabled={locked}
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
