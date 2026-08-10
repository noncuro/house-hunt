/** The boundaries the split rests on, checked rather than trusted.
 *
 *  There used to be one invariant here — one Supabase client, in one context — because there was
 *  one application. Splitting the website out of the extension turns that into four, and every one
 *  of them fails the same way if it is only written down: silently, later, on the other laptop.
 *
 *  **1. One client per process.** Supabase rotates the refresh token on every use, so two clients
 *  in one process eventually refresh with a token the other has already spent, and the loser is
 *  signed out with nothing on screen explaining why. Intermittently. Under load. Which is to say:
 *  on the other laptop, on an evening, while somebody is looking at flats. Each application
 *  constructs exactly one and hands it to core through `configure()`.
 *
 *  Note what this does *not* forbid: the extension and the website each hold their own client and
 *  their own session, deliberately, because they are separate processes. That is design D3 — one
 *  sign-in, two independent refresh-token families — and copying a session between them would
 *  reintroduce the failure above somewhere neither this check nor the runtime can see it.
 *
 *  **2. `packages/core` constructs nothing.** It cannot know whether it is inside a service worker
 *  that needs the `chrome.storage` adapter or a tab where the defaults are right, so a client built
 *  there would be wrong in one of the two places — and wrong quietly, because a session persisted
 *  somewhere it will not be found again looks exactly like being signed out.
 *
 *  **3. `packages/ui` never reaches the database.** A component takes its data as props. An import
 *  of `@house-hunt/core/db` from a component would pull the whole data layer, and
 *  `@supabase/supabase-js` with it, into every content-script bundle that only wanted a rating
 *  colour.
 *
 *  **4. The two applications do not import each other.** `apps/web` reaching into `apps/extension`
 *  would compile — the files are right there — and then fail at runtime on the first `chrome.*`.
 *
 *  Run: `pnpm check:one-client`
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');

/** The one file in each application that may construct a client, and nothing else may. */
const CLIENT_OWNERS = new Set(['apps/extension/src/lib/auth.ts', 'apps/web/src/lib/client.ts']);

/** What a component may not import for its runtime values, in any spelling. */
const DB_SPECIFIERS = ['@house-hunt/core/db', './db', '../db', './db/index', '../db/index'];

interface Import {
  specifier: string;
  typeOnly: boolean;
  text: string;
}

function walk(dir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return []; // apps/web does not exist yet; the check should not fail for that.
  }
  return entries.flatMap((entry) => {
    if (entry === 'node_modules' || entry === '.output' || entry === '.wxt' || entry === '.next') return [];
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return walk(full);
    return /\.tsx?$/.test(entry) ? [full] : [];
  });
}

/** Every import statement in a file, as `{ specifier, typeOnly }`.
 *
 *  Deliberately a regex rather than a parser: this check has to be trivially runnable and it is
 *  matching import *statements*, which are the one construct in TypeScript whose grammar is fixed
 *  at the top of a file. `import type X`, `import { type X }` and a bare `import '...'` are the
 *  three shapes it has to tell apart, and it is tested against all three by the files it reads. */
function importsOf(source: string): Import[] {
  const found: Import[] = [];
  const pattern = /import\s+(type\s+)?([^'"]*?)from\s*['"]([^'"]+)['"]/g;
  for (const match of source.matchAll(pattern)) {
    const [text, typeKeyword, clause = '', specifier] = match;
    // `import type { A } from` and `import { type A, type B } from` are both type-only. A clause
    // with any binding that is *not* prefixed with `type` pulls a value across.
    const named = clause.match(/\{([^}]*)\}/)?.[1];
    const allNamedAreTypes =
      named !== undefined &&
      named
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .every((s) => s.startsWith('type '));
    const hasDefaultOrNamespace = /^\s*[A-Za-z_$*]/.test(clause.replace(/\{[^}]*\}/, '').trim());
    found.push({
      specifier: specifier!,
      typeOnly: Boolean(typeKeyword) || (allNamedAreTypes && !hasDefaultOrNamespace),
      text: text.replace(/\s+/g, ' ').trim(),
    });
  }
  return found;
}

const problems: string[] = [];
const constructors: string[] = [];
const configurers: string[] = [];

for (const dir of ['packages/core', 'packages/ui', 'apps/extension', 'apps/web']) {
  for (const file of walk(join(ROOT, dir))) {
    const rel = relative(ROOT, file).replaceAll('\\', '/');
    const source = readFileSync(file, 'utf8');
    const imports = importsOf(source);

    if (/\bcreateClient\s*\(/.test(source)) {
      constructors.push(rel);
      if (!CLIENT_OWNERS.has(rel)) {
        problems.push(
          `${rel} calls createClient(). Only ${[...CLIENT_OWNERS].join(' or ')} may — a second ` +
            'client in one process means a second refresh-token holder, and the loser of that race ' +
            'is silently signed out (design D2).',
        );
      }
    }

    if (/\bconfigure\s*\(/.test(source) && dir.startsWith('apps/')) configurers.push(rel);

    // 3 — a component takes its data as props.
    if (dir === 'packages/ui') {
      for (const entry of imports) {
        if (DB_SPECIFIERS.includes(entry.specifier) && !entry.typeOnly) {
          problems.push(
            `${rel} imports values from '${entry.specifier}' (\`${entry.text}\`). A component takes ` +
              'its data as props; this pulls the whole data layer, and supabase-js with it, into ' +
              'every bundle that renders it. `import type` is fine.',
          );
        }
        if (entry.specifier.startsWith('@/') || entry.specifier.includes('apps/')) {
          problems.push(
            `${rel} imports '${entry.specifier}', which is an application path. packages/ui is ` +
              'shared by both surfaces and may only reach @house-hunt/core, react, and its own files.',
          );
        }
      }
    }

    // 4 — one application never reaches into the other.
    if (dir.startsWith('apps/')) {
      const other = dir === 'apps/web' ? 'apps/extension' : 'apps/web';
      for (const entry of imports) {
        if (entry.specifier.includes(other)) {
          problems.push(
            `${rel} imports '${entry.specifier}' from ${other}. The two applications share code ` +
              'through packages/, never directly: what compiles here fails at runtime on the first ' +
              'chrome.* call, or the first window.',
          );
        }
      }
    }
  }
}

// 2 — core builds nothing.
for (const owner of constructors) {
  if (owner.startsWith('packages/')) {
    problems.push(
      `${owner} constructs a client. packages/ cannot know whether it is in a service worker that ` +
        'needs the chrome.storage adapter or a tab where the defaults are right, so its guess ' +
        'would be wrong in one of the two — and wrong quietly.',
    );
  }
}

if (constructors.length === 0) {
  problems.push(
    `nothing calls createClient() — one of ${[...CLIENT_OWNERS].join(', ')} should. Did the client move?`,
  );
}

if (configurers.length === 0) {
  problems.push(
    'nothing calls configure(). Core throws rather than constructing a default, so an application ' +
      'that forgets it fails on its first database read rather than at start-up.',
  );
}

if (problems.length > 0) {
  console.error('boundary check FAILED\n');
  for (const problem of problems) console.error(`  ✗ ${problem}\n`);
  process.exit(1);
}

console.log('boundary check passed');
console.log(`  createClient() only in: ${constructors.join(', ')}`);
console.log(`  configure() called from: ${configurers.join(', ')}`);
console.log('  packages/ui reaches no database, and neither application imports the other');
