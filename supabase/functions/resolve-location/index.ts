/** A neighbourhood name -> the Rightmove location identifier a sweep searches with.
 *
 *  `STATION^4187` cannot be guessed and must not be. The failure mode of a wrong one is silent: the
 *  search returns a page of plausible London flats for somewhere else entirely, the sweep records
 *  them against the wrong hub, and nothing on screen looks wrong. So the identifier is read back
 *  out of Rightmove's own page, which resolves its own SEO paths server-side: ask for
 *  `/property-to-rent/Belsize-Park-Station.html` and `__NEXT_DATA__.props.pageProps.searchResults
 *  .location` says what it decided that meant — the `locationType` and `id` that make the
 *  identifier, a `displayName` a human can sanity-check, and a polygon whose centroid is a second,
 *  independent answer to "where is this".
 *
 *  This is `tools/find-locations.ts`, moved to where a person adding a hub can reach it, because
 *  hubs stopped being a compile-time constant (design D11).
 *
 *  ---------------------------------------------------------------------------------------------
 *  THIS IS THE ONE PLACE IN THIS EXTENSION THAT FETCHES RIGHTMOVE, AND THE NO-CRAWL RULE IS NOT
 *  RELAXED FOR IT.
 *
 *  `AGENTS.md`: *read pages the user opened; never crawl*. That line is what separates a notes app
 *  from a scraper, both in spirit and under Rightmove's terms, and everything else in this codebase
 *  is arranged around it — the sweep panel reads the results page the user opened themselves, the
 *  paced opener opens listing pages one at a time in front of them, and nothing anywhere calls the
 *  property-search endpoint even though it works unauthenticated.
 *
 *  What keeps this inside the rule is the *shape* of the request, not the fact that it is useful:
 *
 *    - **one** request, for **one** hub, per invocation. Never a list, never a loop.
 *    - **initiated by a person** in the middle of adding that hub. Never on a schedule, never in
 *      the background, never on page load, never as a warm-up.
 *    - **an SEO landing page**, the same document a browser gets by clicking through Rightmove's
 *      own navigation — not the search API.
 *    - **rate-limited per user** below, so a bug in a caller cannot turn a hand action into a loop.
 *      Adding a hub is something that happens a handful of times, ever.
 *
 *  Do not take this as precedent for fetching anything else. Widening it — resolving several names
 *  at once, prefetching suggestions as somebody types, refreshing identifiers on a timer — turns a
 *  hand lookup into a crawler, and the rule does not have an exception shaped like convenience.
 *  ---------------------------------------------------------------------------------------------
 *
 *  Deploy:
 *    supabase functions deploy resolve-location --project-ref <ref>
 */
import { requireActiveProject, requireCaller } from '../_shared/caller.ts';
import { body, eq, HttpError, requireEnv, rest, SERVICE_KEY, serve, SUPABASE_URL } from '../_shared/http.ts';

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

/** Ten an hour per person. Adding a hub is a handful of actions in the lifetime of a project, so
 *  this is loose enough that nobody doing it by hand will ever meet it and tight enough that a
 *  retry loop in a caller cannot become a crawl. */
const LIMIT_PER_HOUR = 10;

/** Rate limiting needs somewhere durable to count, and an Edge Function isolate is not durable —
 *  it is recycled without warning, which is exactly when a limit held in memory stops existing.
 *  `api_usage` is the log of external calls this system makes on a user's behalf, `kind` is there to
 *  tell them apart, and the row is written with `cost_usd = 0` so nothing here moves a spend cap or
 *  shows up as money in the admin view. Counting rows in that table is the whole limiter. */
const KIND = 'resolve_location';

serve(async (request) => {
  requireEnv({ SUPABASE_URL, SERVICE_KEY });

  const caller = await requireCaller(request);
  // A hub belongs to a project, so resolving one is only meaningful for somebody who is in one.
  const projectId = await requireActiveProject(caller);

  const input = await body<{ query?: string; slug?: string }>(request);
  const slug = toSlug(input.slug ?? input.query);

  const used = await recentLookups(caller.userId);
  if (used >= LIMIT_PER_HOUR) {
    return {
      status: 'rate-limited',
      used,
      limit: LIMIT_PER_HOUR,
      retry_after_seconds: 3600,
    } as const;
  }

  // Counted before the request goes out, not after, so a lookup that fails still spends its slot.
  // Charged after would make every failure free and the limit unreachable by retrying.
  await note(projectId, caller.userId, slug);

  return await resolve(slug);
});

/** A name a person typed -> the SEO path segment Rightmove uses.
 *
 *  Nothing here is allowed to reach outside `/property-to-rent/<slug>.html`: the slug is rebuilt
 *  from scratch out of letters, digits and single dashes rather than escaped, so a `..` or a `?` in
 *  the input cannot become part of the URL at all. */
export function toSlug(input: string | undefined): string {
  const slug = (input ?? '')
    .trim()
    .replace(/\.html$/i, '')
    .replaceAll('&', ' and ')
    .replaceAll(/[^A-Za-z0-9]+/g, '-')
    .replaceAll(/^-+|-+$/g, '');
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,80}$/.test(slug)) {
    throw new HttpError(400, 'bad-request', 'a place name is required, e.g. "Kentish Town Station"');
  }
  return slug;
}

async function recentLookups(userId: string): Promise<number> {
  const since = new Date(Date.now() - 3600_000).toISOString();
  const rows = await rest<Array<{ id: number }>>(
    `api_usage?user_id=eq.${eq(userId)}&kind=eq.${KIND}&occurred_at=gt.${eq(since)}&select=id`,
  );
  return rows.length;
}

async function note(projectId: string, userId: string, slug: string): Promise<void> {
  await rest('api_usage', {
    method: 'POST',
    body: {
      project_id: projectId,
      user_id: userId,
      kind: KIND,
      // No model and no tokens: this call costs nothing. The row exists to be counted, and a zero
      // cost is what keeps it out of every sum the caps and the admin view take.
      //
      // Inserted directly with the service role, and it must stay that way. `record_api_usage`
      // raises when there is no `model_price` row for the model it is given, so routing this
      // through it would have every rate-limit write throw on a price for a model that does not
      // exist — turning the limiter into an outage on the path it is supposed to protect.
      cost_usd: 0,
      rightmove_id: null,
      input_tokens: 0,
      cached_input_tokens: 0,
      output_tokens: 0,
    },
  });
  console.log(`resolving ${slug} for ${userId}`);
}

type Resolved =
  | { status: 'not-found'; slug: string }
  | {
      status: 'resolved';
      slug: string;
      locationIdentifier: string;
      displayLocationId: string;
      displayName: string;
      canonicalUrl: string | null;
      centroid: { lat: number; lon: number } | null;
      resultCount: unknown;
    };

export async function resolve(slug: string): Promise<Resolved> {
  // The single request. Read the block at the top of this file before adding a second one.
  const response = await fetch(`https://www.rightmove.co.uk/property-to-rent/${slug}.html`, {
    headers: { 'User-Agent': USER_AGENT },
  });
  if (response.status === 404) return { status: 'not-found', slug };
  if (!response.ok) throw new Error(`rightmove returned ${response.status} for ${slug}`);

  const html = await response.text();
  const blob = /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/.exec(html);
  // No blob means the path did not resolve to a search, which is the same answer as a 404 to
  // somebody typing a neighbourhood in — and a far more useful one than a parse error.
  if (!blob?.[1]) return { status: 'not-found', slug };

  const results = (JSON.parse(blob[1]) as SearchPage).props?.pageProps?.searchResults;
  const location = results?.location;
  if (!location?.locationType || location.id === undefined) return { status: 'not-found', slug };

  return {
    status: 'resolved',
    slug,
    locationIdentifier: `${location.locationType}^${location.id}`,
    // Kept so a wrong identifier is traceable to the page that produced it.
    displayLocationId: `${slug}.html`,
    displayName: location.displayName ?? slug,
    canonicalUrl: results?.seoModel?.canonicalUrl ?? null,
    // A second, independent answer to "where is this". The caller compares it against whatever
    // coordinate it got from postcodes.io or TfL: two sources agreeing to a tenth of a mile is the
    // actual verification, and the identifier on its own is a number somebody wrote down. A hub
    // placed wrong silently rotates every bearing computed from it.
    centroid: location.geometry ? centreOf(location.geometry) : null,
    resultCount: results?.resultCount ?? null,
  };
}

interface SearchPage {
  props?: {
    pageProps?: {
      searchResults?: {
        location?: {
          locationType?: string;
          id?: string | number;
          displayName?: string;
          geometry?: Geometry;
        };
        seoModel?: { canonicalUrl?: string };
        resultCount?: unknown;
      };
    };
  };
}

/** GeoJSON, kept loose because it arrives off the network and the two shapes below are not the
 *  only two Rightmove could ever send. `centreOf` narrows it rather than trusting it. */
interface Geometry {
  type?: string;
  coordinates?: unknown;
}

/** Rightmove's own centre for whatever it decided the name meant.
 *
 *  Two shapes, because a full postcode has no extent and everything else does. A station's
 *  catchment, a region or an outcode comes back as a `Polygon` and is averaged; a `POSTCODE^`
 *  result comes back as a bare `Point`, which is the centre already.
 *
 *  The point case is not a nicety. It is the shape the *default* lookup now returns, since a place
 *  with a postcode is resolved by that postcode — and a polygon-only reader answers null for it,
 *  which the screen renders as "no coordinate here to check it against". That sentence would be
 *  false, and it would retire the cross-check on exactly the path that carries it. */
function centreOf(geometry: Geometry): { lat: number; lon: number } | null {
  const { coordinates } = geometry;
  if (!Array.isArray(coordinates)) return null;
  if (geometry.type === 'Point') return pointFrom(coordinates);

  // Mean of the ring's vertices. The polygons are near-regular rings of up to ~140 points around
  // the search centre, so the plain mean lands well inside any tolerance a caller applies; nothing
  // here needs a proper area-weighted centroid.
  const ring = coordinates[0];
  if (!Array.isArray(ring) || ring.length === 0) return null;
  let lat = 0;
  let lon = 0;
  for (const vertex of ring) {
    const point = pointFrom(vertex);
    // One unreadable vertex means no centre, rather than a centre computed as if it were at
    // [0, 0]. That default dragged the answer towards the Atlantic in proportion to how much of
    // the ring was missing — a wrong centre, which is what this whole value exists to catch.
    if (point === null) return null;
    lat += point.lat;
    lon += point.lon;
  }
  return { lat: lat / ring.length, lon: lon / ring.length };
}

/** GeoJSON writes a coordinate `[lon, lat]`, the reverse of every other pair in this codebase.
 *  Worth one named function rather than the index dance at each call site. */
function pointFrom(value: unknown): { lat: number; lon: number } | null {
  if (!Array.isArray(value)) return null;
  const [lon, lat] = value as unknown[];
  if (typeof lat !== 'number' || typeof lon !== 'number') return null;
  return { lat, lon };
}
