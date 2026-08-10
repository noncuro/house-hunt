import { useEffect, useRef, useState } from 'react';
import './opener.css';
import { useHost } from './host';

/** Faster than a person clicking, and the same order of magnitude.
 *
 *  Every tab this opens is a page you would otherwise have opened yourself, one at a time, and
 *  nothing here runs in parallel. Twelve seconds is roughly how long a listing takes to load,
 *  extract, cache its travel times and start its analysis, so the next tab lands about when the
 *  last one has settled — which is both the polite rate and the one that actually works. */
export const OPEN_INTERVAL_MS = 12_000;

export interface OpenTarget {
  rightmoveId: string;
  /** What to show while it is being opened, so a run is legible rather than a progress bar over
   *  a list of numbers. */
  label: string;
}

interface Run {
  targets: OpenTarget[];
  /** How many have been opened. Also the index of the next one. */
  opened: number;
}

/** Opens listings one at a time, slowly, and stops the instant you ask it to.
 *
 *  This used to live on the Rightmove search-results page, which made its worklist the two dozen
 *  cards on screen and killed it the moment you paged on: sweeping five hubs of four pages each
 *  meant twenty separate unattended runs, every one of which you had to sit through before
 *  navigating. Scanning a page is instant and belongs where the page is; filling in what you have
 *  scanned is one long run over everything, and belongs somewhere that stays open. So it lives on
 *  the shortlist now, and takes its targets from the database rather than from a DOM.
 *
 *  The pacing is a timer rather than a loop with awaits in it, so Stop takes effect immediately —
 *  there is no in-flight sleep still holding a reference to the tab it was about to open. */
export function Opener({
  targets,
  what,
  onFinished,
  onError,
}: {
  targets: OpenTarget[];
  /** Plural noun for the button — "we don't have yet", "left to fill in". */
  what: string;
  /** Called when a run ends of its own accord, so the caller can refresh its counts. */
  onFinished?: () => void;
  onError?: (message: string) => void;
}) {
  const [run, setRun] = useState<Run | null>(null);
  useTicker(run, setRun, onFinished, onError);

  if (run) {
    const at = Math.min(run.opened, run.targets.length - 1);
    return (
      <div className="rm-open-run">
        <div className="rm-open-run-head">
          <span>
            Opening {Math.min(run.opened + 1, run.targets.length)} of {run.targets.length}
          </span>
          <button type="button" className="rm-open-stop" onClick={() => setRun(null)}>
            Stop
          </button>
        </div>
        <progress value={run.opened} max={run.targets.length} />
        {/* Which one, by name. A bar filling over a count tells you it is working; the address
            tells you what it is working on, which is what you look at a long run to find out. */}
        <div className="rm-open-at">{run.targets[at]?.label}</div>
      </div>
    );
  }

  if (targets.length === 0) return null;

  // The explanation is plain text under the label rather than a tooltip: it is the kind of thing
  // worth reading *before* you press the button, which is an argument against hiding it behind a
  // hover — and this button commits the browser to several minutes of opening tabs.
  return (
    <button type="button" className="rm-open-go" onClick={() => setRun({ targets, opened: 0 })}>
      <span>
        Open the {targets.length} {what}
      </span>
      <small>
        one tab every {OPEN_INTERVAL_MS / 1000}s · about {describeMinutes(targets.length)} unattended ·
        stoppable
      </small>
    </button>
  );
}

function useTicker(
  run: Run | null,
  setRun: (run: Run | null) => void,
  onFinished: (() => void) | undefined,
  onError: ((message: string) => void) | undefined,
): void {
  const host = useHost();
  // Read the latest callbacks without making them dependencies — a changing dependency here
  // restarts the timer, which in practice means it resets before it ever fires.
  const latest = useRef({ onFinished, onError });
  latest.current = { onFinished, onError };

  useEffect(() => {
    if (!run) return;
    if (run.opened >= run.targets.length) {
      setRun(null);
      latest.current.onFinished?.();
      return;
    }

    const open = async () => {
      const target = run.targets[run.opened]!;
      try {
        await host.openListing(target.rightmoveId);
      } catch (e) {
        // Stop rather than skip. One failure to open a tab is usually the whole mechanism being
        // unavailable, and grinding through forty more of them would bury the reason.
        const reason = e instanceof Error ? e.message : String(e);
        latest.current.onError?.(`Couldn't open ${target.label}: ${reason} — stopping the run.`);
        setRun(null);
        return;
      }
      setRun({ ...run, opened: run.opened + 1 });
    };

    // The first opens straight away; the wait is *between* tabs, not before the first, or the
    // button appears not to have worked.
    const timer = setTimeout(() => void open(), run.opened === 0 ? 0 : OPEN_INTERVAL_MS);
    return () => clearTimeout(timer);
  }, [run, setRun, host]);
}

export function describeMinutes(count: number): string {
  const total = Math.round((count * OPEN_INTERVAL_MS) / 60_000);
  if (total < 1) return 'a few seconds';
  return total === 1 ? 'a minute' : `${total} minutes`;
}
