/** Two things a route may be, and no third.
 *
 *  Nothing sits in front of a route here, so a handler that forgets to resolve its caller is open
 *  to the internet in the quietest possible way: it works. The gate therefore lives in the one
 *  place that cannot be skipped by forgetting — the wrapper every route has to use to exist at all.
 *  `authedRoute` resolves the caller before the work runs and hands it in; `publicRoute` is the
 *  deliberate exception and takes a sentence saying why, which `pnpm check:routes` reads back and
 *  holds against a list. `requireCaller` is still the real authority (see `caller.ts`); this only
 *  makes it unskippable.
 *
 *  The reply convention is a contract and not a house style: a non-2xx means the caller got
 *  something wrong or something broke, and *every product-level outcome* — `capped`, `at-capacity`,
 *  `rate-limited`, `already-invited`, `in-progress`, `withdrawn`, `unreadable`, `insufficient` — is
 *  a 200 with a `status` field. `describeInvokeError` in `packages/core/src/db/travel.ts` and
 *  `refusalFrom` in `packages/core/src/db/supabase.ts` parse the body back out of the failure, so a
 *  route that answers 400 where a 200 is expected turns a sentence somebody can act on into
 *  "something went wrong".
 *
 *  Why the gate is here rather than in the platform or in middleware: `docs/vercel-migration.md`.
 */
import { type Caller, requireCaller } from './caller';
import { corsHeaders, preflight } from './cors';
import { HttpError } from './supabase';

export async function jsonBody<T>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch {
    throw new HttpError(400, 'bad-request', 'the body must be JSON');
  }
}

/** A route that needs a signed-in caller, which is all of them but the stated exceptions. The
 *  caller is resolved before the work runs, so the work cannot see an unauthenticated request. */
export function authedRoute<T>(
  work: (request: Request, caller: Caller) => Promise<T>,
): (request: Request) => Promise<Response> {
  return route((request) => requireCaller(request).then((caller) => work(request, caller)));
}

/** A route that deliberately answers without a session. `why` is not decoration: `check:routes`
 *  requires every one of these to be on its list, and the list is the whole record of what this
 *  deployment exposes to anyone who finds the URL. */
export function publicRoute<T>(
  why: string,
  work: (request: Request) => Promise<T>,
): (request: Request) => Promise<Response> {
  if (!why.trim()) throw new Error('publicRoute needs a reason — it goes in the record of what is open');
  return route(work);
}

/** The `OPTIONS` a cross-origin caller sends first.
 *
 *  A third kind of export, and named rather than left as a bare function on purpose: `check:routes`
 *  holds every exported HTTP method to one of these builders, and an `OPTIONS` that escaped that
 *  rule would be the one method nobody was checking. It answers headers only — there is no caller
 *  to resolve, because a preflight carries no credentials by design.
 *
 *  Only the routes with a non-page caller export one. A same-origin request is never preflighted,
 *  so `predict` and `listing` need none and do not have one. */
export function preflightRoute(): (request: Request) => Promise<Response> {
  return async (request: Request) => preflight(request);
}

/** Mirrors `serve()`: 405 for anything but POST, `HttpError` at its own status, and everything else
 *  a 500 that still says what happened — a blank 500 is the failure mode this codebase calls
 *  "blanks look like real data".
 *
 *  Every reply carries the CORS headers, including the failures. A refusal without them is read by
 *  the browser as a CORS error and the body — which says what was actually wrong — is thrown away
 *  before any code sees it, so the caller gets "something went wrong" about a 403 that named the
 *  problem. For a same-origin caller the headers are inert. */
function route<T>(work: (request: Request) => Promise<T>): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    const cors = corsHeaders(request.headers.get('Origin'));
    try {
      if (request.method !== 'POST') {
        throw new HttpError(405, 'method-not-allowed', `${request.method} is not allowed here`);
      }
      return reply(200, await work(request), cors);
    } catch (e) {
      if (e instanceof HttpError) {
        console.error(`${request.url}: ${e.code}: ${e.message}`);
        return reply(e.status, { code: e.code, error: e.message }, cors);
      }
      const message = e instanceof Error ? e.message : String(e);
      console.error(`${request.url}: ${message}`);
      return reply(500, { code: 'failed', error: message }, cors);
    }
  };
}

function reply(status: number, payload: unknown, cors: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...cors },
  });
}
