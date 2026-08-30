/** Every API route is either authenticated or a stated exception, and nothing else.
 *
 *  On Supabase this was the platform's job. `verify_jwt` was on for every function, set in
 *  `config.toml`, and the one exception was a line somebody had written on purpose:
 *  `[functions.password] verify_jwt = false`. A function could not become public by accident,
 *  because becoming public took an edit to a file that had nothing else in it.
 *
 *  Vercel has no such gate. Nothing sits in front of a route handler, so one that forgets to resolve
 *  its caller is open to anyone who finds the URL — and open in the quietest way there is, because
 *  it works. Nothing goes red, nothing looks odd, and the service role is behind it.
 *
 *  So the rule moves here. `authedRoute` in `apps/web/src/server/handler.ts` resolves the caller
 *  before the work runs; `publicRoute` is the exception and takes a sentence saying why. This check
 *  reads every route file back and holds three things:
 *
 *    1. every exported HTTP method is built by one of those two wrappers — not by a bare function,
 *       and not by something that merely looks like them;
 *    2. every `publicRoute` is on the list below, so opening a route is a change to this file and
 *       shows up in a diff as one;
 *    3. every entry on the list is still a public route, because an allowlist nobody prunes is how
 *       the next public route gets waved through.
 *
 *  And one more, from the same family: the service-role key must not be reachable from anything that
 *  ends up in a browser bundle. `apps/web/src/server/` may be imported by routes and by itself, and
 *  by nothing else.
 *
 *  Run: `pnpm check:routes`
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const API = 'apps/web/src/app/api';
const SERVER = 'apps/web/src/server';

/** The routes that deliberately answer without a session, and why. Mirrors what
 *  `[functions.password] verify_jwt = false` said in `supabase/config.toml`: redeeming an invite
 *  code is done by somebody who has no account yet, so requiring one would be a door that can only
 *  be opened from inside.
 *
 *  Empty until a function that needs it moves. Adding to it is the whole point of it existing —
 *  the record of what this deployment exposes to the open internet lives here and nowhere else. */
const PUBLIC_ROUTES = new Map<string, string>();

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

let failures = 0;

function fail(message: string): void {
  failures++;
  console.log(`  FAIL  ${message}`);
}

function ok(message: string): void {
  console.log(`  ok    ${message}`);
}

function walk(dir: string, hit: (path: string) => void): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (e) {
    // A directory that is not there yet is the ordinary case and means there is nothing to check.
    // Any other failure — a permission, a file where a directory was expected, too many open
    // handles — is this check being unable to look, and swallowing it would report "no unauthorised
    // routes" about a tree it never read. That is the one wrong answer a security check can give.
    if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return;
    fail(`cannot read ${relative(ROOT, dir)}: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }
  for (const entry of entries) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, hit);
    else hit(path);
  }
}

// --------------------------------------------------------------------------------------------- //
console.log('every API route says which of the two it is');

const seenPublic = new Map<string, string>();
let routeCount = 0;

walk(resolve(ROOT, API), (path) => {
  if (!path.endsWith('/route.ts') && !path.endsWith('/route.tsx')) return;
  routeCount++;
  const rel = relative(ROOT, path);
  const source = readFileSync(path, 'utf8');

  // Which of the two wrappers this file actually imported from the module that defines them. The
  // names alone prove nothing: a route declaring its own `const authedRoute = (f) => f` satisfies
  // every check below while authenticating nobody, and it would read as the safest file in the
  // directory. Matching the import is what makes the name mean the thing.
  const imported = new Set<string>();
  for (const m of source.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"](@\/server\/handler|\.\.?\/(?:\.\.\/)*server\/handler)['"]/g)) {
    for (const name of m[1]!.split(',')) {
      // `authedRoute as route` binds the local name, which is what the export is written with.
      const local = name.includes(' as ') ? name.split(' as ')[1]! : name;
      imported.add(local.trim());
    }
  }

  const exported = [...source.matchAll(/export\s+const\s+([A-Z]+)\s*=\s*([A-Za-z_$][\w$]*)?\s*\(?/g)]
    .filter((m) => METHODS.includes(m[1]!));

  if (exported.length === 0) {
    fail(`${rel} exports no HTTP method — a route file that handles nothing is either dead or broken`);
    return;
  }

  for (const [, method, builder] of exported) {
    if (builder && (builder === 'authedRoute' || builder === 'publicRoute') && !imported.has(builder)) {
      fail(
        `${rel} exports ${method} built by a local ${builder}, not the one in ${SERVER}/handler.ts — ` +
          'a wrapper that only shares the name checks nothing',
      );
      continue;
    }
    if (builder === 'authedRoute') continue;
    if (builder === 'publicRoute') {
      // The reason is the argument, and it has to be a literal so this can read it. A computed one
      // would type-check and tell nobody anything.
      const why = /publicRoute\(\s*(['"])((?:\\.|(?!\1).)*)\1/.exec(source)?.[2];
      if (!why) {
        fail(`${rel} calls publicRoute without a literal reason`);
        continue;
      }
      seenPublic.set(rel, why);
      continue;
    }
    fail(
      `${rel} exports ${method} built by ${builder ?? 'a bare function'} — ` +
        'every route goes through authedRoute or publicRoute, or nothing checks the caller',
    );
  }
});

if (routeCount === 0) {
  // Not a pass. This check going quiet because the glob stopped matching is exactly how it would
  // fail to notice the first unauthenticated route.
  fail(`no route files under ${API} — this check found nothing to check, which is not the same as passing`);
} else {
  ok(`${routeCount} route file(s) under ${API}`);
}

// --------------------------------------------------------------------------------------------- //
console.log('\nand the open ones are the ones we meant');

for (const [rel, why] of seenPublic) {
  if (PUBLIC_ROUTES.has(rel)) ok(`${rel} is public on purpose: ${why}`);
  else fail(`${rel} is public but is not in PUBLIC_ROUTES in ${relative(ROOT, import.meta.filename)}`);
}
for (const rel of PUBLIC_ROUTES.keys()) {
  if (!seenPublic.has(rel)) {
    fail(`PUBLIC_ROUTES still lists ${rel}, which is no longer a public route — prune it`);
  }
}
if (seenPublic.size === 0 && PUBLIC_ROUTES.size === 0) ok('no route answers without a session');

// --------------------------------------------------------------------------------------------- //
console.log('\nand the service role stays on the server');

let importers = 0;
walk(resolve(ROOT, 'apps/web/src'), (path) => {
  if (!/\.tsx?$/.test(path)) return;
  const rel = relative(ROOT, path);
  if (rel.startsWith(SERVER) || rel.startsWith(API)) return;
  const source = readFileSync(path, 'utf8');
  // Both roads to the same module. `import('@/server/supabase')` carries no `from`, so a static-only
  // pattern reads a dynamic import as absence — and a bundler resolves it into the browser chunk
  // just the same.
  const statically = /from\s+['"](@\/server\/|\.\.?\/server\/)/.test(source);
  const dynamically = /\bimport\s*\(\s*['"](@\/server\/|\.\.?\/server\/)/.test(source);
  if (statically || dynamically) {
    importers++;
    fail(
      `${rel} ${dynamically && !statically ? 'dynamically imports' : 'imports'} from ${SERVER} — ` +
        'that module reads the Supabase secret key',
    );
  }
});
if (importers === 0) ok(`nothing outside ${SERVER} and ${API} imports the service-role layer`);

// --------------------------------------------------------------------------------------------- //
console.log(failures === 0 ? '\nall good' : `\n${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
