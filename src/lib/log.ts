/** A diagnostic log you can actually get at.
 *
 *  Most of this extension's work happens in the background service worker, whose console is
 *  three clicks deep in chrome://extensions and is wiped every time Chrome tears the worker
 *  down. That is how a transient TfL failure ends up looking like a permanent "no route" with
 *  no evidence either way. So every notable call also lands in a capped ring buffer in
 *  chrome.storage.local, which the popup can copy to the clipboard in one click. */

export type LogLevel = 'info' | 'warn' | 'error';

export interface LogEntry {
  at: string;
  level: LogLevel;
  scope: string;
  message: string;
  detail?: unknown;
}

const KEY = 'log';
/** Enough to cover a session of browsing without letting storage grow without bound. */
const LIMIT = 400;

/** Writes are serialised through this: read-modify-write on chrome.storage races badly when a
 *  dozen travel lookups finish at once, and a lost log line is worse than a slow one. */
let queue: Promise<void> = Promise.resolve();

export function log(level: LogLevel, scope: string, message: string, detail?: unknown): void {
  const entry: LogEntry = { at: new Date().toISOString(), level, scope, message, detail };

  const line = `[${scope}] ${message}`;
  if (level === 'error') console.error(line, detail ?? '');
  else if (level === 'warn') console.warn(line, detail ?? '');
  else console.log(line, detail ?? '');

  queue = queue.then(async () => {
    try {
      const stored = ((await chrome.storage.local.get(KEY))[KEY] ?? []) as LogEntry[];
      stored.push(entry);
      await chrome.storage.local.set({ [KEY]: stored.slice(-LIMIT) });
    } catch {
      // Logging must never be the thing that breaks a lookup.
    }
  });
}

export const logInfo = (scope: string, message: string, detail?: unknown) =>
  log('info', scope, message, detail);
export const logWarn = (scope: string, message: string, detail?: unknown) =>
  log('warn', scope, message, detail);
export const logError = (scope: string, message: string, detail?: unknown) =>
  log('error', scope, message, detail);

export async function readLog(): Promise<LogEntry[]> {
  return ((await chrome.storage.local.get(KEY))[KEY] ?? []) as LogEntry[];
}

export async function clearLog(): Promise<void> {
  await chrome.storage.local.remove(KEY);
}

/** Plain text, because the point is pasting it into a chat. */
export function formatLog(entries: LogEntry[]): string {
  return entries
    .map((e) => {
      const detail = e.detail === undefined ? '' : ` ${safeJson(e.detail)}`;
      return `${e.at} ${e.level.toUpperCase().padEnd(5)} [${e.scope}] ${e.message}${detail}`;
    })
    .join('\n');
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
