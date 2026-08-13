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
  filterIsOn,
  matchesFilter,
  type TriageFilter,
} from '../packages/core/src/filter';
import type { Analysis } from '../packages/core/src/types';
import type { ShortlistEntry } from '../packages/core/src/db/supabase';

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
    bedInKitchen: null, bedInKitchenConfidence: null, utilitiesIncluded: null, utilitiesConfidence: null,
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

// Laundry and light are the two whose "has it" is narrower than "is not null" — in-building laundry
// is not in-unit laundry, and medium light is the model hedging rather than saying yes.
check(
  'laundry in the building is not laundry in the flat',
  matchesFilter(flat({ analysis: analysis({ laundry: 'in-building' }) }), only({ amenities: ['inUnitLaundry'] })),
  false,
);
check(
  'medium light does not clear a bright-light filter',
  matchesFilter(flat({ analysis: analysis({ naturalLight: 'medium' }) }), only({ amenities: ['brightLight'] })),
  false,
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

if (failures > 0) { console.error(`\n${failures} failing`); process.exit(1); }
console.log('\nall ok');
