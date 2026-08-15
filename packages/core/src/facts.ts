/** Turning several disagreeing sources into one number you can act on.
 *
 *  A listing tells you its size, its beds and its baths more than once — the structured data,
 *  the description prose, and the floorplan the model read — and they routinely disagree.
 *  Verified case: Rightmove's `sizings` said 1044 sq ft where the plan plainly stated 1105.
 *  Showing all of them is noise; showing one silently hides that a check is warranted. So we
 *  show the most trustworthy one, mark it, and put the rest one hover away. */

import type { Confidence, Laundry, LightLevel } from './types';
import type { SweepCriteria } from './sweep';

export interface Candidate {
  /** Where the number came from, in words — this is what the tooltip shows. */
  source: string;
  value: number | null | undefined;
}

export interface Reading {
  value: number;
  source: string;
  /** Other sources that materially disagree. Empty means everyone agrees (or only one spoke). */
  conflicts: Array<{ source: string; value: number }>;
}

/** Take the first candidate that has a number — the list is in order of trust — and record which
 *  of the others disagree by more than `tolerance` (a fraction: 0.03 = 3%). Counts want
 *  tolerance 0, where any difference is a real disagreement; areas want a few percent, because
 *  rounding between sq ft and m² is not a conflict. */
export function resolveReading(candidates: Candidate[], tolerance = 0): Reading | null {
  // Negatives are dropped; zero is not. Zero bedrooms is a studio, which is a real answer, but a
  // negative count or area is impossible — and worse than merely impossible: a negative chosen
  // value flips the sign of the disagreement ratio below, so every conflict compares as less than
  // the tolerance and none is ever flagged. Dropping them turns an impossible number into an
  // absent one, which every view already knows how to draw.
  const present = candidates.flatMap((c) =>
    typeof c.value === 'number' && Number.isFinite(c.value) && c.value >= 0
      ? [{ source: c.source, value: c.value }]
      : [],
  );
  const chosen = present[0];
  if (!chosen) return null;

  const conflicts = present.slice(1).filter((other) => {
    // Zero survives the filter above, so the division still needs guarding — and against zero any
    // other number at all is a disagreement, whatever the tolerance.
    if (chosen.value === 0) return other.value !== 0;
    return Math.abs(other.value - chosen.value) / chosen.value > tolerance;
  });
  return { value: chosen.value, source: chosen.source, conflicts };
}

/** The tooltip body for a reading: what we're showing, where it came from, and what the other
 *  sources said. Written as prose because a bare list of numbers doesn't say which to believe. */
export function explainReading(reading: Reading, format: (n: number) => string): string {
  const lines = [`${format(reading.value)} — from the ${reading.source}.`];
  if (reading.conflicts.length > 0) {
    lines.push('');
    for (const other of reading.conflicts) {
      lines.push(`The ${other.source} says ${format(other.value)}.`);
    }
  }
  return lines.join('\n');
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** "Reduced on 31/07/2026" -> "Reduced 9 days ago". An absolute date makes you do arithmetic
 *  every time; how long it has sat is the thing you actually read it for.
 *
 *  Rightmove also writes "Reduced today" / "Added yesterday", which are already relative — those
 *  pass through untouched. */
export function relativeUpdate(text: string, now = new Date()): string {
  const match = /^(.*?)\s+on\s+(\d{2})\/(\d{2})\/(\d{4})\s*$/.exec(text.trim());
  if (!match) return text;

  const [, verb, dd, mm, yyyy] = match;
  const day = Number(dd);
  const month = Number(mm);
  const year = Number(yyyy);
  // UK format, and UTC so a local timezone can't shift the day across midnight.
  const then = Date.UTC(year, month - 1, day);
  // Date.UTC rolls 31/02 forward into March rather than rejecting it, which would turn a typo
  // into a confident, wrong "3 days ago". Check it round-trips.
  const check = new Date(then);
  if (check.getUTCDate() !== day || check.getUTCMonth() !== month - 1 || check.getUTCFullYear() !== year) {
    return text;
  }
  const days = Math.floor((Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) - then) / DAY_MS);
  if (!Number.isFinite(days) || days < 0) return text;

  return `${verb} ${agoLabel(days)}`;
}

function agoLabel(days: number): string {
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 14) return `${days} days ago`;
  // Past a fortnight the exact day stops mattering, so round to the unit you'd actually say.
  if (days < 60) return `${Math.round(days / 7)} weeks ago`;
  const months = Math.round(days / 30);
  return `${months} month${months === 1 ? '' : 's'} ago`;
}

/** The floor area, resolved the same way everywhere.
 *
 *  The three views had three rules. The panel ignored the model's figure when the plan was
 *  unreadable; the shortlist card always preferred it. So one flat read 750 sq ft in the panel and
 *  1,082 on its own card, from the same row — and the card gave no hint that its number came out
 *  of a paragraph rather than off a plan. There is one rule now, and it returns the caveat along
 *  with the number so no view can drop it.
 *
 *  Order of trust: a legible floorplan was measured; `sizings` is what Rightmove published as
 *  data; the description is an agent typing a number into prose. */
export interface SizeSource {
  /** From the model's read of the floorplan, and whether that plan was legible. */
  floorplanSqft?: number | null;
  floorplanLegible?: boolean | null;
  /** What Rightmove had, and whether it was published as data or parsed out of the description. */
  listedSqft?: number | null;
  listedSource?: 'sizings' | 'description' | null;
}

export interface Size extends Reading {
  /** True when the number came out of prose — the one source that may be measuring the garden. */
  approximate: boolean;
}

/** Sizes are converted between sq ft and m² along the way, so a few percent apart is rounding,
 *  not disagreement. */
const AREA_TOLERANCE = 0.03;

export function resolveSize(source: SizeSource): Size | null {
  // An unreadable plan means the model's figure came from nowhere trustworthy, so it must not
  // outrank Rightmove's own number.
  const fromPlan = source.floorplanLegible === false ? null : source.floorplanSqft;
  const reading = resolveReading(
    [
      { source: 'floorplan', value: fromPlan },
      { source: 'listing', value: source.listedSource === 'sizings' ? source.listedSqft : null },
      { source: 'description', value: source.listedSource === 'description' ? source.listedSqft : null },
    ],
    AREA_TOLERANCE,
  );
  if (!reading) return null;
  return { ...reading, approximate: reading.source === 'description' };
}

export const APPROXIMATE_SIZE_HELP =
  'Read out of the description, not published as data — it may not be the whole flat.';

/** How sure the model was, said in words rather than asserted flatly.
 *
 *  Everything the model reads off the photos was stated the same way whether it had a clear shot
 *  of the bathroom or was inferring from a mirror in the corner of one frame — "no bathtub" reads
 *  as a fact, and acting on it means not viewing a flat that may well have one. The claim now
 *  carries its own certainty, so a low-confidence read says so in the label instead of burying it
 *  in a dot you have to hover.
 *
 *  Both views read this table, so the panel and the shortlist can't word the same claim
 *  differently. A missing confidence is treated as high — that is what the model returned before
 *  we asked it for one, and those were mostly floorplan reads. */
export type Claim =
  | 'house-share'
  | 'bed-in-kitchen'
  | 'laundry-none'
  | 'laundry-building'
  | 'laundry-unit'
  | 'dishwasher-absent'
  | 'dishwasher-present'
  | 'bills-included'
  | 'light-low'
  | 'light-high'
  | 'bathtub-absent'
  | 'bathtub-present'
  | 'rooms-small'
  | 'rooms-big'
  | 'outdoor-absent';

const CLAIM_WORDING: Record<Claim, Record<Confidence, string>> = {
  'bathtub-absent': {
    high: 'no bathtub',
    medium: 'bath possibly missing',
    low: 'bath unclear from photos',
  },
  'bathtub-present': {
    high: 'bathtub',
    medium: 'bathtub, probably',
    low: 'possible bathtub',
  },
  'rooms-small': {
    high: 'small rooms',
    medium: 'rooms look small',
    low: 'rooms may be small',
  },
  'rooms-big': {
    high: 'big rooms',
    medium: 'rooms look big',
    low: 'rooms may be big',
  },
  'outdoor-absent': {
    high: 'no outdoor space',
    medium: 'no outdoor space shown',
    low: 'outdoor space unclear',
  },
  'house-share': {
    high: 'house share',
    medium: 'looks like a house share',
    low: 'may be a house share',
  },
  'bed-in-kitchen': {
    high: 'bed in the kitchen',
    medium: 'bed looks to be in the kitchen',
    low: 'bed may be in the kitchen',
  },
  'laundry-none': {
    high: 'nowhere to wash clothes',
    medium: 'no washing machine shown',
    low: 'laundry unclear',
  },
  'laundry-building': {
    high: 'laundry in the building',
    medium: 'laundry looks communal',
    low: 'laundry may be communal',
  },
  'laundry-unit': {
    high: 'washer-dryer',
    medium: 'washer-dryer, probably',
    low: 'possible washer-dryer',
  },
  'dishwasher-absent': {
    high: 'no dishwasher',
    medium: 'no dishwasher shown',
    low: 'dishwasher unclear',
  },
  'dishwasher-present': {
    high: 'dishwasher',
    medium: 'dishwasher, probably',
    low: 'possible dishwasher',
  },
  'bills-included': {
    high: 'bills included',
    medium: 'bills probably included',
    low: 'bills may be included',
  },
  'light-low': {
    high: 'dark',
    medium: 'looks dark',
    low: 'may be dark',
  },
  'light-high': {
    high: 'bright',
    medium: 'looks bright',
    low: 'may be bright',
  },
};

export function claimLabel(claim: Claim, confidence: Confidence | null | undefined): string {
  return CLAIM_WORDING[claim][confidence ?? 'high'];
}

/** Thresholds we judge a place by. Named rather than inlined so the panel and any future
 *  shortlist ranking read the same numbers. */
export const BIGGEST_ROOM_SMALL_SQFT = 450;
export const BIGGEST_ROOM_BIG_SQFT = 600;
/** Below this, "outdoor space" is a window box, not somewhere you sit. */
export const OUTDOOR_MINIMUM_SQFT = 20;

/** What a hunt is looking for, set on the "Your Hunt" page and stored per project (see the
 *  `project_setting` migration). Read here, and nowhere else, so there is one place that decides how
 *  a preference changes a flat's flags. The shape lives with this logic on purpose — adding a
 *  preference is a change here, not a migration, because the store is a jsonb blob. */
export type AmenityWant = 'must' | 'nice';
/** The amenities a hunt can prioritise. Each maps to one analysis field in `AMENITY` below. The two
 *  facts that end a conversation on their own — a house share, a bed in the kitchen — are not here:
 *  they are already hard red for every hunt, so a "must not have" toggle would say nothing new. */
export type AmenityKey = 'outdoor' | 'dishwasher' | 'bathtub' | 'inUnitLaundry' | 'brightLight' | 'billsIncluded';
export interface HuntPreferences {
  /** A biggest-room bar in sq ft: a flat whose largest room clears it earns the great-room mark.
   *  Null/absent leaves the default `BIGGEST_ROOM_BIG_SQFT`. */
  greatRoomMinSqft?: number | null;
  /** The whole flat's floor area, in sq ft, below which it is too small for this hunt.
   *
   *  The obvious preference, and the one that was missing: every surface already resolves and shows
   *  a floor area, triage can filter on it, and nothing ever said whether a given number was *bad*.
   *  A hunt looking for 900 sq ft and a hunt looking for 450 read the identical panel on a 600 sq ft
   *  flat. Absent means no opinion, and no flag either way — a size bar is not something to guess. */
  minSqft?: number | null;
  /** Per amenity, whether the hunt must have it or would merely like it. Absent means "don't mind",
   *  which is the default behaviour these flags already had. */
  amenities?: Partial<Record<AmenityKey, AmenityWant>>;
  /** The Rightmove filters a sweep runs with — see `SweepCriteria`. Absent means the criteria this
   *  project swept with before any of them were choosable, so nothing changes for a hunt that has
   *  never set them. */
  search?: SweepCriteria;
}

/** The address as it reads when the full postcode is printed beside it.
 *
 *  Rightmove's `displayAddress` ends in the outward code — "Pond Street, Hampstead, NW3" — and the
 *  shortlist card states "NW3 2NW" a few pixels away, so the district was on screen twice. The full
 *  postcode is the half worth keeping: it names the street as well as the district, and it is what
 *  every travel time is routed from.
 *
 *  Only for a view that shows both. The panel and the compare table print the address alone and
 *  must keep it whole — this is not "the address", it is the address minus something already said.
 *
 *  Every comma-separated part that is nothing but the outward code goes, not only the last: agents
 *  file addresses like "Greencroft Gardens, NW6, South Hampstead, London, NW6", which put the
 *  district on screen three times between the address and the chip beside it.
 *
 *  Dropped only where the two agree. A part carrying a *different* outward code from the postcode
 *  we hold is two sources disagreeing about where a flat is, which is worth seeing rather than
 *  tidying away; and an address that is nothing but its outward code is returned untouched, since a
 *  blank line where the address goes is worse than a repetition. */
export function addressBesidePostcode(displayAddress: string, postcode: string | null): string {
  const outward = postcode?.trim().split(/\s+/)[0]?.toUpperCase();
  if (!outward) return displayAddress;
  const kept = displayAddress
    .split(',')
    .filter((part) => part.trim().toUpperCase() !== outward)
    .join(',')
    .trim()
    .replace(/,$/, '');
  return kept || displayAddress;
}

/** A station distance in the unit Rightmove actually supplied.
 *
 *  Every view printed "mi" regardless. `unit` is extracted and stored, so a listing served in
 *  kilometres would have read as 0.8 miles when it meant 0.8 km — the kind of wrong that never
 *  looks wrong. In practice Rightmove sends "miles", which is exactly why nobody noticed. */
export function stationDistance(distance: number, unit: string): string {
  const short = /^mile/i.test(unit) ? 'mi' : /^(km|kilomet)/i.test(unit) ? 'km' : unit;
  return `${distance.toFixed(1)} ${short}`;
}

/** What the photos say about a flat, and how much of a problem each thing is.
 *
 *  "Flag" was only ever a CSS class before: everything that wasn't good news took the same red, so
 *  a bathroom with a shower instead of a bath looked exactly as serious as a main room coming in
 *  slightly under target. They are not the same. A red flag is a reason not to view the place at
 *  all — no bath, nowhere to sit outside. A yellow one is a reservation you would raise at the
 *  viewing rather than skip it over.
 *
 *  Derived here rather than in each view because the card, the panel and the compare table had
 *  three copies of these thresholds and three sets of wording, and they had already drifted apart
 *  once. */
export type Severity = 'red' | 'yellow' | 'good';

export interface Flag {
  /** Stable identity, so a view can pick a subset without matching on the words. */
  key: string;
  severity: Severity;
  /** Already hedged for confidence, via `claimLabel`. */
  text: string;
  /** How sure the model was, or null where the fact is not an inference at all — "there is no
   *  floorplan" is something the page told us. */
  confidence: Confidence | null;
}

export interface FlagSource {
  analysis?: {
    hasFloorplan?: boolean | null;
    floorplanLegible?: boolean | null;
    hasBathtub?: boolean | null;
    bathtubConfidence?: Confidence | null;
    biggestRoomSqft?: number | null;
    biggestRoomConfidence?: Confidence | null;
    hasOutdoorSpace?: boolean | null;
    outdoorKind?: string | null;
    outdoorSqft?: number | null;
    outdoorIsEstimate?: boolean | null;
    outdoorConfidence?: Confidence | null;
    isHouseShare?: boolean | null;
    houseShareConfidence?: Confidence | null;
    laundry?: Laundry | null;
    laundryConfidence?: Confidence | null;
    hasDishwasher?: boolean | null;
    dishwasherConfidence?: Confidence | null;
    bedInKitchen?: boolean | null;
    bedInKitchenConfidence?: Confidence | null;
    utilitiesIncluded?: boolean | null;
    utilitiesConfidence?: Confidence | null;
    naturalLight?: LightLevel | null;
    naturalLightConfidence?: Confidence | null;
  } | null;
  floorplanUrl?: string | null;
  /** Where the flat's floor area can be read from — the same `SizeSource` the size on screen beside
   *  the flags is resolved from, so the two can't disagree about which figure wins. Callers already
   *  hold one: `sizeOf(entry)`. */
  size?: SizeSource | null;
}

/* A flag carries no picture. It used to carry an emoji chosen here, which put a rendering decision
   in the data layer and then made it twice: every flag that was not good news rendered the same
   warning sign, so "no bathtub" — a reason to skip the viewing — looked exactly like an unreadable
   floorplan, and the bath glyph marked both "bathtub" and "no bathtub". `FlagChip` draws the glyph
   now, from `key` and `severity`, out of the one drawn icon set both surfaces share. */

export function flagsFor({ analysis, floorplanUrl, size }: FlagSource, prefs?: HuntPreferences): Flag[] {
  const flags: Flag[] = [];
  const floorArea = size ? resolveSize(size) : null;

  // The whole flat against the hunt's own bar, before anything the photos say. Only when both
  // numbers exist: an unmeasured flat is not a small one (the same rule triage's filters follow),
  // and a hunt that has set no bar has no opinion for this to report.
  //
  // Red rather than amber, and deliberately unlike the main-room flag above it. A main room a
  // little under target is a reservation you settle by standing in it; a flat two hundred square
  // feet under what you need is not a viewing you were going to enjoy. The bar is the hunt's own
  // number, so being under it is their own judgement rather than ours.
  if (prefs?.minSqft != null && floorArea && floorArea.value < prefs.minSqft) {
    flags.push({
      key: 'size',
      severity: 'red',
      // The caveat rides along: a figure read out of the description may be measuring the garden,
      // and being told a flat is too small on the strength of one is worth knowing about.
      text: `${floorArea.value} sq ft — under your ${prefs.minSqft}${floorArea.approximate ? ', and approximate' : ''}`,
      confidence: null,
    });
  }

  if (!analysis) {
    if (!floorplanUrl) {
      flags.push({ key: 'floorplan', severity: 'yellow', text: 'no floorplan', confidence: null });
    }
    return flags;
  }

  if (!analysis.hasFloorplan && !floorplanUrl) {
    flags.push({ key: 'floorplan', severity: 'yellow', text: 'no floorplan', confidence: null });
  } else if (analysis.floorplanLegible === false) {
    // A plan we could not read is not the same as no plan: it means everything below it came from
    // the photos alone, which is worth knowing before trusting any of it.
    flags.push({
      key: 'floorplan',
      severity: 'yellow',
      text: 'floorplan unreadable',
      confidence: null,
    });
  }

  const bath = analysis.bathtubConfidence ?? null;
  if (analysis.hasBathtub === false) {
    // Red: a shower-only flat is a reason to skip the viewing, not a reservation to raise at it.
    flags.push({ key: 'bathtub', severity: 'red', text: claimLabel('bathtub-absent', bath), confidence: bath });
  } else if (analysis.hasBathtub) {
    flags.push({ key: 'bathtub', severity: 'good', text: claimLabel('bathtub-present', bath), confidence: bath });
  }

  const room = analysis.biggestRoomSqft ?? null;
  const rooms = analysis.biggestRoomConfidence ?? null;
  // A hunt can set its own bar for what counts as a great room; without one, the default stands.
  const bigThreshold = prefs?.greatRoomMinSqft ?? BIGGEST_ROOM_BIG_SQFT;
  if (room !== null && room < BIGGEST_ROOM_SMALL_SQFT) {
    // Yellow: a small main room is a real objection, but one you can settle by standing in it —
    // and the number is what tells you whether it is worth the trip. "Small" spans a bedsit and a
    // 440 sq ft reception, which are not the same objection.
    flags.push({
      key: 'rooms',
      severity: 'yellow',
      text: `${claimLabel('rooms-small', rooms)} · ${room} sq ft`,
      confidence: rooms,
    });
  } else if (room !== null && room >= bigThreshold) {
    // At or above the bar counts — "450 sq ft or bigger" includes exactly 450.
    // When the bar is the hunt's own, name it a great room and say the size — that is the number
    // the preference was set against, so it is the one worth showing.
    const named = prefs?.greatRoomMinSqft != null;
    flags.push({
      key: 'rooms',
      severity: 'good',
      text: named ? `great room · ${room} sq ft` : claimLabel('rooms-big', rooms),
      confidence: rooms,
    });
  }

  const outdoor = analysis.outdoorConfidence ?? null;
  const area = analysis.outdoorSqft ?? null;
  if (analysis.hasOutdoorSpace === false) {
    flags.push({ key: 'outdoor', severity: 'red', text: claimLabel('outdoor-absent', outdoor), confidence: outdoor });
  } else if (analysis.hasOutdoorSpace && area !== null && area < OUTDOOR_MINIMUM_SQFT) {
    // Under the minimum it is a window box rather than somewhere to sit, which is the same answer
    // as none at all.
    flags.push({ key: 'outdoor', severity: 'red', text: `only ${area} sq ft outdoors`, confidence: outdoor });
  } else if (analysis.hasOutdoorSpace) {
    flags.push({
      key: 'outdoor',
      severity: 'good',
      text: [
        analysis.outdoorKind ?? 'outdoor space',
        area !== null ? `${analysis.outdoorIsEstimate ? 'about ' : ''}${area} sq ft` : null,
      ]
        .filter(Boolean)
        .join(', '),
      confidence: outdoor,
    });
  }

  // The five amenities, in the order they decide anything.
  //
  // Two of them can end the conversation on their own and are red for that reason: a room in a
  // house share is not the thing being looked for at all, and a bed in the kitchen is a studio
  // wearing a one-bedroom's clothes. The rest are things you would want to know before a viewing
  // and would not cancel one over.
  const share = analysis.houseShareConfidence ?? null;
  if (analysis.isHouseShare) {
    flags.push({ key: 'share', severity: 'red', text: claimLabel('house-share', share), confidence: share });
  }

  const kitchenBed = analysis.bedInKitchenConfidence ?? null;
  if (analysis.bedInKitchen) {
    flags.push({
      key: 'bed-in-kitchen',
      severity: 'red',
      text: claimLabel('bed-in-kitchen', kitchenBed),
      confidence: kitchenBed,
    });
  }

  const wash = analysis.laundryConfidence ?? null;
  if (analysis.laundry === 'none') {
    flags.push({ key: 'laundry', severity: 'yellow', text: claimLabel('laundry-none', wash), confidence: wash });
  } else if (analysis.laundry === 'in-building') {
    flags.push({
      key: 'laundry',
      severity: 'yellow',
      text: claimLabel('laundry-building', wash),
      confidence: wash,
    });
  } else if (analysis.laundry === 'in-unit') {
    flags.push({ key: 'laundry', severity: 'good', text: claimLabel('laundry-unit', wash), confidence: wash });
  }

  const dish = analysis.dishwasherConfidence ?? null;
  if (analysis.hasDishwasher === false) {
    flags.push({
      key: 'dishwasher',
      severity: 'yellow',
      text: claimLabel('dishwasher-absent', dish),
      confidence: dish,
    });
  } else if (analysis.hasDishwasher) {
    flags.push({
      key: 'dishwasher',
      severity: 'good',
      text: claimLabel('dishwasher-present', dish),
      confidence: dish,
    });
  }

  // Only ever shown when true. Bills not being included is what almost every rental does, so an
  // amber "bills not included" on nearly every place would be a column of noise saying nothing.
  const bills = analysis.utilitiesConfidence ?? null;
  if (analysis.utilitiesIncluded) {
    flags.push({ key: 'bills', severity: 'good', text: claimLabel('bills-included', bills), confidence: bills });
  }

  // Only the ends of the scale say anything. "Medium light" on two thirds of the rows is a column
  // of noise, and it is also the answer the model reaches for when it is unsure.
  const lit = analysis.naturalLightConfidence ?? null;
  if (analysis.naturalLight === 'low') {
    flags.push({ key: 'light', severity: 'yellow', text: claimLabel('light-low', lit), confidence: lit });
  } else if (analysis.naturalLight === 'high') {
    flags.push({ key: 'light', severity: 'good', text: claimLabel('light-high', lit), confidence: lit });
  }

  applyAmenityWants(flags, analysis, prefs);
  return forgetAmenitiesNobodyMinds(flags, prefs);
}

/** Drop every flag about an amenity this hunt said it does not mind about.
 *
 *  The Your Hunt page offers three answers per amenity — don't mind, nice to have, must have — and
 *  until now the first of them did nothing at all. A hunt that had explicitly said it did not care
 *  about a bathtub still got "no bathtub" in amber on every panel, which is the settings screen and
 *  the panel disagreeing in writing about what the hunt is looking for. Told twice a day, on a flat
 *  you have no objection to, that it lacks a thing you said you did not want, the flags stop being
 *  read at all — and the ones that matter go with them.
 *
 *  The consequence worth stating: a hunt that has never opened the preferences has every amenity at
 *  "don't mind", so it gets no amenity flags. That is the same sentence as above and it is the
 *  honest default — the screen says "don't mind" for all six before anyone touches it, and a panel
 *  contradicting that was the bug. The flags this never touches are the ones that are not a matter
 *  of preference: no floorplan, an unreadable floorplan, the size against the great-room bar.
 */
function forgetAmenitiesNobodyMinds(flags: Flag[], prefs: HuntPreferences | undefined): Flag[] {
  const minded = new Set(
    AMENITIES.filter((a) => prefs?.amenities?.[a.key]).map((a) => a.flagKey),
  );
  const optional = new Set(AMENITIES.map((a) => a.flagKey));
  return flags.filter((f) => !optional.has(f.key) || minded.has(f.key));
}

/** How much each amenity the hunt named actually matters to it, layered on top of the default flags.
 *
 *  The defaults already flag most absences — a missing dishwasher is amber, no outdoor space is red —
 *  but they treat every hunt the same. A hunt that has said it *must* have a dishwasher wants that
 *  amber to be a red, and a flat that is missing something the hunt merely said would be *nice* stays
 *  a reservation rather than a dealbreaker. So this only ever raises the stakes of an absence the
 *  hunt cares about, and never lowers one the defaults already called serious. A present or unknown
 *  amenity is left exactly as the defaults had it.
 *
 *  The severity is the whole of what it has to say. Flags used to be suffixed "· must have", which
 *  spelled out in words what the red circle beside it already meant, on the one line of the card
 *  where every character competes with another fact about the flat. */
function applyAmenityWants(
  flags: Flag[],
  analysis: NonNullable<FlagSource['analysis']>,
  prefs: HuntPreferences | undefined,
): void {
  if (!prefs?.amenities) return;
  const severityRank: Record<Severity, number> = { good: 0, yellow: 1, red: 2 };

  for (const key of Object.keys(prefs.amenities) as AmenityKey[]) {
    const want = prefs.amenities[key];
    if (!want) continue;
    // Persisted preferences are a jsonb blob and could carry a key from a newer or hand-edited
    // build; an unknown one is skipped rather than dereferenced, so bad data can never crash the
    // shortlist or the compare table.
    const spec = AMENITY[key];
    if (!spec) continue;
    // Only an amenity the flat is *known* to lack is escalated — unknown is not an absence, and
    // present is what the hunt wanted.
    if (spec.present(analysis) !== false) continue;

    const target: Severity = want === 'must' ? 'red' : 'yellow';
    const existing = flags.find((f) => f.key === spec.flagKey);
    if (existing) {
      if (severityRank[target] > severityRank[existing.severity]) {
        existing.severity = target;
      }
    } else {
      flags.push({
        key: spec.flagKey,
        severity: target,
        text: `no ${spec.label}`,
        confidence: null,
      });
    }
  }
}

/** Each preferable amenity, mapped to the analysis field that says whether a flat has it and the
 *  flag key the defaults use for it — so a preference escalates the existing flag rather than adding
 *  a second one about the same thing. `present` returns null for unknown, never a false.
 *
 *  Exported, and in this order, because three surfaces ask the same question of it: the flags
 *  above, the preferences on the Your Hunt page, and triage's filters. The Your Hunt page kept its
 *  own copy of the list until the filters wanted a third — and a list of amenities that exists
 *  twice is one that will disagree with itself about what a flat has.
 *
 *  Two names each, because the same amenity is read in two places: `label` goes mid-sentence in a
 *  flag ("no outdoor space · must have"), `name` stands alone on a control. */
export const AMENITIES: Array<{
  key: AmenityKey;
  name: string;
  label: string;
  flagKey: string;
  present: (a: NonNullable<FlagSource['analysis']>) => boolean | null;
}> = [
  { key: 'outdoor', name: 'Outdoor space', flagKey: 'outdoor', label: 'outdoor space', present: (a) => a.hasOutdoorSpace ?? null },
  { key: 'dishwasher', name: 'Dishwasher', flagKey: 'dishwasher', label: 'dishwasher', present: (a) => a.hasDishwasher ?? null },
  { key: 'bathtub', name: 'Bathtub', flagKey: 'bathtub', label: 'bathtub', present: (a) => a.hasBathtub ?? null },
  {
    key: 'inUnitLaundry',
    name: 'In-unit laundry',
    flagKey: 'laundry',
    label: 'in-unit laundry',
    present: (a) => (a.laundry == null ? null : a.laundry === 'in-unit'),
  },
  {
    key: 'brightLight',
    name: 'Good natural light',
    flagKey: 'light',
    label: 'good natural light',
    // Only "high" counts as having it; "medium" is the model's unsure answer, not a yes.
    present: (a) => (a.naturalLight == null ? null : a.naturalLight === 'high'),
  },
  {
    key: 'billsIncluded',
    name: 'Bills included',
    flagKey: 'bills',
    label: 'bills included',
    present: (a) => a.utilitiesIncluded ?? null,
  },
];

const AMENITY: Record<AmenityKey, (typeof AMENITIES)[number]> = Object.fromEntries(
  AMENITIES.map((a) => [a.key, a]),
) as Record<AmenityKey, (typeof AMENITIES)[number]>;

/** Whether a flat has an amenity: true, false, or null for "the photos did not say". The three
 *  answers are the whole point — an amenity nobody could see is not one the flat lacks. */
export function amenityPresent(
  key: AmenityKey,
  analysis: FlagSource['analysis'],
): boolean | null {
  if (!analysis) return null;
  return AMENITY[key]?.present(analysis) ?? null;
}

/** Only what is wrong. The compare table exists to scan seventeen rows at once, and a column that
 *  says "bathtub" on fourteen of them spends its width telling you nothing — the question a table
 *  answers is which places have something against them. */
export function problemsOnly(flags: Flag[]): Flag[] {
  return flags.filter((f) => f.severity !== 'good');
}

/** Red outranks yellow outranks nothing, so a column of flags can sort worst-first. */
export function worstSeverity(flags: Flag[]): number {
  if (flags.some((f) => f.severity === 'red')) return 2;
  if (flags.some((f) => f.severity === 'yellow')) return 1;
  return 0;
}
