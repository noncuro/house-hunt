/** Two things a route may be, and no third.
 *
 *  ## The gate, which the platform used to hold
 *
 *  On Supabase every function but one ran behind `verify_jwt`, set in `config.toml`, and the single
 *  exception was a line somebody had written on purpose: `[functions.password] verify_jwt = false`.
 *  A function could not be accidentally public, because being public took an edit to a file that
 *  had nothing else in it.
 *
 *  Vercel has no such gate. Nothing sits in front of a route, so a handler that forgets to resolve
 *  its caller is open to the internet, and it is open in the quietest possible way: it works. So the
 *  gate moves into the only place that cannot be skipped by forgetting — the wrapper every route has
 *  to use to exist at all. `authedRoute` resolves the caller before the work runs and hands it in;
 *  `publicRoute` is the deliberate exception, and it takes a sentence saying why, which
 *  `pnpm check:routes` reads back and holds against a list. Being public is once again an edit
 *  somebody has to mean.
 *
 *  Middleware was the other candidate and is weaker. A middleware that checks a token is *present*
 *  still lets a route that forgot its caller run for anyone holding any string; a middleware that
 *  verifies properly does a GoTrue round trip that the route then repeats, on every request, for the
 *  chatty functions as much as the slow ones. The check gives the guarantee at build time and costs
 *  nothing at run time.
 *
 *  Note what this is not: `requireCaller` verifies the token by asking GoTrue rather than decoding
 *  it, deliberately (see `caller.ts`), and that has always been the real authority. This makes it
 *  unskippable; it does not make it stronger.
 *
 *  ## The reply convention, which is a contract and not a house style
 *
 *  `_shared/http.ts`'s `serve()` established it and the clients read it back out: a non-2xx means
 *  the caller got something wrong or something broke, and *every product-level outcome* — `capped`,
 *  `at-capacity`, `rate-limited`, `already-invited`, `in-progress`, `withdrawn`, `unreadable`,
 *  `insufficient` — is a 200 with a `status` field. `describeInvokeError` in
 *  `packages/core/src/db/travel.ts` and `refusalFrom` in `packages/core/src/db/supabase.ts` both
 *  parse the body back out of the failure, so a route that answers 400 where the Edge Function
 *  answered 200 turns a sentence somebody can act on into "something went wrong".
 */
import { type Caller, requireCaller } from './caller';
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

/** Mirrors `serve()`: 405 for anything but POST, `HttpError` at its own status, and everything else
 *  a 500 that still says what happened — a blank 500 is the failure mode this codebase calls
 *  "blanks look like real data". */
function route<T>(work: (request: Request) => Promise<T>): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    try {
      if (request.method !== 'POST') {
        throw new HttpError(405, 'method-not-allowed', `${request.method} is not allowed here`);
      }
      return reply(200, await work(request));
    } catch (e) {
      if (e instanceof HttpError) {
        console.error(`${request.url}: ${e.code}: ${e.message}`);
        return reply(e.status, { code: e.code, error: e.message });
      }
      const message = e instanceof Error ? e.message : String(e);
      console.error(`${request.url}: ${message}`);
      return reply(500, { code: 'failed', error: message });
    }
  };
}

function reply(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}
