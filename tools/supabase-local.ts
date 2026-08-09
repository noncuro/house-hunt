/** Where the checks that need a real database point, and the refusal to point them anywhere else.
 *
 *  Three harnesses now need Postgres rather than a pure function — `check:rls`, `check:spend` and
 *  the browser smoke tests, which cannot sign anybody in without a service role key to create a
 *  user with. All three want the same two things, so both live here rather than being copied:
 *
 *  1. **Finding the local stack.** `supabase status -o env`, or the three `RLS_*` variables when
 *     the default ports are taken and a scratch copy is standing somewhere else.
 *  2. **Refusing the live one.** These suites create users, write rows and delete them again.
 *     Pointed at the hosted project that is not a failing test, it is somebody's actual house
 *     hunt. The guard is a hostname check and it is not optional.
 *
 *  The `RLS_` prefix is kept even though two of the three readers are not the RLS check: renaming
 *  it would silently ignore whatever you already have exported, and an ignored override reads
 *  exactly like a stack on the wrong port.
 */
import { execFileSync } from 'node:child_process';

export interface LocalCredentials {
  url: string;
  anonKey: string;
  serviceKey: string;
}

/** What to print when there is no stack to talk to. One message, so the three suites give the
 *  same instructions rather than three half-remembered versions of them. */
export const NO_LOCAL_STACK =
  'no local Supabase found. Run `supabase start` in this directory, or set RLS_SUPABASE_URL, ' +
  'RLS_ANON_KEY and RLS_SERVICE_KEY to point at one.';

export function localCredentials(): LocalCredentials {
  const fromEnv = {
    url: process.env.RLS_SUPABASE_URL,
    anonKey: process.env.RLS_ANON_KEY,
    serviceKey: process.env.RLS_SERVICE_KEY,
  };
  const credentials =
    fromEnv.url && fromEnv.anonKey && fromEnv.serviceKey
      ? { url: fromEnv.url, anonKey: fromEnv.anonKey, serviceKey: fromEnv.serviceKey }
      : fromStatus();

  // A live project would be a catastrophe here: these suites create users and delete rows.
  if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(credentials.url)) {
    throw new Error(
      `refusing to run against ${credentials.url} — these checks write and delete, and are local-only`,
    );
  }
  return credentials;
}

function fromStatus(): LocalCredentials {
  // Non-zero exit is not the same as no stack. `supabase status` fails the whole command if any
  // one container is less than healthy — realtime restarting, analytics deliberately off — while
  // still printing the URL and keys, and every one of these suites works perfectly against that.
  // Treating the exit code as the answer produced a loud, confident, wrong "no local Supabase
  // found" in the middle of a run, which is a worse failure than the honest one: it sends you to
  // start a stack that is already up.
  //
  // And it prints NOTHING AT ALL, on either stream, while a container is mid-restart — which the
  // realtime container does regularly and on its own. So the first read of a run would report no
  // stack, at random, on a machine where the stack had been up for an hour. Retrying is the fix,
  // because the condition it is reporting really is temporary: the second or third read has the
  // keys. Nothing here uses realtime — the tables are in the publication and no client subscribes
  // — so a flapping realtime container is genuinely none of these suites' business.
  let raw = '';
  let complaint = '';
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      raw = execFileSync('supabase', ['status', '-o', 'env'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      const failure = error as { stdout?: Buffer | string; stderr?: Buffer | string };
      raw = String(failure.stdout ?? '');
      complaint = String(failure.stderr ?? '').trim();
    }
    if (raw.includes('API_URL')) break;
    if (attempt === 5) break;
    console.log(`  ..    \`supabase status\` gave nothing back; a container is probably restarting (${attempt}/4)`);
    execFileSync('sleep', ['3']);
  }
  if (!raw.trim()) {
    // Say which, when we know. "No local Supabase found" while one is running and merely
    // restarting is the confident wrong answer this whole function exists to avoid.
    throw new Error(complaint ? `${NO_LOCAL_STACK}\n\nWhat the CLI actually said:\n${complaint}` : NO_LOCAL_STACK);
  }

  const env: Record<string, string> = {};
  for (const line of raw.split('\n')) {
    const match = /^([A-Z_]+)="?([^"]*)"?$/.exec(line.trim());
    if (match?.[1] && match[2]) env[match[1]] = match[2];
  }
  const url = env.API_URL;
  const anonKey = env.ANON_KEY;
  const serviceKey = env.SERVICE_ROLE_KEY;
  if (!url || !anonKey || !serviceKey) {
    throw new Error(
      `\`supabase status -o env\` did not report API_URL / ANON_KEY / SERVICE_ROLE_KEY:\n${raw}`,
    );
  }
  return { url, anonKey, serviceKey };
}
