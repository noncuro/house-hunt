/** Where you are, and the link to where a flat is. Run with `pnpm check:geo`.
 *
 *  Both halves are invisible when wrong. A geolocation failure that produced a tidy blank would be
 *  a map that simply did not move — indistinguishable from a slow fix, and the reason there is a
 *  sentence for every code including the ones nobody planned for. A maps link is worse: it is a
 *  string that looks right in every review and is dead on one of the two phone platforms, and
 *  nobody finds out except the person standing outside the wrong building.
 */
import { LOCATE_ZOOM, locateProblem, mapsUrl, zoomForLocate } from '../apps/web/src/lib/geo';

let failed = 0;
function ok(what: string, got: unknown, want: unknown) {
  const same = got === want;
  if (!same) failed++;
  console.log(`${same ? 'ok  ' : 'FAIL'} ${what.padEnd(56)} ${JSON.stringify(got)}`);
  if (!same) console.log(`     ${''.padEnd(56)} want ${JSON.stringify(want)}`);
}

// What the reader is told when it does not work. Every code gets its own sentence, and none of
// them gets a position instead.
ok(
  'refused',
  locateProblem({ code: 1, message: 'User denied Geolocation' }),
  'Your browser would not share where you are. Allow location for this site and try again.',
);
ok(
  'no fix',
  locateProblem({ code: 2, message: 'Unknown error acquiring position' }),
  'Your device could not work out where you are.',
);
ok(
  'timed out',
  locateProblem({ code: 3, message: 'Timeout expired' }),
  'Working out where you are took too long.',
);

// The case the switch was not written for: a browser that invents a fourth code, or a rejection
// that is no GeolocationPositionError at all. It must still say something specific — flattening it
// into "something went wrong" throws away the only description of the fault that exists.
ok(
  'an unknown code keeps the browser own words',
  locateProblem({ code: 42, message: 'kCLErrorDomain error 1.' }),
  'Could not work out where you are — kCLErrorDomain error 1.',
);
ok(
  'nothing said at all is still admitted',
  locateProblem({}),
  'Could not work out where you are, and the browser did not say why.',
);
ok(
  'a blank message is not a message',
  locateProblem({ code: 0, message: '   ' }),
  'Could not work out where you are, and the browser did not say why.',
);

// How far in "show me where I am" goes.
ok('zoomed out, come in to the street', zoomForLocate(11), LOCATE_ZOOM);
ok('already at the street, stay there', zoomForLocate(LOCATE_ZOOM), LOCATE_ZOOM);
// The one that matters: locating must never pull the view back out from under somebody who has
// zoomed in past it.
ok('zoomed in past it, keep it', zoomForLocate(18), 18);

// The link to the phone's maps app. A plain https URL: not `geo:` (no iOS handler) and not
// `maps://` (no Android one). The whole point is that one string works on both without anyone
// asking what the device is.
const url = mapsUrl({ lat: 51.53412, lon: -0.10567 }, 'N1 9GU');
ok('coordinates win over the postcode', url, 'https://www.google.com/maps/search/?api=1&query=51.53412%2C-0.10567');
ok('and it is an ordinary https link', url?.startsWith('https://'), true);

// Rightmove hides the postcode on some listings and gives no pin on others; each half stands alone.
ok('postcode when that is all there is', mapsUrl(null, 'N1 9GU'), 'https://www.google.com/maps/search/?api=1&query=N1%209GU');
// A metre, matching what `CopyLocation` copies — the link and the clipboard must not disagree.
ok('five decimals, rounded not truncated', mapsUrl({ lat: 51.5341299, lon: -0.1 }, null), 'https://www.google.com/maps/search/?api=1&query=51.53413%2C-0.10000');
// Neither: a link would open a map of nowhere, so there is none and the caller says so.
ok('nothing to map', mapsUrl(null, null), null);
ok('a blank postcode is nothing to map', mapsUrl(null, '  '), null);

console.log(failed === 0 ? '\nall passed' : `\n${failed} failed`);
if (failed > 0) process.exit(1);
