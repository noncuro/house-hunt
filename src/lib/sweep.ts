/** Building the search a sweep runs, and deciding how far back it has to look.
 *
 *  A sweep is the deliberate half of this extension: rather than waiting to stumble on listings,
 *  you open one Rightmove search per neighbourhood and work down it. Everything here is pure, and
 *  it is pure on purpose — `check:sweep` covers it, because the one number that matters is the
 *  one nobody can see being wrong. If the "how many days back" window comes out a day short, the
 *  sweep silently omits the listings added in that day and the panel cheerfully reports that
 *  everything on the page is already recorded. That failure looks exactly like success.
 */
import type { SweepHub } from './hubs';

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
 *  `lastSweptAt` comes from `hub_sweep` and from nowhere else. It briefly sat on `project_hub` as
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

/** The search criteria the sweep runs with — the flat we are actually looking for.
 *
 *  These live here rather than in the URL you pasted because a sweep that searched a different
 *  price band per hub would be worse than useless, and because changing what we are looking for
 *  should be one edit in one place. They match the search we have been running by hand. */
export const SWEEP_CRITERIA = {
  minBedrooms: 1,
  maxBedrooms: 3,
  minPrice: 4000,
  maxPrice: 6000,
  /** Miles. Wide enough to overlap between neighbouring hubs, which is intended — a listing
   *  between Belsize Park and Primrose Hill should turn up in both sweeps rather than neither. */
  radius: '1.0',
} as const;

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
}

/** The Rightmove search URL for one hub, one time window, one page.
 *
 *  This builds a link a human clicks. Nothing fetches it — see the standing rule in AGENTS.md
 *  about reading pages you opened and never calling their search endpoint. The distinction is
 *  the whole design: a URL in an anchor is a bookmark, and the same URL in a `fetch` is a crawler.
 *
 *  Returns null for a hub whose identifier we could not verify, because a search URL with a
 *  wrong `locationIdentifier` still returns a page full of plausible flats somewhere else. */
export function sweepSearchUrl({ hub, days, page = 1 }: SweepSearch): string | null {
  if (!hub.rightmove) return null;
  const { locationIdentifier, displayLocationIdentifier } = hub.rightmove;

  const parameters = new URLSearchParams({
    searchLocation: searchLocationFor(displayLocationIdentifier),
    useLocationIdentifier: 'true',
    locationIdentifier,
    rent: 'To rent',
    minBedrooms: String(SWEEP_CRITERIA.minBedrooms),
    maxBedrooms: String(SWEEP_CRITERIA.maxBedrooms),
    radius: SWEEP_CRITERIA.radius,
    minPrice: String(SWEEP_CRITERIA.minPrice),
    maxPrice: String(SWEEP_CRITERIA.maxPrice),
    _includeLetAgreed: 'on',
    maxDaysSinceAdded: String(days),
    index: String(Math.max(0, page - 1) * RESULTS_PER_PAGE),
    sortType: SORT_NEWEST_FIRST,
    channel: 'RENT',
    transactionType: 'LETTING',
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
