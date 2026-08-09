import './spend.css';
import type { AnalysisRequest, SpendScope, SpendSummary } from '@/lib/messages';

// ------------------------------------------------------------------------------------------------
// What the analysis budget costs, and what it looks like when it runs out (design D9).
//
// One renderer for both surfaces. The panel says it about the listing in front of you and the
// shortlist says it about the month, and they must not disagree about the numbers, the scope or
// the reset date — a limit on someone else's money is the last thing two views should phrase two
// ways.
// ------------------------------------------------------------------------------------------------

/** Above this share of either cap, the shortlist and the panel warn. The first sign of a limit
 *  should not be a listing that quietly refuses to analyse. */
export const WARN_AT = 0.8;

/** "1 September" — when a month's spend goes back to zero. The boundary is Europe/London, which
 *  is what every other date in this project uses. */
export function resetLabel(iso: string): string {
  const at = new Date(iso);
  if (!Number.isFinite(at.getTime())) return 'the start of next month';
  return at.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', timeZone: 'Europe/London' });
}

export function money(usd: number): string {
  return `$${usd.toFixed(2)}`;
}

/** Whichever cap is closest to being hit, once it is worth mentioning. Both are checked because
 *  either can bind first, and the one that binds is the only one worth a sentence. */
export function pressingScope(
  summary: SpendSummary,
): { scope: 'project' | 'user'; spend: SpendScope; share: number } | null {
  const candidates: Array<{ scope: 'project' | 'user'; spend: SpendScope; share: number }> = (
    [
      { scope: 'project' as const, spend: summary.project },
      { scope: 'user' as const, spend: summary.user },
    ]
  )
    .filter((c) => c.spend.capUsd > 0)
    .map((c) => ({ ...c, share: c.spend.spentUsd / c.spend.capUsd }));

  const worst = candidates.sort((a, b) => b.share - a.share)[0];
  return worst && worst.share >= WARN_AT ? worst : null;
}

const SCOPE_WORD: Record<'project' | 'user', string> = {
  project: "this project's",
  user: 'your personal',
};

/** The 80% warning. Renders nothing when there is nothing to warn about — the one place in this
 *  file where silence is right, because a budget with room in it is not news. */
export function SpendWarning({ summary }: { summary: SpendSummary | null }) {
  const pressing = summary ? pressingScope(summary) : null;
  if (!pressing) return null;

  const { scope, spend } = pressing;
  const left = Math.max(0, spend.capUsd - spend.spentUsd);
  return (
    <div className="rm-spend-warning" data-testid="spend-warning">
      💷 {money(spend.spentUsd)} of {SCOPE_WORD[scope]} {money(spend.capUsd)} monthly photo-analysis
      budget is spent — {money(left)} left until {resetLabel(spend.resetsAt)}.
    </div>
  );
}

/** The cap, hit. Not an error and not a blank: the budget is used up, here is when it comes back,
 *  and here is the one thing that is missing because of it. Everything free keeps working —
 *  travel times, nearest stations, extraction, verdicts and sweeps are all unaffected. */
export function CappedNotice({ capped }: { capped: Extract<AnalysisRequest, { status: 'capped' }> }) {
  return (
    <div className="rm-capped" data-testid="capped">
      <strong>No photo analysis this month.</strong> {SCOPE_WORD[capped.scope]}{' '}
      {money(capped.capUsd)} budget is used up ({money(capped.spentUsd)} spent). It resets on{' '}
      {resetLabel(capped.resetsAt)}.
      <div className="rm-capped-rest">
        Everything else here is unaffected: travel times, stations, the listing itself, verdicts and
        sweeps all cost nothing. Only the photo findings are missing.
      </div>
    </div>
  );
}
