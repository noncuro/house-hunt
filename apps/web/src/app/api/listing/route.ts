/** One listing URL, on any site we read -> the listing, read server-side.
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
 *  **The URL the caller sends is never the URL this fetches.** It is offered to every site in
 *  `SITES`, reduced to that site's own id, and the page is rebuilt by that site's `listingUrl` — so
 *  the host and the path come from the adapter and the only thing a caller controls is an id
 *  matching `[A-Za-z0-9-]+`. Take that away and this route is an open proxy: anything that can
 *  reach it can aim a server-side request wherever it likes, including at addresses only this
 *  deployment can see. Adding a site does not widen that: a new adapter adds one more host this can
 *  reach, chosen by us, and `listingUrl` throws on an id it did not shape itself. It is rate-limited
 *  per person below for the same family of reasons — a bug or a retry loop in a caller cannot turn
 *  one action into an unbounded number of outbound requests.
 *
 *  No image is fetched, saved or re-hosted here either: the URLs go back as URLs, because the
 *  photographs belong to whoever took them and are shown from the site's own CDN rather than copied
 *  onto ours.
 *
 *  Moved off the Supabase Edge runtime; `docs/server-side.md` is what
 *  this file was ported against.
 */
import { ListingWithdrawn, siteForUrl, SITES, type Site } from '@house-hunt/core';
import { requireActiveProject } from '@/server/caller';
import { authedRoute, jsonBody } from '@/server/handler';
import { claimHourlyCall, type RateLimited } from '@/server/rate-limit';
import { HttpError } from '@/server/supabase';

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
 *  limit that silently stops existing. The row is the limit — claimed and written in one step, for
 *  the reason `@/server/rate-limit` gives. */
const LIMIT_PER_HOUR = 60;
const KIND = 'fetch_listing';

/** How long to wait for the site before giving up.
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
  /** The site served a page the adapter could not read. Distinct from `withdrawn`, which is a page
   *  shape we understand: this is the one that means the site has changed something, and on
   *  Rightmove it means the extension is about to break too — so it must not be dressed up as
   *  "that flat is gone". */
  | { status: 'unreadable'; rightmoveId: string; message: string }
  | RateLimited;

export const POST = authedRoute(async (request, caller): Promise<Result> => {
  // Adding a flat is only meaningful inside a hunt, and the usage row this writes is charged to
  // one. Neither is a permission check on the property itself: what the caller may write is decided
  // by `record_property` when they record what comes back.
  const projectId = await requireActiveProject(caller);

  const { url } = await jsonBody<{ url?: string }>(request);
  const found = siteForUrl(url ?? '');
  if (!found) {
    throw new HttpError(
      400,
      'not-a-listing',
      `that is not a listing address on a site we read (${SITES.map((s) => s.name).join(', ')}) — a Rightmove one looks like https://www.rightmove.co.uk/properties/88023648`,
    );
  }

  const refused = await claimHourlyCall({
    userId: caller.userId,
    projectId,
    kind: KIND,
    limit: LIMIT_PER_HOUR,
    rightmoveId: found.key,
  });
  if (refused) return refused;
  console.log(`reading listing ${found.key} for ${caller.userId}`);

  return await read(found.site, found.externalId, found.key);
});

async function read(site: Site, externalId: string, key: string): Promise<Result> {
  const url = site.listingUrl(externalId);
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
    // A withdrawn Rightmove listing answers 404 with a full page that still carries a (hollowed-out)
    // model, so the status alone is not the answer — `extract` below is what tells the two apart,
    // from the page's own shape. Anything other than 200 or 404 is the site having a problem, and is
    // thrown rather than returned: it is not a state the interface has a sentence for.
    if (!response.ok && response.status !== 404) {
      throw new Error(`${site.name} returned ${response.status} for ${url}`);
    }
    html = await response.text();
  } catch (e) {
    // A timeout, and only a timeout. `AbortSignal.timeout` rejects with a `TimeoutError`, and
    // catching anything wider would file a DNS failure, a TLS error, a dropped connection or the
    // status thrown just above under a deadline that was never reached — a sentence about the site
    // being slow when it was never spoken to. Everything else goes up as the 500 it is.
    if (e instanceof Error && e.name === 'TimeoutError') {
      return {
        status: 'unreadable',
        rightmoveId: key,
        message: `${site.name} did not answer within ${FETCH_MS / 1000} seconds`,
      };
    }
    throw e;
  }

  try {
    return { status: 'read', listing: site.extract(html, url) };
  } catch (e) {
    if (e instanceof ListingWithdrawn) return { status: 'withdrawn', rightmoveId: key };
    // A 404 with nothing to decode is a listing that is gone — the page a site serves for an id
    // that never existed, or one old enough to have been cleared out.
    if (response.status === 404) return { status: 'withdrawn', rightmoveId: key };
    return {
      status: 'unreadable',
      rightmoveId: key,
      message: e instanceof Error ? e.message : String(e),
    };
  }
}

