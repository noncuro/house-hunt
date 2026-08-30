/** What an invite is *now*, which is not always what its status column says.
 *
 *  Nothing ages a pending invite out: a row fourteen days past its `expires_at` still reads
 *  `pending` in the database. The contract derives `expired` when it builds the row, and this
 *  derives it again from the date at render time — the two agree on load, and only this one stays
 *  right on a tab left open across the expiry, which is exactly the tab someone is watching an
 *  invite on.
 *
 *  Two screens show invitations — Project's "Invite someone" and Admin's invite table — and each
 *  worked this out for itself, with the same rule written twice and no way to notice if one of them
 *  were edited. They never disagreed, which is the only reason nothing went wrong: the same invite
 *  would have read as live on one screen and dead on the other. One fact, one renderer.
 *
 *  The words are still each screen's own — Admin draws a chip reading "waiting", Project writes a
 *  sentence with a date in it. What is shared is the state, which is the part that can be wrong. */
import type { Invite } from '@house-hunt/core';

export type InviteState = 'pending' | 'expired' | 'accepted' | 'revoked';

/** `now` is passed rather than read here so that a screen partitioning a list takes one clock
 *  reading for the whole pass — otherwise a row can fall between two filters that each called
 *  `Date.now()` a millisecond apart. */
export function inviteState(invite: Invite, now = Date.now()): InviteState {
  if (invite.status !== 'pending') return invite.status;
  return invite.expired || Date.parse(invite.expiresAt) <= now ? 'expired' : 'pending';
}

/** Still waiting for somebody, and so still holding a place: `project_headcount` counts
 *  `status = 'pending' and expires_at > now()`, which is this and nothing else. */
export function inviteIsLive(invite: Invite, now = Date.now()): boolean {
  return inviteState(invite, now) === 'pending';
}

/** "in 12 days" rather than a date, because a date makes the reader do the arithmetic that decides
 *  whether resending is worth it. */
export function expiryInWords(iso: string, now = Date.now()): string {
  const days = Math.round((Date.parse(iso) - now) / 86_400_000);
  if (days <= 0) return 'today';
  return days === 1 ? 'tomorrow' : `in ${days} days`;
}
