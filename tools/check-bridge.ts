import { BRIDGE, isBridgeRequest, isBridgeResponse } from '../packages/core/src/bridge';

/** The two guards that stand between the extension and every other `postMessage` on the website.
 *
 *  Worth a check of its own because of what they are load-bearing for. A page fires a great many
 *  messages nobody wrote — React DevTools, Next's own dev channel, any embedded frame — and the
 *  bridge's listener has to ignore all of them without ever mistaking one for a `sign-in`. The
 *  origin and `event.source` checks around these cannot be exercised outside a browser; these can,
 *  and they are the half that has to reject rather than merely not match.
 *
 *  The failures below are the shapes that actually turn up: a bare string, a message with the right
 *  `source` and nothing else, and — the one worth naming — a *response* arriving where a request is
 *  expected. The two envelopes differ only in whether they carry `ask` or `reply`, so a guard that
 *  checked `source` and `id` alone would have the content script answering its own answers. */
let failures = 0;

function ok(what: string) {
  console.log(`  ok   ${what}`);
}

function fail(what: string, why: string) {
  failures += 1;
  console.log(`  FAIL ${what}\n       ${why}`);
}

function accepts(what: string, value: unknown, guard: (v: unknown) => boolean) {
  if (guard(value)) ok(what);
  else fail(what, 'the guard rejected something well-formed');
}

function rejects(what: string, value: unknown, guard: (v: unknown) => boolean) {
  if (guard(value)) fail(what, 'the guard accepted it');
  else ok(what);
}

const request = { source: BRIDGE, id: 'a', ask: { kind: 'hello' } };
const response = { source: BRIDGE, id: 'a', reply: { kind: 'hello', signedIn: false, email: null } };

console.log('a request is recognised, and nothing else is');
accepts('a well-formed request', request, isBridgeRequest);
// The fourth message rides the same envelope — the guards check shape, not `ask.kind`, so a new
// kind must pass them unchanged. Named here so the contract and its guard stay visibly in step.
accepts('an open-tab request', { source: BRIDGE, id: 'b', ask: { kind: 'open-tab', url: 'https://www.rightmove.co.uk/properties/1' } }, isBridgeRequest);
rejects('a response is not a request', response, isBridgeRequest);
rejects('another extension’s message', { source: 'something-else', id: 'a', ask: {} }, isBridgeRequest);
rejects('no source at all', { id: 'a', ask: { kind: 'hello' } }, isBridgeRequest);
rejects('an id that is not a string', { source: BRIDGE, id: 7, ask: {} }, isBridgeRequest);
rejects('an ask that is not an object', { source: BRIDGE, id: 'a', ask: 'hello' }, isBridgeRequest);
rejects('a null ask', { source: BRIDGE, id: 'a', ask: null }, isBridgeRequest);
rejects('a bare string', 'hello', isBridgeRequest);
rejects('null', null, isBridgeRequest);
rejects('undefined', undefined, isBridgeRequest);

console.log('and the same in the other direction');
accepts('a well-formed response', response, isBridgeResponse);
rejects('a request is not a response', request, isBridgeResponse);
rejects('no reply', { source: BRIDGE, id: 'a' }, isBridgeResponse);
rejects('a reply that is not an object', { source: BRIDGE, id: 'a', reply: 3 }, isBridgeResponse);

console.log(failures === 0 ? '\nall ok' : `\n${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
