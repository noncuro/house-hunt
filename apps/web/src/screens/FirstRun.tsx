'use client';

import { Icon } from '@house-hunt/ui';
import type { Place } from '@house-hunt/core';
import { useExtension } from '@/lib/queries';
import type { View } from '@/lib/view';

/** A hunt with nothing in it yet, and the three things that have to happen before there is.
 *
 *  What was here before was one sentence — "Nothing yet — mark a place 'Love it' in the panel and it
 *  lands here" — under a heading, four counts all reading zero, and a row of tabs that all led to
 *  more of the same emptiness. It named the last of the three steps and neither of the first two, so
 *  the answer to "what do I do" was to go and read the Install page and guess.
 *
 *  Three steps, in order, each showing whether it is done. Done is read rather than remembered: the
 *  extension answers the handshake or it does not, and a saved place is a row in the database — so
 *  this cannot get out of step with the thing it is describing, which a stored "seen the tour" flag
 *  would within a week. */
export function FirstRun({ places, setView }: { places: Place[]; setView: (next: View) => void }) {
  const extension = useExtension();
  // One probe for the whole page — the banner and the Install screen read the same query, which is
  // what stopped this saying "not installed" directly above a green "already installed".
  //
  // `broken` counts as installed: it is present and something went wrong talking to it, and telling
  // somebody to go and install a thing they already have is how a real fault gets ignored. The
  // banner above says what actually happened.
  const status = extension.data?.status;
  const installed = status !== undefined && status !== 'absent';

  return (
    <section className="firstrun" data-testid="first-run">
      <h2 className="firstrun-head">Nothing here yet</h2>
      <p className="firstrun-lead">
        This is where the flats land. Three things first, and then it fills itself in as you browse.
      </p>

      <ol className="firstrun-steps">
        <Step
          n={1}
          done={installed}
          title="Put the extension in Chrome"
          why="It reads the listing you are on and sends it here. Nothing gets typed in by hand."
          action="Install it"
          onAction={() => setView('install')}
          // Only while the handshake is still out. A step that says "checking" forever is a step
          // nobody can tell they have finished.
          busy={extension.isPending}
        />
        <Step
          n={2}
          done={places.length > 0}
          title="Save the places you travel to"
          why="Work, the gym, whoever you visit on Sundays. Every flat gets its journey times to all of them, worked out on its own."
          action={places.length > 0 ? 'Add another' : 'Add a place'}
          onAction={() => setView('project')}
        />
        <Step
          n={3}
          done={false}
          title="Open a flat on Rightmove"
          why="The panel appears on the listing. Say what you think of it and it is here, for everybody in the hunt, with the photos already read."
          action="Go to Rightmove"
          href="https://www.rightmove.co.uk/property-to-rent.html"
        />
      </ol>
    </section>
  );
}

function Step({
  n,
  done,
  busy = false,
  title,
  why,
  action,
  onAction,
  href,
}: {
  n: number;
  done: boolean;
  busy?: boolean;
  title: string;
  why: string;
  action: string;
  onAction?: () => void;
  href?: string;
}) {
  return (
    <li className={done ? 'firstrun-step firstrun-step-done' : 'firstrun-step'}>
      <span className="firstrun-n" aria-hidden="true">
        {done ? <Icon name="tick" size={14} /> : n}
      </span>
      <div className="firstrun-body">
        <h3>
          {title}
          {done && <span className="firstrun-done">done</span>}
          {busy && <span className="dim working"> checking…</span>}
        </h3>
        <p className="dim">{why}</p>
      </div>
      {href ? (
        <a className="key" href={href} target="_blank" rel="noreferrer">
          {action} <Icon name="external" size={12} />
        </a>
      ) : (
        <button type="button" className="key" onClick={onAction}>
          {action}
        </button>
      )}
    </li>
  );
}
