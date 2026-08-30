/** Plumbing every Edge Function here needs: CORS, JSON replies, and the service-role REST client.
 *
 *  Hand-written, unlike `analysis.ts` and `png.ts` in this directory, which are generated copies of
 *  `src/lib/` and carry a GENERATED header. `tools/sync-edge-function.ts` only writes and checks
 *  those two, so a file like this one sitting beside them is left alone.
 *
 *  **The reply convention, which the extension depends on.** A non-2xx status means the caller got
 *  something wrong or something broke: no session (401), no standing (403), bad input (400), a
 *  failure (500). Every outcome the *product* has a story for comes back 200 with a `status` field
 *  — capped, at-capacity, rate-limited, already-invited, in-progress. Those are states the
 *  interface explains rather than errors it apologises for, which is the whole of the fail-loudly
 *  rule applied to money and quotas: a generic failure just gets the button pressed again.
 */

export const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
export const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

/** A refusal with an HTTP status and a stable machine-readable code. The message is for the log and
 *  for a human reading a response body; the code is what the extension switches on. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message?: string,
  ) {
    super(message ?? code);
  }
}

/** Fail at the door rather than three awaits in, where the error reads as a database problem. */
export function requireEnv(values: Record<string, string | undefined>): void {
  for (const [name, value] of Object.entries(values)) {
    if (!value) throw new Error(`${name} is not set on this function`);
  }
}

/** Who may call these functions from a browser.
 *
 *  Three kinds of caller, and none of them is a fixed string. The extension's service worker has
 *  origin `chrome-extension://<id>`, and the id differs between the unpacked and store builds of
 *  the same code, so it is matched by scheme. A content script's fetch carries Rightmove's origin.
 *  And since the app moved out of the extension, the website calls these too — its origin comes
 *  from `WEB_APP_ORIGIN` on the function rather than being hardcoded, so a preview deploy and
 *  production do not need different code.
 *
 *  Anything else gets `null`, which is a refusal the browser enforces. Note this is a convenience
 *  rather than a control: CORS stops a *page* on another origin from reading the reply, and the
 *  thing actually gating these functions is `requireCaller` (design D10). */
/** Plural, comma-separated, because the site answers on more than one name and every one of them
 *  is the real site: a custom domain, plus the `vercel.app` URL Vercel keeps alongside it and which
 *  the extension is built against.
 *
 *  It was singular, and the consequence was invisible in the worst way. The custom domain served the
 *  whole app and was refused by every function it called, so the flats still loaded — supabase-js
 *  talks to PostgREST directly and is not governed by this — while every travel time spun for ever
 *  and adding a flat failed. That reads as a slow app rather than a broken one, which is the exact
 *  shape of failure this codebase refuses elsewhere. */
const WEB_APP_ORIGINS = (Deno.env.get('WEB_APP_ORIGIN') ?? '')
  .split(',')
  .map((origin) => origin.trim())
  .filter((origin) => origin !== '');

export function cors(origin: string | null): Record<string, string> {
  const allowed =
    origin &&
    (origin.startsWith('chrome-extension://') ||
      origin === 'https://www.rightmove.co.uk' ||
      WEB_APP_ORIGINS.includes(origin))
      ? origin
      : 'null';
  return {
    'Access-Control-Allow-Origin': allowed,
    // The headers supabase-js actually sends, which is more than the three obvious ones. It adds
    // `x-client-info` (its own version string) to every request and `x-retry-count` to retried
    // ones, and a browser refuses the whole preflight over a single unlisted header — so the call
    // never happens and the failure arrives as a CORS message about a header nobody wrote.
    //
    // That was live on the deployed website: every travel lookup was refused before it left the
    // browser. It reads as an origin problem and is not one; the origin was allowed all along.
    // The list is supabase-js's own (`@supabase/supabase-js/cors`), copied rather than imported
    // because these functions run on Deno with no node_modules — so when the SDK adds a header,
    // this is the line that has to learn about it.
    'Access-Control-Allow-Headers': 'content-type, authorization, apikey, x-client-info, x-retry-count',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    Vary: 'Origin',
  };
}

export function json(body: unknown, status: number, headers: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, 'content-type': 'application/json' },
  });
}

/** The one entry point each function's `Deno.serve` hands its request to, so the OPTIONS reply, the
 *  method check and the error mapping are written once. `handler` returns the body; throwing an
 *  `HttpError` is how it refuses. */
export function serve(handler: (request: Request) => Promise<unknown>): void {
  Deno.serve(async (request) => {
    const headers = cors(request.headers.get('origin'));
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    if (request.method !== 'POST') return json({ code: 'method-not-allowed' }, 405, headers);

    try {
      return json(await handler(request), 200, headers);
    } catch (e) {
      if (e instanceof HttpError) {
        console.warn(`refused (${e.status} ${e.code}): ${e.message}`);
        return json({ code: e.code, error: e.message }, e.status, headers);
      }
      const message = e instanceof Error ? e.message : String(e);
      console.error('failed:', message);
      return json({ code: 'failed', error: message }, 500, headers);
    }
  });
}

/** Read the JSON body, or refuse. A malformed body is the caller's mistake, not a 500. */
export async function body<T>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch {
    throw new HttpError(400, 'bad-request', 'the body must be JSON');
  }
}

/** The service-role key, not the publishable one: these run on the server, and the writes they make
 *  are exactly the ones RLS deliberately grants to nobody else (design D4). */
export async function rest<T = unknown>(
  path: string,
  options: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<T> {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: options.method ?? 'GET',
    headers: {
      apikey: SERVICE_KEY!,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new PostgrestError(response.status, `supabase ${path}: ${response.status} ${text.slice(0, 300)}`);
  }
  return (text ? JSON.parse(text) : null) as T;
}

/** Kept distinguishable so a caller can tell a unique-violation apart from a real failure and turn
 *  it into a stated result. PostgREST answers a constraint violation with 409. */
export class PostgrestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Call a `SECURITY DEFINER` function. Every one of these is granted to `service_role` alone. */
export function rpc<T = unknown>(name: string, args: Record<string, unknown>): Promise<T> {
  return rest<T>(`rpc/${name}`, { method: 'POST', body: args });
}

/** PostgREST filters go in the query string, so anything interpolated into one has to be escaped or
 *  a value containing a comma or a parenthesis changes what the filter means. */
export function eq(value: string): string {
  return encodeURIComponent(value);
}
