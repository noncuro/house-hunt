/** Triage's filters, and the one rule in them that is invisible when it is wrong.
 *
 *  A filter that drops too much looks exactly like a shortlist with fewer flats in it. Nothing on
 *  screen distinguishes "no flat over 700 sq ft" from "the seventy flats whose size nobody has
 *  measured were thrown away", and the second is what a naive `size >= min` does, because most of
 *  what these filters ask about is read off photographs and is frequently unknown.
 *
 *  So every case below is about the three answers — yes, no, and we could not tell — and the last
 *  one is the point: an unknown clears every bar, and is counted, so the screen can say how much of
 *  what is left is there on a shrug.
 */
import {
  NO_FILTER,
  applyFilter,
  barModesFor,
  CROW,
  defaultMax,
  startingBar,
  filterIsOn,
  destinationsFor,
  huntFloor,
  matchesFilter,
  unknownBars,
  NEAREST_STATION,
  NEAREST_STATION_PLACE,
  parseFilter,
  splitByHuntFloor,
  withKnownPlaces,
  type TravelIndex,
  type TriageFilter,
} from '../packages/core/src/filter';
import type { Analysis, TravelTime } from '../packages/core/src/types';
import { toAnalysis, type ShortlistEntry } from '../packages/core/src/db/supabase';

let failures = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) return console.log(`  ok   ${name}`);
  failures++;
  console.log(`  FAIL ${name}\n       expected ${e}\n       got      ${a}`);
}

/** A flat, with only the fields a filter reads meant seriously. */
function flat(fields: Partial<ShortlistEntry>): ShortlistEntry {
  return {
    rightmoveId: '1', url: '', displayAddress: '', postcode: null, price: null,
    bedrooms: null, bathrooms: null, floorAreaSqft: null, floorAreaSource: null,
    floorplanUrl: null, imageUrls: [], furnishType: null, listingUpdate: null,
    nearestStations: [], lastSeenAt: '', lat: null, lon: null, exactLocation: false,
    verdicts: [], stage: null, analysis: null,
    ...fields,
  };
}

/** An analysis with everything unknown, so each case can set exactly the one field it is about. */
function analysis(fields: Partial<Analysis>): Analysis {
  return {
    model: 'test', analysedAt: '', imageCount: 0,
    hasFloorplan: false, floorplanLegible: null, floorplanSqft: null, floorplanSqftSource: null,
    floorplanConfidence: null, bedrooms: null, bathrooms: null,
    biggestRoomLabel: null, biggestRoomSqft: null, biggestRoomConfidence: null,
    hasBathtub: null, bathtubConfidence: null,
    hasOutdoorSpace: null, outdoorKind: null, outdoorSqft: null, outdoorIsEstimate: null,
    outdoorConfidence: null, isHouseShare: null, houseShareConfidence: null,
    laundry: null, laundryConfidence: null, hasDishwasher: null, dishwasherConfidence: null,
    sleepingSeparation: null, sleepingSeparationConfidence: null, utilitiesIncluded: null, utilitiesConfidence: null,
    naturalLight: null, naturalLightConfidence: null, summary: null,
    ...fields,
  };
}

const only = (filter: Partial<TriageFilter>): TriageFilter => ({ ...NO_FILTER, ...filter });

// ------------------------------------------------------------------------------------------- //
console.log('\nnothing set keeps everything');

check('an empty filter is off', filterIsOn(NO_FILTER), false);
check('...and one bar turns it on', filterIsOn(only({ minSqft: 700 })), true);
check('an empty filter keeps a flat we know nothing about', matchesFilter(flat({}), NO_FILTER), true);

// ------------------------------------------------------------------------------------------- //
console.log('\nrent, beds and size: known misses go, unknowns stay');

const dear = flat({ price: '£4,000 pcm' });
const cheap = flat({ price: '£2,000 pcm' });
check('a flat over the rent goes', matchesFilter(dear, only({ maxPrice: 3000 })), false);
check('a flat under it stays', matchesFilter(cheap, only({ maxPrice: 3000 })), true);
// Exactly on the bar is inside it: "max £3,000" is what somebody typed after seeing a £3,000 flat.
check('exactly on the bar stays', matchesFilter(flat({ price: '£3,000 pcm' }), only({ maxPrice: 3000 })), true);
check('a flat with no readable price stays', matchesFilter(flat({ price: null }), only({ maxPrice: 3000 })), true);
check('and neither does a price we cannot parse drop it', matchesFilter(flat({ price: 'POA' }), only({ maxPrice: 3000 })), true);

check('one bed fails a two-bed minimum', matchesFilter(flat({ bedrooms: 1 }), only({ minBedrooms: 2 })), false);
check('an unknown bedroom count stays', matchesFilter(flat({ bedrooms: null }), only({ minBedrooms: 2 })), true);

// Size comes through `resolveSize`, so the source matters as much as the number: this is the same
// figure the card and the compare table print, and a filter reading a different one would drop
// flats whose size on screen plainly clears the bar.
const small = flat({ floorAreaSqft: 500, floorAreaSource: 'sizings' });
const big = flat({ floorAreaSqft: 900, floorAreaSource: 'sizings' });
check('under the size bar goes', matchesFilter(small, only({ minSqft: 700 })), false);
check('over it stays', matchesFilter(big, only({ minSqft: 700 })), true);
check('no size at all stays', matchesFilter(flat({}), only({ minSqft: 700 })), true);
// An unreadable floorplan is not a measurement — `resolveSize` drops it, and so this filter must
// treat the flat as unmeasured rather than as tiny.
check(
  'a floorplan the model could not read is not a small flat',
  matchesFilter(flat({ analysis: analysis({ floorplanSqft: 300, floorplanLegible: false }) }), only({ minSqft: 700 })),
  true,
);

check(
  'a main room under the bar goes',
  matchesFilter(flat({ analysis: analysis({ biggestRoomSqft: 200 }) }), only({ minGreatRoomSqft: 250 })),
  false,
);
check(
  'an unmeasured main room stays',
  matchesFilter(flat({ analysis: analysis({}) }), only({ minGreatRoomSqft: 250 })),
  true,
);

// ------------------------------------------------------------------------------------------- //
console.log('\namenities: only a known absence drops a flat');

const wantOutdoor = only({ amenities: ['outdoor'] });
check('has one, stays', matchesFilter(flat({ analysis: analysis({ hasOutdoorSpace: true }) }), wantOutdoor), true);
check('known not to, goes', matchesFilter(flat({ analysis: analysis({ hasOutdoorSpace: false }) }), wantOutdoor), false);
check('nobody could tell, stays', matchesFilter(flat({ analysis: analysis({}) }), wantOutdoor), true);
// The case that would empty the pile: a flat whose photos have not been analysed at all fails every
// amenity at once under a `=== true` test, and those are the newest listings in the hunt.
check('never analysed, stays', matchesFilter(flat({ analysis: null }), wantOutdoor), true);

// ------------------------------------------------------------------------------------------- //
console.log('\nfloorplan: the one bar where a missing value is an answer');

const wantPlan = only({ hasFloorplan: true });
check(
  'a listing with a floorplan stays',
  matchesFilter(flat({ floorplanUrl: 'https://media.rightmove.co.uk/plan.png' }), wantPlan),
  true,
);
// The whole point of the control, and the one place this file's governing rule is deliberately
// inverted. Everywhere else a missing value clears the bar, because everywhere else it means the
// model has not looked. `floorplanUrl` is read off the listing when the flat is first seen, so null
// means the agent published none — and a filter that kept those would remove nothing at all.
check('one without goes', matchesFilter(flat({ floorplanUrl: null }), wantPlan), false);
// It asks about the listing, not about the analysis: a flat nobody has run the vision pass over
// still has a floorplan if the agent published one.
check(
  'and it does not wait for the photos to be read',
  matchesFilter(flat({ floorplanUrl: 'https://media.rightmove.co.uk/plan.png', analysis: null }), wantPlan),
  true,
);
check('off means don\'t mind, not "must not have"', matchesFilter(flat({ floorplanUrl: null }), NO_FILTER), true);
check('and it counts as a filter being on', filterIsOn(wantPlan), true);

// Laundry and light are the two whose "has it" is narrower than "is not null" — in-building laundry
// is not in-unit laundry, and medium light is the model hedging rather than saying yes.
check(
  'laundry in the building is not laundry in the flat',
  matchesFilter(flat({ analysis: analysis({ laundry: 'in-building' }) }), only({ amenities: ['inUnitLaundry'] })),
  false,
);
check(
  'but it does clear "a machine somewhere in the building"',
  matchesFilter(flat({ analysis: analysis({ laundry: 'in-building' }) }), only({ amenities: ['anyLaundry'] })),
  true,
);
check(
  'and nowhere to wash clothes clears neither',
  matchesFilter(flat({ analysis: analysis({ laundry: 'none' }) }), only({ amenities: ['anyLaundry'] })),
  false,
);
check(
  'medium light does not clear a bright-light filter',
  matchesFilter(flat({ analysis: analysis({ naturalLight: 'medium' }) }), only({ amenities: ['brightLight'] })),
  false,
);

// The two facts most likely to kill a listing, and until now the two you could not clear out of the
// pile after a sweep: they were left out of the amenity list on the grounds that they were already
// red for everybody, and triage builds its filter from that same list.
check(
  'a known house share can be dropped from the pile',
  matchesFilter(flat({ analysis: analysis({ isHouseShare: true }) }), only({ amenities: ['wholeProperty'] })),
  false,
);
check(
  'so can one open room where the kitchen and the bed share a view',
  matchesFilter(
    flat({ analysis: analysis({ sleepingSeparation: 'same-space' }) }),
    only({ amenities: ['separateSleeping'] }),
  ),
  false,
);
// The distinction the field exists for. Both of these are studios.
check(
  'a mezzanine studio stays — one room on the plan, two in use',
  matchesFilter(
    flat({ analysis: analysis({ sleepingSeparation: 'practically-separate' }) }),
    only({ amenities: ['separateSleeping'] }),
  ),
  true,
);
check(
  'and a studio nobody has assessed stays, like every other unknown',
  matchesFilter(flat({ analysis: analysis({}) }), only({ amenities: ['separateSleeping'] })),
  true,
);
// `sleeping_separation` is plain text in the database, so a string nobody recognises can come back
// out of it — an older writer, a hand-edited row, a value some later version adds. Taken at face
// value it is a finding rather than a gap, because everything below reads anything but 'same-space'
// as a bedroom of its own: the flat would clear the bar as *known* to qualify and go uncounted,
// which is the one thing the tally exists to prevent.
//
// The row goes through `toAnalysis`, the function every property_analysis row actually travels
// through on its way out of Postgres. Writing `sleepingSeparation` into the fixture by hand would
// assert the parser and leave the hydration free to cast, which is where the bug was.
const hydrated = toAnalysis({ sleeping_separation: 'mezzanine-ish', sleeping_separation_confidence: 'high' });
check('a stored separation nobody recognises hydrates to unknown', hydrated.sleepingSeparation, null);
const unreadable = applyFilter(
  [flat({ rightmoveId: 'unreadable', analysis: hydrated })],
  only({ amenities: ['separateSleeping'] }),
);
check('so its flat stays', unreadable.kept.map((e) => e.rightmoveId), ['unreadable']);
check('and is counted among the unknowns rather than the separated', unreadable.unknowns, 1);
// The three real values still survive the same trip — a parser that dropped everything would pass
// the case above and quietly turn every assessed studio into an unknown.
check(
  'and the values we do recognise come through it unchanged',
  ['separate-room', 'practically-separate', 'same-space'].map(
    (v) => toAnalysis({ sleeping_separation: v }).sleepingSeparation,
  ),
  ['separate-room', 'practically-separate', 'same-space'],
);

// Every bar has to be cleared, not any of them.
check(
  'two bars are both applied',
  matchesFilter(flat({ price: '£2,000 pcm', analysis: analysis({ hasOutdoorSpace: false }) }), only({ maxPrice: 3000, amenities: ['outdoor'] })),
  false,
);

// ------------------------------------------------------------------------------------------- //
console.log('\nand the count that keeps it honest');

const pile = [
  flat({ rightmoveId: 'a', floorAreaSqft: 900, floorAreaSource: 'sizings' }),
  flat({ rightmoveId: 'b', floorAreaSqft: 400, floorAreaSource: 'sizings' }),
  flat({ rightmoveId: 'c' }),
  flat({ rightmoveId: 'd' }),
];
const filtered = applyFilter(pile, only({ minSqft: 700 }));
check('the one under the bar is dropped', filtered.kept.map((e) => e.rightmoveId), ['a', 'c', 'd']);
check('and two of the three left are unmeasured', filtered.unknowns, 2);
check('with no filter on, nothing is counted as unknown', applyFilter(pile, NO_FILTER).unknowns, 0);

// ------------------------------------------------------------------------------------------- //
console.log('\ntravel: a bar per place and mode, and three answers again');

/** A travel cache keyed the way `cachedTravelTimes` returns it: by the flat's own postcode. */
function reachIndex(postcode: string, rows: Array<Partial<TravelTime>>): TravelIndex {
  return {
    [postcode]: rows.map((r) => ({ placeId: 'work', mode: 'transit', seconds: 0, changes: null, ...r }) as TravelTime),
  };
}

const near = flat({ rightmoveId: 'near', postcode: 'N1 1AA' });
const far = flat({ rightmoveId: 'far', postcode: 'E1 1AA' });
const toWork = only({ travel: [{ placeId: 'work', mode: 'transit', max: 20 }] });

check('a filter with only a travel bar is on', filterIsOn(toWork), true);
check(
  'inside the bar stays',
  matchesFilter(near, toWork, reachIndex('N1 1AA', [{ seconds: 15 * 60 }])),
  true,
);
check(
  'outside it goes',
  matchesFilter(far, toWork, reachIndex('E1 1AA', [{ seconds: 40 * 60 }])),
  false,
);
// The number on the card is the rounded one, so the bar has to be read against that: 20m 20s prints
// as "20m", and dropping it from a twenty-minute filter reads as the filter being broken.
check(
  'a journey that prints as 20m clears a bar of 20',
  matchesFilter(near, toWork, reachIndex('N1 1AA', [{ seconds: 20 * 60 + 20 }])),
  true,
);
check(
  'nothing cached for that pairing stays',
  matchesFilter(near, toWork, reachIndex('N1 1AA', [])),
  true,
);
check('no cache at all stays', matchesFilter(near, toWork, undefined), true);
// A flat with no postcode has no origin to route from — unknown, not unreachable.
check('a flat with no postcode stays', matchesFilter(flat({ postcode: null }), toWork, {}), true);

// The bar is about one place and one mode, and a number for a different pairing answers neither.
check(
  'a time to another place does not clear this bar',
  matchesFilter(near, toWork, reachIndex('N1 1AA', [{ placeId: 'gym', seconds: 5 * 60 }])),
  true,
);
check(
  'and neither does the same trip by another mode',
  matchesFilter(near, toWork, reachIndex('N1 1AA', [{ mode: 'walking', seconds: 90 * 60 }])),
  true,
);

// "TfL says there is no such journey" is an answer, and it is a failing one — unlike a rate limit,
// which is us not having asked yet.
check(
  'no route by this mode goes',
  matchesFilter(near, toWork, reachIndex('N1 1AA', [{ seconds: 0, error: 'no journey', transient: false }])),
  false,
);
check(
  'a transient failure stays',
  matchesFilter(near, toWork, reachIndex('N1 1AA', [{ seconds: 0, error: 'rate limited', transient: true }])),
  true,
);
// The case `readTravel` would get wrong, and why this does not go through it: an hour-and-a-half
// walk is discarded there as "not a real option", which for a twenty-minute walking bar is a known
// failure rather than a missing measurement.
check(
  'a 90-minute walk fails a 20-minute walking bar',
  matchesFilter(near, only({ travel: [{ placeId: 'work', mode: 'walking', max: 20 }] }),
    reachIndex('N1 1AA', [{ mode: 'walking', seconds: 90 * 60 }])),
  false,
);

// Two journeys are both requirements, the same as every other pair of bars here.
check(
  'both travel bars have to be cleared',
  matchesFilter(
    near,
    only({ travel: [
      { placeId: 'work', mode: 'transit', max: 20 },
      { placeId: 'gym', mode: 'walking', max: 10 },
    ] }),
    reachIndex('N1 1AA', [
      { seconds: 15 * 60 },
      { placeId: 'gym', mode: 'walking', seconds: 25 * 60 },
    ]),
  ),
  false,
);

const travelPile = applyFilter([near, far], toWork, {
  'N1 1AA': [{ placeId: 'work', mode: 'transit', seconds: 15 * 60, changes: null }],
});
check('the measured one inside the bar is kept', travelPile.kept.map((e) => e.rightmoveId), ['near', 'far']);
check('and the unmeasured one is counted as unknown', travelPile.unknowns, 1);

// ------------------------------------------------------------------------------------------- //
console.log('\ncoming back out of storage');

check('nothing stored is no filter', parseFilter(null), NO_FILTER);
check('a string is not a filter', parseFilter('700'), NO_FILTER);
// The case this exists for: a filter saved before travel bars existed still has to work.
check(
  'a filter from before a field existed keeps the rest',
  parseFilter({ maxPrice: 3000, minBedrooms: 2 }),
  only({ maxPrice: 3000, minBedrooms: 2 }),
);
check('an amenity we no longer have is dropped', parseFilter({ amenities: ['outdoor', 'helipad'] }), only({ amenities: ['outdoor'] }));
check('the floorplan toggle survives a round trip', parseFilter({ hasFloorplan: true }), only({ hasFloorplan: true }));
// A filter stored before this field existed, and one holding something that is not a boolean, both
// read as off — the direction that shows more flats rather than fewer.
check('anything but a stored true is off', parseFilter({ hasFloorplan: 'yes' }), NO_FILTER);
check('a bar of nought is not a bar', parseFilter({ minSqft: 0 }), NO_FILTER);
check('nor is one that is not a number', parseFilter({ minSqft: '700' }), NO_FILTER);
check(
  'a travel bar survives the round trip',
  parseFilter(JSON.parse(JSON.stringify(toWork))),
  toWork,
);
check('a travel bar with no place is dropped', parseFilter({ travel: [{ mode: 'transit', max: 20 }] }), NO_FILTER);
check('so is one with a mode we do not have', parseFilter({ travel: [{ placeId: 'work', mode: 'teleport', max: 20 }] }), NO_FILTER);

// --------------------------------------------------------------------------------------------- //
console.log('\ndistance: the bar TfL cannot answer');

// The neighbourhoods folded in from the old hub list have a coordinate and no postcode, so there is
// no journey to look up and there is a straight line to measure. Angel is the place; the two flats
// are a quarter-mile and two miles off it.
const ANGEL = { lat: 51.5322, lon: -0.1058 };
const points = { angel: ANGEL };
const onTop = flat({ rightmoveId: 'ontop', lat: 51.5322, lon: -0.1058 });
const nearby = flat({ rightmoveId: 'nearby', lat: 51.5358, lon: -0.1058 }); // ~0.25 mi due north
const away = flat({ rightmoveId: 'away', lat: 51.5612, lon: -0.1058 });     // ~2 mi due north
const withinMile = only({ travel: [{ placeId: 'angel', mode: CROW, max: 1 }] });

check('a filter with only a distance bar is on', filterIsOn(withinMile), true);
check('the same spot is within any bar', matchesFilter(onTop, withinMile, undefined, points), true);
check('a quarter mile off stays', matchesFilter(nearby, withinMile, undefined, points), true);
check('two miles off goes', matchesFilter(away, withinMile, undefined, points), false);

// The rule the whole file is about, applied to the one measure that does not need the cache: no
// coordinate at either end is not "far away", it is not knowing.
check(
  'a flat with no coordinates stays',
  matchesFilter(flat({ lat: null, lon: null }), withinMile, undefined, points),
  true,
);
check('a place with no coordinates keeps everything', matchesFilter(away, withinMile, undefined, {}), true);
check('and so does being handed no places at all', matchesFilter(away, withinMile, undefined, undefined), true);

// A distance bar needs no postcode and no cache — which is the point of it. A flat that could never
// have a journey time still has an answer here.
check(
  'a flat with no postcode is still measured',
  matchesFilter(flat({ postcode: null, lat: 51.5322, lon: -0.1058 }), withinMile, undefined, points),
  true,
);

const milePile = applyFilter([onTop, nearby, away, flat({ rightmoveId: 'nowhere' })], withinMile, undefined, points);
check('the pile keeps the two near ones and the unplaceable one', milePile.kept.length, 3);
check('and counts the unplaceable one as unknown', milePile.unknowns, 1);

check(
  'a distance bar survives the round trip',
  parseFilter(JSON.parse(JSON.stringify(withinMile))),
  withinMile,
);
// The field was `maxMinutes` before a bar could be measured in miles. A filter left in somebody's
// localStorage has to keep narrowing rather than quietly widening to "any distance".
check(
  'a bar stored under the old field name is read',
  parseFilter({ travel: [{ placeId: 'work', mode: 'transit', maxMinutes: 20 }] }),
  toWork,
);

// A place can be deleted while a filter naming it is still stored, and a bar nobody can see is a
// bar nobody can clear — so it goes, which shows more flats rather than fewer.
const WORK = { id: 'work', postcode: 'EC1V 1JN', lat: 51.53, lon: -0.09 };
const GYM = { id: 'gym', postcode: 'N1 7GU', lat: 51.54, lon: -0.1 };
/** A neighbourhood folded in from the old hub list: a point on the map, and nothing to ask TfL. */
const ANGEL_PLACE = { id: 'angel', postcode: null, lat: ANGEL.lat, lon: ANGEL.lon };
/** A place whose postcode never resolved to a point. The other half of the same coin. */
const UNPLACED = { id: 'work', postcode: 'EC1V 1JN', lat: null, lon: null };

check('a bar naming a deleted place is dropped', withKnownPlaces(toWork, [GYM]), NO_FILTER);
check('and one naming a place that exists is kept', withKnownPlaces(toWork, [WORK]), toWork);

// --------------------------------------------------------------------------------------------- //
console.log('\nwhat a place can be asked');

check('a place with both offers all four', barModesFor(WORK).length, 4);
check('a point with no postcode offers only the straight line', barModesFor(ANGEL_PLACE).join(), CROW);
check('a postcode that never resolved offers the three journeys', barModesFor(UNPLACED).join(), 'walking,cycling,transit');
check('a place with neither offers nothing', barModesFor({ postcode: null, lat: null, lon: null }).length, 0);
check('and gets no starting bar at all', startingBar({ postcode: null, lat: null, lon: null }), null);

// The stored bar nobody was ever offered. A postcode removed from a place leaves its transit bars
// reading `unknown` for every flat in the hunt — the pile unfiltered, the control saying otherwise.
check(
  'a transit bar on a place that lost its postcode is dropped',
  withKnownPlaces(toWork, [{ id: 'work', postcode: null, lat: 51.53, lon: -0.09 }]),
  NO_FILTER,
);
check(
  'and a distance bar on a place that lost its coordinates goes too',
  withKnownPlaces(withinMile, [{ id: 'angel', postcode: 'N1 1AA', lat: null, lon: null }]),
  NO_FILTER,
);
check(
  'a distance bar on a place that still has a point is kept',
  withKnownPlaces(withinMile, [ANGEL_PLACE]),
  withinMile,
);

// Thirty minutes and thirty miles are the same digits and nothing like the same filter, so the
// number never crosses between units — see the note on `startingBar`.
check('a place with a postcode starts on the commute', startingBar(WORK)?.max, 30);
check('a point on the map starts at a mile', startingBar(ANGEL_PLACE)?.max, 1);
check('minutes default to thirty', defaultMax('transit'), 30);
check('miles default to one', defaultMax(CROW), 1);

// --------------------------------------------------------------------------------------------- //
console.log("\nand the hunt's own must-haves, which are a filter nobody set today");

// The three that are bars. `targetSqft` and `greatRoomMinSqft` are deliberately absent below, and a
// `nice` amenity is the setting that exists precisely so as not to exclude anything — folding any of
// them in here would empty the pile of flats the hunt said it would look at.
check('a hunt with no preferences is no filter at all', filterIsOn(huntFloor({})), false);
check('nor is one that only aims high', filterIsOn(huntFloor({ targetSqft: 900, greatRoomMinSqft: 450 })), false);
// `greatRoomFloorSqft` *is* a floor and is still not one of these: a main-room size is read off a
// photograph, so excluding on it would drop flats on a guess. It goes red on the card instead.
check('nor a main-room floor', filterIsOn(huntFloor({ greatRoomFloorSqft: 450 })), false);
check('nor a nice-to-have', filterIsOn(huntFloor({ amenities: { bathtub: 'nice' } })), false);
check('a must-have is one', huntFloor({ amenities: { bathtub: 'must', outdoor: 'nice' } }).amenities, ['bathtub']);
check('and so are the two floors', huntFloor({ minBedrooms: 2, minSqft: 600 }), {
  ...NO_FILTER, minBedrooms: 2, minSqft: 600,
});
// "A studio is fine" is an answer, and it excludes nothing — which is why it is stored as 0 rather
// than as a category. A `bar()`-style truthiness test here would read it as "don't mind", which is
// the same behaviour by luck rather than the same meaning.
check('a hunt that will take a studio excludes nothing', huntFloor({ minBedrooms: 0 }).minBedrooms, 0);

const tiny = flat({ floorAreaSqft: 400, floorAreaSource: 'sizings' });
const roomy = flat({ rightmoveId: '2', floorAreaSqft: 800, floorAreaSource: 'sizings' });
const unmeasured = flat({ rightmoveId: '3' });
const split = splitByHuntFloor([tiny, roomy, unmeasured], { minSqft: 600 });
check('the flat under the hunt\'s floor is set aside', split.below.map((e) => e.rightmoveId), ['1']);
// Both halves, and the unknown in the half that is kept: the rule the whole file is about does not
// stop applying because the bar was set on the Your Hunt page rather than on this screen.
check('the one over it and the one nobody measured stay', split.above.map((e) => e.rightmoveId), ['2', '3']);
check(
  'a hunt with no bars sets nothing aside',
  splitByHuntFloor([tiny, roomy], {}).below.length,
  0,
);

// --------------------------------------------------------------------------------------------- //
console.log('\nthe nearest station: a place nobody saved');

const station = (miles: number, unit = 'miles') => [
  { name: 'Angel Station', types: ['LONDON_UNDERGROUND'], distance: miles, unit },
];
const nearAStation = flat({ rightmoveId: 'near', nearestStations: station(0.3) });
const farFromOne = flat({ rightmoveId: 'far', nearestStations: station(1.4) });
const noStations = flat({ rightmoveId: 'none' });
const halfMileOfATube = only({ travel: [{ placeId: NEAREST_STATION, mode: CROW, max: 0.5 }] });

check('three hundred yards away stays', matchesFilter(nearAStation, halfMileOfATube), true);
check('a mile and a half goes', matchesFilter(farFromOne, halfMileOfATube), false);
// The rule again, on the one bar that needs neither the travel cache nor a coordinate: a listing
// with no stations on it is one nobody has a distance for, not one in the middle of nowhere.
check('a listing with no stations on it stays', matchesFilter(noStations, halfMileOfATube), true);
check(
  'and is counted as kept on a shrug',
  applyFilter([nearAStation, farFromOne, noStations], halfMileOfATube).unknowns,
  1,
);
// Kilometres are converted rather than compared as if they were miles, which would read as a much
// closer station than it is — the bar would keep a flat 0.9 miles from one.
check(
  'a distance in kilometres is converted, not trusted',
  matchesFilter(flat({ nearestStations: station(1.4, 'km') }), halfMileOfATube),
  false,
);

check('it offers the straight line and nothing else', barModesFor({ id: NEAREST_STATION, postcode: null, lat: null, lon: null }).join(), CROW);
// It is not one of the project's places, so the pruning that drops a bar naming a deleted place
// must not drop this one — there is nothing for it to have been deleted from.
check('a station bar survives a project with no places at all', withKnownPlaces(halfMileOfATube, []), halfMileOfATube);
check('and comes back out of storage intact', parseFilter(JSON.parse(JSON.stringify(halfMileOfATube))), halfMileOfATube);
// Last in the picker, so the button that adds a bar still lands on a place somebody saved — the
// commute is what they saved it for.
const workPlace = { ...NEAREST_STATION_PLACE, id: 'work', label: 'Work', postcode: 'EC1V 1JN', lat: 51.53, lon: -0.09 };
check('the picker offers it after the saved places', destinationsFor([workPlace]).map((p) => p.id), ['work', NEAREST_STATION]);
check('and offers it on its own when nothing is saved', destinationsFor([]).map((p) => p.id), [NEAREST_STATION]);

// --------------------------------------------------------------------------------------------- //
console.log('\nwhat a row says it does not know');

// The tally under the filter counts these; a row has to be able to say which of them it is. Every
// phrase here is drawn as a chip beside an address, so they are the words, not keys.
check('a size bar and no size', unknownBars(flat({}), only({ minSqft: 700 })), ['no size']);
check(
  'a measured flat has nothing to say',
  unknownBars(flat({ floorAreaSqft: 800, floorAreaSource: 'sizings' }), only({ minSqft: 700 })),
  [],
);
check(
  'an amenity nobody could see names itself',
  unknownBars(flat({ analysis: analysis({}) }), only({ amenities: ['outdoor'] })),
  ['outdoor space unknown'],
);
check(
  'and one the model answered does not',
  unknownBars(flat({ analysis: analysis({ hasOutdoorSpace: false }) }), only({ amenities: ['outdoor'] })),
  [],
);
check(
  'two missing figures are two chips',
  unknownBars(flat({ price: 'POA' }), only({ maxPrice: 3000, minBedrooms: 2 })),
  ['no rent', 'beds unknown'],
);
// A bar nobody has looked up yet, which on a fresh sweep is nearly the whole pile.
check(
  'an unmeasured journey says so once, however many bars are set',
  unknownBars(flat({ postcode: 'N1 9AA' }), only({ travel: [
    { placeId: 'work', mode: 'transit', max: 20 },
    { placeId: 'gym', mode: 'walking', max: 15 },
  ] })),
  ['journey not measured'],
);
// The station bar is not the travel cache and its absence is not an instruction: no amount of
// opening the flat produces a station the listing never named.
check(
  'a listing with no stations says so in its own words',
  unknownBars(noStations, halfMileOfATube),
  ['no station listed'],
);
check(
  'and a hunt filtering on both hears about both',
  unknownBars(flat({ postcode: 'N1 9AA' }), only({ travel: [
    { placeId: NEAREST_STATION, mode: CROW, max: 0.5 },
    { placeId: 'work', mode: 'transit', max: 20 },
  ] })),
  ['no station listed', 'journey not measured'],
);
check('and a filter that is off says nothing at all', unknownBars(flat({}), NO_FILTER), []);

if (failures > 0) { console.error(`\n${failures} failing`); process.exit(1); }
console.log('\nall ok');
