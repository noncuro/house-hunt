import { chromium } from 'playwright';
const url = process.argv[2]!;
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(6000);
for (const label of ['Accept all', 'Accept All']) {
  const b = page.getByRole('button', { name: label });
  if (await b.count()) { await b.first().click().catch(() => {}); break; }
}
await page.waitForTimeout(2000);
await page.locator('[role="button"][aria-label*="£"], [class*="marker"]').first().click({ force: true });
await page.waitForTimeout(3000);

console.log(JSON.stringify(await page.evaluate(`(() => {
  const close = document.querySelector('[data-testid="map-card-close-button"]');
  const anchor = document.querySelector('a[href*="/properties/"]');
  const chain = [];
  let n = anchor;
  for (let i = 0; i < 12 && n; i++) {
    const r = n.getBoundingClientRect();
    chain.push({ tag: n.tagName.toLowerCase(), testid: n.dataset.testid || null,
      cls: String(n.className || '').slice(0, 40), w: Math.round(r.width), h: Math.round(r.height),
      hasClose: close ? n.contains(close) : false });
    n = n.parentElement;
  }
  return { closeFound: !!close, chain };
})()`), null, 2));
await page.screenshot({ path: '.fixtures/shots/map-preview.png' });
await browser.close();
