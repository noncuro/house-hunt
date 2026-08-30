// GENERATED — do not edit. Copied from packages/core/src/ by tools/sync-edge-function.ts.
// Edit the original and run `pnpm sync:function`.

/** Building the search a sweep runs, and deciding how far back it has to look.
 *
 *  A sweep is the deliberate half of this extension: rather than waiting to stumble on listings,
 *  you open one Rightmove search per neighbourhood and work down it. Everything here is pure, and
 *  it is pure on purpose — `check:sweep` covers it, because the one number that matters is the
 *  one nobody can see being wrong. If the "how many days back" window comes out a day short, the
 *  sweep silently omits the listings added in that day and the panel cheerfully reports that
 *  everything on the page is already recorded. That failure looks exactly like success.
 */
import type { SweepHub } from './hubs.ts';

/** The only values Rightmove's `maxDaysSinceAdded` accepts. Its filter is a dropdown, not a free
 *  number: anything else is either rejected or silently rounded by the site, and we would rather
 *  choose the rounding ourselves than find out which. */
export const SWEEP_WINDOWS = [1, 3, 7, 14] as const;
export type SweepWindow = (typeof SWEEP_WINDOWS)[number];

/** The widest window the filter offers. A gap longer than this cannot be covered in one sweep. */
export const WIDEST_WINDOW: SweepWindow = 14;

/** Slack added to the elapsed time before it is snapped to a window.
 *
 *  Rightmove states an added date, not an added time — the cards say "Added on 07/08/2026" — so
 *  we do not know whether `maxDaysSinceAdded=1` means "in the last 24 hours" or "today and
 *  yesterday", and the two differ by up to a day at the boundary. Half a day of slack means the
 *  snap lands on the wider bucket whenever we are near an edge, which costs us some listings we
 *  have already seen and no listings we have not. That is the trade this constant exists to make.
 */
export const SWEEP_MARGIN_HOURS = 12;

const HOURS_PER_DAY = 24;
const MS_PER_HOUR = 3600_000;

export interface SweepWindowChoice {
  /** What to put in `maxDaysSinceAdded`. */
  days: SweepWindow;
  /** Days since the last sweep of this hub, or null if it has never been swept. */
  elapsedDays: number | null;
  /** False when the gap since the last sweep is wider than 14 days, so even the widest filter
   *  leaves a hole. The panel says this out loud instead of quietly using 14 and looking done. */
  covered: boolean;
}

/** How many days back this hub's sweep should look.
 *
 *  Always snaps *up* to a window at least as wide as the gap since the last sweep, never down —
 *  a window narrower than the gap drops listings on the floor, whereas one that is too wide only
 *  shows you rows you have already recorded and can hide with a click.
 *
 *  Never swept means the widest window. That is not the same as "all listings ever", and it is
 *  the right answer anyway: the first sweep of a hub is about catching the current market, and
 *  a full back-catalogue is what the shortlist is for.
 *
 *  `lastSweptAt` comes from `hub_sweep`, through `lastSweptFor`, and from nowhere else — the row's
 *  date is only a date for the search it was stamped with. It briefly sat on `project_hub` as
 *  well and `20260809290000_record_property_link.sql` dropped that copy: two homes for one fact is
 *  how they come to disagree, and a disagreement here means narrowing the next window past
 *  listings nobody looked at. `hub_sweep` keeps it because that is where the rule about what may
 *  set it — only a complete pass — is written down.
 *
 *  `minimumDays` is a hub's own `max_days_since_added`, and it is a **floor, never a ceiling**.
 *  A per-hub setting that could narrow the window would be a switch for the one failure here that
 *  looks exactly like success: the search returns fewer flats, the panel reports the page fully
 *  recorded, and nothing anywhere says the missing ones were skipped. As a floor it can only make
 *  a hub look further back than the elapsed time demands, which costs a screenful of rows you
 *  already have. */
export function sweepWindow(
  lastSweptAt: string | null,
  now: Date = new Date(),
  minimumDays: number | null = null,
): SweepWindowChoice {
  const atLeast = (choice: SweepWindowChoice): SweepWindowChoice => {
    if (minimumDays === null || choice.days >= minimumDays) return choice;
    return { ...choice, days: SWEEP_WINDOWS.find((window) => window >= minimumDays) ?? WIDEST_WINDOW };
  };

  if (!lastSweptAt) return atLeast({ days: WIDEST_WINDOW, elapsedDays: null, covered: true });

  const swept = new Date(lastSweptAt).getTime();
  // An unparseable timestamp is a broken row, not a recent sweep. Treating it as "never" is the
  // conservative reading: it widens the window rather than narrowing it.
  if (Number.isNaN(swept)) return atLeast({ days: WIDEST_WINDOW, elapsedDays: null, covered: true });

  // A clock skew between the two laptops can put the last sweep slightly in the future. Clamping
  // at zero keeps that from producing a negative gap, which would snap to the narrowest window
  // for the wrong reason.
  const elapsedDays = Math.max(0, (now.getTime() - swept) / (MS_PER_HOUR * HOURS_PER_DAY));
  const needed = elapsedDays + SWEEP_MARGIN_HOURS / HOURS_PER_DAY;

  const days = SWEEP_WINDOWS.find((window) => window >= needed) ?? WIDEST_WINDOW;
  // `covered` reports the gap, not the floor: widening the window past what the gap needs does not
  // change whether the last sweep is reachable, and saying "covered" because a floor pushed the
  // number up would be the same lie in a different place.
  return atLeast({ days, elapsedDays, covered: needed <= WIDEST_WINDOW });
}

/** What makes this a rental search at all, and nothing beyond that.
 *
 *  There used to be a `SWEEP_CRITERIA` constant here holding one to three bedrooms, four to six
 *  thousand a month and a mile of radius — the search one hunt had been running by hand, compiled
 *  in, and therefore run by every hunt using this app whether they were looking in Hampstead or
 *  Hull. It is the same mistake as `SEED_HUBS`, which AGENTS.md already names: a constant standing
 *  in for project data puts one project's answer on another project's flats, and does it silently,
 *  because a search that returns results always looks like it worked.
 *
 *  A price band is not a sensible default. There is no number here that is right for a hunt we know
 *  nothing about, and picking one is worse than picking none: a hunt that never set its own would
 *  sweep somebody else's budget and find nothing, with no sign anywhere that the filter rather than
 *  the market was the reason. So there is no fallback. A project that has not said what it is
 *  looking for cannot sweep, exactly as a hub with no Rightmove location cannot — see
 *  `sweepSearchUrl`, which returns null for both and lets the surface say which.
 *
 *  What is left here is not preference. Rightmove needs to be told this is a letting search before
 *  any filter means anything, and no hunt using this app is buying. */
export const RENTAL_SEARCH: SweepCriteria = {
  rent: 'To rent',
  channel: 'RENT',
  transactionType: 'LETTING',
};

/** The saved criteria as Rightmove's own query parameters, which is the whole of the design.
 *
 *  The obvious version of "let people choose the filters" is a form: a price box, a beds box, a
 *  furnish-type picker, and a field in `HuntPreferences` for each. It is the wrong shape. Rightmove
 *  has upwards of a dozen filters — property types, must-haves, let type, bathrooms, what not to
 *  show — it adds to them, and each one modelled here is a field to define, a control to build, a
 *  migration to write and a thing to keep in step with a site nobody here controls. A hunt that
 *  wanted one we had not modelled could not have it.
 *
 *  So the criteria are stored as the parameters themselves, taken off a search URL somebody has
 *  already set up on Rightmove — where the filters are, where they are explained, and where you can
 *  see the results before committing. What we keep is that query minus the three things a sweep
 *  decides for itself, below. Anything Rightmove supports works on the day it ships, including the
 *  filters in this comment that this app has never heard of. */
export type SweepCriteria = Record<string, string>;

/** The parameters a sweep owns, and which a pasted URL therefore never contributes.
 *
 *  `locationIdentifier` and its two companions are the *hub* — the whole point is running the same
 *  criteria against each neighbourhood in turn, so taking the one in the pasted URL would pin every
 *  sweep to whichever area happened to be on screen when it was copied. `maxDaysSinceAdded` is the
 *  *window*, which `sweepWindow` computes from when that hub was last swept and must not be frozen
 *  to the value in a URL copied once. `index` is the pager. `sortType` is newest-first, which is
 *  what makes a sweep terminate at all (see `SORT_NEWEST_FIRST`) — a URL sorted by price would make
 *  the sweep unbounded, so it is ours rather than theirs. */
const SWEEP_OWNS = new Set([
  'searchLocation',
  'useLocationIdentifier',
  'locationIdentifier',
  'displayLocationIdentifier',
  'maxDaysSinceAdded',
  'index',
  'sortType',
  // The radius belongs to the place being swept, not to the hunt's filters. A pasted URL carries
  // whatever was on screen when it was copied, and applying that one number to every place is
  // exactly what a per-place radius exists to stop.
  'radius',
]);


/** What a pasted Rightmove search URL says this hunt is looking for.
 *
 *  Returns the criteria and, separately, the parameters that were dropped — because dropping them
 *  silently is how somebody pastes a Hampstead search, sweeps Peckham with it, and never finds out
 *  why the results look wrong. The screen says which ones it took charge of and why.
 *
 *  Anything that is not a Rightmove rental search comes back null rather than as an empty set of
 *  criteria, since an empty set is a valid and very wide search — "everything, everywhere" — and
 *  accepting a pasted tweet as one would quietly widen the sweep to the whole country. */
export function criteriaFromUrl(href: string): { criteria: SweepCriteria; ignored: string[] } | null {
  let url: URL;
  try {
    url = new URL(href.trim());
  } catch {
    return null;
  }
  if (!/(^|\.)rightmove\.co\.uk$/i.test(url.hostname)) return null;
  if (!url.pathname.includes('find.html')) return null;

  const criteria: SweepCriteria = {};
  const ignored: string[] = [];
  for (const [key, value] of url.searchParams) {
    // Rightmove writes the literal string "undefined" into `displayLocationIdentifier` on some of
    // its own links. It is in `SWEEP_OWNS` regardless, so this is only worth noting: a value that
    // looks like a bug is a good sign the URL was copied from the address bar, which is exactly
    // where we want it copied from.
    if (SWEEP_OWNS.has(key)) {
      ignored.push(key);
      continue;
    }
    // Rightmove routinely emits `minPrice=&maxPrice=` for a filter nobody set. Kept, those are
    // filters in name only: `sweepSearchUrl` would count the hunt as having chosen something (the
    // object is not empty) while nothing is actually narrowed, and the summary would read
    // "Rent £–£". An empty value is the absence of a filter, so it is recorded as dropped.
    if (value === '') {
      ignored.push(key);
      continue;
    }
    // A repeated parameter cannot survive a flat record, and the last one silently winning is the
    // same class of failure this function exists to prevent — a search that looks like the one you
    // pasted and is not. Say so rather than lose it quietly.
    if (key in criteria) {
      ignored.push(key);
      continue;
    }
    criteria[key] = value;
  }
  return { criteria, ignored: [...new Set(ignored)] };
}

/** What a sweep's progress is progress *on*: the filters it ran with, in a form two sets of them
 *  can be compared by.
 *
 *  `hub_sweep.last_swept_at` means "we have seen everything this search returns up to here", and
 *  that sentence is about one search. Raise the rent ceiling and a flat listed three months ago,
 *  outside the old ceiling, is one nobody has looked at — but it is older than `last_swept_at`, so
 *  the next window stepped straight over it, permanently, with the panel reporting the page fully
 *  recorded. It fired on exactly the action that means somebody is trying harder (#80).
 *
 *  So a sweep is stamped with what it searched for, and `lastSweptFor` treats a stamp for a
 *  different search as no sweep at all — which `sweepWindow` reads as the widest window. A stamp
 *  on the row rather than a reset when the criteria are saved, because a reset is a second write
 *  that every device able to save criteria has to remember to make and can fail at on its own; the
 *  stamp is self-describing and is read by whatever is about to sweep.
 *
 *  It is the *parsed* criteria, not the pasted string: re-pasting the same search must not throw a
 *  fortnight of progress away over a reordered query string. Keys are sorted, and two groups are
 *  left out — which is what lets the stamp be taken from the search page actually recorded, radius
 *  and window and all, and still equal the saved criteria `sweepSearchUrl` built that page from.
 *
 *  The two groups are left out for different reasons, and the difference decides how. `SWEEP_OWNS`
 *  is written *after* the saved criteria in `sweepSearchUrl`, so those seven win outright: whatever
 *  a saved set says about the radius or the window, the search that runs uses ours, and a key that
 *  cannot change what was searched cannot belong in a record of what was searched. `RENTAL_SEARCH`
 *  is written *before*, so a saved value beats it — and dropping those three keys on membership
 *  alone stamped a saved `channel=BUY`, which genuinely opens a sales search, identically to the
 *  lettings search it replaced. The old date came back, the window narrowed, and everything older
 *  than it was stepped over: #80 exactly, surviving inside the fix for it. It needs no hand-edited
 *  row — a Rightmove URL carrying `To Rent` for `To rent` lands in the same place.
 *
 *  So the three are dropped only where their value *is* the constant. That is the form that matches
 *  the reason for dropping them: they carry no information when the app is the thing that wrote
 *  them, because the app always writes them, and every hunt using this is renting. A value that
 *  differs was not written by us and does change the search, so it is part of the search.
 *
 *  Narrowing resets too. A narrower search's progress would be sound to keep, but telling a
 *  narrowing from a widening across a dozen parameters this app does not model is a guess, and the
 *  cost of guessing wrong is the silent skip this exists to end. The cost of not guessing is one
 *  wide sweep. */
export function criteriaFingerprint(criteria: SweepCriteria | null | undefined): string {
  if (!criteria) return '';
  const entries = Object.entries(criteria)
    .filter(([key, value]) => !SWEEP_OWNS.has(key) && RENTAL_SEARCH[key] !== value && value !== '')
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return new URLSearchParams(entries).toString();
}

/** When this place was last swept completely *for what the hunt is searching for now* — the only
 *  `lastSweptAt` that may narrow a window. See `criteriaFingerprint` for why a sweep of a different
 *  search is no sweep, and `sweepWindow` for what null then does.
 *
 *  A row with no stamp is a sweep from before sweeps were stamped, of a search nobody can name any
 *  more. The reading that cannot drop listings is "never", at the price of one wide pass. */
export function lastSweptFor(
  sweep: { lastSweptAt: string | null; criteriaFingerprint: string | null } | null | undefined,
  criteria: SweepCriteria | null | undefined,
): string | null {
  if (!sweep || sweep.criteriaFingerprint === null) return null;
  return sweep.criteriaFingerprint === criteriaFingerprint(criteria) ? sweep.lastSweptAt : null;
}

export interface CriteriaSummary {
  /** Rent and bedrooms, in English. */
  supported: string[];
  /** Everything else the pasted search carried, printed as `key=value`. */
  other: string[];
}

/** The saved criteria in words, so the page can show what a sweep will actually search without
 *  making anyone read a query string.
 *
 *  Two lists rather than one, and the split is the point. This used to render a hand-written
 *  sentence for whichever eight parameters somebody had got round to — bathrooms, furnish types,
 *  let-agreed — which reads as a form this app knows how to fill in and is nothing of the kind: the
 *  next Rightmove filter along came out as `newHomes: true` beside "Furnishing: furnished", and no
 *  part of the screen said which of those the app understood. The basics a hunt actually sets are
 *  rent and bedrooms (the radius is per place, and never comes from the paste — see `SWEEP_OWNS`),
 *  so those get sentences and everything else is shown as itself, under its own heading.
 *
 *  Nothing is hidden either way. A filter we have no name for is still a filter narrowing the
 *  results, and the surest way to make a sweep look broken is to run it with a constraint nobody on
 *  screen can see. */
export function describeCriteria(criteria: SweepCriteria): CriteriaSummary {
  const supported: string[] = [];
  // The three that only say "this is a lettings search" (`RENTAL_SEARCH`) are not filters anybody
  // chose, so they are neither described nor listed as extras — but only where the value is ours.
  // A saved `channel=BUY` beats the constant in `sweepSearchUrl` and opens a sales search, and
  // hiding it here on the strength of its key alone is the constraint nobody on screen can see that
  // the note below refuses to allow. Same asymmetry as `criteriaFingerprint`, same fix.
  const said = new Set(Object.keys(RENTAL_SEARCH).filter((key) => criteria[key] === RENTAL_SEARCH[key]));

  const take = (...keys: string[]) => {
    for (const key of keys) said.add(key);
    return keys.map((key) => criteria[key]);
  };

  const [minPrice, maxPrice] = take('minPrice', 'maxPrice');
  if (minPrice !== undefined && maxPrice !== undefined) {
    supported.push(`Rent ${pounds(minPrice)}–${pounds(maxPrice)} pcm`);
  } else if (minPrice !== undefined) supported.push(`Rent from ${pounds(minPrice)} pcm`);
  else if (maxPrice !== undefined) supported.push(`Rent up to ${pounds(maxPrice)} pcm`);

  const [minBeds, maxBeds] = take('minBedrooms', 'maxBedrooms');
  if (minBeds !== undefined && minBeds === maxBeds) supported.push(bedrooms(minBeds));
  else if (minBeds !== undefined && maxBeds !== undefined) {
    // Only the far end carries the word: "1 to 3 bedrooms", not "1 bedroom to 3 bedrooms".
    supported.push(`${minBeds === '0' ? 'Studio' : minBeds} to ${bedrooms(maxBeds)}`);
  } else if (minBeds !== undefined) supported.push(`${bedrooms(minBeds)} or more`);
  else if (maxBeds !== undefined) supported.push(maxBeds === '0' ? 'Studio' : `Up to ${bedrooms(maxBeds)}`);

  const other = Object.entries(criteria)
    .filter(([key]) => !said.has(key))
    .map(([key, value]) => `${key}=${value}`);
  return { supported, other };
}

/** "1500" -> "£1,500". Grouped by hand rather than through `toLocaleString`, which returns a
 *  different string depending on where the browser thinks it is. */
function pounds(value: string): string {
  return `£${/^\d+$/.test(value) ? value.replace(/\B(?=(\d{3})+$)/g, ',') : value}`;
}

/** Rightmove counts a studio as nought bedrooms, which is the one value that cannot be printed as a
 *  number without saying something false. */
function bedrooms(value: string): string {
  if (value === '0') return 'Studio';
  return value === '1' ? '1 bedroom' : `${value} bedrooms`;
}

/** Where to go to choose those filters: Rightmove's own search page, already pointed at one of this
 *  hunt's places.
 *
 *  The paste-a-URL design (see `SweepCriteria`) is only as good as the first step, and the first
 *  step was "go and find the right search on Rightmove yourself" — which is where somebody sets the
 *  filters for the wrong area and pastes back a search that looks fine. Starting from the place we
 *  already resolved means the area is right before anybody touches a filter.
 *
 *  `locationIdentifier` is used only when we hold one. Rightmove's identifiers are not guessable and
 *  a made-up one returns a page full of plausible flats somewhere else, so a place that has not been
 *  resolved gets the plain text search — Rightmove asks which of the matching areas was meant, which
 *  is honest about what we know. */
export function rightmoveSearchStart(place: {
  label: string;
  locationIdentifier: string | null;
  displayLocationIdentifier: string | null;
}): string {
  const parameters = new URLSearchParams({
    searchLocation: place.displayLocationIdentifier
      ? searchLocationFor(place.displayLocationIdentifier)
      : place.label,
  });
  if (place.locationIdentifier) {
    parameters.set('useLocationIdentifier', 'true');
    parameters.set('locationIdentifier', place.locationIdentifier);
  }
  return `https://www.rightmove.co.uk/property-to-rent/search.html?${parameters.toString()}`;
}

/** What a scanned listing still needs before the fill-in run should stop offering it.
 *
 *  The worklist's rule, in one place, because it is a rule about *what re-opening a tab can
 *  produce* and it is wrong in a way nothing looks wrong: a listing that can never satisfy it is
 *  re-opened on every run, for ever, and the count of work left never reaches zero.
 *
 *  `getSweepKnowledge` already states the principle, about the geocode it deliberately does not
 *  gate on — "gating on it would leave every opened-but-not-yet-geocoded flat permanently in the
 *  opener's worklist, which re-opening can never clear". The photo analysis is the same case
 *  whenever there are no photos. `analysis.ts` throws `no images to analyse` on an empty list, the
 *  Edge Function writes `status = 'failed'`, and `claim_analysis` re-claims a failed row on the
 *  next attempt — which is right, because most failures are a timeout or a bad gateway and the
 *  retry is how they come good. A listing with no pictures is the one failure that is not a retry
 *  away from anything: opened, analysed, failed, and re-opened tomorrow to fail identically.
 *
 *  So the analysis is required only of a listing that has an image to analyse. Two real ones had
 *  been going round that loop, one of them since the twelfth of August.
 *
 *  Not the same thing as forgiving a failure. A listing *with* photos whose analysis failed is
 *  still missing something a re-open can supply, and is still offered. */
export function missingFor(known: {
  postcode: string | null;
  /** How many photographs the listing carries. Zero is a fact, not an absence: `image_urls` is
   *  `not null default '[]'`, so an empty list means the page had none rather than that nobody
   *  has looked. */
  imageCount: number;
  /** Whether any analysis of it finished. */
  analysed: boolean;
}): string[] {
  const missing: string[] = [];
  if (!known.postcode) missing.push('no postcode read from the listing');
  if (known.imageCount > 0 && !known.analysed) missing.push('photos not analysed yet');
  return missing;
}

/** A listing's page, from its id. The one URL both apps build, so it is built in one place. */
export function listingUrl(rightmoveId: string): string {
  return `https://www.rightmove.co.uk/properties/${rightmoveId}`;
}

/** Rightmove's own page size. Only used to turn a page number into the `index` it wants. */
export const RESULTS_PER_PAGE = 24;

/** Sort order 6 is "newest listed first", which is the only ordering that makes a sweep
 *  bounded: the ones we have not seen cluster at the top, and paging stops mattering once you
 *  reach rows you already have. */
const SORT_NEWEST_FIRST = '6';

export interface SweepSearch {
  hub: SweepHub;
  days: SweepWindow;
  /** 1-based, the way the site's own pager counts. */
  page?: number;
  /** What this hunt is looking for, from `project_setting`. Required, and there is deliberately no
   *  default — see `RENTAL_SEARCH`. A hunt that has not chosen gets no link rather than somebody
   *  else's price band. */
  criteria: SweepCriteria | null | undefined;
}

/** The Rightmove search URL for one hub, one time window, one page.
 *
 *  This builds a link a human clicks. Nothing fetches it — see the standing rule in AGENTS.md
 *  about reading pages you opened and never calling their search endpoint. The distinction is
 *  the whole design: a URL in an anchor is a bookmark, and the same URL in a `fetch` is a crawler.
 *
 *  Returns null for a hub whose identifier we could not verify, because a search URL with a
 *  wrong `locationIdentifier` still returns a page full of plausible flats somewhere else. */
export function sweepSearchUrl({ hub, days, page = 1, criteria }: SweepSearch): string | null {
  if (!hub.rightmove || hub.radiusMiles === null) return null;
  // Nothing chosen, no link. The alternative is a search with no price and no bedroom filter at all,
  // which returns every rental within a mile and reads as a broken sweep rather than as an unset
  // one — and the alternative to *that* is inventing a budget, which is what this stopped doing.
  if (!criteria || Object.keys(criteria).length === 0) return null;
  const { locationIdentifier, displayLocationIdentifier } = hub.rightmove;

  // The hunt's criteria first, then the seven parameters a sweep decides for itself — written
  // second so they win outright. A saved set that somehow carried a `locationIdentifier` (a future
  // Rightmove rename that slips past `SWEEP_OWNS`, a hand-edited row) would otherwise sweep every
  // neighbourhood at whichever one was on screen when the URL was copied, and the results would
  // look plausible for every hub.
  const parameters = new URLSearchParams({
    ...RENTAL_SEARCH,
    ...criteria,
    searchLocation: searchLocationFor(displayLocationIdentifier),
    useLocationIdentifier: 'true',
    locationIdentifier,
    // The place's own radius, written with the sweep-owned parameters rather than left to the
    // saved criteria. A pasted search URL carries the radius that was on screen when it was
    // copied, and one radius for every place is exactly what having a radius per place is for —
    // half a mile around the office is not half a mile around the whole search area.
    // The number as configured. `toFixed(1)` turned a quarter mile into 0.3, which is not one of
    // the radii Rightmove accepts — so a place set to the smallest option searched a wider area
    // than anybody chose, and the URL looked right.
    radius: String(hub.radiusMiles),
    maxDaysSinceAdded: String(days),
    index: String(Math.max(0, page - 1) * RESULTS_PER_PAGE),
    sortType: SORT_NEWEST_FIRST,
    displayLocationIdentifier,
  });

  return `https://www.rightmove.co.uk/property-to-rent/find.html?${parameters.toString()}`;
}

/** `Hampstead-Station.html` -> `Hampstead Station`. This is the label Rightmove puts back in its
 *  own search box, and it is cosmetic — `locationIdentifier` is what actually selects the area,
 *  which is why `useLocationIdentifier=true` is in the query. */
export function searchLocationFor(displayLocationIdentifier: string): string {
  return displayLocationIdentifier.replace(/\.html$/, '').replace(/-/g, ' ');
}

/** How a sweep window reads in the panel: "everything added in the last 3 days". */
export function windowLabel(choice: SweepWindowChoice): string {
  const window = choice.days === 1 ? 'the last day' : `the last ${choice.days} days`;
  if (choice.elapsedDays === null) return `${window} — this hub has never been swept`;
  if (!choice.covered) {
    return `${window}, which is as far back as Rightmove filters — the last sweep was ${describeElapsed(choice.elapsedDays)} ago, so anything older than 14 days will be missed`;
  }
  return `${window}, covering the ${describeElapsed(choice.elapsedDays)} since the last sweep`;
}

function describeElapsed(days: number): string {
  if (days < 1 / 24) return 'few minutes';
  if (days < 1) {
    const hours = Math.round(days * HOURS_PER_DAY);
    return hours === 1 ? '1 hour' : `${hours} hours`;
  }
  const whole = Math.round(days);
  return whole === 1 ? '1 day' : `${whole} days`;
}


/** Which pages of a hub's sweep are recorded after this one, and whether that finishes it.
 *
 *  Pulled out of the database call because it is the rule that decides whether the *next* search
 *  narrows its window, and narrowing it too early is the one failure in the sweep that looks
 *  exactly like success — the pages nobody opened simply never appear again. It replaced a "Mark
 *  swept" button that asked a human to assert what the page number already said.
 *
 *  Page 1 restarts the count, because that is where a sweep begins in practice: you open the link
 *  from the shortlist and page forward. A changed page total restarts it too — the search returned
 *  a different shape (a narrower window, or simply more flats), and pages recorded against the old
 *  one do not describe the new one. */
export function sweepProgress(
  before: { pagesTotal: number | null; pagesSeen: number[] } | null,
  page: number,
  totalPages: number,
): { pagesSeen: number[]; complete: boolean } {
  const carryOn = page !== 1 && before !== null && before.pagesTotal === totalPages;
  const seen = new Set<number>(carryOn ? before.pagesSeen : []);
  seen.add(page);
  const complete = Array.from({ length: totalPages }, (_, i) => i + 1).every((n) => seen.has(n));
  return { pagesSeen: [...seen].sort((a, b) => a - b), complete };
}


/** The same search, one page on, as a URL that will actually reload.
 *
 *  This exists because Rightmove's own pager is a client-side route change: it swaps every card in
 *  the DOM and leaves `__NEXT_DATA__` describing the page you were on a moment ago. The panel spots
 *  that (`staleAgainst`) and refuses to record, which is correct and was also, in practice, what
 *  happened every single time anyone paged — so the honest warning became the normal experience.
 *
 *  A full navigation fixes it at the source: the server renders the next page and its blob, and
 *  there is nothing stale to detect. So the panel offers its own "next page" and asks you to use
 *  that rather than Rightmove's.
 *
 *  Built from the URL you are actually on rather than from `sweepSearchUrl`, because you may have
 *  narrowed the search by hand — a different price, an added must-have — and rebuilding it from the
 *  hub would silently throw that away and page you into a different set of results.
 *
 *  Returns null when there is no page to go to, which the panel renders as "this is the last one"
 *  rather than as a dead button. */
export function nextPageUrl(currentHref: string, page: number, totalPages: number): string | null {
  if (page >= totalPages) return null;
  let url: URL;
  try {
    url = new URL(currentHref);
  } catch {
    return null;
  }
  // Rightmove pages by result offset, not by page number — `index` is what its own pager sets.
  url.searchParams.set('index', String(page * RESULTS_PER_PAGE));
  return url.toString();
}
