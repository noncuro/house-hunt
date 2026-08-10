import {
  authState,
  consumeInvites,
  forgetActiveProject,
  signIn,
  signOut,
} from '@house-hunt/core/db';
import type { SignInResult } from '@house-hunt/core';

/** What signing in *means* here, as opposed to what `signIn` does.
 *
 *  `signIn` in core hands over a password and gets a session or a named refusal. That is not the
 *  whole of arriving, and the three lines around it are the ones that are easy to lose:
 *
 *  - **Invites are consumed on every sign-in, not only the first.** Somebody who already has an
 *    account is never sent a code — they are simply asked into a second house hunt, and this is the
 *    line that notices. Without it, a newly invited person signs in and lands in no project forever.
 *  - **The remembered active project is forgotten**, because it belongs to whoever was signed in
 *    before, and on a shared laptop that is a different person's house hunt.
 *  - **The resulting state is read in the same breath.** A second round trip from the caller is a
 *    window in which somebody who has just joined a hunt is shown "you are in no house hunt".
 *
 *  This is the extension's `auth:sign-in` handler with the message envelope removed. Once the
 *  extension stops having a sign-in form of its own, this is the only copy. */
export async function beginSession(email: string, password: string): Promise<SignInResult> {
  const result = await signIn(email, password);
  if (result.status !== 'signed-in') return result;
  await consumeInvites();
  forgetActiveProject();
  return { status: 'signed-in', state: await authState() };
}

export async function endSession(): Promise<void> {
  await signOut();
  forgetActiveProject();
}
