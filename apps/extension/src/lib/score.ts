/** Scoring the open listing on the panel, from the extension's own shapes.
 *
 *  The web has the same adapter over its `ShortlistEntry`; this one is over `Listing` + `Analysis`,
 *  the two things the panel already holds. Both feed the one feature builder in `@house-hunt/core`,
 *  so a flat gets the same features whichever surface scores it.
 *
 *  Scoring is pure arithmetic against weights already in hand — no network, well under the 1s the
 *  panel budgets — so it runs here in the content script rather than round-tripping the worker. The
 *  only cost is fetching the model once (`model:get`), which the panel does alongside its hubs.
 */
import { score as scoreModel, type Analysis, type Hub, type Listing, type Model, type PredictInput } from '@house-hunt/core';

/** Nearest station distance in miles (Rightmove's unit; a stray km is converted, not trusted). */
function nearestStationMiles(listing: Listing): number | null {
  const miles = listing.nearestStations
    .filter((s) => typeof s.distance === 'number')
    .map((s) => (s.unit === 'km' ? s.distance * 0.621371 : s.distance));
  return miles.length ? Math.min(...miles) : null;
}

export function predictInputFromListing(
  listing: Listing,
  analysis: Analysis | null,
  /** The postcode point, preferred over Rightmove's fuzzed pin for distance to hubs. */
  point: { lat: number; lon: number } | null,
): PredictInput {
  return {
    price: listing.price,
    bedrooms: listing.bedrooms,
    bathrooms: listing.bathrooms,
    floorAreaSqft: listing.floorArea?.sqft ?? null,
    lat: point?.lat ?? listing.latitude,
    lon: point?.lon ?? listing.longitude,
    nearestStationMiles: nearestStationMiles(listing),
    furnishType: listing.furnishType,
    naturalLight: analysis?.naturalLight ?? null,
    hasOutdoorSpace: analysis?.hasOutdoorSpace ?? null,
    hasDishwasher: analysis?.hasDishwasher ?? null,
    laundry: analysis?.laundry ?? null,
    hasBathtub: analysis?.hasBathtub ?? null,
  };
}

export function scoreListing(
  model: Model,
  listing: Listing,
  analysis: Analysis | null,
  hubs: Hub[],
  point: { lat: number; lon: number } | null,
): number {
  return scoreModel(model, predictInputFromListing(listing, analysis, point), hubs);
}
