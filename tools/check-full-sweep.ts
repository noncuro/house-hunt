/** The unattended sweep's sequencing, pinned without a browser.
 *
 *  Everything the run does is open a tab and wait, and both are injected — so this drives it with
 *  a fake extension that "records" a search page some ticks after it is opened, and a fake clock,
 *  and asserts on the order of URLs it asked for. The reasoning worth pinning is invisible when it
 *  is wrong: a run that pages on before page 1 is recorded still opens every page and still says
 *  "done", and the sightings it lost look like flats that were never listed.
 */
import { RECORD_TIMEOUT_MS, runFullSweep, type FullSweepDeps } from '../apps/web/src/lib/full-sweep';
import type { Place } from '../packages/core/src/types';
import type { HubSweep, PendingSighting, ShortlistEntry } from '../packages/core/src/db/supabase';

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) return console.log(`  ok   ${name}`);
  failures++;
  console.log(`  FAIL ${name}${detail ? `\n       ${detail}` : ''}`);
}

const CRITERIA = { minPrice: '2000', maxPrice: '3000', minBedrooms: '1' };

function place(id: string, label: string, overrides: Partial<Place> = {}): Place {
  return {
    id,
    label,
    kind: 'neighbourhood',
    lat: 51.5,
    lon: -0.1,
    postcode: null,
    sweepRadiusMiles: 0.5,
    maxDaysSinceAdded: null,
    locationIdentifier: `STATION^${id}`,
    displayLocationIdentifier: `${label}-Station.html`,
    ...overrides,
  } as Place;
}

/** A fake of the two halves of the machine this run drives: the extension that opens tabs, and the
 *  database the panel in those tabs writes to. A search page "lands" `landAfter` sleeps after it
 *  was opened; listings land nowhere, because the run never waits on them. */
function fakeWorld({
  pagesPerHub,
  landAfter = 1,
  pending = [],
  shortlist = [],
}: {
  pagesPerHub: Record<string, number>;
  landAfter?: number;
  pending?: PendingSighting[];
  shortlist?: ShortlistEntry[];
}) {
  const opened: string[] = [];
  const sweeps = new Map<string, HubSweep>();
  const due: Array<{ at: number; apply: () => void }> = [];
  let tick = 0;
  // Starts well past the re-check cutoff, so a shortlist entry last seen at the epoch reads as due.
  let clock = 30 * 24 * 3600_000;

  const deps: FullSweepDeps = {
    async openTab(url) {
      opened.push(url);
      const u = new URL(url);
      if (!u.pathname.endsWith('find.html')) return;
      const placeId = u.searchParams.get('locationIdentifier')!.split('^')[1]!;
      const page = Number(u.searchParams.get('index')) / 24 + 1;
      const total = pagesPerHub[placeId]!;
      due.push({
        at: tick + landAfter,
        apply: () => {
          const before = sweeps.get(placeId);
          const carryOn = page !== 1 && before && before.pagesTotal === total;
          const seen = new Set(carryOn ? before!.pagesSeen : []);
          seen.add(page);
          sweeps.set(placeId, {
            hub: placeId,
            placeId,
            lastSweptAt: null,
            lastResultCount: null,
            lastWindowDays: null,
            locationIdentifier: null,
            pagesTotal: total,
            pagesSeen: [...seen].sort((a, b) => a - b),
          });
        },
      });
    },
    async listSweeps() {
      return [...sweeps.values()];
    },
    async pending() {
      return pending;
    },
    async shortlist() {
      return shortlist;
    },
    async sleep(ms, signal) {
      if (signal.aborted) throw signal.reason;
      tick++;
      clock += ms;
      for (const d of due.filter((d) => d.at <= tick)) d.apply();
    },
    now: () => new Date(clock),
  };
  return { deps, opened, sweeps, seed: (s: HubSweep) => sweeps.set(s.placeId!, s) };
}

const noop = () => {};

async function main() {
  console.log('scan order');
  {
    const world = fakeWorld({ pagesPerHub: { a: 3, b: 1 } });
    const summary = await runFullSweep({
      hubs: [place('a', 'Angel'), place('b', 'Barbican')],
      criteria: CRITERIA,
      intervalMs: 1000,
      signal: new AbortController().signal,
      onProgress: noop,
      deps: world.deps,
    });
    const pages = world.opened.map((u) => {
      const q = new URL(u).searchParams;
      return `${q.get('locationIdentifier')!.split('^')[1]}:${Number(q.get('index')) / 24 + 1}`;
    });
    check('every page of every place, in order', pages.join(' ') === 'a:1 a:2 a:3 b:1', pages.join(' '));
    check('summary counts pages and places', summary.pagesScanned === 4 && summary.hubsScanned === 2);
    check('nothing skipped', summary.hubsSkipped.length === 0);
    check('sort is newest first on every page', world.opened.every((u) => new URL(u).searchParams.get('sortType') === '6'));
  }

  console.log('\nwaiting for the record');
  {
    // Page 1 lands three sleeps after it opens. The run must not open page 2 until it has.
    const world = fakeWorld({ pagesPerHub: { a: 2 }, landAfter: 3 });
    const order: string[] = [];
    const deps: FullSweepDeps = {
      ...world.deps,
      async openTab(url) {
        order.push(`open ${Number(new URL(url).searchParams.get('index')) / 24 + 1}`);
        await world.deps.openTab(url);
      },
      async listSweeps() {
        const rows = await world.deps.listSweeps();
        order.push(`read ${rows[0]?.pagesSeen.join(',') ?? '-'}`);
        return rows;
      },
    };
    await runFullSweep({
      hubs: [place('a', 'Angel')],
      criteria: CRITERIA,
      intervalMs: 1000,
      signal: new AbortController().signal,
      onProgress: noop,
      deps,
    });
    const secondOpen = order.indexOf('open 2');
    const firstRecorded = order.indexOf('read 1');
    check('page 2 is not opened until page 1 is read back', firstRecorded !== -1 && secondOpen > firstRecorded, order.join(' | '));
  }
  {
    // A sweep abandoned on page 3 last week says pagesSeen [1,2,3]. That is not today's page 1.
    const world = fakeWorld({ pagesPerHub: { a: 2 }, landAfter: 2 });
    world.seed({
      hub: 'a',
      placeId: 'a',
      lastSweptAt: null,
      lastResultCount: null,
      lastWindowDays: null,
      locationIdentifier: null,
      pagesTotal: 5,
      pagesSeen: [1, 2, 3],
    });
    const summary = await runFullSweep({
      hubs: [place('a', 'Angel')],
      criteria: CRITERIA,
      intervalMs: 1000,
      signal: new AbortController().signal,
      onProgress: noop,
      deps: world.deps,
    });
    check("last week's half-sweep does not answer for today's page 1", summary.pagesScanned === 2, `scanned ${summary.pagesScanned}, expected 2 (today's total), not 5`);
  }
  {
    // Nothing ever lands — the extension is signed out, say. The run must stop and name the page.
    const world = fakeWorld({ pagesPerHub: { a: 4 }, landAfter: Number.POSITIVE_INFINITY });
    const started = world.deps.now().getTime();
    let error = '';
    await runFullSweep({
      hubs: [place('a', 'Angel')],
      criteria: CRITERIA,
      intervalMs: 1000,
      signal: new AbortController().signal,
      onProgress: noop,
      deps: world.deps,
    }).catch((e: Error) => (error = e.message));
    check('a page that never records stops the run', /page 1 of Angel/.test(error), error || 'no error');
    check('…without opening the pages after it', world.opened.length === 1, `${world.opened.length} opened`);
    check('…after the timeout, not before', world.deps.now().getTime() - started >= RECORD_TIMEOUT_MS);
  }

  console.log('\nthen the listings');
  {
    const shortlistEntry = {
      rightmoveId: '300',
      displayAddress: 'Loved',
      price: '£2,500 pcm',
      lastSeenAt: new Date(0).toISOString(),
      verdicts: [{ rating: 'love' }],
      stage: { stage: 'shortlisted' },
    } as unknown as ShortlistEntry;
    const world = fakeWorld({
      pagesPerHub: { a: 1 },
      pending: [
        { rightmoveId: '100', url: '', hub: 'Angel', displayAddress: 'New one', price: null, missing: [] },
        { rightmoveId: '200', url: '', hub: 'Angel', displayAddress: 'Another', price: null, missing: [] },
      ],
      shortlist: [shortlistEntry],
    });
    // The run reads the shortlist after filling in, with a clock that has moved past the
    // three-day cutoff by then — `lastSeenAt` is the epoch, so it is due whatever the clock says.
    const phases: string[] = [];
    const summary = await runFullSweep({
      hubs: [place('a', 'Angel')],
      criteria: CRITERIA,
      intervalMs: 1000,
      signal: new AbortController().signal,
      onProgress: (p) => phases.push(p.phase),
      deps: world.deps,
    });
    const listings = world.opened.filter((u) => u.includes('/properties/')).map((u) => u.split('/').pop());
    check('search pages first, then pending listings, then re-checks', listings.join(' ') === '100 200 300', listings.join(' '));
    check('phases reported in order', [...new Set(phases)].join(' ') === 'scan fill recheck', phases.join(' '));
    check('summary counts each phase', summary.filledIn === 2 && summary.rechecked === 1);
  }

  console.log('\nskipping and stopping');
  {
    const world = fakeWorld({ pagesPerHub: { a: 1, b: 1, c: 1 } });
    const summary = await runFullSweep({
      hubs: [
        place('a', 'Angel'),
        place('b', 'No radius', { sweepRadiusMiles: null }),
        place('c', 'Unresolved', { locationIdentifier: null, displayLocationIdentifier: null }),
      ],
      criteria: CRITERIA,
      intervalMs: 1000,
      signal: new AbortController().signal,
      onProgress: noop,
      deps: world.deps,
    });
    check('a place with no search is skipped and named', summary.hubsSkipped.map((h) => h.hub).join(',') === 'No radius,Unresolved', JSON.stringify(summary.hubsSkipped));
    check('…and the others still run', summary.hubsScanned === 1);
  }
  {
    const world = fakeWorld({ pagesPerHub: { a: 1 } });
    const summary = await runFullSweep({
      hubs: [place('a', 'Angel')],
      criteria: null,
      intervalMs: 1000,
      signal: new AbortController().signal,
      onProgress: noop,
      deps: world.deps,
    });
    check('no criteria, no search opened', world.opened.length === 0 && summary.hubsSkipped.length === 1);
  }
  {
    const world = fakeWorld({ pagesPerHub: { a: 5 } });
    const abort = new AbortController();
    const deps: FullSweepDeps = {
      ...world.deps,
      async openTab(url) {
        await world.deps.openTab(url);
        if (world.opened.length === 2) abort.abort(new Error('stop'));
      },
    };
    const summary = await runFullSweep({
      hubs: [place('a', 'Angel')],
      criteria: CRITERIA,
      intervalMs: 1000,
      signal: abort.signal,
      onProgress: noop,
      deps,
    });
    check('Stop ends the run at the next wait', summary.stopped && world.opened.length === 2, `${world.opened.length} opened`);
    // Two were opened, but the second's record was never read back before the stop — and a page
    // is only "scanned" once it is known to be in.
    check('…and only what was confirmed recorded is counted', summary.pagesScanned === 1, `${summary.pagesScanned} scanned`);
  }
  {
    const world = fakeWorld({ pagesPerHub: { a: 3 } });
    const deps: FullSweepDeps = {
      ...world.deps,
      async openTab(url) {
        if (world.opened.length === 1) throw new Error('refusing to open');
        await world.deps.openTab(url);
      },
    };
    let error = '';
    await runFullSweep({
      hubs: [place('a', 'Angel')],
      criteria: CRITERIA,
      intervalMs: 1000,
      signal: new AbortController().signal,
      onProgress: noop,
      deps,
    }).catch((e: Error) => (error = e.message));
    check('a tab that will not open stops the run with the reason', error === 'refusing to open', error);
  }

  console.log(failures === 0 ? '\nall good' : `\n${failures} failing`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
