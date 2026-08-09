/** UK postcode lookup via postcodes.io — free, no key, no rate limit worth worrying about.
 *
 *  We don't let TfL geocode postcodes any more. Asked for "TW6 1JH" (Heathrow, terminated in
 *  2009) it returned a confident match at 51.551,-0.190 — northwest London — via a 300
 *  disambiguation. A wrong travel time is worse than none, so postcodes are resolved here and
 *  journeys are routed by coordinates.
 */

export interface Point {
  lat: number;
  lon: number;
}

export interface PostcodeLookup {
  point: Point | null;
  /** Set when the postcode existed once but no longer does — worth saying out loud. */
  terminated?: boolean;
}

/** Accepts a UK postcode, or raw "lat,lon" pasted from Google Maps.
 *
 *  Plus codes are deliberately not handled: a short one ("FGCW+PG Hounslow") still needs its
 *  locality geocoded, so it buys nothing over a postcode, and a full one is just coordinates in
 *  a different encoding — which the lat,lon branch already covers. */
export async function lookupPostcode(postcode: string): Promise<PostcodeLookup> {
  const coordinates = parseLatLon(postcode);
  if (coordinates) return { point: coordinates };

  const encoded = encodeURIComponent(postcode.trim());

  const live = await get(`https://api.postcodes.io/postcodes/${encoded}`);
  if (live) return { point: live };

  // A terminated postcode still has a location, and for somewhere like an airport terminal it is
  // usually still the right place — but the caller should be told.
  const dead = await get(`https://api.postcodes.io/terminated_postcodes/${encoded}`);
  if (dead) return { point: dead, terminated: true };

  return { point: null };
}

function parseLatLon(input: string): Point | null {
  const match = /^\s*(-?\d{1,2}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)\s*$/.exec(input);
  if (!match) return null;
  const lat = Number(match[1]);
  const lon = Number(match[2]);
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lat, lon };
}

async function get(url: string): Promise<Point | null> {
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    const body = (await response.json()) as { result?: { latitude?: number; longitude?: number } };
    const { latitude, longitude } = body.result ?? {};
    return typeof latitude === 'number' && typeof longitude === 'number'
      ? { lat: latitude, lon: longitude }
      : null;
  } catch {
    return null;
  }
}

/** Resolve many postcodes in one request. postcodes.io takes up to 100 per call, which turns
 *  "put every shortlisted property on a map" into one round trip rather than one per property. */
export async function lookupPostcodes(postcodes: string[]): Promise<Map<string, Point>> {
  const found = new Map<string, Point>();

  for (let at = 0; at < postcodes.length; at += 100) {
    const batch = postcodes.slice(at, at + 100);
    try {
      const response = await fetch('https://api.postcodes.io/postcodes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ postcodes: batch }),
      });
      if (!response.ok) continue;

      const body = (await response.json()) as {
        result?: Array<{ query?: string; result?: { latitude?: number; longitude?: number } | null }>;
      };
      for (const row of body.result ?? []) {
        const lat = row.result?.latitude;
        const lon = row.result?.longitude;
        if (row.query && typeof lat === 'number' && typeof lon === 'number') {
          found.set(row.query, { lat, lon });
        }
      }
    } catch {
      // A failed batch just leaves those postcodes unresolved; the map falls back to
      // Rightmove's own pin for them.
    }
  }
  return found;
}
