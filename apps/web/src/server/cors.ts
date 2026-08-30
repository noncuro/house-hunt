/** Who may read a route's reply from another origin.
 *
 *  `predict` and `listing` needed none of this: they are called by the website's own page, and a
 *  same-origin request is never preflighted and never CORS-checked. These four are different — the
 *  extension's background worker and its content scripts call them, and both are cross-origin to
 *  the site.
 *
 *  What is allowed, and why each:
 *
 *  - **`chrome-extension://` by scheme.** The unpacked build and the store build of the same code
 *    have different ids, so matching an id would allow one and refuse the other — and the refusal
 *    would arrive as a CORS message about the extension somebody had just been told to install.
 *    This is not a hole: the scheme cannot be forged by a page, because a browser sets the `Origin`
 *    header itself and a page on the web can never present one.
 *  - **`https://www.rightmove.co.uk` exactly.** A content script's fetch carries the page's origin,
 *    not the extension's.
 *
 *  What is deliberately *not* here is the site's own origins. `WEB_APP_ORIGIN` existed on the Edge
 *  Functions because every caller of theirs was cross-origin, including the website — and it was
 *  singular for a while, which meant the custom domain served the whole app and was refused by every
 *  function it called: flats loaded (supabase-js talks to PostgREST directly and is not governed by
 *  this) while travel times spun for ever. On Vercel the page and the route are the same origin, so
 *  there is nothing to allow and no variable to get wrong. A preview deployment works for the same
 *  reason, with no configuration at all.
 *
 *  This is a convenience rather than a control. CORS stops a *page* on another origin from reading
 *  the reply; what actually gates these routes is `requireCaller` in `authedRoute` (design D10).
 */

const RIGHTMOVE = 'https://www.rightmove.co.uk';

export function corsHeaders(origin: string | null): Record<string, string> {
  const allowed =
    origin && (origin.startsWith('chrome-extension://') || origin === RIGHTMOVE) ? origin : 'null';
  return {
    'Access-Control-Allow-Origin': allowed,
    // supabase-js's own list, and more than the three obvious ones: it adds `x-client-info` to every
    // request and `x-retry-count` to retried ones. A browser refuses the whole preflight over a
    // single unlisted header, so the call never happens and the failure arrives as a CORS message
    // about a header nobody wrote. That was live on the deployed website once — every travel lookup
    // refused before it left the browser, reading as an origin problem it was not.
    //
    // `callRoute` sends only `content-type` and `authorization`, but the list stays complete: the
    // extension still reaches PostgREST through supabase-js, and a route these calls migrate to
    // later would inherit a shorter list nobody remembered to lengthen.
    'Access-Control-Allow-Headers': 'content-type, authorization, apikey, x-client-info, x-retry-count',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    // Without this a shared cache can serve one origin's allowance to another, which fails closed
    // and confusingly: the extension is refused with the content script's origin in the header.
    Vary: 'Origin',
  };
}

/** The preflight. 204 with the headers and no body — the browser reads only the headers, and a body
 *  here is bytes nobody looks at. */
export function preflight(request: Request): Response {
  return new Response(null, { status: 204, headers: corsHeaders(request.headers.get('Origin')) });
}
