import { useEffect, useMemo, useState } from 'react';
import { Hint } from '@house-hunt/ui';
import { Toasts, useToasts } from '@house-hunt/ui';
import { findCards, onPageChange } from '@/lib/cards';
import { sweepableHubs, toSweepHub, type SweepHub } from '@house-hunt/core';
import { send } from '@/lib/messages';
import { readSearchPage, staleAgainst, type SearchPage } from '@/lib/search-page';
import {
  WIDEST_WINDOW,
  nextPageUrl,
  sweepSearchUrl,
  sweepWindow,
  windowLabel,
  type SweepWindowChoice,
} from '@house-hunt/core';
import type { HubSweep, SweepKnowledge, SweepState } from '@house-hunt/core/db';

/** The sweep panel: working systematically through one neighbourhood's search results.
 *
 *  This is a different job from the listing panel and so it is a different panel. The listing
 *  panel answers "what about this flat"; this one answers "have I finished looking at this
 *  neighbourhood, and what is left to do here" — a question about a page, not a property.
 *
 *  Everything it knows comes from `__NEXT_DATA__` on a page the human opened. It builds links;
 *  it never fetches a search. */

/** The class that hides recorded cards. Set on <body> so one toggle moves the whole page, rather
 *  than touching two dozen elements every time the switch flips. */
const HIDING_CLASS = 'rm-sweep-hiding';
const STATE_ATTRIBUTE = 'data-rm-sweep';

export function Sweep() {
  const { toasts, push, dismiss } = useToasts();
  const [result] = useState(() => readSearchPage(document));
  const [knowledge, setKnowledge] = useState<Record<string, SweepKnowledge> | null>(null);
  const [sweeps, setSweeps] = useState<HubSweep[] | null>(null);
  /** The active project's searchable neighbourhoods. Null while it is still being asked — which
   *  is not the same as "this project has none", and not the same as "this search is not one of
   *  ours". All three used to be one silence (design D11). */
  const [hubs, setHubs] = useState<SweepHub[] | null>(null);
  const [stale, setStale] = useState<string[]>([]);
  const [hiding, setHiding] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  /** This hub's sweep after the current page was counted — which pages are in, and whether that
   *  finished it. Replaces the "Mark swept" button: the page you are on was the only thing the
   *  button ever knew, and the panel knows it already. */
  const [progress, setProgress] = useState<HubSweep | null>(null);

  const page = result.ok ? result.page : null;
  const hub = useMemo(() => (page && hubs ? hubFor(page, hubs) : null), [page, hubs]);

  // Which hub was last swept when, for the picker. Read regardless of whether this page is one of
  // our sweeps: an unrecognised search is exactly when you want the list of the real ones.
  useEffect(() => {
    void (async () => {
      // The neighbourhoods are the active project's rows now, not a compile-time list: a second
      // project searching Manchester must not be offered another project's five (design D11).
      const [history, list] = await Promise.all([send({ type: 'sweep:hubs' }), send({ type: 'hubs:list' })]);
      if (history.ok) setSweeps(history.data);
      else push(`Couldn't read the sweep history: ${history.error}`);
      if (list.ok) setHubs(sweepableHubs(list.data).map(toSweepHub));
      else push(`Couldn't read this project's neighbourhoods: ${list.error}`);
    })();
    // `push` is recreated every render; depending on it would re-read forever.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Record every card on the page. This runs once, on load, without being asked: the recording is
  // the cheap, safe half — it writes down what Rightmove already showed us — and making it a
  // button would mean the common case is a page that was looked at and never captured.
  useEffect(() => {
    if (!page || !hub) return;
    void (async () => {
      const reply = await send({
        type: 'sweep:record',
        hub: hub.name,
        cards: page.cards,
        progress: {
          page: page.page,
          totalPages: page.totalPages,
          resultCount: page.resultCount,
          windowDays: page.maxDaysSinceAdded ?? WIDEST_WINDOW,
          locationIdentifier: page.locationIdentifier,
        },
      });
      if (reply.ok) {
        setKnowledge(reply.data.knowledge);
        setProgress(reply.data.sweep);
      } else push(`Couldn't record this page: ${reply.error}`);
    })();
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [page, hub]);

  // Rightmove pages between results without reloading the document, which leaves __NEXT_DATA__
  // describing the page you are no longer on. Watching for ids we have never heard of is how that
  // becomes visible instead of becoming twenty-four wrong rows.
  useEffect(() => {
    if (!page) return;
    const check = () => setStale(staleAgainst(page, [...findCards().keys()]));
    check();
    const observer = onPageChange(check);
    return () => observer.disconnect();
  }, [page]);

  // Paint the cards themselves. The panel says how many are new; the page says which.
  useEffect(() => {
    if (!knowledge) return;
    for (const [id, card] of findCards()) {
      card.setAttribute(STATE_ATTRIBUTE, knowledge[id]?.state ?? 'new');
    }
  }, [knowledge, stale]);

  useEffect(() => {
    document.body.classList.toggle(HIDING_CLASS, hiding);
    return () => document.body.classList.remove(HIDING_CLASS);
  }, [hiding]);

  const counts = useMemo(() => tally(page, knowledge), [page, knowledge]);

  const choice: SweepWindowChoice | null = useMemo(
    () => (hub ? sweepWindow(sweeps?.find((s) => s.hub === hub.name)?.lastSweptAt ?? null) : null),
    [hub, sweeps],
  );

  if (!result.ok) {
    // Fail loudly: a silent sweep panel on a page full of flats reads as "nothing new here".
    return (
      <div className="rm-sweep rm-sweep-broken">
        <strong>Couldn't read this search page.</strong>
        <p>{result.error}</p>
        <p>Nothing has been recorded. Re-check with <code>pnpm check:sweep</code>.</p>
        <Toasts toasts={toasts} dismiss={dismiss} />
      </div>
    );
  }

  if (collapsed) {
    return (
      <div className="rm-sweep rm-sweep-collapsed">
        <button type="button" onClick={() => setCollapsed(false)}>
          Sweep{hub ? ` · ${hub.name}` : ''}
        </button>
      </div>
    );
  }

  const incomplete = counts.new + counts.partial;
  const recorded = knowledge !== null;
  const lastPage = page!.page >= page!.totalPages;

  return (
    <div className="rm-sweep">
      <header className="rm-sweep-head">
        <h2>{hub ? `Sweeping ${hub.name}` : 'Sweep'}</h2>
        <button type="button" className="rm-sweep-hide" onClick={() => setCollapsed(true)} aria-label="Collapse">
          –
        </button>
      </header>

      {/* Three different silences, said as three different sentences. Collapsed into one they
          read as "not one of our hubs" — which is a claim, and two thirds of the time a false
          one. */}
      {hubs === null && <p className="rm-sweep-note rm-sweep-working">Reading this project's neighbourhoods…</p>}

      {hubs?.length === 0 && (
        <p className="rm-sweep-warn">
          This house hunt has no searchable neighbourhoods yet, so nothing here has been recorded.
          Add one in the extension's Settings — it needs a Rightmove location before it can be
          swept.
        </p>
      )}

      {hubs !== null && hubs.length > 0 && !hub && (
        <p className="rm-sweep-warn">
          This search is <strong>{page!.locationName}</strong> ({page!.locationIdentifier}), which is
          not one of this project's neighbourhoods, so nothing here has been recorded. Open one of
          the sweeps below.
        </p>
      )}

      {stale.length > 0 && (
        <p className="rm-sweep-warn">
          These aren't the cards this panel read — Rightmove's own pager swaps them without
          reloading the data underneath, so nothing here describes what you are looking at.{' '}
          <button type="button" className="rm-sweep-link" onClick={() => location.reload()}>
            Reload
          </button>{' '}
          to record this page, and use the button below to page on next time.
        </p>
      )}

      {hub && (
        <>
          <Ready
            recorded={recorded}
            stale={stale.length > 0}
            counted={counts.total}
            page={page!}
            lastPage={lastPage}
          />

          <NextPage page={page!} recorded={recorded && stale.length === 0} />

          <ul className="rm-sweep-counts">
            <li>
              <Hint text="Never opened — we hold only this search card.">
                <strong>{counts.new}</strong> new
              </Hint>
            </li>
            <li>
              <Hint text="Opened, but something is still missing — usually the tab was closed too early.">
                <strong>{counts.partial}</strong> part-filled
              </Hint>
            </li>
            <li>
              <Hint text="Located and analysed — nothing left to fetch.">
                <strong>{counts.complete}</strong> done
              </Hint>
            </li>
          </ul>

          <label className="rm-sweep-toggle">
            <input type="checkbox" checked={hiding} onChange={(e) => setHiding(e.target.checked)} />
            Hide the {counts.complete} we already have
          </label>

          {/* No opener here any more. Filling in is one long run over everything scanned, and
              bolted onto this page it could only ever see the cards in front of it and died the
              moment you paged on — twenty separate unattended runs to sweep five hubs. It lives
              on the shortlist now; this page's job is to scan and to say when it is safe to move
              on. */}
          {incomplete > 0 && (
            <p className="rm-sweep-note">
              {incomplete} on this page {incomplete === 1 ? 'is' : 'are'} not filled in. Open them
              from the Sweep tab of the shortlist once you have finished scanning — it works
              through every hub at once.
            </p>
          )}

          <Progress hub={hub} page={page!} choice={choice} sweep={progress} />
        </>
      )}

      <HubList hubs={hubs} sweeps={sweeps} current={hub} />
      <Toasts toasts={toasts} dismiss={dismiss} />
    </div>
  );
}

/** The "you can turn the page now" signal, asked for by name.
 *
 *  Deliberately the loudest thing in the panel. Its whole job is to be readable from across the
 *  desk, because the alternative is paging on before the write landed and losing a page of
 *  sightings without any error appearing anywhere. */
function Ready({
  recorded,
  stale,
  counted,
  page,
  lastPage,
}: {
  recorded: boolean;
  stale: boolean;
  counted: number;
  page: SearchPage;
  lastPage: boolean;
}) {
  // Not "reload before paging on" any more: that read as an instruction about the future when it
  // is really a statement about now — nothing on screen has been recorded. The warning above it
  // carries the reload.
  if (stale) return <div className="rm-sweep-ready rm-sweep-ready-no">Not recorded — see above</div>;
  if (!recorded) {
    return <div className="rm-sweep-ready rm-sweep-ready-wait">Recording {counted} listings…</div>;
  }
  return (
    <div className="rm-sweep-ready rm-sweep-ready-yes">
      <strong>All {counted} recorded</strong>
      <span>
        page {page.page} of {page.totalPages}
        {lastPage ? ' — this is the last one' : ' — safe to go on'}
      </span>
    </div>
  );
}

/** How far through this hub's sweep you are.
 *
 *  This was a "Mark {hub} swept" button, disabled until the last page and explaining why. Two
 *  things were wrong with that. It asked a human to assert something the data already knew — the
 *  page number is right there — and it only ever knew about the tab it was in, so sweeping a hub
 *  across two sittings meant remembering where you got to.
 *
 *  The pages recorded are now tracked, the hub marks itself swept when they cover all of them, and
 *  this says which are still outstanding. The guard the button existed for survives intact and is
 *  now structural: nothing narrows the next window until every page is in, so a sweep abandoned on
 *  page one leaves the window as wide as it was. */
/** Where to go next, and the reason this panel has a pager at all.
 *
 *  Rightmove's pager is a client-side route change: the cards change, `__NEXT_DATA__` does not, and
 *  the panel correctly refuses to record a page it cannot see. That refusal was firing every time
 *  anyone paged, which turned an honest warning into the normal experience and made the sweep feel
 *  broken. A full navigation has nothing to go stale.
 *
 *  So this is the primary control: recording finishes, and the next thing on screen is where to go.
 *  It is a link rather than a button — middle-click, and knowing where it goes, are both worth
 *  keeping — dressed as the obvious next action. */
function NextPage({ page, recorded }: { page: SearchPage; recorded: boolean }) {
  const next = nextPageUrl(location.href, page.page, page.totalPages);

  if (next === null) {
    return (
      <p className="rm-sweep-note">
        Page {page.page} of {page.totalPages} — the last one. Nothing more to scan here.
      </p>
    );
  }
  // Paging before the write lands would leave this page recorded against nothing.
  if (!recorded) return <p className="rm-sweep-note">Recording this page…</p>;

  return (
    <a className="rm-sweep-next" href={next}>
      Go to page {page.page + 1} of {page.totalPages} →
      <small>Use this rather than Rightmove's pager, which doesn't reload the data.</small>
    </a>
  );
}

function Progress({
  hub,
  page,
  choice,
  sweep,
}: {
  hub: SweepHub;
  page: SearchPage;
  choice: SweepWindowChoice | null;
  sweep: HubSweep | null;
}) {
  if (!sweep) {
    return (
      <div className="rm-sweep-finish">
        <small>Recording this page…</small>
      </div>
    );
  }

  const seen = new Set(sweep.pagesSeen);
  const outstanding = Array.from({ length: page.totalPages }, (_, i) => i + 1).filter((n) => !seen.has(n));

  return (
    <div className="rm-sweep-finish">
      {outstanding.length === 0 ? (
        <p className="rm-sweep-done">
          ✓ {hub.name} swept — all {page.totalPages} {page.totalPages === 1 ? 'page' : 'pages'} in.
        </p>
      ) : (
        // The pager above says where to go next; this says how much of the hub is done, which is
        // the thing you cannot see from the page you are on. Enumerating the outstanding pages was
        // just the complement of a number, and read as a list of chores.
        <Hint text={`${hub.name} is swept only when every page is recorded, so nothing narrows the next search's window yet.`}>
          <strong>
            {sweep.pagesSeen.length} of {page.totalPages} pages recorded
          </strong>
        </Hint>
      )}
      {choice && <small className="rm-sweep-window">This search should cover {windowLabel(choice)}.</small>}
    </div>
  );
}

/** The other hubs, so an unrecognised search has somewhere to go. Deliberately a shorter list
 *  than the shortlist's Sweep view, which is the proper home for choosing what to sweep next —
 *  this one exists for the case where you have landed on a search that is not one of ours. */
function HubList({
  hubs,
  sweeps,
  current,
}: {
  hubs: SweepHub[] | null;
  sweeps: HubSweep[] | null;
  current: SweepHub | null;
}) {
  if (hubs === null) return null; // the panel above already says they are being read
  if (hubs.length === 0) {
    return (
      <details className="rm-sweep-hubs" open>
        <summary>All sweeps</summary>
        <p className="rm-sweep-note">
          No neighbourhoods in this house hunt yet. Add one in Settings and it will appear here.
        </p>
      </details>
    );
  }

  return (
    <details className="rm-sweep-hubs" open={current === null}>
      <summary>All sweeps</summary>
      <ul>
        {hubs.map((hub) => {
          const last = sweeps?.find((s) => s.hub === hub.name)?.lastSweptAt ?? null;
          const choice = sweepWindow(last);
          const url = sweepSearchUrl({ hub, days: choice.days });
          return (
            <li key={hub.name} className={hub.name === current?.name ? 'rm-sweep-here' : undefined}>
              {url ? (
                <a href={url}>{hub.name}</a>
              ) : (
                // Never build a URL from an identifier we could not verify — it would return a
                // page of plausible flats in the wrong place, which is unfalsifiable by eye.
                <Hint text="No verified Rightmove location — no safe search URL to offer.">
                  <span className="rm-sweep-nourl">{hub.name}</span>
                </Hint>
              )}
              <small>{last ? `swept ${describeAgo(last)}, now ${choice.days}d` : 'never swept'}</small>
            </li>
          );
        })}
      </ul>
    </details>
  );
}

/** Which hub this page is a search for, matched on what the page itself resolved rather than on
 *  what the URL asked for — a redirect or a stale bookmark would make those differ. */
function hubFor(page: SearchPage, hubs: SweepHub[]): SweepHub | null {
  return hubs.find((hub) => hub.rightmove?.locationIdentifier === page.locationIdentifier) ?? null;
}

function tally(
  page: SearchPage | null,
  knowledge: Record<string, SweepKnowledge> | null,
): { total: number; new: number; partial: number; complete: number } {
  const total = page?.cards.length ?? 0;
  if (!page || !knowledge) return { total, new: total, partial: 0, complete: 0 };

  const counts: Record<SweepState, number> = { new: 0, partial: 0, complete: 0 };
  for (const card of page.cards) counts[knowledge[card.rightmoveId]?.state ?? 'new']++;
  return { total, ...counts };
}

function describeAgo(iso: string): string {
  const hours = (Date.now() - new Date(iso).getTime()) / 3600_000;
  if (!Number.isFinite(hours)) return 'at some point';
  if (hours < 1) return 'just now';
  if (hours < 24) return `${Math.round(hours)}h ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? 'yesterday' : `${days}d ago`;
}
