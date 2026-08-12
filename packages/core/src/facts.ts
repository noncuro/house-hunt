/** Turning several disagreeing sources into one number you can act on.
 *
 *  A listing tells you its size, its beds and its baths more than once — the structured data,
 *  the description prose, and the floorplan the model read — and they routinely disagree.
 *  Verified case: Rightmove's `sizings` said 1044 sq ft where the plan plainly stated 1105.
 *  Showing all of them is noise; showing one silently hides that a check is warranted. So we
 *  show the most trustworthy one, mark it, and put the rest one hover away. */

import type { Confidence, Laundry, LightLevel } from './types';

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
  /** Per amenity, whether the hunt must have it or would merely like it. Absent means "don't mind",
   *  which is the default behaviour these flags already had. */
  amenities?: Partial<Record<AmenityKey, AmenityWant>>;
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
  icon: string;
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
}

/** One glyph per severity, and never the same glyph for two of them.
 *
 *  Every flag that was not good news used to render `⚠️`, so "no bathtub" — a reason to skip the
 *  viewing — looked exactly like an unreadable floorplan. Worse, `🛁` marked both "bathtub" and
 *  "no bathtub", so the icon actively argued against the words next to it at a glance. The icon
 *  now carries severity and nothing else; the subject icon survives only on good news, where
 *  there is no severity for it to contradict. */
export const FLAG_ICON: Record<Severity, string> = { red: '⛔', yellow: '⚠️', good: '' };
const RED = FLAG_ICON.red;
const AMBER = FLAG_ICON.yellow;

export function flagsFor({ analysis, floorplanUrl }: FlagSource, prefs?: HuntPreferences): Flag[] {
  const flags: Flag[] = [];

  if (!analysis) {
    if (!floorplanUrl) {
      flags.push({ key: 'floorplan', severity: 'yellow', icon: AMBER, text: 'no floorplan', confidence: null });
    }
    return flags;
  }

  if (!analysis.hasFloorplan && !floorplanUrl) {
    flags.push({ key: 'floorplan', severity: 'yellow', icon: AMBER, text: 'no floorplan', confidence: null });
  } else if (analysis.floorplanLegible === false) {
    // A plan we could not read is not the same as no plan: it means everything below it came from
    // the photos alone, which is worth knowing before trusting any of it.
    flags.push({
      key: 'floorplan',
      severity: 'yellow',
      icon: AMBER,
      text: 'floorplan unreadable',
      confidence: null,
    });
  }

  const bath = analysis.bathtubConfidence ?? null;
  if (analysis.hasBathtub === false) {
    // Red: a shower-only flat is a reason to skip the viewing, not a reservation to raise at it.
    flags.push({ key: 'bathtub', severity: 'red', icon: RED, text: claimLabel('bathtub-absent', bath), confidence: bath });
  } else if (analysis.hasBathtub) {
    flags.push({ key: 'bathtub', severity: 'good', icon: '🛁', text: claimLabel('bathtub-present', bath), confidence: bath });
  }

  const room = analysis.biggestRoomSqft ?? null;
  const rooms = analysis.biggestRoomConfidence ?? null;
  // A hunt can set its own bar for what counts as a great room; without one, the default stands.
  const bigThreshold = prefs?.greatRoomMinSqft ?? BIGGEST_ROOM_BIG_SQFT;
  if (room !== null && room < BIGGEST_ROOM_SMALL_SQFT) {
    // Yellow: a small main room is a real objection, but one you can settle by standing in it.
    flags.push({ key: 'rooms', severity: 'yellow', icon: AMBER, text: claimLabel('rooms-small', rooms), confidence: rooms });
  } else if (room !== null && room > bigThreshold) {
    // When the bar is the hunt's own, name it a great room and say the size — that is the number
    // the preference was set against, so it is the one worth showing.
    const named = prefs?.greatRoomMinSqft != null;
    flags.push({
      key: 'rooms',
      severity: 'good',
      icon: '⭐',
      text: named ? `great room · ${room} sq ft` : claimLabel('rooms-big', rooms),
      confidence: rooms,
    });
  }

  const outdoor = analysis.outdoorConfidence ?? null;
  const area = analysis.outdoorSqft ?? null;
  if (analysis.hasOutdoorSpace === false) {
    flags.push({ key: 'outdoor', severity: 'red', icon: RED, text: claimLabel('outdoor-absent', outdoor), confidence: outdoor });
  } else if (analysis.hasOutdoorSpace && area !== null && area < OUTDOOR_MINIMUM_SQFT) {
    // Under the minimum it is a window box rather than somewhere to sit, which is the same answer
    // as none at all.
    flags.push({ key: 'outdoor', severity: 'red', icon: RED, text: `only ${area} sq ft outdoors`, confidence: outdoor });
  } else if (analysis.hasOutdoorSpace) {
    flags.push({
      key: 'outdoor',
      severity: 'good',
      icon: '🌿',
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
    flags.push({ key: 'share', severity: 'red', icon: RED, text: claimLabel('house-share', share), confidence: share });
  }

  const kitchenBed = analysis.bedInKitchenConfidence ?? null;
  if (analysis.bedInKitchen) {
    flags.push({
      key: 'bed-in-kitchen',
      severity: 'red',
      icon: RED,
      text: claimLabel('bed-in-kitchen', kitchenBed),
      confidence: kitchenBed,
    });
  }

  const wash = analysis.laundryConfidence ?? null;
  if (analysis.laundry === 'none') {
    flags.push({ key: 'laundry', severity: 'yellow', icon: AMBER, text: claimLabel('laundry-none', wash), confidence: wash });
  } else if (analysis.laundry === 'in-building') {
    flags.push({
      key: 'laundry',
      severity: 'yellow',
      icon: AMBER,
      text: claimLabel('laundry-building', wash),
      confidence: wash,
    });
  } else if (analysis.laundry === 'in-unit') {
    flags.push({ key: 'laundry', severity: 'good', icon: '🧺', text: claimLabel('laundry-unit', wash), confidence: wash });
  }

  const dish = analysis.dishwasherConfidence ?? null;
  if (analysis.hasDishwasher === false) {
    flags.push({
      key: 'dishwasher',
      severity: 'yellow',
      icon: AMBER,
      text: claimLabel('dishwasher-absent', dish),
      confidence: dish,
    });
  } else if (analysis.hasDishwasher) {
    flags.push({
      key: 'dishwasher',
      severity: 'good',
      icon: '🍽',
      text: claimLabel('dishwasher-present', dish),
      confidence: dish,
    });
  }

  // Only ever shown when true. Bills not being included is what almost every rental does, so an
  // amber "bills not included" on nearly every place would be a column of noise saying nothing.
  const bills = analysis.utilitiesConfidence ?? null;
  if (analysis.utilitiesIncluded) {
    flags.push({ key: 'bills', severity: 'good', icon: '💡', text: claimLabel('bills-included', bills), confidence: bills });
  }

  // Only the ends of the scale say anything. "Medium light" on two thirds of the rows is a column
  // of noise, and it is also the answer the model reaches for when it is unsure.
  const lit = analysis.naturalLightConfidence ?? null;
  if (analysis.naturalLight === 'low') {
    flags.push({ key: 'light', severity: 'yellow', icon: AMBER, text: claimLabel('light-low', lit), confidence: lit });
  } else if (analysis.naturalLight === 'high') {
    flags.push({ key: 'light', severity: 'good', icon: '☀️', text: claimLabel('light-high', lit), confidence: lit });
  }

  applyAmenityWants(flags, analysis, prefs);
  return flags;
}

/** How much each amenity the hunt named actually matters to it, layered on top of the default flags.
 *
 *  The defaults already flag most absences — a missing dishwasher is amber, no outdoor space is red —
 *  but they treat every hunt the same. A hunt that has said it *must* have a dishwasher wants that
 *  amber to be a red, and a flat that is missing something the hunt merely said would be *nice* stays
 *  a reservation rather than a dealbreaker. So this only ever raises the stakes of an absence the
 *  hunt cares about, never lowers one the defaults already called serious, and it says which
 *  preference it was. A present or unknown amenity is left exactly as the defaults had it. */
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
    const spec = AMENITY[key];
    // Only an amenity the flat is *known* to lack is escalated — unknown is not an absence, and
    // present is what the hunt wanted.
    if (spec.present(analysis) !== false) continue;

    const target: Severity = want === 'must' ? 'red' : 'yellow';
    const existing = flags.find((f) => f.key === spec.flagKey);
    if (existing) {
      if (severityRank[target] > severityRank[existing.severity]) {
        existing.severity = target;
        existing.icon = FLAG_ICON[target];
      }
      existing.text = `${existing.text} · ${want} have`;
    } else {
      flags.push({
        key: spec.flagKey,
        severity: target,
        icon: FLAG_ICON[target],
        text: `no ${spec.label} · ${want} have`,
        confidence: null,
      });
    }
  }
}

/** Each preferable amenity, mapped to the analysis field that says whether a flat has it and the
 *  flag key the defaults use for it — so a preference escalates the existing flag rather than adding
 *  a second one about the same thing. `present` returns null for unknown, never a false. */
const AMENITY: Record<
  AmenityKey,
  { flagKey: string; label: string; present: (a: NonNullable<FlagSource['analysis']>) => boolean | null }
> = {
  outdoor: { flagKey: 'outdoor', label: 'outdoor space', present: (a) => a.hasOutdoorSpace ?? null },
  dishwasher: { flagKey: 'dishwasher', label: 'dishwasher', present: (a) => a.hasDishwasher ?? null },
  bathtub: { flagKey: 'bathtub', label: 'bathtub', present: (a) => a.hasBathtub ?? null },
  inUnitLaundry: {
    flagKey: 'laundry',
    label: 'in-unit laundry',
    present: (a) => (a.laundry == null ? null : a.laundry === 'in-unit'),
  },
  brightLight: {
    flagKey: 'light',
    label: 'good natural light',
    // Only "high" counts as having it; "medium" is the model's unsure answer, not a yes.
    present: (a) => (a.naturalLight == null ? null : a.naturalLight === 'high'),
  },
  billsIncluded: {
    flagKey: 'bills',
    label: 'bills included',
    present: (a) => a.utilitiesIncluded ?? null,
  },
};

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
