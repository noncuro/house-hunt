/** Calling one of the website's own API routes.
 *
 *  The functions this app runs server-side are moving off Supabase's Edge runtime and onto routes in
 *  `apps/web/src/app/api/` (`docs/vercel-migration.md`). A route is reached with a plain `fetch`
 *  rather than `db().functions.invoke(...)`, which changes two things worth naming:
 *
 *  - **The URL is relative wherever there is a page**, so it follows whichever origin that page is
 *    served from — production, a Vercel preview, or localhost — instead of becoming another copy of
 *    an origin to keep in step with the deployment. A caller that is not a page cannot do that: a
 *    relative fetch from the extension's background worker resolves against `chrome-extension://`
 *    and 404s with a body that parses as nothing. So the extension says where the website is, once,
 *    through `Host.apiOrigin` (`client.ts`), which it fills from `WXT_WEB_APP_URL` — the same value
 *    its bridge already trusts. Anything with neither a page origin nor a configured one is refused
 *    with a sentence rather than left to that 404.
 *  - **A refusal arrives as an ordinary body.** supabase-js collapsed every non-2xx to the string
 *    "Edge Function returned a non-2xx status code" and hid the real one inside
 *    `FunctionsHttpError.context`, which is why `refusalFrom` exists. With `fetch` the body is
 *    simply there, so the sentence the server wrote is the sentence the caller throws.
 *
 *  The reply convention is unchanged and is the reason this returns rather than throws on a 200:
 *  every *product-level* outcome — `rate-limited`, `withdrawn`, `unreadable`, `insufficient` — is a
 *  200 with a `status` field, and only a caller mistake or a real failure is a non-2xx.
 */
import { configuredApiOrigin } from './client';
import { accessToken } from './session';

/** The bearer the route verifies the caller from.
 *
 *  Passed explicitly rather than left to supabase-js to attach from its own session state — these
 *  are not supabase-js calls at all any more, so there is nothing to leave it to. A missing bearer
 *  is a 401 that reads as "you were signed out", which is the wrong sentence entirely, so it is read
 *  here at the moment of the call.
 */
async function bearer(): Promise<Record<string, string>> {
  const token = await accessToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/** POST a JSON body to `/api/<name>` and return the parsed reply.
 *
 *  Throws on a non-2xx, carrying the server's own `error` sentence where there is one. A 200 comes
 *  back as-is for the caller to read the `status` off, because a stated outcome is not a failure.
 */
export async function callRoute<T>(name: string, body: unknown = {}): Promise<T> {
  const response = await fetch(`${routeBase(name)}/api/${name}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await bearer()) },
    body: JSON.stringify(body),
  });
  const payload = (await response.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!response.ok) {
    throw new Error(payload?.error || `${name} failed (${response.status})`);
  }
  if (!payload) throw new Error(`${name} returned nothing readable`);
  return payload;
}

/** Empty for a page, which makes the URL relative; the configured origin for the extension.
 *
 *  Refuses rather than guessing when there is neither. The failure it prevents is specific: a
 *  relative fetch from a `chrome-extension://` context resolves against the extension's own origin
 *  and answers 404 with an HTML body, so the caller sees "returned nothing readable" about a route
 *  that is running perfectly on a server it never addressed. */
function routeBase(name: string): string {
  const pageOrigin = globalThis.location?.origin ?? '';
  if (/^https?:/.test(pageOrigin)) return '';

  const configured = configuredApiOrigin();
  if (configured) return configured.replace(/\/+$/, '');

  throw new Error(
    `${name} runs on the website and there is no origin to reach it at from ${pageOrigin || 'here'} — ` +
      'the extension sets one through `configure({ apiOrigin })`, and a page needs none',
  );
}
