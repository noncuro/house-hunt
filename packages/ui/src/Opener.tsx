import { useEffect, useRef, useState } from 'react';
import './opener.css';
import { useHost } from './host';

/** Faster than a person clicking, and the same order of magnitude.
 *
 *  Every tab this opens is a page you would otherwise have opened yourself, one at a time, and
 *  nothing here runs in parallel. Twelve seconds is roughly how long a listing takes to load,
 *  extract, cache its travel times and start its analysis, so the next tab lands about when the
 *  last one has settled — which is both the polite rate and the one that actually works. This is
 *  the *default*: the idle control below lets you change it, clamped to a sane range, and the
 *  choice is remembered per browser. */
export const OPEN_INTERVAL_MS = 12_000;

/** The pace is adjustable but not to anything. Below a few seconds the tabs stop landing after the
 *  last one has settled — the whole reason for the interval — and start hammering; above two
 *  minutes it is no longer a run so much as a reminder. */
const MIN_INTERVAL_S = 3;
const MAX_INTERVAL_S = 120;
const INTERVAL_KEY = 'house-hunt/open-interval-ms';

function clampIntervalMs(ms: number): number {
  return Math.min(MAX_INTERVAL_S * 1000, Math.max(MIN_INTERVAL_S * 1000, Math.round(ms)));
}

/** Remembered per browser so a pace you settled on survives a reload — read defensively because a
 *  hand-edited or stale value must fall back to the default rather than opening forty tabs at once. */
function loadIntervalMs(): number {
  if (typeof window === 'undefined') return OPEN_INTERVAL_MS;
  const raw = Number(window.localStorage.getItem(INTERVAL_KEY));
  return Number.isFinite(raw) && raw > 0 ? clampIntervalMs(raw) : OPEN_INTERVAL_MS;
}

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
  const [intervalMs, setIntervalMs] = useState<number>(loadIntervalMs);
  // The pace input's live text, kept separate from the committed `intervalMs` so a two-digit number
  // is typable without the first digit snapping to the clamp. Committed on blur/Enter.
  const [paceDraft, setPaceDraft] = useState(() => String(Math.round(loadIntervalMs() / 1000)));
  useTicker(run, setRun, intervalMs, onFinished, onError);

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

  const seconds = Math.round(intervalMs / 1000);
  const commitInterval = () => {
    const n = Number(paceDraft);
    // Anything unusable — empty, non-numeric, negative — snaps the box back to the value in force
    // rather than being accepted, so the input can never disagree with what a run would actually use.
    if (!Number.isFinite(n) || n <= 0) {
      setPaceDraft(String(seconds));
      return;
    }
    const ms = clampIntervalMs(n * 1000);
    setIntervalMs(ms);
    setPaceDraft(String(Math.round(ms / 1000)));
    if (typeof window !== 'undefined') window.localStorage.setItem(INTERVAL_KEY, String(ms));
  };

  // The explanation is plain text under the label rather than a tooltip: it is the kind of thing
  // worth reading *before* you press the button, which is an argument against hiding it behind a
  // hover — and this button commits the browser to several minutes of opening tabs.
  return (
    <div className="rm-open-idle">
      <button type="button" className="rm-open-go" onClick={() => setRun({ targets, opened: 0 })}>
        <span>
          Open the {targets.length} {what}
        </span>
        <small>
          one tab every {seconds}s · about {describeMinutes(targets.length, intervalMs)} unattended ·
          stoppable
        </small>
      </button>
      {/* The pace is on the idle control and not inside a run: it changes what the next press does,
          not a run already in flight, and hiding it there would invite fiddling with a timer that
          is mid-count. Committed on blur/Enter rather than per keystroke so a two-digit number is
          typable without the first digit snapping to the clamp. */}
      <label className="rm-open-pace">
        <span>Seconds between tabs</span>
        <input
          type="number"
          min={MIN_INTERVAL_S}
          max={MAX_INTERVAL_S}
          value={paceDraft}
          onChange={(e) => setPaceDraft(e.target.value)}
          onBlur={commitInterval}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
          }}
        />
      </label>
    </div>
  );
}

function useTicker(
  run: Run | null,
  setRun: (run: Run | null) => void,
  intervalMs: number,
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
    const timer = setTimeout(() => void open(), run.opened === 0 ? 0 : intervalMs);
    return () => clearTimeout(timer);
  }, [run, setRun, intervalMs, host]);
}

export function describeMinutes(count: number, intervalMs: number = OPEN_INTERVAL_MS): string {
  const total = Math.round((count * intervalMs) / 60_000);
  if (total < 1) return 'a few seconds';
  return total === 1 ? 'a minute' : `${total} minutes`;
}
