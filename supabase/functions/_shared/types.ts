// GENERATED — do not edit. Copied from packages/core/src/ by tools/sync-edge-function.ts.
// Edit the original and run `pnpm sync:function`.

/** Shapes shared across the extension. Kept deliberately narrow — we only model the parts of
 *  Rightmove's page blob we actually use, so a change elsewhere in their payload can't break us. */

export type Rating = 'no' | 'maybe' | 'love';

export interface Station {
  name: string;
  types: string[];
  distance: number;
  unit: string;
}

/** Floor area. Rentals frequently omit the structured `sizings`, so we fall back to reading the
 *  description prose — and say which it was, because a parsed-from-prose number deserves less
 *  trust than one Rightmove published as data. */
export interface FloorArea {
  sqft: number;
  source: 'sizings' | 'description';
}

export interface Floorplan {
  url: string;
  caption: string | null;
}

/** What the MAIN-world extractor pulls out of window.__PAGE_MODEL. */
export interface Listing {
  rightmoveId: string;
  url: string;
  /** Full postcode, e.g. "NW8 6HS" — outcode + incode, present even though the page hides it. */
  postcode: string | null;
  outcode: string | null;
  displayAddress: string;
  price: string | null;
  bedrooms: number | null;
  bathrooms: number | null;
  latitude: number | null;
  longitude: number | null;
  nearestStations: Station[];
  floorArea: FloorArea | null;
  /** "Furnished" / "Unfurnished" / "Part furnished", from lettings.furnishType. */
  furnishType: string | null;
  /** "Reduced today", "Added on 05/08/2026", … from listingHistory.listingUpdateReason. */
  listingUpdate: string | null;
  floorplans: Floorplan[];
  /** Gallery URLs, passed to the analyser. We store the URLs and never the images (ToS 13.4). */
  imageUrls: string[];
  /** The agent's own prose. Photos cannot answer whether bills are included or whether this is a
   *  room in a house share; the description is the only place either is ever stated. */
  description: string | null;
  /** Off the market according to the page itself: `propertyData.status.archived` is true (and
   *  `published` false) once a listing is let-agreed or taken down. Null when the status object is
   *  absent — unknown, not "still on" — so a missing field never auto-withholds a live flat. The
   *  panel uses this to offer to mark the flat off the market without anyone having to notice. */
  archived: boolean | null;
}

export type Confidence = 'high' | 'medium' | 'low';

/** What the vision pass concluded about a property. Computed once per property, not per view. */
export interface Analysis {
  model: string;
  analysedAt: string;
  imageCount: number;

  hasFloorplan: boolean;
  /** A plan that is present but unreadable is a third state, distinct from having none: it means
   *  the listing has not been assessed, rather than that it failed the assessment. */
  floorplanLegible: boolean | null;
  floorplanSqft: number | null;
  floorplanSqftSource: 'stated' | 'computed' | 'none' | null;
  floorplanConfidence: Confidence | null;

  bedrooms: number | null;
  bathrooms: number | null;

  biggestRoomLabel: string | null;
  biggestRoomSqft: number | null;
  biggestRoomConfidence: Confidence | null;

  hasBathtub: boolean | null;
  bathtubConfidence: Confidence | null;

  hasOutdoorSpace: boolean | null;
  outdoorKind: string | null;
  outdoorSqft: number | null;
  outdoorIsEstimate: boolean | null;
  outdoorConfidence: Confidence | null;

  /** True when this is a room in a shared house or flat rather than the whole place. It is the
   *  one amenity finding that can end the conversation on its own, so it is asked directly rather
   *  than inferred from a low bedroom count. */
  isHouseShare: boolean | null;
  houseShareConfidence: Confidence | null;

  /** Where the washing machine is, which is a different question from whether one exists. */
  laundry: Laundry | null;
  laundryConfidence: Confidence | null;

  hasDishwasher: boolean | null;
  dishwasherConfidence: Confidence | null;

  /** How separate the place to sleep is from the kitchen — see `SleepingSeparation`. */
  sleepingSeparation: SleepingSeparation | null;
  sleepingSeparationConfidence: Confidence | null;

  /** Only ever shown when true. Bills not being included is the norm and says nothing. */
  utilitiesIncluded: boolean | null;
  utilitiesConfidence: Confidence | null;

  /** How much daylight the place gets. A rating rather than a yes/no, because every flat has some
   *  and the question is how much. */
  naturalLight: LightLevel | null;
  naturalLightConfidence: Confidence | null;

  summary: string | null;
}

/** `none` is a finding; `null` on the field above is "we could not tell". */
export type Laundry = 'in-unit' | 'in-building' | 'none';

export type LightLevel = 'low' | 'medium' | 'high';

/** Whether the kitchen and the place to sleep are the same room *in practice*, which is not the
 *  same question as whether they are the same room on the floorplan.
 *
 *  This replaced a boolean, `bedInKitchen`, that was true for any studio — and so said the same
 *  thing about a mezzanine reached by a ladder as about a hob at the foot of the bed. Those are
 *  different flats to live in, and the boolean could not tell you which one you were looking at.
 *  `practically-separate` is the answer it could not give: one room on the plan, two in use,
 *  because of a level change, a corner in the outline, or something full-height standing between
 *  them. */
export type SleepingSeparation = 'separate-room' | 'practically-separate' | 'same-space';

/** Somewhere this hunt cares about: the office, the in-laws, Angel.
 *
 *  One row does up to three jobs, and says for itself which it can do.
 *
 *    - **Measured to** — every place with a postcode is timed by walking, cycling and transit.
 *      Every place is measured in every mode; the panel shows all three side by side.
 *    - **Named on a listing** — every place with coordinates fixes a flat: "0.4 mi NE of Angel".
 *    - **Swept around** — a place with a Rightmove location *and* a radius is a search centre.
 *
 *  This used to be two tables. `project_hub` held the third job and half of the second, and the
 *  compass merged the two lists on every card. Adding Angel as somewhere to search and somewhere
 *  to commute from meant typing it twice, into two forms, on two pages. See the
 *  `places_are_hubs` migration. */
export interface Place {
  id: string;
  label: string;
  /** Null for a place that arrived as a neighbourhood — a name resolved to a coordinate and a
   *  Rightmove identifier, with no postcode in sight. Travel skips a place without one rather than
   *  routing from the coordinate: the postcode is what TfL is asked about (see AGENTS.md). */
  postcode: string | null;
  /** Resolved at entry. Journeys route from these, never from the postcode string. */
  lat: number | null;
  lon: number | null;
  /** `<locationType>^<id>`, e.g. `STATION^4187` — how Rightmove names this place in a search URL.
   *  Null means we have not verified one, and no search URL is built rather than a guessed one:
   *  a wrong identifier returns a page of plausible flats somewhere else, which is the failure
   *  that looks exactly like success. */
  locationIdentifier: string | null;
  /** The SEO path segment the identifier was read out of, kept so a wrong one is traceable. Both
   *  halves are needed before a place is searchable. */
  displayLocationIdentifier: string | null;
  /** How far around this place to search, in miles, or null for a place we do not sweep from.
   *  Never defaulted — a radius nobody chose is a search nobody asked for. */
  sweepRadiusMiles: number | null;
  /** A per-place override of the sweep window. Null leaves it to `sweepWindow`, which decides from
   *  when this place was last swept completely. */
  maxDaysSinceAdded: number | null;
}

/** The steps Rightmove's own radius control offers. Stored as the number that goes into the URL,
 *  so nothing converts on the way out. */
export const SWEEP_RADII = [0.25, 0.5, 1, 3, 5, 10] as const;

export type TravelMode = 'walking' | 'cycling' | 'transit';

/** One way of making the trip. Duplicated from tfl.ts rather than imported, so the message
 *  layer doesn't drag the TfL client into every consumer. */
export interface JourneyOption {
  minutes: number;
  legs: Leg[];
}

export interface Leg {
  mode: string;
  lineId: string | null;
  lineName: string | null;
  minutes: number;
}

export const TRAVEL_MODES: TravelMode[] = ['walking', 'cycling', 'transit'];

/** Walking to anywhere over an hour away is not a real option, and showing it crowds out the
 *  numbers that matter. */
export const WALKING_LIMIT_SECONDS = 60 * 60;

export interface TravelTime {
  placeId: string;
  mode: TravelMode;
  seconds: number;
  changes: number | null;
  /** Distinct routes, fastest first — what the transit tooltip draws. */
  options?: JourneyOption[];
  /** Set when the lookup failed, so the panel can say so rather than render a blank. */
  error?: string;
  /** True when the failure was TfL being unavailable rather than there being no such journey.
   *  Only the first is worth a retry button, and conflating them made a rate-limit look like a
   *  permanent verdict on the place. */
  transient?: boolean;
  /** Why this cached number no longer answers the question we now ask — see `staleTravel`.
   *
   *  Only ever set on the read-only path the compare table uses. Everywhere else a stale row is
   *  simply refetched; the table cannot refetch (it would fire a journey-planner request per
   *  gap on open), so it shows the old number and says what is wrong with it. Ranking a
   *  Tuesday-morning commute against one measured at midnight without saying so is the failure
   *  this exists to prevent. */
  stale?: string;
}

export interface Verdict {
  rightmoveId: string;
  person: string;
  rating: Rating;
  note: string;
  updatedAt: string;
}
