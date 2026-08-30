/** The per-user hourly limit on the two routes that fetch Rightmove.
 *
 *  Both of them held the same shape, written out twice: count the last hour's `api_usage` rows for
 *  this user and kind, decide, then insert one. Two statements, so requests arriving together all
 *  read the same count and all proceed — the overshoot bounded by concurrency rather than by the
 *  limit (#117). `claim_hourly_call` makes the read and the write one step under an advisory lock;
 *  the argument for that shape is in the migration beside it.
 *
 *  This is not the spend cap and must not become it. `claim_analysis` guards money and hands back a
 *  reservation somebody has to release, because an overshoot there is a bill. These calls are free:
 *  what they protect is the standing no-crawl rule — one request, for one thing, initiated by a
 *  person — so a claim either takes a slot or does not, and a refusal is a stated outcome rather
 *  than a failure.
 */
import { rpc } from './supabase';

/** What a refused claim looks like on the wire. A 200 with a `status`, like every other
 *  product-level outcome — see `@/server/handler`. */
export interface RateLimited {
  status: 'rate-limited';
  used: number;
  limit: number;
  retry_after_seconds: number;
}

interface Claim {
  status: 'claimed' | 'rate-limited';
  used: number;
  limit: number;
}

/** Take one of the caller's hourly slots, or answer why not.
 *
 *  The slot is spent before the request goes out rather than after it, so a fetch that fails still
 *  costs one. Charged afterwards, every failure would be free and the limit unreachable by
 *  retrying — which is the caller this exists to stop. */
export async function claimHourlyCall(options: {
  userId: string;
  projectId: string;
  kind: string;
  limit: number;
  rightmoveId?: string;
}): Promise<RateLimited | null> {
  const claim = await rpc<Claim>('claim_hourly_call', {
    p_user_id: options.userId,
    p_project_id: options.projectId,
    p_kind: options.kind,
    p_limit: options.limit,
    p_rightmove_id: options.rightmoveId ?? null,
  });
  if (claim?.status === 'claimed') return null;
  if (claim?.status === 'rate-limited') {
    return { status: 'rate-limited', used: claim.used, limit: claim.limit, retry_after_seconds: 3600 };
  }
  // Neither outcome means the function is not the one this expects. Loudly, rather than falling
  // through to "allowed": a limiter that fails open on a reply it cannot read is not a limiter.
  throw new Error(`claim_hourly_call answered ${JSON.stringify(claim)}`);
}
