'use client';

/** Run a write, and report its failure through `notify` rather than throwing.
 *
 *  Both settings-shaped pages need this. The extension's version got it from the message envelope
 *  — `result.ok` was the shape of every reply, so handling the failure was unavoidable. Calling
 *  core directly, a rejection unmounts the whole page through the error boundary and loses whatever
 *  had been typed into the form, which on a page of forms is the worst possible response to a
 *  postcode lookup timing out.
 *
 *  Shared rather than copied once per screen: it was one file's private helper until Neighbourhoods
 *  moved to Your Hunt and took five callers with it, and a second copy is a second place for the
 *  swallow-or-throw decision to be made differently. */
export type Notify = (text: string, kind?: 'error' | 'info') => void;

export async function attempt<T>(work: () => Promise<T>, notify: Notify): Promise<T | null> {
  try {
    return await work();
  } catch (e) {
    notify(e instanceof Error ? e.message : String(e));
    return null;
  }
}
