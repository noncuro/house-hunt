/** What counts as a Rightmove listing address, and what a share hands over. Run with
 *  `pnpm check:listing`.
 *
 *  Two functions, one check, because they are the two halves of one path: a listing arrives from a
 *  paste, a link or the system share sheet (`sharedLink`), and is then either a listing or not
 *  (`rightmoveListingId`). Both are pure, both are read on a phone where there is no extension to
 *  fall back on, and both fail in the same quiet way — a share that lands on the shortlist with no
 *  dialog, or an address refused with a sentence about it not being a listing when it plainly is.
 *
 *  The host cases are the ones worth pinning. `rightmove.co.uk.evil.example` contains the string
 *  every naive check tests for, and accepting it would have the Edge Function fetch whatever that
 *  host served and decode it as a flat.
 */
import { rightmoveListingId } from '../packages/core/src/listing';
import { sharedLink, withoutSharedLink } from '../apps/web/src/lib/shared-link';

const urls: Array<[string, string | null]> = [
  ['https://www.rightmove.co.uk/properties/88023648', '88023648'],
  ['https://www.rightmove.co.uk/properties/88023648/', '88023648'],
  // What the search page's own links look like, and what the share sheet passes on.
  ['https://www.rightmove.co.uk/properties/88023648?channel=RES_LET', '88023648'],
  ['https://www.rightmove.co.uk/properties/88023648#/media?id=media0', '88023648'],
  ['https://www.rightmove.co.uk/properties/88023648#/', '88023648'],
  ['http://rightmove.co.uk/properties/88023648', '88023648'],
  ['  https://www.rightmove.co.uk/properties/88023648  ', '88023648'],
  // A link somebody saved years ago. Rightmove still redirects these.
  ['https://www.rightmove.co.uk/property-to-rent/property-88023648.html', '88023648'],
  // A search results page: the commonest wrong paste, and there is no one flat on it.
  ['https://www.rightmove.co.uk/property-to-rent/find.html?locationIdentifier=STATION%5E4187', null],
  ['https://www.rightmove.co.uk/', null],
  // The string check every naive host test passes and must not.
  ['https://www.rightmove.co.uk.evil.example/properties/88023648', null],
  ['https://notrightmove.co.uk/properties/88023648', null],
  // An agent's own site, which is what a listing's "view on our website" link is.
  ['https://example-lettings.co.uk/properties/88023648', null],
  ['javascript:alert(1)//rightmove.co.uk/properties/88023648', null],
  ['not a url at all', null],
  ['', null],
];

const shares: Array<[string, string | null]> = [
  // The manifest's Add-a-flat shortcut: present and empty means "open the dialog", not "no share".
  ['?add=', ''],
  ['?add=https%3A%2F%2Fwww.rightmove.co.uk%2Fproperties%2F88023648', 'https://www.rightmove.co.uk/properties/88023648'],
  ['?url=https%3A%2F%2Fwww.rightmove.co.uk%2Fproperties%2F88023648', 'https://www.rightmove.co.uk/properties/88023648'],
  // Android routinely puts the whole "look at this — <url>" string in `text` and sends no `url` at
  // all, which is the case a share target reading only `url` receives as an empty share.
  ['?text=2%20bed%20flat%20https%3A%2F%2Fwww.rightmove.co.uk%2Fproperties%2F88023648', 'https://www.rightmove.co.uk/properties/88023648'],
  // The sharer finished their sentence. `\S+` runs to the next space, so without the trailing-prose
  // strip the candidate keeps the full stop, its pathname matches neither listing pattern, and a
  // perfectly good share is refused with "that is not a listing address".
  ['?text=Look%20at%20this%20https%3A%2F%2Fwww.rightmove.co.uk%2Fproperties%2F88023648.', 'https://www.rightmove.co.uk/properties/88023648'],
  ['?text=(https%3A%2F%2Fwww.rightmove.co.uk%2Fproperties%2F88023648)', 'https://www.rightmove.co.uk/properties/88023648'],
  ['?text=%22https%3A%2F%2Fwww.rightmove.co.uk%2Fproperties%2F88023648%22%2C%20thoughts%3F', 'https://www.rightmove.co.uk/properties/88023648'],
  // A query string ends in real punctuation often enough that stripping must stop at the first
  // character that could not end an address — here the `?` is the last thing in the sentence.
  ['?text=this%20one%3F%20https%3A%2F%2Fwww.rightmove.co.uk%2Fproperties%2F88023648%3Fchannel%3DRES_LET', 'https://www.rightmove.co.uk/properties/88023648?channel=RES_LET'],
  ['?title=A%20flat&text=nothing%20linked%20here', null],
  ['?v=triage', null],
  ['', null],
];

let failed = 0;

for (const [url, want] of urls) {
  const got = rightmoveListingId(url);
  if (got !== want) failed++;
  console.log(`${got === want ? 'ok  ' : 'FAIL'} id ${JSON.stringify(url).slice(0, 62)} -> ${got} (want ${want})`);
}

for (const [search, want] of shares) {
  const got = sharedLink(search);
  if (got !== want) failed++;
  console.log(`${got === want ? 'ok  ' : 'FAIL'} share ${JSON.stringify(search).slice(0, 58)} -> ${JSON.stringify(got)}`);
}

// The share's own parameters have to come back out of the address bar, or a reload re-opens the
// dialog for a flat that was added twenty minutes ago — while everything else the app keeps there
// stays put.
const stripped: Array<[string, string]> = [
  ['?add=https%3A%2F%2Fx&v=triage', '?v=triage'],
  ['?title=A&text=B&url=C', ''],
  ['?v=map', '?v=map'],
];
for (const [search, want] of stripped) {
  const got = withoutSharedLink(search);
  if (got !== want) failed++;
  console.log(`${got === want ? 'ok  ' : 'FAIL'} strip ${search} -> ${JSON.stringify(got)} (want ${JSON.stringify(want)})`);
}

console.log(failed === 0 ? '\nall passed' : `\n${failed} failed`);
if (failed > 0) process.exit(1);
