import {
  listingUrl,
  recheckTargets,
  sweepSearchUrl,
  sweepWindow,
  toSweepHub,
  type Place,
  type SweepCriteria,
} from '@house-hunt/core';
import type { HubSweep, PendingSighting, ShortlistEntry } from '@house-hunt/core/db';

/** The whole sweep, unattended, from one button.
 *
 *  The Sweep screen has three halves and each is a thing a person does: click a place's search
 *  link and page through it (scan), open every listing the scan turned up (fill in), and reopen
 *  every flat in the funnel that has gone stale (re-check). Each is right on its own and together
 *  they are an evening — five places of four pages, then two runs of an hour — of pressing the
 *  next button at the right moment. This presses them in order.
 *
 *  It does nothing the three halves do not already do, by the same mechanism. Every page is a
 *  real navigation in a real background tab, opened through the extension (`open-tab`); the panel
 *  on that tab records what it finds, exactly as it would had you opened it yourself. Nothing here
 *  fetches Rightmove and nothing here parses it — see the standing rule in AGENTS.md. What this
 *  adds is only the *sequencing*: which page next, and when it is safe to open it.
 *
 *  "Safe" is the part that needs care and it is the reason the scan waits on the database rather
 *  than on a timer alone. A search page is recorded by the panel in the tab, asynchronously, and
 *  paging on before that write lands is how a page of sightings is lost with nothing on screen
 *  looking wrong — the same hazard the panel's green "safe to go on" exists for. So after each
 *  search page this reads `hub_sweep` back until that page is in `pagesSeen`, and only then opens
 *  the next. The listing phases have no such wait: their writes are per listing, and a listing
 *  whose analysis lands after the run has ended is simply pending next time.
 *
 *  Every dependency is a parameter so the sequencing can be checked without a browser, a database
 *  or Rightmove (`pnpm check:full-sweep`). */

export type FullSweepPhase = 'scan' | 'fill' | 'recheck';

export interface FullSweepProgress {
  phase: FullSweepPhase;
  /** What is being opened right now, by name — a place and page, or an address. */
  label: string;
  /** Position within the phase. `total` is null while the scan does not yet know how many pages
   *  a place has, which it cannot until page 1 has been recorded. */
  done: number;
  total: number | null;
}

export interface FullSweepSummary {
  hubsScanned: number;
  /** Rightmove ids opened in the fill-in phase, so the re-check does not open them again: their
   *  `lastSeenAt` is rewritten by the tab, asynchronously, and a re-check list built before that
   *  lands would still count them as stale. */
  filledIn: number;
  pagesScanned: number;
  /** Places with no search to open, by name and reason — no criteria, no radius, no verified
   *  identifier. Said out loud rather than silently left out, for the usual reason. */
  hubsSkipped: Array<{ hub: string; why: string }>;
  rechecked: number;
  /** True when Stop was pressed. Everything counted above still happened. */
  stopped: boolean;
}

export interface FullSweepDeps {
  /** Open one Rightmove URL in a background tab. Rejecting ends the run: one failure to open a
   *  tab is usually the whole mechanism being gone, and grinding on would bury the reason. */
  openTab(url: string): Promise<void>;
  listSweeps(): Promise<HubSweep[]>;
  /** Clear a place's pages-in-progress before page 1 — see `resetSweepProgress` for why a run
   *  that reads its progress back cannot start without this. */
  resetSweep(placeId: string): Promise<void>;
  pending(): Promise<PendingSighting[]>;
  shortlist(): Promise<ShortlistEntry[]>;
  /** Resolves after `ms`, or rejects the moment `signal` aborts — so Stop takes effect at once
   *  rather than after whatever wait was in flight. */
  sleep(ms: number, signal: AbortSignal): Promise<void>;
  now(): Date;
}

export interface FullSweepOptions {
  hubs: Place[];
  criteria: SweepCriteria | null;
  /** The pause between one tab and the next — the Opener's pace, and for the same reason. */
  intervalMs: number;
  signal: AbortSignal;
  onProgress(progress: FullSweepProgress): void;
  deps: FullSweepDeps;
}

/** How long to keep asking whether a search page has been recorded before calling it lost.
 *
 *  A recorded page is one round trip after the tab has loaded, so under a minute is generous;
 *  past it the tab has almost certainly failed — signed out, a different hunt active in the
 *  extension, a page Rightmove would not serve — and the honest thing is to stop and say which
 *  page, rather than open the next twenty against a panel that is recording none of them. */
export const RECORD_TIMEOUT_MS = 60_000;
const RECORD_POLL_MS = 3_000;

/** The search changed shape under the run — a page reported a different total from page 1's,
 *  which `sweepProgress` reads as a new sweep and restarts the count from that page. Rightmove does
 *  this when a listing lands or goes mid-run and the count crosses a page boundary. The hub is
 *  started again once (page 1 first, the new total); if it happens twice the run stops and says so
 *  rather than chase a search that will not hold still. */
export class SearchChanged extends Error {
  constructor(hub: string, was: number, now: number | null) {
    super(`${hub}'s search changed from ${was} pages to ${now ?? 'an unknown number'} mid-sweep`);
    this.name = 'SearchChanged';
  }
}

export class PageNotRecorded extends Error {
  constructor(hub: string, page: number) {
    super(
      `page ${page} of ${hub} was opened but never recorded — is the extension signed in to this ` +
        'hunt? Stopping rather than paging on past a page that was not written down.',
    );
    this.name = 'PageNotRecorded';
  }
}

/** Thrown out of a wait when Stop is pressed. Never leaves `runFullSweep`. */
class Stopped extends Error {}

export async function runFullSweep(options: FullSweepOptions): Promise<FullSweepSummary> {
  const { deps, signal, intervalMs } = options;
  const summary: FullSweepSummary = {
    hubsScanned: 0,
    pagesScanned: 0,
    hubsSkipped: [],
    filledIn: 0,
    rechecked: 0,
    stopped: false,
  };
  const filled = new Set<string>();

  // The wait is *between* tabs, never before the first — the button must visibly do something the
  // moment it is pressed — so the first open of the whole run goes straight away.
  let opened = 0;
  const open = async (url: string) => {
    if (opened > 0) await deps.sleep(intervalMs, signal);
    if (signal.aborted) throw new Stopped();
    await deps.openTab(url);
    opened++;
  };

  try {
    await scan(options, summary, open);
    await fillIn(options, summary, open, filled);
    await recheck(options, summary, open, filled);
  } catch (e) {
    if (e instanceof Stopped || signal.aborted) {
      summary.stopped = true;
      return summary;
    }
    throw e;
  }
  return summary;
}

async function scan(
  { hubs, criteria, onProgress, deps, signal }: FullSweepOptions,
  summary: FullSweepSummary,
  open: (url: string) => Promise<void>,
): Promise<void> {
  // Read once, up front: the window for each place comes from when it was last swept *before*
  // this run, and reading it again mid-run would date a place from the sweep in progress.
  const before = await deps.listSweeps();

  for (const hub of hubs) {
    const previous = before.find((s) => s.placeId === hub.id) ?? null;
    const choice = sweepWindow(previous?.lastSweptAt ?? null, deps.now(), hub.maxDaysSinceAdded);
    const search = { hub: toSweepHub(hub), days: choice.days, criteria };
    const first = sweepSearchUrl({ ...search, page: 1 });
    if (first === null) {
      summary.hubsSkipped.push({ hub: hub.label, why: skipReason(hub, criteria) });
      continue;
    }

    const scanHub = async () => {
      // Cleared first, so that "page 1 is in" below can only be this run's page 1 — see
      // `resetSweepProgress`. Then page 1 alone, because it is the page that says how many there
      // are; its record restarts the count (`sweepProgress`), so a sweep abandoned halfway last
      // time is not resumed from its old total — the search may well have a different shape today.
      await deps.resetSweep(hub.id);
      onProgress({ phase: 'scan', label: `${hub.label} — page 1`, done: 0, total: null });
      await open(first);
      const recorded = await awaitRecorded(deps, signal, hub, 1);
      summary.pagesScanned++;
      const total = recorded.pagesTotal ?? 1;

      for (let page = 2; page <= total; page++) {
        onProgress({ phase: 'scan', label: `${hub.label} — page ${page}`, done: page - 1, total });
        // Rebuilt from the same search rather than from a tab's `location.href` (`nextPageUrl`),
        // because this run has no tab to read: the pages are the extension's, and it does not
        // report back. The URL is byte-for-byte what page 1 was with the offset moved, which is
        // what the panel's own next-page link would have produced.
        await open(sweepSearchUrl({ ...search, page })!);
        await awaitRecorded(deps, signal, hub, page, total);
        summary.pagesScanned++;
      }
    };

    try {
      await scanHub();
    } catch (e) {
      if (!(e instanceof SearchChanged)) throw e;
      // Once. The pages already counted were recorded — they are just filed under a sweep the
      // database has since restarted — so the count stands and the hub goes again from page 1.
      await scanHub();
    }
    summary.hubsScanned++;
  }
}

/** Why a place gets no search. Three causes, three different things to do about them — the same
 *  three the Sweep screen's per-place row distinguishes, in the same order. */
function skipReason(hub: Place, criteria: SweepCriteria | null): string {
  if (!criteria || Object.keys(criteria).length === 0) return 'this hunt has not chosen its Rightmove filters';
  if (hub.sweepRadiusMiles === null) return 'no search radius — tick "search around" on Your Hunt';
  return 'no verified Rightmove location';
}

/** Wait until `hub_sweep` says this page is in, and return the row that says so.
 *
 *  The row is read rather than trusted: nothing reports back from a background tab, and a tab
 *  that loaded a sign-in wall, or a panel bound to a different hunt, records nothing and looks
 *  from here exactly like one that is still loading. The timeout is what tells those apart. */
async function awaitRecorded(
  deps: FullSweepDeps,
  signal: AbortSignal,
  hub: Place,
  page: number,
  /** The total page 1 reported, for every page after it. A row that says otherwise is a restarted
   *  count, not a recorded page — see `SearchChanged`. */
  expectedTotal?: number,
): Promise<HubSweep> {
  const deadline = deps.now().getTime() + RECORD_TIMEOUT_MS;
  for (;;) {
    const sweep = (await deps.listSweeps()).find((s) => s.placeId === hub.id) ?? null;
    if (sweep && sweep.pagesTotal !== null && recordedPage(sweep.pagesSeen, page)) {
      if (expectedTotal !== undefined && sweep.pagesTotal !== expectedTotal) {
        throw new SearchChanged(hub.label, expectedTotal, sweep.pagesTotal);
      }
      return sweep;
    }
    if (deps.now().getTime() >= deadline) throw new PageNotRecorded(hub.label, page);
    await deps.sleep(RECORD_POLL_MS, signal);
  }
}

/** Whether `pagesSeen` shows this page recorded *by this run*.
 *
 *  Page 1 restarts the count (`sweepProgress`), so after its record the list is exactly `[1]` —
 *  and with the progress cleared before page 1 was opened (`resetSweep`), exactly `[1]` can only
 *  be this run's. "Includes 1" would have let a sweep abandoned on page three last week answer for
 *  a page that had only just been opened. */
function recordedPage(pagesSeen: number[], page: number): boolean {
  return page === 1 ? pagesSeen.length === 1 && pagesSeen[0] === 1 : pagesSeen.includes(page);
}

async function fillIn(
  { onProgress, deps }: FullSweepOptions,
  summary: FullSweepSummary,
  open: (url: string) => Promise<void>,
  filled: Set<string>,
): Promise<void> {
  // Asked after the scan, not before it: the point of scanning first is that the worklist here
  // includes what the scan just found. Newest sighting first, as the Sweep screen's own run goes.
  const targets = await deps.pending();
  for (const [i, row] of targets.entries()) {
    onProgress({ phase: 'fill', label: row.displayAddress || row.rightmoveId, done: i, total: targets.length });
    await open(listingUrl(row.rightmoveId));
    filled.add(row.rightmoveId);
    summary.filledIn++;
  }
}

async function recheck(
  { onProgress, deps }: FullSweepOptions,
  summary: FullSweepSummary,
  open: (url: string) => Promise<void>,
  filled: Set<string>,
): Promise<void> {
  // Read now rather than at the start, so the list reflects the scan — and minus what the fill-in
  // opened a moment ago, because the tab that rewrites a flat's `lastSeenAt` has not necessarily
  // finished, and a list that still saw the old date would open the same flat twice in a minute.
  const targets = recheckTargets(await deps.shortlist(), deps.now()).filter(
    (row) => !filled.has(row.rightmoveId),
  );
  for (const [i, row] of targets.entries()) {
    onProgress({ phase: 'recheck', label: row.displayAddress || row.rightmoveId, done: i, total: targets.length });
    await open(listingUrl(row.rightmoveId));
    summary.rechecked++;
  }
}

/** A sleep that gives up the instant it is told to. */
export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(signal.reason);
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
