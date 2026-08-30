/** What an invite reads as, and when it stops reading as that. Run with `pnpm check:invite`.
 *
 *  This rule used to be written twice — once in `screens/Project.tsx` and once in
 *  `screens/Admin.tsx` — with nothing comparing them, so the same invite could have read as live on
 *  one screen and dead on the other the moment either copy was edited. It is one function now, and
 *  this is what stops the next edit moving the boundary by accident: every case here is silent when
 *  wrong. An invite shown as waiting confers nothing and offers a Resend button that mints a code
 *  redeeming into nothing; an invite shown as expired holds a place in `project_headcount` that the
 *  screen says is free.
 */
import { expiryInWords, inviteIsLive, inviteState } from '../apps/web/src/lib/invite';
import type { Invite } from '../packages/core/src/contracts';

let failures = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) return console.log(`  ok   ${name}`);
  failures++;
  console.log(`  FAIL ${name}\n       expected ${e}\n       got      ${a}`);
}

const NOW = Date.parse('2026-08-30T12:00:00Z');
const DAY = 86_400_000;

function invite(over: Partial<Invite>): Invite {
  return {
    id: 'i',
    email: 'someone@example.test',
    projectId: 'p',
    projectName: 'a hunt',
    status: 'pending',
    expired: false,
    expiresAt: new Date(NOW + 12 * DAY).toISOString(),
    createdAt: new Date(NOW - DAY).toISOString(),
    acceptedAt: null,
    ...over,
  };
}

console.log('\nwhat state an invite is in');
check('a pending invite with days left is waiting', inviteState(invite({}), NOW), 'pending');
check('and is live', inviteIsLive(invite({}), NOW), true);

/* The whole reason the state is derived rather than read: nothing ages a row out, so `status`
 * stays 'pending' for ever and only the date says otherwise. */
check(
  'a pending row past its date is expired, whatever its status column says',
  inviteState(invite({ expiresAt: new Date(NOW - DAY).toISOString() }), NOW),
  'expired',
);
check('and is not live', inviteIsLive(invite({ expiresAt: new Date(NOW - DAY).toISOString() }), NOW), false);

/* The contract derives `expired` when it builds the row and the screen derives it again from the
 * date; either saying so is enough. A tab left open across the expiry only has the second. */
check(
  "the contract's own expired flag is believed even while the date has not passed",
  inviteState(invite({ expired: true }), NOW),
  'expired',
);

/* Exactly on the boundary. `project_headcount` counts `expires_at > now()`, so the instant it
 * equals now the invite has stopped holding a place — and a screen that still called it pending
 * would show a place taken that the database says is free. */
check(
  'an invite expiring exactly now is expired, not pending',
  inviteState(invite({ expiresAt: new Date(NOW).toISOString() }), NOW),
  'expired',
);
check(
  'a millisecond before, it is still pending',
  inviteState(invite({ expiresAt: new Date(NOW + 1).toISOString() }), NOW),
  'pending',
);

/* An accepted or revoked invite is settled, and its date stops meaning anything. Reading the date
 * first would relabel every old accepted invite as expired, which is the list of people who are
 * already in the hunt. */
check(
  'an accepted invite stays accepted long past its date',
  inviteState(invite({ status: 'accepted', expiresAt: new Date(NOW - 90 * DAY).toISOString() }), NOW),
  'accepted',
);
check(
  'a revoked invite stays revoked, expired flag or not',
  inviteState(invite({ status: 'revoked', expired: true }), NOW),
  'revoked',
);
check('neither is live', [
  inviteIsLive(invite({ status: 'accepted' }), NOW),
  inviteIsLive(invite({ status: 'revoked' }), NOW),
], [false, false]);

console.log('\nhow long it has left, in words');
check('twelve days', expiryInWords(new Date(NOW + 12 * DAY).toISOString(), NOW), 'in 12 days');
check('one day is tomorrow', expiryInWords(new Date(NOW + DAY).toISOString(), NOW), 'tomorrow');
/* Rounded, not floored: eighteen hours is nearer tomorrow than today, and "today" on an invite
 * with most of a day left is the sentence that makes somebody resend one that still works. */
check('eighteen hours is tomorrow', expiryInWords(new Date(NOW + 0.75 * DAY).toISOString(), NOW), 'tomorrow');
check('six hours is today', expiryInWords(new Date(NOW + 0.25 * DAY).toISOString(), NOW), 'today');
check('a date already past is today rather than a negative', expiryInWords(new Date(NOW - 5 * DAY).toISOString(), NOW), 'today');

if (failures > 0) {
  console.error(`\n${failures} failing`);
  process.exit(1);
}
console.log('\nall ok');
