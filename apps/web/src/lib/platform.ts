'use client';

import { useSyncExternalStore } from 'react';

/** What this browser can and cannot be asked to do.
 *
 *  One question, really: can an extension exist here at all? Chrome for Android loads none, and no
 *  browser on iOS loads a Chrome extension — so on a phone the whole install story is not "not done
 *  yet", it is "not possible", and every sentence offering it is an instruction the reader cannot
 *  follow. That is worse than useless on the surface where the app has the least room: it is the
 *  first thing on the screen, it has a button, and the button leads to a page of steps about
 *  `chrome://extensions`.
 *
 *  So the notice, the install menu item and the first-run step all ask here first. What replaces
 *  them is not nothing — a phone adds a flat by pasting or sharing its address (`screens/AddFlat`),
 *  which is the same act performed by the half of the system that can run there.
 */

/** Is this a phone or a tablet — somewhere no Chrome extension can be installed?
 *
 *  `userAgentData.mobile` is the answer where it exists (Chromium) and is the only one that is not a
 *  guess. Everywhere else this reads the user-agent, which is the thing every piece of advice says
 *  not to do and is right here for a narrow reason: what is being asked is not "which browser is
 *  this" but "is this a device class that has an extension mechanism at all", and that genuinely is
 *  a property of the platform rather than of any feature.
 *
 *  Wrong in one direction costs a nag that is already what happens today; wrong in the other costs
 *  nothing but a missing offer somebody can still reach from the menu. So where it is unsure it
 *  says mobile — the quieter of the two mistakes. That is why iPadOS, which reports itself as a Mac
 *  and is caught by the touch test below, lands on the right side of it.
 */
export function isMobile(): boolean {
  if (typeof navigator === 'undefined') return false;

  const data = (navigator as Navigator & { userAgentData?: { mobile?: boolean } }).userAgentData;
  if (typeof data?.mobile === 'boolean') return data.mobile;

  if (/Android|iPhone|iPad|iPod|Mobile Safari|Opera Mini|IEMobile/i.test(navigator.userAgent)) return true;

  // iPadOS 13+ says it is a Mac. A Mac has no touchscreen, so a touch-primary "Mac" is an iPad —
  // and `pointer: coarse` is the same question asked of the pointer rather than of the string.
  const touch = navigator.maxTouchPoints > 1;
  const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  return touch && coarse;
}

/** Is this a Chromium-family browser — the only kind that can load the extension we ship?
 *
 *  The download is a Chrome MV3 folder. Safari's extensions are a different format inside a signed
 *  app bundle, and Firefox's are a different manifest again, so `chrome://extensions` and "Load
 *  unpacked" are, in both, instructions that cannot be carried out — the same failure as offering
 *  them on a phone, just further from anybody's mind because the device *looks* capable.
 *
 *  `userAgentData.brands` where it exists, which is Chromium browsers saying so themselves. The
 *  user-agent fallback is for the two that have no such API, and it works because of what is
 *  *absent* rather than present: Safari's string carries no `Chrome/` token and Firefox's carries
 *  neither. Edge, Opera, Brave and Arc all keep `Chrome/`, which is right — all four load this.
 *
 *  Pure, and takes its inputs, so `tools/check-platform.ts` can hold the strings the real browsers
 *  send. A browser sniff that nothing checks is a browser sniff that quietly stops matching. */
export function chromiumFamily(
  userAgent: string,
  brands?: Array<{ brand: string }>,
): boolean {
  if (brands?.length) return brands.some((b) => /Chromium|Google Chrome|Microsoft Edge/i.test(b.brand));
  return /Chrom(e|ium)\//.test(userAgent);
}

/** Could the extension be installed in this browser? A desktop, and a Chromium.
 *
 *  Named for what the callers want to know, so nothing has to remember which way round either test
 *  goes — and asked in one place, because four surfaces ask it (the notice, the account menu, the
 *  first-run step, the Install screen) and a fifth will. */
export function canHoldExtension(): boolean {
  if (typeof navigator === 'undefined') return false;
  const brands = (navigator as Navigator & { userAgentData?: { brands?: Array<{ brand: string }> } })
    .userAgentData?.brands;
  return !isMobile() && chromiumFamily(navigator.userAgent, brands);
}

/** Is the app running as an installed app rather than in a browser tab?
 *
 *  `display-mode: standalone` covers everything installed from a manifest; `navigator.standalone` is
 *  the older iOS-only flag for a page added to the home screen, which Safari still sets and which no
 *  media query reports. Both, because a phone that answers only the second is exactly the one this
 *  matters most on.
 *
 *  It decides two things and neither is cosmetic: whether the shortlist's photographs are worth
 *  pre-loading into the browser's cache (`lib/photos.ts`) — a tab does not stay around long enough
 *  for that to pay — and whether to offer installing at all. */
export function isInstalled(): boolean {
  if (typeof window === 'undefined') return false;
  if (typeof matchMedia === 'function' && matchMedia('(display-mode: standalone)').matches) return true;
  return (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

// ------------------------------------------------------------------------------------------------
// The same three questions, asked from a render.
// ------------------------------------------------------------------------------------------------

/** Nothing to subscribe to: a device does not stop being a phone, and no event fires if it somehow
 *  did. The subscription exists because `useSyncExternalStore` requires one. */
const never = () => () => {};

/** The server has no `navigator`, so every one of these answers `false` there — and that is not a
 *  guess that happens to be safe, it is the *only* answer a prerender can give.
 *
 *  Which is exactly why these are `useSyncExternalStore` rather than a plain call in a render.
 *  Calling `isMobile()` during render makes the server's markup and the phone's first render
 *  disagree, and React resolves a hydration mismatch by throwing the server's tree away — so the
 *  bug is not the warning in the console, it is a first paint of the desktop copy of this page on a
 *  device that cannot use it. `getServerSnapshot` is React's own name for "what the prerender saw",
 *  and it re-renders once with the real answer after hydrating, which is the whole mechanism.
 *
 *  So the Chrome-on-a-laptop reading is the one that is briefly shown to everybody. That decides
 *  which way round these questions are phrased: what appears for a frame and then goes is a
 *  sentence about the extension, which is right in Chrome and stale for a moment on a phone or in
 *  Safari — never the reverse, where a phone's own instructions would flash up on a machine that
 *  should never see them. */
export function useCanHoldExtension(): boolean {
  return useSyncExternalStore(never, canHoldExtension, () => true);
}

export function useIsMobile(): boolean {
  return useSyncExternalStore(never, isMobile, () => false);
}

export function useIsInstalled(): boolean {
  return useSyncExternalStore(never, isInstalled, () => false);
}
