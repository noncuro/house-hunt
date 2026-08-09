import { extractFromPage } from '@/lib/extract';
import { describe, PAGE_MESSAGE, PAGE_REQUEST, type PageMessage } from '@/lib/messages';

/** MAIN world. This is the only script that can see window.__PAGE_MODEL — an isolated content
 *  script gets a different `window` and would always read undefined. It has no chrome.* APIs, so
 *  the way out is postMessage. See RESEARCH.md §2.
 */
export default defineContentScript({
  matches: ['https://www.rightmove.co.uk/properties/*'],
  world: 'MAIN',
  runAt: 'document_end',

  main() {
    // Held so a late listener still gets an answer: this script runs at document_end and the
    // panel at document_idle, so a single broadcast would land before anyone was listening.
    let result: PageMessage | null = null;

    window.addEventListener('message', (event) => {
      if (event.source !== window) return;
      if ((event.data as { source?: string } | undefined)?.source !== PAGE_REQUEST) return;
      if (result) post(result);
    });

    void (async () => {
      try {
        result = { source: PAGE_MESSAGE, ok: true, listing: await waitForPageModel() };
      } catch (e) {
        // Fail loudly: the panel says "couldn't read this listing" rather than rendering blanks
        // that look like "this property has no nearby stations".
        result = { source: PAGE_MESSAGE, ok: false, error: describe(e) };
      }
      post(result);
    })();
  },
});

/** The global is assigned by an inline script, which has usually run by document_end but not
 *  always. Retry briefly before declaring it missing. */
async function waitForPageModel(attempts = 20, delayMs = 100) {
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return extractFromPage(window, location.href);
    } catch (e) {
      lastError = e;
      if (!describe(e).includes('__PAGE_MODEL not found')) throw e; // a real decode failure
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastError;
}

function post(message: PageMessage): void {
  window.postMessage(message, location.origin);
}
