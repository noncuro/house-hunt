/** Save one listing page for the harnesses to read.
 *
 *  A tool rather than the one-line `curl` this replaces, which had been broken: the user-agent
 *  string contains spaces and parentheses, so it needed quoting inside a shell command that was
 *  itself a quoted JSON string in package.json, and the inner quotes closed the outer ones. The
 *  command never parsed — `pnpm fixture <id>` failed with a shell syntax error, which meant the
 *  fixture the smoke harness needs could not be produced at all.
 *
 *  One page, when you ask for it, by id — the same act as opening the listing and hitting save.
 *  Never a crawl (AGENTS.md): nothing in the extension fetches Rightmove, and this is run by hand.
 *
 *    pnpm fixture 88023648
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const id = process.argv[2];
if (!id || !/^\d+$/.test(id)) {
  console.error('usage: pnpm fixture <listing-id>        e.g. pnpm fixture 88023648');
  process.exit(1);
}

const url = `https://www.rightmove.co.uk/properties/${id}`;
const response = await fetch(url, {
  headers: {
    'User-Agent':
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
  },
});
if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);

const html = await response.text();
// Loudly, here, rather than as a confusing failure two commands later: a listing that has been
// taken down still returns HTTP 200, with a page that carries no model to decode.
if (!/window\.__PAGE_MODEL\s*=/.test(html)) {
  throw new Error(
    `${url} returned a page with no window.__PAGE_MODEL — the listing is probably no longer live.\n` +
      'Pick another id from Rightmove and try again.',
  );
}

const directory = resolve(import.meta.dirname, '../.fixtures');
mkdirSync(directory, { recursive: true });
const file = resolve(directory, `${id}.html`);
writeFileSync(file, html);

console.log(`saved ${file}`);
console.log(`  from ${url}`);
console.log(`\nnow: pnpm check:extractor ${file}`);
console.log(`and: pnpm smoke ${file}`);
