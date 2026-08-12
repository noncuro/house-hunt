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
import { stopTree, wasAskedToStop } from './servers';

/** What `supabase/.env.example` sets WEB_APP_ORIGIN to, and the port `smoke:web` serves on.
 *
 *  Here as well as there because it is the readiness probe's expected answer, and a harness that
 *  probed for the wrong origin would wait ninety seconds and then blame the environment file. */
export const WEB_APP_ORIGIN = 'http://127.0.0.1:3199';

/** What supabase-js puts on its requests, from its own `@supabase/supabase-js/cors` module. Copied
 *  rather than imported because the functions run on Deno and this runs on Node, and because the
 *  point is to notice when the two lists drift apart. */
const SDK_HEADERS = ['content-type', 'authorization', 'apikey', 'x-client-info', 'x-retry-count'];

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
  // Before the readiness poll below, not after it: dying during startup is the likeliest moment of
  // all, and a watcher attached later misses it — Node does not replay the event it was not there
  // for, so the run would fall back to reporting the wrapper's own exit code, which is the sentence
  // this exists to replace.
  watchForDeath(child);

  // A machine with no `supabase` on its PATH never runs the command at all, and a `ChildProcess`
  // with nobody listening for `error` takes the whole harness down with an unhandled event —
  // ninety seconds of polling followed by a stack trace, for the one failure with a one-line fix.
  let spawnFailure: Error | null = null;
  child.once('error', (error) => {
    spawnFailure = error;
  });

  // Poll the thing we actually depend on — the CORS answer — rather than a readiness line. It is
  // the only signal that distinguishes "serving" from "serving, and will talk to us".
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (spawnFailure !== null) {
      throw new Error(
        `could not run \`supabase functions serve\`: ${(spawnFailure as Error).message}\n` +
          'Install the Supabase CLI, or put it on PATH.',
      );
    }
    if (child.exitCode !== null) throw new Error(`supabase functions serve exited (${child.exitCode})`);
    const allowed = await fetch(`${supabaseUrl}/functions/v1/travel`, {
      method: 'OPTIONS',
      // Origin-matched, always. Kong answers OPTIONS 204 by itself when nothing is serving the
      // functions at all, so "did anything reply" is not a readiness signal — it is a green light
      // that stays green with no backend behind it. The allow-origin header comes from the
      // function's own code and from `WEB_APP_ORIGIN`, so it cannot be produced by the gateway.
      headers: {
        Origin: origin,
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': SDK_HEADERS.join(', '),
      },
      signal: AbortSignal.timeout(3_000),
    })
      .then((r) => ({
        origin: r.headers.get('access-control-allow-origin'),
        headers: r.headers.get('access-control-allow-headers'),
      }))
      .catch(() => null);

    if (allowed?.origin === origin) {
      // The origin was never the whole question. A browser refuses the entire preflight over one
      // unlisted *header*, and supabase-js sends `x-client-info` on every single request — so a
      // function that allows the right origin and forgets that header refuses every call, and says
      // so in a sentence about CORS that sends you looking at origins. That shipped to production
      // and broke every travel lookup on the deployed site, while this probe went green.
      const permitted = (allowed.headers ?? '').toLowerCase();
      const missing = SDK_HEADERS.filter((h) => !permitted.includes(h));
      if (missing.length > 0) {
        // `stopTree` rather than `child.kill`, which reaches the wrapper and leaves the server it
        // started holding the container for the next run to trip over.
        stopTree(child);
        throw new Error(
          `the functions allow ${origin} but not the headers supabase-js sends: ` +
            `${missing.join(', ')} missing from "${allowed.headers}".\n` +
            'Every call from a browser will be refused at the preflight. See `cors()` in ' +
            'supabase/functions/_shared/http.ts.',
        );
      }
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

/** The container telling us it has gone, which is the line that matters and the one nobody sees:
 *  `supabase` is a wrapper and reports 1 whatever happened underneath, so its own exit code names
 *  nothing. 137 is SIGKILL, and on this container that is nearly always the kernel taking it for
 *  memory. */
const CONTAINER_DIED = /\berror running container: exit (\d+)/;

/** Say it out loud when the functions container dies mid-run.
 *
 *  Everything downstream of the death is a 502 from Kong, which the caller reports as whatever it
 *  happened to be asking for at the time — "inviting someone: HTTP 502" for a run that got nowhere
 *  near a problem with invites. The one that cost an afternoon was the container being killed for
 *  memory because Docker had 1.87 GiB and a second project's Supabase stack was also up.
 *
 *  Announced from the stderr line rather than from the child's exit, which is what this did first
 *  and which stayed silent on exactly the run that needed it: the container goes, the next call
 *  502s, the harness throws, and its `finally` stops the wrapper before Node has delivered the
 *  wrapper's own `close` — so the death arrives looking like the tidy shutdown we asked for. The
 *  container says so itself, at the moment it happens, and that is not a race. */
function watchForDeath(child: ChildProcess): void {
  const lastWords: string[] = [];
  let pending = '';
  let announced = false;

  const remember = (lines: string[]): void => {
    for (const line of lines) {
      if (line.trim().length === 0) continue;
      lastWords.push(line);
      if (lastWords.length > 5) lastWords.shift();
      const died = CONTAINER_DIED.exec(line)?.[1];
      if (died !== undefined && !announced) {
        announced = true;
        report(`the edge functions' container died mid-run (exit ${died})`, lastWords, died);
      }
    }
  };

  // Kept as well as streamed, because the interesting lines are the last few before it dies and
  // they are otherwise only visible under SMOKE_LOG=all — which nobody has set on the run that
  // failed.
  child.stderr?.on('data', (chunk: Buffer) => {
    const text = chunk.toString();
    if (process.env.SMOKE_LOG === 'all') process.stderr.write(`[functions] ${text}`);
    // A `data` event is an arbitrary slice of the stream rather than a line, so the sentence naming
    // the cause can arrive in two halves. Held over to the next event instead of counted as two of
    // the five kept, which is how a fragment ends up evicting the line worth printing.
    const lines = (pending + text).split(/\r?\n/);
    pending = lines.pop() ?? '';
    remember(lines);
  });

  // The wrapper going without the container having said why — a `supabase` that failed to start one
  // at all, or was killed itself. `close` rather than `exit`, because stderr can still be draining
  // and what it was draining is the whole point of this.
  child.once('close', (code, signal) => {
    if (pending.trim().length > 0) remember([pending]);
    // A harness that finished and stopped its own server is the ordinary case. Asked rather than
    // inferred from the signal, because a tidy shutdown and a kill are both just a signal here.
    // `pid` is undefined when the command never ran at all — the caller throws a sentence naming the
    // binary for that, and "died mid-run (exit -2)" above it is noise about a run that never began.
    if (announced || child.pid === undefined || wasAskedToStop(child)) return;
    report(`the edge functions died mid-run (${signal ?? `exit ${code}`})`, lastWords, null);
  });
}

function report(what: string, lastWords: string[], containerExit: string | null): void {
  console.error(`\n${what}. Everything after this point fails as an HTTP 502 about whatever it was asking for.`);
  for (const line of lastWords) console.error(`  [functions] ${line}`);
  if (containerExit === '137') {
    console.error(
      '\n137 is SIGKILL, which here is nearly always the kernel taking it for memory. Check\n' +
        "`docker info | grep Memory` and `docker ps` — another project's `supabase start` left\n" +
        'up is enough to do it.',
    );
  }
}
