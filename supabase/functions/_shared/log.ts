// GENERATED — do not edit. Copied from packages/core/src/ by tools/sync-edge-function.ts.
// Edit the original and run `pnpm sync:function`.

/** A diagnostic line, and somewhere for it to go that core does not have to know about.
 *
 *  The extension keeps a ring buffer in `chrome.storage.local` that Settings can copy to the
 *  clipboard, because the other laptop is not one you can attach a debugger to. That is the right
 *  answer there and it is unavailable everywhere else: a browser tab has no `chrome.storage`, and
 *  an Edge Function running this same code under Deno has neither.
 *
 *  So core emits and does not store. Each host registers a sink at start-up — the extension
 *  registers the one that writes to `chrome.storage.local`, the website registers one that writes
 *  to the console, and nothing registered means nothing recorded, which is the correct behaviour
 *  for a test harness. */
export type LogLevel = 'info' | 'warn' | 'error';

export type LogSink = (level: LogLevel, scope: string, message: string, detail?: unknown) => void;

/** Deliberately silent rather than console-logging: core runs inside content scripts on somebody
 *  else's page, and a library that writes to their console uninvited is a library people turn off. */
let sink: LogSink = () => {};

export function setLogSink(next: LogSink): void {
  sink = next;
}

export const logInfo = (scope: string, message: string, detail?: unknown) => sink('info', scope, message, detail);
export const logWarn = (scope: string, message: string, detail?: unknown) => sink('warn', scope, message, detail);
export const logError = (scope: string, message: string, detail?: unknown) => sink('error', scope, message, detail);
