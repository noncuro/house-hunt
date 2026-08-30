/** Calling one of the website's own API routes.
 *
 *  The functions this app runs server-side are moving off Supabase's Edge runtime and onto routes in
 *  `apps/web/src/app/api/` (`docs/vercel-migration.md`). A route is reached with a plain `fetch`
 *  rather than `db().functions.invoke(...)`, which changes two things worth naming:
 *
 *  - **The URL is relative**, so it follows whichever origin the page is served from — production, a
 *    Vercel preview, or localhost — instead of becoming another copy of an origin to keep in step
 *    with the deployment. The cost is that a caller which is not a page cannot use it: a relative
 *    fetch from the extension's background worker resolves against `chrome-extension://` and 404s
 *    with a body that parses as nothing. So this refuses outright there, with a sentence, rather
 *    than leaving that 404 for whoever tries it next. The routes the extension does need get an
 *    explicit origin when they move — deliberately, and not by deleting this check.
 *  - **A refusal arrives as an ordinary body.** supabase-js collapsed every non-2xx to the string
 *    "Edge Function returned a non-2xx status code" and hid the real one inside
 *    `FunctionsHttpError.context`, which is why `refusalFrom` exists. With `fetch` the body is
 *    simply there, so the sentence the server wrote is the sentence the caller throws.
 *
 *  The reply convention is unchanged and is the reason this returns rather than throws on a 200:
 *  every *product-level* outcome — `rate-limited`, `withdrawn`, `unreadable`, `insufficient` — is a
 *  200 with a `status` field, and only a caller mistake or a real failure is a non-2xx.
 */
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
  const origin = globalThis.location?.origin ?? '';
  if (!/^https?:/.test(origin)) {
    throw new Error(
      `${name} runs on the website and cannot be reached from ${origin || 'here'} — open the app`,
    );
  }

  const response = await fetch(`/api/${name}`, {
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
