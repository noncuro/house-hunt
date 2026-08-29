/** Which browsers are offered the extension. Run with `pnpm check:platform`.
 *
 *  A browser sniff nothing checks is a browser sniff that quietly stops matching, and this one fails
 *  in both directions without a word on screen. Say yes to Safari and somebody gets six numbered
 *  steps about `chrome://extensions`, a menu that does not exist there, for a folder their browser
 *  cannot load. Say no to Chrome and the download disappears from the one place it is served —
 *  there is no store link to fall back on, because distribution is an invite.
 *
 *  Real strings, copied from the browsers themselves, because that is the whole subject: a regex
 *  written against a paraphrase of a user-agent is a regex that has never met one.
 */
import { chromiumFamily } from '../apps/web/src/lib/platform';

/** [what it is, user-agent, brands if the browser reports any, may it hold the extension] */
const cases: Array<[string, string, Array<{ brand: string }> | undefined, boolean]> = [
  [
    'Chrome on macOS',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
    // GREASE: Chromium sends a deliberately varying nonsense brand alongside the real ones, so a
    // check that matched the *first* entry would be right about three times in four.
    [{ brand: 'Not;A=Brand' }, { brand: 'Chromium' }, { brand: 'Google Chrome' }],
    true,
  ],
  [
    'Chrome, no client hints (an older build)',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    undefined,
    true,
  ],
  [
    'Edge',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0',
    [{ brand: 'Chromium' }, { brand: 'Microsoft Edge' }, { brand: 'Not=A?Brand' }],
    true,
  ],
  [
    // Brave and Opera keep Chrome's token and load the same folder. Naming Chrome alone would
    // refuse two browsers that work.
    'Brave',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
    [{ brand: 'Brave' }, { brand: 'Chromium' }, { brand: 'Not.A/Brand' }],
    true,
  ],
  [
    'Opera',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 OPR/117.0.0.0',
    undefined,
    true,
  ],
  [
    // The one this check was written for. Safari's string ends in `Safari/` and never carries
    // `Chrome/`, which is what separates it from every Chromium above — all of which also say
    // `Safari/`, because they all claim WebKit compatibility.
    'Safari on macOS',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15',
    undefined,
    false,
  ],
  [
    'Firefox',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 14.7; rv:131.0) Gecko/20100101 Firefox/131.0',
    undefined,
    false,
  ],
  [
    // Chrome for Android reports `Chrome/` and loads no extensions at all. `chromiumFamily` says
    // yes here on purpose — it answers one question — and `canHoldExtension` asks `isMobile()` too.
    // The comment is the assertion: this case exists so that division stays deliberate.
    'Chrome on Android (a Chromium, and still no extensions — isMobile decides)',
    'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36',
    [{ brand: 'Chromium' }, { brand: 'Google Chrome' }, { brand: 'Not)A;Brand' }],
    true,
  ],
];

let failed = 0;
for (const [what, userAgent, brands, want] of cases) {
  const got = chromiumFamily(userAgent, brands);
  if (got !== want) failed++;
  console.log(`${got === want ? 'ok  ' : 'FAIL'} ${what.padEnd(58)} -> ${got} (want ${want})`);
}

console.log(failed === 0 ? '\nall passed' : `\n${failed} failed`);
if (failed > 0) process.exit(1);
