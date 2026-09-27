/** When two listings are the same flat, and — more importantly — when they are not.
 *  Run with `pnpm check:duplicates`.
 *
 *  This is advice, so the cost of the two mistakes is lopsided and the cases below are weighted
 *  that way. A missed duplicate costs a second analysis and a verdict on the wrong card, which
 *  somebody notices. A false one puts "this may be the same as" under two different flats in the
 *  same building, which teaches the reader to stop reading the line — after which the true ones are
 *  invisible too. So most of what is pinned here is refusals.
 */
import { possibleDuplicates, type Comparable } from '../packages/core/src/duplicates';

let failed = 0;
function check(ok: boolean, what: string): void {
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
}

function flat(over: Partial<Comparable> & Pick<Comparable, 'rightmoveId' | 'site'>): Comparable {
  return {
    displayAddress: 'A flat',
    postcode: 'NW3 5PL',
    bedrooms: 2,
    price: '£3,000 pcm',
    ...over,
  };
}

// The case this exists for: one CRM record, two renderings.
const onRightmove = flat({ rightmoveId: '88023648', site: 'rightmove', displayAddress: 'Thurlow Road, NW3' });
const onFoxtons = flat({ rightmoveId: 'foxtons_chpk3392427', site: 'foxtons', displayAddress: 'Flat 7, 16 Thurlow Road' });

const both = possibleDuplicates(onRightmove, [onFoxtons]);
check(both.length === 1, 'the same flat on two sites is noticed');
check(both[0]?.rightmoveId === 'foxtons_chpk3392427', 'and names the other one');
check(both[0]?.why.includes('same rent') === true, `and says why: ${both[0]?.why}`);

// Symmetric. Whichever card the reader is looking at has to carry the note, or half of them do not.
check(
  possibleDuplicates(onFoxtons, [onRightmove]).length === 1,
  'and says so from the other side too',
);

// Never itself, even offered itself.
check(possibleDuplicates(onRightmove, [onRightmove]).length === 0, 'a flat is not its own duplicate');

// --- the refusals, which are the point ------------------------------------------------------------

// Two flats in one building. Same postcode, same beds, £900 apart — different flats, and this is
// the commonest shape a false positive would take.
check(
  possibleDuplicates(onRightmove, [flat({ rightmoveId: '99999999', site: 'rightmove', price: '£3,900 pcm' })]).length === 0,
  'a different rent at the same postcode is a different flat',
);

// Same building, different size.
check(
  possibleDuplicates(onRightmove, [flat({ rightmoveId: '99999999', site: 'rightmove', bedrooms: 3 })]).length === 0,
  'a different bedroom count is a different flat',
);

// An outcode is thousands of homes. Matching on one would put the note under half the list.
check(
  possibleDuplicates(
    flat({ rightmoveId: '1', site: 'rightmove', postcode: null }),
    [flat({ rightmoveId: 'foxtons_x', site: 'foxtons', postcode: null })],
  ).length === 0,
  'two flats with no postcode are not paired',
);
check(
  possibleDuplicates(onRightmove, [flat({ rightmoveId: 'foxtons_x', site: 'foxtons', postcode: 'NW3 5PP' })]).length === 0,
  'a neighbouring postcode is not a match',
);

// --- the tolerances -------------------------------------------------------------------------------

// One system quotes weekly and the other monthly. £700 pw is £3,033 pcm — the same money, and the
// commonest reason two true duplicates disagree on price.
check(
  possibleDuplicates(onRightmove, [flat({ rightmoveId: 'jdw_1', site: 'johndwood', price: '£700 pw' })]).length === 1,
  'a weekly rent is compared against a monthly one',
);

// The agent moved the rent on one system first.
check(
  possibleDuplicates(onRightmove, [flat({ rightmoveId: 'savills_x', site: 'savills', price: '£3,100 pcm' })]).length === 1,
  'a 3% difference is within the tolerance',
);
check(
  possibleDuplicates(onRightmove, [flat({ rightmoveId: 'savills_x', site: 'savills', price: '£3,300 pcm' })]).length === 0,
  'a 10% difference is not',
);

// A site that states no price at all still gets the note — the postcode and the beds are enough to
// be worth a look, and it says the rent could not be compared rather than implying it agreed.
const noPrice = possibleDuplicates(onRightmove, [
  flat({ rightmoveId: 'tkinternational_a-slug', site: 'tkinternational', price: null }),
]);
check(noPrice.length === 1, 'a listing with no price is still offered');
check(
  noPrice[0]?.why.includes('rent not comparable') === true,
  `and says the rent could not be compared: ${noPrice[0]?.why}`,
);

// An unstated bedroom count is not a contradiction — a studio states none on Rightmove, and a site
// that omits it is exactly the listing hardest to place by hand.
check(
  possibleDuplicates(onRightmove, [flat({ rightmoveId: 'foxtons_x', site: 'foxtons', bedrooms: null })]).length === 1,
  'an unstated bedroom count does not rule a pair out',
);

// --- the same site twice --------------------------------------------------------------------------

// Austin Homes and TK International key on a URL slug, because neither names an id in its URLs. An
// agent retitling a listing mints a second key for a flat already here, and this is the only thing
// that would ever say so.
const relisted = possibleDuplicates(
  flat({ rightmoveId: 'tkinternational_maresfield-gardens-nw3-5sx', site: 'tkinternational' }),
  [flat({ rightmoveId: 'tkinternational_maresfield-gardens-nw3-5sx-2', site: 'tkinternational' })],
);
check(relisted.length === 1, 'a retitled listing on a slug-keyed site is noticed');
check(
  relisted[0]?.why.includes('re-listing') === true,
  `and is described as a re-listing rather than as two sites: ${relisted[0]?.why}`,
);

// --- ordering ---------------------------------------------------------------------------------------

// A block where several flats share a postcode shows all of them, strongest first — the reader is
// the one who can tell which is theirs.
const ranked = possibleDuplicates(onRightmove, [
  flat({ rightmoveId: 'rm_weak', site: 'rightmove', price: null, bedrooms: null }),
  flat({ rightmoveId: 'foxtons_strong', site: 'foxtons' }),
]);
check(ranked.length === 2, 'every candidate at one postcode is offered');
check(
  ranked[0]?.rightmoveId === 'foxtons_strong',
  `strongest first (got ${ranked.map((r) => r.rightmoveId).join(', ')})`,
);

console.log(failed === 0 ? '\nall passed' : `\n${failed} failed`);
if (failed > 0) process.exit(1);
