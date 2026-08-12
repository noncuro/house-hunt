/** Serve the Edge Functions with an environment, and wait until they will talk to us.
 *
 *  Needed because travel resolution is server-side: both the panel and the shortlist ask the
 *  `travel` function rather than TfL, and it answers `Access-Control-Allow-Origin` built from
 *  `WEB_APP_ORIGIN`. Without one running, the page sits on "Working…" until the settle timeout —
 *  which reaches the harness output as "the panel never left its loading state", a sentence about
 *  a spinner for what is really a missing process.
 *
 *  **It has to be `functions serve` rather than the runtime `supabase start` already has**, which
 *  was the surprise: that container is built with no environment of its own. `supabase/.env` does
 *  not reach it, and neither does the host's — both were tried. `functions serve --env-file` is the
 *  documented way to give the functions an environment locally, and Kong routes `/functions/v1/*`
 *  to it, so nothing else has to know it happened.
 *
 *  Lifted out of `smoke-web.ts` because it turned out not to be a website concern at all.
 *  `pnpm smoke` needs the same thing and never started it, so it passed only when a server happened
 *  to be running from something else — which is the worst kind of green, since it goes red the
 *  first time somebody runs the harness on a clean machine and the message is about a panel.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { stopTree } from './servers';

/** What `supabase/.env.example` sets WEB_APP_ORIGIN to, and the port `smoke:web` serves on.
 *
 *  Here as well as there because it is the readiness probe's expected answer, and a harness that
 *  probed for the wrong origin would wait ninety seconds and then blame the environment file. */
export const WEB_APP_ORIGIN = 'http://127.0.0.1:3199';

export interface FunctionsOptions {
  /** Where the local stack answers, from `localCredentials()`. */
  supabaseUrl: string;
  /** The browser origin that must come back allowed. Defaults to the one `supabase/.env` grants,
   *  which is what a harness driving no website of its own wants — it is a readiness probe, and
   *  the extension is granted its hosts by the manifest rather than by CORS. `smoke:web` passes
   *  the origin it is really serving on, because there the answer is load-bearing rather than a
   *  probe: a mismatch means the browser discards every reply and nothing says why. */
  origin?: string;
}

export async function startFunctions({
  supabaseUrl,
  origin = WEB_APP_ORIGIN,
}: FunctionsOptions): Promise<ChildProcess> {
  const root = resolve(import.meta.dirname, '..');
  const envFile = resolve(root, 'supabase/.env');
  if (!existsSync(envFile)) {
    throw new Error(
      `no supabase/.env, so the Edge Functions would run with no WEB_APP_ORIGIN and refuse this\n` +
        `harness's origin. Copy the template and try again:\n\n` +
        '    cp supabase/.env.example supabase/.env\n',
    );
  }

  // Two copies fight over the same edge-runtime container and one of them loses: the second `serve`
  // takes it, the first sees it go and exits 1, and whichever harness owned that one reports
  // "supabase functions serve exited (1)" — a sentence about its own child for what is really
  // somebody else's run. Said plainly here instead. Best effort, since a machine without `pgrep`
  // says nothing either way; the assertion that actually protects the run is the origin-matched
  // probe below.
  const others = spawnSync('pgrep', ['-f', 'supabase functions serve'], { encoding: 'utf8' });
  const running = (others.stdout ?? '').split('\n').map((line) => line.trim()).filter(Boolean);
  if (running.length > 0) {
    throw new Error(
      `a \`supabase functions serve\` is already running (pid ${running.join(', ')}).\n` +
        'Two of them take turns holding the edge-runtime container, so this run would fail in a\n' +
        'way that reads as a broken function. Stop the other one and try again.',
    );
  }

  console.log('serving the edge functions');
  const child = spawn('supabase', ['functions', 'serve', '--env-file', 'supabase/.env'], {
    cwd: root,
    stdio: ['ignore', 'ignore', 'pipe'],
    // `supabase` is a wrapper around the process that actually serves, so a signal to it alone
    // leaves the server behind. A group of its own is what lets `stopTree` take both.
    detached: true,
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    if (process.env.SMOKE_LOG === 'all') process.stderr.write(`[functions] ${chunk.toString()}`);
  });

  // Poll the thing we actually depend on — the CORS answer — rather than a readiness line. It is
  // the only signal that distinguishes "serving" from "serving, and will talk to us".
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`supabase functions serve exited (${child.exitCode})`);
    const allowed = await fetch(`${supabaseUrl}/functions/v1/travel`, {
      method: 'OPTIONS',
      // Origin-matched, always. Kong answers OPTIONS 204 by itself when nothing is serving the
      // functions at all, so "did anything reply" is not a readiness signal — it is a green light
      // that stays green with no backend behind it. The allow-origin header comes from the
      // function's own code and from `WEB_APP_ORIGIN`, so it cannot be produced by the gateway.
      headers: { Origin: origin, 'Access-Control-Request-Method': 'POST' },
      signal: AbortSignal.timeout(3_000),
    })
      .then((r) => r.headers.get('access-control-allow-origin'))
      .catch(() => null);

    if (allowed === origin) {
      console.log(`edge functions accept ${origin}`);
      return child;
    }
    await new Promise((r) => setTimeout(r, 1_000));
  }

  stopTree(child);
  throw new Error(
    `the travel function never answered Access-Control-Allow-Origin: ${origin}.\n` +
      `Check that supabase/.env says WEB_APP_ORIGIN=${origin} and that \`supabase start\` is up.`,
  );
}
