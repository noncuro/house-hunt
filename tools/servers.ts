/** Standing a long-running server up from a harness, and being sure it is gone afterwards.
 *
 *  The website a harness starts under `next start` is really two processes — the `pnpm` command and
 *  the server it runs — and `child.kill()` signals only the first. Wherever the wrapper does not
 *  pass the signal on, the server keeps the port after the harness has exited.
 *
 *  Nothing notices, which is the part that costs a morning. The next run's readiness probe asks the
 *  port for an OK and gets one — from the previous run's build, made on another branch or against
 *  another database — so every assertion after it is about a bundle nobody just built. It reaches
 *  the output as a page that sits on "Working…" and never settles, or as ERR_CONNECTION_REFUSED
 *  halfway through when the leftover finally dies, and neither sentence is about a stale server.
 *  The same trap caught `pnpm smoke` from the other side while the Edge Functions existed: it
 *  passed only when a `supabase functions serve` left over from something else happened to be
 *  answering. That server is gone; this one is the one left to get wrong.
 *
 *  So the servers are spawned `detached: true`, which puts each in a process group of its own, and
 *  stopped by signalling the group. The price of the group is that Ctrl-C no longer reaches them
 *  through the terminal, so a harness that detaches has to pass the interrupt on itself — see the
 *  signal handlers in `smoke-web.ts` and `smoke.ts`.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import { connect } from 'node:net';

/** The port the website is served on, and the port the smoke extension is built to call.
 *
 *  Here rather than in either file because both need it and they must agree: the extension's API
 *  origin is compiled in, so a build against one port and a server on another is an extension whose
 *  every call is refused with nothing on screen to say why. */
export const WEB_APP_PORT = 3199;

/** Stop a server and everything it started.
 *
 *  Errors are reported rather than thrown: this runs from a `finally`, and a tidy-up that throws
 *  replaces the harness's own verdict with a complaint about killing something that had already
 *  died — which is the ordinary case when the server crashed on its own. */
export function stopTree(child: ChildProcess | undefined, signal: NodeJS.Signals = 'SIGTERM'): void {
  if (!child?.pid) return;
  try {
    // The negative pid is the group `detached: true` made, so this reaches the wrapper and the
    // server it runs. A plain `child.kill()` would reach only the wrapper.
    process.kill(-child.pid, signal);
  } catch (error) {
    // ESRCH is the ordinary case: the server crashed on its own before we got here, which is news
    // rather than tidy-up, and the harness's own verdict is the thing that should say so.
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
      console.error(`could not stop the process group of pid ${child.pid}: ${String(error)}`);
    }
  }
}

/** Refuse to run when somebody else holds the port.
 *
 *  Taking whatever answers is how `pnpm smoke` came to pass only when a `supabase functions serve`
 *  left over from something else happened to be running. The same trap is worse here, because a
 *  website on the right port answers every request perfectly well while being the wrong build, so
 *  the run is green about code that is not on this branch.
 *
 *  Asked by dialling the port rather than by reading `lsof`, so the answer is the kernel's and does
 *  not depend on a tool being installed; `lsof` is then asked who it is, and the message survives it
 *  being absent. Nothing is killed here on purpose — the process may well be somebody's `pnpm
 *  dev:web`, and a harness that reaps strangers is worse than one that stops. */
export async function demandFreePort(port: number, what: string): Promise<void> {
  if (!(await inUse(port))) return;

  const found = spawnSync('lsof', ['-ti', `tcp:${port}`], { encoding: 'utf8' });
  const holders = (found.stdout ?? '').split('\n').map((line) => line.trim()).filter(Boolean);

  throw new Error(
    `something is already listening on ${port}, so ${what} cannot start there.\n` +
      (holders.length > 0 ? `Held by pid ${holders.join(', ')}.\n` : '') +
      '\nMost likely a previous run of this harness that did not stop its server, or a `pnpm\n' +
      'dev:web` on the wrong port. Running against it would test whatever that server was built\n' +
      'from, which is why this stops instead. Clear it with:\n\n' +
      `    lsof -ti :${port} | xargs kill\n`,
  );
}

/** Asked by connecting, not by binding.
 *
 *  The binding version of this missed the case it exists for. Node sets `SO_REUSEADDR` on every
 *  server it makes, and on macOS that lets a bind to `127.0.0.1` succeed while another process
 *  holds the same port on `0.0.0.0` — which is how `next start` and most other servers bind. So the
 *  probe reported the port free, the harness started its own server behind the leftover one, and
 *  the guard was green in exactly the situation it was written to refuse. Verified by holding 3199
 *  with `python3 -m http.server` and watching `smoke:web` walk straight past it into the stale
 *  server's pages.
 *
 *  A connection has no such ambiguity: something either accepts on that port or nothing does. */
function inUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = connect({ port, host: '127.0.0.1' });
    const settle = (answer: boolean) => {
      probe.destroy();
      resolve(answer);
    };
    probe.once('connect', () => settle(true));
    probe.once('error', () => settle(false));
    // A port nobody is listening on refuses at once on loopback. A timeout here means something
    // stranger than a leftover server, and treating that as "free" would put us back to attaching
    // to it — so it counts as held.
    probe.setTimeout(2_000, () => settle(true));
  });
}

/** The website under `next start`, which is what a harness needs now that the functions this app
 *  runs server-side are its own routes. `smoke:web` drives the site; `smoke` drives the extension
 *  against a real listing, and the panel asks `/api/travel` for its station walks the moment it
 *  renders — so both need this and neither may assume the other started it.
 *
 *  A production build rather than `next dev`, for the reason `smoke:web` already documented: the app
 *  ships a CSP with no `unsafe-eval` and React's development build needs `eval()`, so under
 *  `next dev` the bundle dies on load and the page renders nothing. */
export async function startWebApp(credentials: {
  url: string;
  anonKey: string;
  serviceKey: string;
}): Promise<ChildProcess> {
  const { url: supabaseUrl, anonKey, serviceKey } = credentials;
  const PORT = WEB_APP_PORT;
  const ORIGIN = `http://127.0.0.1:${PORT}`;
  // Before the build rather than after it, so a port somebody else holds costs a second instead of
  // a minute — and so nothing is built for a server that is not going to be started.
  await demandFreePort(PORT, 'the website under test');

  const cwd = resolve(import.meta.dirname, '..');
  const env = {
    ...process.env,
    NEXT_PUBLIC_SUPABASE_URL: supabaseUrl,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: anonKey,
    // The local stack's service role, because the routes need one and this is the deployment they
    // are running as. `invite` and `password` are routes now and `checkJoining` drives both, so
    // without this the joining section fails as a 500 saying the key is missing — which is the
    // route's own sentence, correct, and one step away from a harness that simply did not set it.
    // Read at request time rather than baked into the bundle, so `next start` gets it here rather
    // than the build above.
    SUPABASE_SECRET_KEY: serviceKey,
  };
  // Note: this writes the ordinary `apps/web/.next`, so it replaces whatever `pnpm dev:web` last
  // built — with a bundle pointed at the *local* stack. Harmless (the next `dev:web` rebuilds from
  // the root `.env`) but worth knowing if a dev server is running while this does.

  console.log(`building the website against ${supabaseUrl} (this takes a minute)`);
  const built = spawn('pnpm', ['--filter', '@house-hunt/web', 'exec', 'next', 'build'], {
    cwd,
    env,
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  const code = await new Promise<number>((done) => built.on('exit', (c) => done(c ?? 1)));
  if (code !== 0) throw new Error(`next build failed with code ${code} — the harness cannot run`);

  console.log(`starting the website on ${ORIGIN}`);
  const child = spawn('pnpm', ['--filter', '@house-hunt/web', 'exec', 'next', 'start', '-p', String(PORT)], {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    // In a process group of its own, so `stopTree` can take the `next start` underneath pnpm with
    // it. Signalling pnpm alone leaves the server holding the port, and the run after this one
    // then asserts against it — see `tools/servers.ts`.
    detached: true,
  });

  child.stderr?.on('data', (chunk: Buffer) => {
    const text = chunk.toString();
    if (/Error|error:/.test(text)) process.stderr.write(`[next] ${text}`);
  });

  // Poll rather than parse the banner: the "ready" line has moved between Next versions, and a
  // harness that waits for a string it no longer prints hangs for its whole timeout with the
  // server up and healthy behind it.
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`next dev exited with code ${child.exitCode}`);
    try {
      const response = await fetch(ORIGIN, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) {
        console.log('website is up');
        return child;
      }
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 1_000));
  }
  // The caller never got a handle on this one, so its `finally` cannot stop it and this is the only
  // place that can.
  stopTree(child);
  throw new Error(`the website did not come up on ${ORIGIN} within 120s`);
}
