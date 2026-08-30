/** One Rightmove listing URL -> the listing, read server-side.
 *
 *  This exists so a phone can add a flat. Everywhere else the listing arrives from a content script
 *  standing on the page the reader opened, and there is no content script on a phone — Chrome for
 *  Android and every iOS browser load no extensions at all. Without this, the whole capture half of
 *  the product is a desktop feature and the app on a phone is a viewer of what somebody else added.
 *
 *  What comes back is a `Listing` and nothing else. The caller records it under their own project
 *  with `record_property`, exactly as the extension does — this route holds no project, writes no
 *  property, and is not a way to reach one. It reads a page and decodes it.
 *
 *  ---------------------------------------------------------------------------------------------
 *  THE SECOND PLACE IN THIS SYSTEM THAT FETCHES RIGHTMOVE, AND THE NO-CRAWL RULE IS NOT RELAXED
 *  FOR IT EITHER.
 *
 *  `AGENTS.md`: *read pages the user opened; never crawl*. Read the block at the top of
 *  `supabase/functions/resolve-location/index.ts` — the argument is the same one and it is the
 *  reason both of these are allowed to exist. The shape of the request is what keeps it inside the
 *  rule:
 *
 *    - **one** request, for **one** listing, per invocation. Never a list, never a loop.
 *    - **initiated by a person** who has just pasted or shared that exact URL, in the moment they
 *      did it. Never on a schedule, never in the background, never as a warm-up, and never
 *      speculatively over a sweep's sightings — a sighting is a card somebody's own search returned,
 *      and turning that list into fetches here is precisely the crawl this rule forbids. The paced
 *      opener in the extension exists because opening those pages *in front of the reader* is the
 *      only way we do that.
 *    - **the listing page itself**, the same document their browser would get, not an API.
 *    - **rate-limited per person** below, so a bug in a caller cannot turn a hand action into a
 *      loop.
 *
 *  Two things follow from that and are enforced rather than intended: the URL is reduced to an id
 *  by `rightmoveListingId` and the page is rebuilt from the id, so nothing a caller sends can steer
 *  this at another host or another path; and no image is fetched, saved or re-hosted here — the
 *  URLs go back as URLs, because Rightmove's photographs are shown from Rightmove's CDN and never
 *  from us.
 *  ---------------------------------------------------------------------------------------------
 *
 *  Moved off the Supabase Edge runtime by `docs/vercel-migration.md`; the checklist there is what
 *  this file was ported against.
 */
import { listingFromHtml, ListingWithdrawn, listingUrl, rightmoveListingId } from '@house-hunt/core';
import { requireActiveProject } from '@/server/caller';
import { authedRoute, jsonBody } from '@/server/handler';
import { eq, HttpError, rest } from '@/server/supabase';

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

/** Node, not Edge. Nothing here needs Node specifically; it is the same choice `predict` made, so
 *  that every route on this deployment fails and logs the same way rather than two ways. */
export const runtime = 'nodejs';

/** Seconds. The work is one outbound request under a 15-second deadline plus two PostgREST calls,
 *  so this is roughly four times the worst case that can still return an answer — a ceiling for the
 *  platform to kill a wedged invocation on, not a budget anything spends. */
export const maxDuration = 60;

/** Never prerendered, never cached: it reads a live page and writes a usage row. */
export const dynamic = 'force-dynamic';

/** Sixty an hour per person. Adding flats by hand on a phone is a bursty activity — an evening
 *  working through a saved-links list is real — so this is well above what a person does and far
 *  below anything that would read as traffic. The extension's own capture does not pass through
 *  here at all, so this limit is only ever met by hand-adding.
 *
 *  Counted out of `api_usage` rather than held in memory, and that is not a detail of the old
 *  runtime that stopped mattering on this one: a Vercel function instance is recycled without
 *  warning and several may serve the same person at once, so a counter in a module variable is a
 *  limit that silently stops existing. The row is the limit. */
const LIMIT_PER_HOUR = 60;
const KIND = 'fetch_listing';

/** How long to wait for Rightmove before giving up.
 *
 *  A `fetch` with no signal waits as long as the other end keeps the socket open, and the only thing
 *  that ends it is the platform killing the whole invocation — at which point the caller gets a
 *  generic failure with nothing in it about what was slow. Fifteen seconds is far above a listing
 *  page's real cost and well below anything a person will sit through with "Reading…" on screen. */
const FETCH_MS = 15_000;

type Result =
  | { status: 'read'; listing: unknown }
  /** The agent has taken it down. A fact about the flat rather than a failure of ours, so it comes
   *  back 200 with a name the interface can explain — the reply convention in `@/server/handler`. */
  | { status: 'withdrawn'; rightmoveId: string }
  /** Rightmove served a page with no model in it. Distinct from `withdrawn`, which is a page shape
   *  we understand: this is the one that means Rightmove has changed something and the extension is
   *  about to break too, so it must not be dressed up as "that flat is gone". */
  | { status: 'unreadable'; rightmoveId: string; message: string }
  | { status: 'rate-limited'; used: number; limit: number; retry_after_seconds: number };

export const POST = authedRoute(async (request, caller): Promise<Result> => {
  // Adding a flat is only meaningful inside a hunt, and the usage row this writes is charged to
  // one. Neither is a permission check on the property itself: what the caller may write is decided
  // by `record_property` when they record what comes back.
  const projectId = await requireActiveProject(caller);

  const { url } = await jsonBody<{ url?: string }>(request);
  const id = rightmoveListingId(url ?? '');
  if (!id) {
    throw new HttpError(
      400,
      'not-a-listing',
      'that is not a Rightmove listing address — it should look like https://www.rightmove.co.uk/properties/88023648',
    );
  }

  const used = await recentFetches(caller.userId);
  if (used >= LIMIT_PER_HOUR) {
    return { status: 'rate-limited', used, limit: LIMIT_PER_HOUR, retry_after_seconds: 3600 };
  }
  // Before the request goes out, so a fetch that fails still spends its slot — charged after, every
  // failure would be free and the limit unreachable by retrying.
  await note(projectId, caller.userId, id);

  return await read(id);
});

async function read(id: string): Promise<Result> {
  const url = listingUrl(id);
  // The single request. Read the block at the top of this file before adding a second one.
  //
  // The fetch and the body read are inside one deadline because `AbortSignal.timeout` *is* one: it
  // covers the whole exchange rather than just the headers. So a page whose headers arrive promptly
  // and whose body then stalls — which is what a slow listing page actually looks like — rejects
  // here at `.text()`, not at `fetch`. Guarding only the fetch left that case, the commonest of the
  // two, falling through to the generic 500 that this whole block exists to avoid.
  let response: Response;
  let html: string;
  try {
    response = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(FETCH_MS),
      // Next caches `fetch` in server code by default, and a cached listing page is this route
      // answering about a flat as it was rather than as it is — including answering `read` for one
      // that has since been withdrawn.
      cache: 'no-store',
    });
    // A withdrawn listing answers 404 with a full page that still carries a (hollowed-out) model,
    // so the status alone is not the answer — `listingFromHtml` below is what tells the two apart,
    // from the page's own shape. Anything other than 200 or 404 is Rightmove having a problem, and
    // is thrown rather than returned: it is not a state the interface has a sentence for.
    if (!response.ok && response.status !== 404) {
      throw new Error(`rightmove returned ${response.status} for ${url}`);
    }
    html = await response.text();
  } catch (e) {
    // A timeout, and only a timeout. `AbortSignal.timeout` rejects with a `TimeoutError`, and
    // catching anything wider would file a DNS failure, a TLS error, a dropped connection or the
    // status thrown just above under a deadline that was never reached — a sentence about Rightmove
    // being slow when it was never spoken to. Everything else goes up as the 500 it is.
    if (e instanceof Error && e.name === 'TimeoutError') {
      return {
        status: 'unreadable',
        rightmoveId: id,
        message: `rightmove did not answer within ${FETCH_MS / 1000} seconds`,
      };
    }
    throw e;
  }

  try {
    return { status: 'read', listing: listingFromHtml(html, url) };
  } catch (e) {
    if (e instanceof ListingWithdrawn) return { status: 'withdrawn', rightmoveId: id };
    // A 404 with nothing to decode is a listing that is gone — the page Rightmove serves for an id
    // that never existed, or one old enough to have been cleared out.
    if (response.status === 404) return { status: 'withdrawn', rightmoveId: id };
    return {
      status: 'unreadable',
      rightmoveId: id,
      message: e instanceof Error ? e.message : String(e),
    };
  }
}

async function recentFetches(userId: string): Promise<number> {
  const since = new Date(Date.now() - 3600_000).toISOString();
  const rows = await rest<Array<{ id: number }>>(
    `api_usage?user_id=eq.${eq(userId)}&kind=eq.${KIND}&occurred_at=gt.${eq(since)}&select=id`,
  );
  return rows.length;
}

async function note(projectId: string, userId: string, rightmoveId: string): Promise<void> {
  await rest('api_usage', {
    method: 'POST',
    body: {
      project_id: projectId,
      user_id: userId,
      kind: KIND,
      // Costs nothing, so it must sum to nothing: the row exists to be counted by the limiter
      // above, and a non-zero cost here would move a spend cap that has nothing to do with it.
      // Inserted with the service role rather than through `record_api_usage`, which raises without
      // a `model_price` row and would turn the limiter into an outage — same note as
      // `resolve-location`.
      cost_usd: 0,
      rightmove_id: rightmoveId,
      input_tokens: 0,
      cached_input_tokens: 0,
      output_tokens: 0,
    },
  });
  console.log(`reading listing ${rightmoveId} for ${userId}`);
}
