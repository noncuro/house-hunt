/** The one page shape the extractor has to tell apart from its own failure.
 *
 *  Rightmove answers a listing the agent has taken down with HTTP 404 and a full page. The page
 *  model is still there — so nothing upstream catches it — but `propertyData` is hollowed out to
 *  `customer` and `propertyUrls`, with `id` gone. Left alone that reached the panel as "Couldn't
 *  read this listing", which sends whoever saw it to `decode_page_model.py` after a Rightmove
 *  change that never happened, and left the sweep reopening the flat on every fill-in run.
 *
 *  The reasoning worth pinning is the *narrowness*. Withdrawn is inferred from an absence, and the
 *  cheap version of that inference — no id, so it must be gone — reads a genuine Rightmove rename
 *  as a withdrawal, which is worse than the bug it fixes: it tells you a flat you are looking at
 *  has been removed, and drops it from the sweep, with no error anywhere. Both directions are
 *  checked here because neither is visible in the other's absence.
 *
 *  The objects are hand-built rather than a saved page, deliberately: the fixtures are Rightmove's
 *  own content and are not committed (docs/fixtures.md), so a check that needed one would only run
 *  where somebody had fetched a withdrawn listing that day. `pnpm check:extractor` against a saved
 *  page is still the check for the real thing.
 *
 *  The same hand-built objects also pin the two signals that a listing has left the market while
 *  its page is still up, at the foot of the file.
 */
import { ListingWithdrawn, toListing } from '../packages/core/src/listing';

const URL = 'https://www.rightmove.co.uk/properties/91760358';

let failures = 0;
function check(name: string, run: () => void, expected: 'withdrawn' | 'unreadable' | 'listing') {
  let got: string;
  try {
    run();
    got = 'listing';
  } catch (e) {
    got = e instanceof ListingWithdrawn ? 'withdrawn' : 'unreadable';
  }
  if (got === expected) return console.log(`  ok   ${name}`);
  failures++;
  console.log(`  FAIL ${name}\n       expected ${expected}\n       got      ${got}`);
}

/** Exactly what the decoded model held for 91760358 on 2026-08-12, taken down between being
 *  sighted and being opened. Two keys, and one of them is a link to flats like it. */
const withdrawn = {
  customer: {},
  propertyUrls: {
    similarPropertiesUrl: '/property-to-rent/NW1-8NZ.html?radius=0.5&minPrice=3500&maxPrice=5000',
  },
};

/** A live listing, cut down to the fields the inference reads. Nothing here is a real address. */
const live = {
  id: 91410465,
  status: { published: true, archived: false },
  address: { outcode: 'NW3', incode: '1AA', displayAddress: 'A Street, London' },
  text: { description: 'A flat.' },
  prices: { primaryPrice: '£2,000 pcm' },
  propertyUrls: { similarPropertiesUrl: '/property-to-rent/NW3-1AA.html' },
};

console.log('withdrawn listings');
check('the page Rightmove serves for a removed listing', () => toListing(withdrawn, URL), 'withdrawn');

console.log('\nnot withdrawn');
check('a live listing', () => toListing(live, URL), 'listing');

// The rename case, which is the whole reason the inference is four fields wide and not one. Every
// other field is intact, so this must stay a loud failure rather than becoming a quiet withdrawal.
check(
  'a live listing whose id Rightmove renamed',
  () => toListing({ ...live, id: undefined }, URL),
  'unreadable',
);

// The half-way shapes. A listing missing one section is a listing we should still read, and a page
// with nothing on it at all is not the withdrawn page — it is something we do not understand.
check(
  'a live listing with no price section',
  () => toListing({ ...live, prices: undefined }, URL),
  'listing',
);
check('an empty object', () => toListing({}, URL), 'unreadable');
check(
  'gutted, but without the withdrawn page\'s own link',
  () => toListing({ customer: {}, propertyUrls: {} }, URL),
  'unreadable',
);

// Off the market with the page still up. Shapes as decoded from live listings on 2026-09-27: let
// agreed keeps `status` published and not archived, and says so only in `tags`. Reading `archived`
// alone is what left let-agreed flats on the shortlist.
console.log('\noff the market, page still up');
function same(name: string, got: unknown, expected: unknown) {
  if (JSON.stringify(got) === JSON.stringify(expected)) return console.log(`  ok   ${name}`);
  failures++;
  console.log(`  FAIL ${name}\n       expected ${JSON.stringify(expected)}\n       got      ${JSON.stringify(got)}`);
}
const signals = (property: Record<string, unknown>) => {
  const { archived, letAgreed } = toListing(property, URL);
  return { archived, letAgreed };
};
same('a live listing is neither', signals({ ...live, tags: [] }), { archived: false, letAgreed: false });
same(
  'let agreed is in tags, not status',
  signals({ ...live, tags: ['LET_AGREED'] }),
  { archived: false, letAgreed: true },
);
same(
  'taken down is in status',
  signals({ ...live, status: { published: false, archived: true }, tags: [] }),
  { archived: true, letAgreed: false },
);
same('no tags array is unknown, not "still on"', signals(live), { archived: false, letAgreed: null });

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
if (failures > 0) process.exit(1);
