/** Standing a long-running server up from a harness, and being sure it is gone afterwards.
 *
 *  Both of the servers a harness starts — the website under `next start`, and `supabase functions
 *  serve` — are really two processes: the `pnpm` or `supabase` command, and the server it runs.
 *  `child.kill()` signals the first of them, and wherever the wrapper does not pass the signal on,
 *  the server keeps the port after the harness has exited.
 *
 *  Nothing notices, which is the part that costs a morning. The next run's readiness probe asks the
 *  port for an OK and gets one — from the previous run's build, made on another branch or against
 *  another database — so every assertion after it is about a bundle nobody just built. It reaches
 *  the output as a page that sits on "Working…" and never settles, or as ERR_CONNECTION_REFUSED
 *  halfway through when the leftover finally dies, and neither sentence is about a stale server.
 *  It is the same shape as the `supabase functions serve` left over from something else that
 *  `edge-functions.ts` records, arriving by a different door.
 *
 *  So the servers are spawned `detached: true`, which puts each in a process group of its own, and
 *  stopped by signalling the group. The price of the group is that Ctrl-C no longer reaches them
 *  through the terminal, so a harness that detaches has to pass the interrupt on itself — see the
 *  signal handlers in `smoke-web.ts` and `smoke.ts`.
 */
import { spawnSync, type ChildProcess } from 'node:child_process';
import { connect } from 'node:net';

/** The children somebody asked to stop.
 *
 *  A watcher on a dying server has to tell "we ended it" from "it died", and the exit alone cannot:
 *  a tidy shutdown and a container the kernel killed both arrive as a number and a signal. Asking
 *  here instead means the question is answered by intent rather than by guessing from the code. */
const asked = new WeakSet<ChildProcess>();

/** Whether `stopTree` was called on this child — i.e. its death, whenever it comes, is ours. */
/** The port `smoke:web` serves the website on, and the port the smoke extension is built to call.
 *
 *  Here rather than in either file because both need it and they must agree: the extension's API
 *  origin is compiled in, so a build against one port and a server on another is an extension whose
 *  every call is refused with nothing on screen to say why. */
export const WEB_APP_PORT = 3199;

export function wasAskedToStop(child: ChildProcess): boolean {
  return asked.has(child);
}

/** Stop a server and everything it started.
 *
 *  Errors are reported rather than thrown: this runs from a `finally`, and a tidy-up that throws
 *  replaces the harness's own verdict with a complaint about killing something that had already
 *  died — which is the ordinary case when the server crashed on its own. */
export function stopTree(child: ChildProcess | undefined, signal: NodeJS.Signals = 'SIGTERM'): void {
  if (!child?.pid) return;
  asked.add(child);
  try {
    // The negative pid is the group `detached: true` made, so this reaches the wrapper and the
    // server it runs. A plain `child.kill()` would reach only the wrapper.
    process.kill(-child.pid, signal);
  } catch (error) {
    // We did not stop it, so the claim is withdrawn: a watcher that kept it would treat the death
    // this process had already died of as the one we asked for, and swallow the reason. ESRCH is
    // exactly that case — the server crashed on its own, which is news rather than tidy-up.
    asked.delete(child);
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
