/** Reading the travel cache: what a set of journey rows adds up to.
 *
 *  Here rather than beside the components that draw it, because it is a fact and not a rendering —
 *  the same reading orders triage's pile, fills the compare table's column and captions a card, and
 *  a second copy of it is two screens disagreeing about how far away somewhere is. It has no JSX and
 *  no React, which is also what lets `check:sort` run it.
 *
 *  It is not what a *filter* should read. `reach` in `filter.ts` deliberately goes to the raw rows,
 *  and the comment there says why: a ninety-minute walk is discarded here as not a real way of
 *  getting anywhere, which is right for a headline number and wrong for a bar that says "walk to the
 *  park in twenty" — that walk is a known failure rather than a thing we could not measure. */
import { WALKING_LIMIT_SECONDS, type TravelMode, type TravelTime } from './types';

/** Which modes are worth showing for one place, and what to say when none are.
 *
 *  Every view was deciding this for itself and reaching different answers. The panel and the card
 *  hid walks over an hour as unrealistic; the compare table did not, so a 61-minute walk showed
 *  there as the best route to somewhere the other views said was a 30-minute train. The table
 *  also called a cached "TfL says there is no journey" the same thing as "nobody has looked yet",
 *  which are opposite facts — one is settled and one is a gap you can fill by clicking. */
export interface TravelVerdict {
  /** The modes worth showing, fastest-first order left to the caller. */
  usable: TravelTime[];
  /** The fastest usable mode, or null. */
  best: TravelTime | null;
  /** A mode we asked about and never got an answer for — worth a retry. */
  transient: TravelTime | null;
  /** Asked and settled, for the place as a whole — no mode gets you there — in the words of
   *  whoever settled it, and null when nothing settled it. Settled, not missing.
   *
   *  The words rather than a flag with a sentence beside it. This is only ever taken from a row
   *  that carries an error, so "settled, but we cannot say why" is a state that cannot arise, and a
   *  fallback sentence for it would be a default that reads as care and never runs — while quietly
   *  being the only place a reader could look to find out what the sentence is. */
  noRoute: string | null;
  /** Each mode's own row, for a view asking about one column rather than about the place.
   *
   *  Everything above answers "how do I get there", which is the question the panel and the cards
   *  ask, and which one usable mode answers for the whole place. The compare table has a column per
   *  mode and asks a narrower one, and reading the place-level answer there loses exactly the fact
   *  it is asking for: a place with a good train time and a cycling leg TfL settled as impossible
   *  has `noRoute: false`, so the cycling column read "not worked out yet" over a question that had
   *  been answered — a settled negative redrawn as a gap, which is the distinction this whole file
   *  exists to keep. */
  byMode: Partial<Record<TravelMode, TravelTime>>;
  /** Nothing has been computed for this pairing at all. */
  unknown: boolean;
}

export function readTravel(rows: TravelTime[] | undefined): TravelVerdict {
  const all = rows ?? [];
  const usable = all.filter(
    (t) =>
      !t.error &&
      t.seconds > 0 &&
      // Walking anywhere over an hour away isn't a real option; showing it crowds out the numbers
      // that matter, and as a "best route" it is actively misleading.
      !(t.mode === 'walking' && t.seconds > WALKING_LIMIT_SECONDS),
  );
  const best = usable.length === 0 ? null : usable.reduce((a, b) => (b.seconds < a.seconds ? b : a));
  const transient = all.find((t) => t.error && t.transient) ?? null;
  const settled = usable.length === 0 ? (all.find((t) => t.error && !t.transient) ?? null) : null;
  const byMode: Partial<Record<TravelMode, TravelTime>> = {};
  for (const t of all) byMode[t.mode] = t;
  return {
    usable,
    best,
    transient,
    noRoute: settled?.error ?? null,
    byMode,
    unknown: all.length === 0,
  };
}

/** One flat's journey to one place, read out of the cached index the screens hold.
 *
 *  The two lines it replaces were written out in the compare table, and triage's sort needed the
 *  same two — a lookup by postcode and a filter by place, in that order, both easy to get subtly
 *  wrong and impossible to notice when they are. Takes the postcode rather than the entry so the
 *  shared components keep knowing nothing about the shortlist row. */
export function readPlaceTravel(
  postcode: string | null,
  placeId: string,
  travel: Record<string, TravelTime[]> | undefined,
): TravelVerdict {
  const rows = (postcode && travel?.[postcode]) || [];
  return readTravel(rows.filter((t) => t.placeId === placeId));
}
