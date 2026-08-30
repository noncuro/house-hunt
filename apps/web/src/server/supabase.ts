/** The service role, on the website's own server rather than on Supabase's.
 *
 *  Vercel injects no `SUPABASE_URL` and no privileged key, so the URL is read from the one the
 *  browser bundle already uses and the key has to be added to the project by hand. Both are read
 *  through `requireEnv` at the top of a request rather than at module scope, because a missing key
 *  must fail that request loudly — a module-scope throw during the build turns a configuration
 *  mistake into a failed deploy of the whole website.
 *
 *  No CORS. These routes are same-origin to the page, so the browser sends no preflight. The day a
 *  route here is called by the extension or by a Rightmove content script it needs a real
 *  allowance — that is a gate, not a formality, and leaving it out silently is how the extension
 *  half of a migrated function stops working. `docs/vercel-migration.md` has the shape it must have.
 */

/** Product-level outcomes are 200 with a `status`; this is for the cases where the caller got
 *  something wrong or something broke, which is the convention every client here already reads. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
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

interface ServiceConfig {
  url: string;
  key: string;
}

/** Two spellings of the same authority, newest first.
 *
 *  This project is on Supabase's current API keys — its browser key is an `sb_publishable_…`, not the
 *  legacy anon JWT — so the server half of that pair is an `sb_secret_…` and `SUPABASE_SECRET_KEY` is
 *  what to set. `SUPABASE_SERVICE_ROLE_KEY` is the legacy name, kept as a fallback for exactly one
 *  reason: it is the name the Supabase↔Vercel integration syncs, so a project that has that
 *  integration connected already has a working key under a name nobody chose. Refusing it would mean
 *  asking somebody to add by hand a credential the platform had already provided.
 *
 *  Both map to the `service_role` database role, which is the part that matters: `set_project_model`
 *  and `clear_project_model` are granted to that role alone, deliberately, because `project_model` is
 *  the row every surface trusts to score flats and its writer must not be something a browser can
 *  impersonate. The reads here could run as the caller under RLS; the write is why there is a key.
 *
 *  Named rather than inlined so the failure says which variable, on a platform where the answer is
 *  "nobody has added it to the project yet" often enough to be worth a sentence. */
function serviceConfig(): ServiceConfig {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
  const missing = [
    url ? null : 'NEXT_PUBLIC_SUPABASE_URL',
    key ? null : 'SUPABASE_SECRET_KEY (or the legacy SUPABASE_SERVICE_ROLE_KEY)',
  ].filter((name): name is string => name !== null);
  if (missing.length > 0) {
    throw new Error(
      `${missing.join(' and ')} ${missing.length === 1 ? 'is' : 'are'} not set on this deployment — ` +
        'add it to the Vercel project environment (Settings → Environment Variables), or connect the ' +
        'Supabase integration, which syncs the legacy name.',
    );
  }
  return { url: url!, key: key! };
}

/** The Supabase project's origin, for the routes that need to reach something other than PostgREST
 *  (GoTrue, for one). Throws the same way `serviceConfig` does. */
export function supabaseUrl(): string {
  return serviceConfig().url;
}

export function serviceKey(): string {
  return serviceConfig().key;
}

/** The service-role key, not the publishable one: these run on the server, and the writes they make
 *  are exactly the ones RLS deliberately grants to nobody else (design D4). */
export async function rest<T = unknown>(
  path: string,
  options: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<T> {
  const { url, key } = serviceConfig();
  const response = await fetch(`${url}/rest/v1/${path}`, {
    method: options.method ?? 'GET',
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    // Next caches `fetch` in server code by default, and a cached read of somebody's verdicts is a
    // model fitted to a snapshot rather than to what they have just rated.
    cache: 'no-store',
  });
  const text = await response.text();
  if (!response.ok) {
    throw new PostgrestError(response.status, `supabase ${path}: ${response.status} ${text.slice(0, 300)}`);
  }
  return (text ? JSON.parse(text) : null) as T;
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
