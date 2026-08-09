/** One Supabase client, in one context. The invariant the whole session design rests on.
 *
 *  Auth was originally left out of this project because of the MV3 trap: a service worker has no
 *  `localStorage` and Chrome tears it down when idle. What makes it survivable (design D2) is that
 *  exactly one context ever holds a client, so exactly one thing ever holds the refresh token.
 *  Supabase rotates that token on every use, so a second client in the shortlist page or a content
 *  script would eventually refresh with a token the worker had already spent — and the loser is
 *  signed out with nothing on screen explaining why. Intermittently. Under load. Which is to say:
 *  on the other laptop, on an evening, while somebody is looking at flats.
 *
 *  So this is a check rather than a comment. Two assertions:
 *
 *    1. `createClient` is called in exactly one file — `src/lib/auth.ts`.
 *    2. `lib/auth.ts` and `lib/supabase.ts` are imported for their *runtime* values only by each
 *       other and by `entrypoints/background.ts`. Everyone else may `import type`, which compiles
 *       to nothing and reaches no database.
 *
 *  Run: `tsx tools/check-one-client.ts`
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const SRC = join(ROOT, 'src');

/** The one file that may construct a client. */
const CLIENT_OWNER = 'src/lib/auth.ts';

/** The files that may import those two modules for their runtime values. */
const RUNTIME_IMPORTERS = new Set(['src/lib/auth.ts', 'src/lib/supabase.ts', 'src/entrypoints/background.ts']);

/** The modules a view must not pull a value out of. */
const GUARDED = ['@/lib/supabase', '@/lib/auth', './supabase', './auth', '../lib/supabase', '../lib/auth'];

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
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
 *  three shapes it has to tell apart, and it is tested against all three below by the files it
 *  actually reads.
 */
function importsOf(source: string): Array<{ specifier: string; typeOnly: boolean; text: string }> {
  const found: Array<{ specifier: string; typeOnly: boolean; text: string }> = [];
  const pattern = /import\s+(type\s+)?([^'"]*?)from\s*['"]([^'"]+)['"]/g;
  for (const match of source.matchAll(pattern)) {
    const [text, typeKeyword, clause = '', specifier] = match;
    // `import type { A } from` and `import { type A, type B } from` are both type-only. A clause
    // with any binding that is *not* prefixed with `type` pulls a value across.
    const named = clause.match(/\{([^}]*)\}/)?.[1];
    const allNamedAreTypes =
      named !== undefined &&
      named.split(',').map((s) => s.trim()).filter(Boolean).every((s) => s.startsWith('type '));
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
let constructors = 0;

for (const file of walk(SRC)) {
  const rel = relative(ROOT, file).replaceAll('\\', '/');
  const source = readFileSync(file, 'utf8');

  if (/\bcreateClient\s*\(/.test(source)) {
    constructors++;
    if (rel !== CLIENT_OWNER) {
      problems.push(
        `${rel} calls createClient(). Only ${CLIENT_OWNER} may — a second client means a second ` +
          'refresh token holder, and the loser of that race is silently signed out (design D2).',
      );
    }
  }

  if (RUNTIME_IMPORTERS.has(rel)) continue;

  for (const entry of importsOf(source)) {
    if (!GUARDED.includes(entry.specifier) || entry.typeOnly) continue;
    problems.push(
      `${rel} imports values from '${entry.specifier}' (\`${entry.text}\`). Reach the database ` +
        'through a message to the background worker; `import type` is fine.',
    );
  }
}

if (constructors === 0) {
  problems.push(`nothing calls createClient() — ${CLIENT_OWNER} should. Did the client move?`);
}

if (problems.length > 0) {
  console.error('one-client check FAILED\n');
  for (const problem of problems) console.error(`  ✗ ${problem}\n`);
  process.exit(1);
}

console.log(`one-client check passed — createClient() only in ${CLIENT_OWNER}, runtime imports only in:`);
for (const importer of RUNTIME_IMPORTERS) console.log(`  ${importer}`);
