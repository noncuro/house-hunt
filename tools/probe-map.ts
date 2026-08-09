/** One-off DOM probe: opens the public map view, clicks a pin, and dumps the shape of the
 *  preview card so we know what to select on. Not part of the test suite. */
import { chromium } from 'playwright';

const url = process.argv[2];
if (!url) throw new Error('usage: probe-map <url>');

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(6000);

// Dismiss the cookie wall if it's in the way.
for (const label of ['Accept all', 'Accept All', 'I Accept']) {
  const b = page.getByRole('button', { name: label });
  if (await b.count()) { await b.first().click().catch(() => {}); break; }
}
await page.waitForTimeout(2000);

const pins = page.locator('[data-testid^="map-pin"], [class*="marker"], [role="button"][aria-label*="£"]');
console.log('pin candidates:', await pins.count());

const before = await page.evaluate(() => document.querySelectorAll('a[href*="/properties/"]').length);
console.log('property links before click:', before);

if (await pins.count()) {
  await pins.first().click({ force: true }).catch((e) => console.log('click failed', e.message));
  await page.waitForTimeout(3000);
}

const dump = await page.evaluate(() => {
  const anchors = [...document.querySelectorAll<HTMLAnchorElement>('a[href*="/properties/"]')];
  return anchors.slice(0, 4).map((a) => {
    const chain: string[] = [];
    let n: HTMLElement | null = a;
    for (let i = 0; i < 8 && n; i++) {
      chain.push(`${n.tagName.toLowerCase()}${n.dataset.testid ? `[${n.dataset.testid}]` : ''}`);
      n = n.parentElement;
    }
    return { href: a.getAttribute('href'), chain: chain.join(' < ') };
  });
});
console.log('property links after click:', dump.length);
console.log(JSON.stringify(dump, null, 2));
console.log('testids:', await page.evaluate(() =>
  [...new Set([...document.querySelectorAll('[data-testid]')].map((e) => (e as HTMLElement).dataset.testid!))]
    .filter((t) => !/^img-groups|^gallery/.test(t)).slice(0, 60)));

await page.screenshot({ path: '.fixtures/shots/map.png' });
await browser.close();
