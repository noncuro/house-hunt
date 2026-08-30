'use client';

import { useState } from 'react';
import {
  MIN_PASSWORD_LENGTH,
  type AuthState,
  type RedeemResult,
  type SignInResult,
} from '@house-hunt/core';
import { redeemInvite } from '@house-hunt/core/db';
import { beginSession } from '@/lib/session';
import { signInExtension } from '@/lib/bridge';

/** The whole of signing in: an address and a password, and one other door for somebody arriving
 *  with an invite code.
 *
 *  **Why there is no email anywhere in this.** Sign-in used to be a six-digit code that Supabase
 *  emailed on request. Supabase's built-in sender stops at roughly two messages an hour for the
 *  whole project, and the owner met that doing ordinary things: invite somebody, resend once
 *  because it landed in spam, and now nobody can sign in for an hour. The fix was either to run
 *  SMTP — a domain, a provider, a bill and a deliverability problem — or to stop needing email at
 *  all. This is the second. A new person is handed a code by text and chooses their own password;
 *  a returning person types the password they chose. Nothing here sends anything.
 *
 *  **Invite-only survives, and by a shorter argument than before.** `signInWithPassword` cannot
 *  create an account whatever it is sent — there is no `shouldCreateUser` to get wrong. So the form
 *  on the left is incapable of admitting anybody, and the form on the right is gated by a code
 *  checked server-side against the address it was issued to, with the guesses counted.
 *
 *  **Every way this can go wrong is its own state with its own sentence,** which was true of the
 *  old code flow and is more true here: "that code isn't right", "you already have an account, sign
 *  in instead", "your password needs to be longer", and "the address or the password is wrong" all
 *  want different next actions from the reader, and a single "sign-in failed" collapses them into
 *  pressing the button again — the one response that is wrong in every one of them. */
export function SignIn({ onSignedIn }: { onSignedIn: (state: AuthState) => void }) {
  /** Which door. Signing in is the default because it is what happens every day; redeeming happens
   *  once per person, ever. */
  const [mode, setMode] = useState<'sign-in' | 'redeem'>('sign-in');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [outcome, setOutcome] = useState<Outcome>({ kind: 'none' });
  const [busy, setBusy] = useState<'signing-in' | 'redeeming' | null>(null);

  const address = email.trim().toLowerCase();
  const ready = address.length > 0 && password.length > 0 && (mode === 'sign-in' || code.trim().length > 0);

  async function signIn() {
    setBusy('signing-in');
    const reply = await attempt(() => beginSession(address, password));
    if (!reply) return setBusy(null);
    if (reply.status !== 'signed-in') {
      setBusy(null);
      return setOutcome(fromSignIn(reply));
    }
    void handOver();
    setBusy(null);
    onSignedIn(reply.state);
  }

  /** The one moment the extension can be signed in without asking anybody anything: the password is
   *  in a local variable a few lines up, and it is never anywhere else (design D3).
   *
   *  Not awaited, and deliberately not reported when it fails. Signing in here has already succeeded, the shortlist
   *  is about to render, and an extension that is absent or refused is what the "connect it" notice
   *  on that page is for — saying it twice, one of them while the reader is watching a spinner
   *  labelled "signing in", would make an optional half look like a broken one.
   *
   *  Awaiting it was worse than saying it twice. Nothing replies when the extension is not
   *  installed, so the ask ran its full twenty-second timeout with the button still reading
   *  "Signing in…" over a session that had already been minted — which reads as a sign-in that
   *  hung, and is why refreshing "fixed" it. The result is not used, so there is nothing to wait
   *  for. */
  async function handOver() {
    try {
      await signInExtension(address, password);
    } catch {
      // Nothing to do about it here.
    }
  }

  /** Redeem, then sign in with the very password just chosen. Two calls rather than one because
   *  redeeming deliberately does not mint a session — that keeps `consume_invites()` running at
   *  exactly one moment in the system — and doing the second call here rather than making the
   *  person type their password again is the whole of what that costs. */
  async function redeem() {
    setBusy('redeeming');
    const reply = await attempt(() => redeemInvite(address, password, code.trim()));
    if (!reply) return setBusy(null);
    if (reply.status !== 'redeemed') {
      setBusy(null);
      return setOutcome(fromRedeem(reply));
    }
    setBusy('signing-in');
    const session = await attempt(() => beginSession(address, password));
    if (!session) return setBusy(null);
    if (session.status === 'signed-in') {
      void handOver();
      setBusy(null);
      return onSignedIn(session.state);
    }
    setBusy(null);
    // The account was made and then would not let us in, which is not a thing the user did and not
    // a thing retyping fixes. Say what happened rather than showing them the sign-in refusal as if
    // they had mistyped something a moment after typing it correctly.
    setOutcome({ kind: 'redeemed-not-signed-in' });
  }

  const submit = mode === 'sign-in' ? signIn : redeem;

  /** A thrown call is the network being down or the project being unreachable, which the extension
   *  got for free as `reply.ok === false`. Every named refusal below still arrives as a value. */
  async function attempt<T>(work: () => Promise<T>): Promise<T | null> {
    try {
      return await work();
    } catch (e) {
      setOutcome({ kind: 'failed', message: e instanceof Error ? e.message : String(e) });
      return null;
    }
  }

  return (
    <div className="settings signin" data-testid="signed-out">
      <section className="setting">
        <h2>{mode === 'sign-in' ? 'Sign in' : 'Use your invite code'}</h2>
        <p className="dim">
          {mode === 'sign-in' ? (
            <>
              This is invite-only. Sign in with the address you were invited on and the password you
              chose. There is nothing to click in an email — nothing here sends any.
            </>
          ) : (
            <>
              Whoever invited you will have sent you a code by text or read it out. Enter it with
              your address and pick a password — that password is how you sign in from then on.
            </>
          )}
        </p>

        <div className="fields">
          <input
            type="email"
            autoComplete="email"
            value={email}
            placeholder="you@example.com"
            onChange={(e) => {
              setEmail(e.target.value);
              // The banner below describes an address; changing the address makes it a claim about
              // something that is no longer on screen.
              setOutcome({ kind: 'none' });
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && ready) void submit();
            }}
          />
        </div>

        <div className="fields">
          <input
            type="password"
            /** `new-password` in the redeem form so a password manager offers to generate and save
             *  one rather than autofilling an old one into a field that is creating an account. */
            autoComplete={mode === 'sign-in' ? 'current-password' : 'new-password'}
            value={password}
            placeholder={mode === 'sign-in' ? 'Password' : `Choose a password (${MIN_PASSWORD_LENGTH}+ characters)`}
            onChange={(e) => {
              setPassword(e.target.value);
              setOutcome({ kind: 'none' });
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && ready) void submit();
            }}
          />
        </div>

        {mode === 'redeem' && (
          <div className="fields">
            <input
              /** Uppercased as it is typed, because that is how the code was written down and a
               *  lowercase one is the same code. The server uppercases too — this is so the field
               *  agrees with the piece of paper, not so the check passes. */
              value={code}
              placeholder="ABCD-EFGH-JKMN"
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => {
                setCode(e.target.value.toUpperCase());
                setOutcome({ kind: 'none' });
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && ready) void submit();
              }}
            />
          </div>
        )}

        <div className="fields">
          <button className="primary" disabled={busy !== null || !ready} onClick={() => void submit()}>
            {busy === 'redeeming' ? 'Checking…' : busy === 'signing-in' ? 'Signing in…' : 'Sign in'}
          </button>
          <button
            disabled={busy !== null}
            onClick={() => {
              setMode(mode === 'sign-in' ? 'redeem' : 'sign-in');
              // The code belongs to one of the two forms. Left behind it would sit in a field the
              // other form does not show and travel with a submission nobody meant to make.
              setCode('');
              setOutcome({ kind: 'none' });
            }}
          >
            {mode === 'sign-in' ? 'I have an invite code' : 'I already have an account'}
          </button>
        </div>

        <Banner outcome={outcome} onSignIn={() => setMode('sign-in')} />
      </section>
    </div>
  );
}

/** Everything the two exchanges can end in, kept as named states rather than an error string.
 *  `SignInResult` and `RedeemResult` both fold into this because the reader does not care which
 *  call refused — they care what to do next, and "rate-limited" wants the same answer whichever
 *  half of the screen produced it. */
type Outcome =
  | { kind: 'none' }
  | { kind: 'wrong-credentials' }
  | { kind: 'not-confirmed' }
  | { kind: 'no-such-code' }
  | { kind: 'already-registered' }
  | { kind: 'password-too-short'; minimum: number }
  | { kind: 'rate-limited'; message: string }
  | { kind: 'redeemed-not-signed-in' }
  | { kind: 'failed'; message: string };

function fromSignIn(result: Exclude<SignInResult, { status: 'signed-in' }>): Outcome {
  switch (result.status) {
    case 'wrong-credentials':
      return { kind: 'wrong-credentials' };
    case 'not-confirmed':
      return { kind: 'not-confirmed' };
    case 'rate-limited':
      return { kind: 'rate-limited', message: result.message };
    case 'failed':
      return { kind: 'failed', message: result.message };
  }
}

function fromRedeem(result: Exclude<RedeemResult, { status: 'redeemed' }>): Outcome {
  switch (result.status) {
    case 'no-such-code':
      return { kind: 'no-such-code' };
    case 'already-registered':
      return { kind: 'already-registered' };
    case 'password-too-short':
      return { kind: 'password-too-short', minimum: result.minimum };
    case 'rate-limited':
      return {
        kind: 'rate-limited',
        message: `Try again in ${Math.ceil(result.retryAfterSeconds / 60)} minutes.`,
      };
    case 'failed':
      return { kind: 'failed', message: result.message };
  }
}

function Banner({ outcome, onSignIn }: { outcome: Outcome; onSignIn: () => void }) {
  switch (outcome.kind) {
    case 'none':
      return null;

    // Said as both halves, because Supabase answers a wrong password and an address with no account
    // with the same refusal — and it is right to, since telling them apart would make this form an
    // oracle for who has an account. A confident "wrong password" here would be wrong half the time.
    case 'wrong-credentials':
      return (
        <p className="notice notice-bad">
          That address and password do not match an account. Either the password is wrong, or that
          address has never been signed up — if you were invited, use your invite code instead.
        </p>
      );

    // Not the user's fault and not fixable by them, so it names the setting rather than apologising.
    case 'not-confirmed':
      return (
        <p className="notice notice-bad">
          That account is waiting on an email confirmation that will never arrive — nothing here
          sends email. Whoever runs the install needs to turn <strong>Confirm email</strong> off in
          Supabase, under Authentication → Providers → Email.
        </p>
      );

    case 'no-such-code':
      return (
        <p className="notice notice-bad">
          That code isn&rsquo;t right for that address. Check both — a code only works for the
          address it was sent to, and it stops working after fourteen days. Ask whoever invited you
          to send a new one.
        </p>
      );

    case 'already-registered':
      return (
        <p className="notice notice-warn">
          That address already has an account, so there is nothing to redeem —{' '}
          <button className="key" onClick={onSignIn}>
            sign in
          </button>{' '}
          with the password you already chose. Forgotten it? Whoever runs the install can set you a
          new one.
        </p>
      );

    case 'password-too-short':
      return (
        <p className="notice notice-bad">
          Pick a longer password — at least {outcome.minimum} characters. Length is the only rule;
          there is nothing here about symbols or capitals.
        </p>
      );

    // The one state where the correct action is to do nothing. Said plainly, because the reflex is
    // to press the button again and that is what extends the wait.
    case 'rate-limited':
      return (
        <p className="notice notice-warn">
          Too many attempts. Wait a few minutes — trying again now will not work.{' '}
          <span className="dim">{outcome.message}</span>
        </p>
      );

    case 'redeemed-not-signed-in':
      return (
        <p className="notice notice-warn">
          Your account was created, but signing in straight afterwards did not work. Nothing is
          lost: use <strong>I already have an account</strong> with the same address and password.
        </p>
      );

    case 'failed':
      return <p className="notice notice-bad">Sign-in failed — {outcome.message}</p>;
  }
}
