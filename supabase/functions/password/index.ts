/** The two things that need the service role now that sign-in is a password.
 *
 *  `redeem` — somebody who was invited turns their code into an account.
 *  `reset`  — an admin sets somebody's password for them, because they forgot it.
 *
 *  Both are here rather than in two functions because they are the same act from two directions:
 *  writing a password into `auth.users` for a person who cannot write one themselves. Splitting
 *  them would mean two deploys, two entries in `config.toml` and two copies of the password rules,
 *  and the rules are the part that must not drift.
 *
 *  ---------------------------------------------------------------------------------------------
 *  THIS IS THE ONLY UNAUTHENTICATED ENDPOINT IN THIS SYSTEM, AND ONLY HALF OF IT IS.
 *
 *  `redeem` cannot require a caller: the person calling it has no account yet, which is the entire
 *  point. So the platform's `verify_jwt` is off for this function (see `[functions.password]` in
 *  supabase/config.toml and the `--no-verify-jwt` in `pnpm deploy:function`), and every gate is
 *  written out by hand below:
 *
 *    - `redeem` is gated by the invite code, checked with the address it was sent to, through
 *      `redeem_code()` — which rate-limits guessing in the database, because an isolate cannot
 *      count. Read the block above that function in the migration for what that covers and what it
 *      does not.
 *    - `reset` is gated by `requireCaller` plus `isAdmin`, exactly as if the platform had verified
 *      nothing — which it has not. Turning `verify_jwt` off for the *function* is why this check
 *      cannot be left implicit.
 *
 *  A refusal is a stated status wherever the product has a story for it (`no-such-code`,
 *  `already-registered`, `rate-limited`), and an HTTP error where the caller got something wrong.
 *  That is the convention in `_shared/http.ts` and it matters most here: "something went wrong"
 *  gets the same code typed in again, which is precisely what the limiter counts.
 *  ---------------------------------------------------------------------------------------------
 *
 *  Deploy:
 *    supabase functions deploy password --project-ref <ref> --no-verify-jwt
 */
import { requireCaller } from '../_shared/caller.ts';
import { callerAddressHash, hashCode, normaliseCode } from '../_shared/code.ts';
import { body, HttpError, requireEnv, rpc, SERVICE_KEY, serve, SUPABASE_URL } from '../_shared/http.ts';

/** Ten characters. Kept in step with `MIN_PASSWORD_LENGTH` in `src/lib/auth.ts` by hand — the
 *  extension cannot import from a Deno function and this function cannot import from the bundle,
 *  and the two checks are not redundant: the client one is so a person is told before they submit,
 *  and this one is the one that is actually enforced. If you change one, change the other. */
const MIN_PASSWORD_LENGTH = 10;

interface Request_ {
  action?: 'redeem' | 'reset';
  email?: string;
  password?: string;
  code?: string;
  userId?: string;
}

serve(async (request) => {
  requireEnv({ SUPABASE_URL, SERVICE_KEY });

  const input = await body<Request_>(request);
  switch (input.action) {
    case 'redeem':
      return await redeem(request, input);
    case 'reset':
      return await reset(request, input);
    default:
      throw new HttpError(400, 'bad-request', 'action must be "redeem" or "reset"');
  }
});

// ------------------------------------------------------------------------------------------------
// Redeeming an invite.
// ------------------------------------------------------------------------------------------------

type Redeemed =
  | { status: 'redeemed'; email: string }
  | { status: 'no-such-code' }
  | { status: 'already-registered'; email: string }
  | { status: 'rate-limited'; retryAfterSeconds: number };

async function redeem(request: Request, input: Request_): Promise<Redeemed> {
  const email = normalise(input.email);
  const password = requirePassword(input.password);
  const code = normaliseCode(input.code);

  // A malformed code is refused before the database is asked anything, and — importantly — without
  // spending one of the caller's ten attempts. It is not a guess at a code; it is not a code.
  if (!code) return { status: 'no-such-code' };

  const outcome = await rpc<{ status: string; retry_after_seconds?: number }>('redeem_code', {
    p_email: email,
    p_code_hash: await hashCode(code),
    p_ip_hash: await callerAddressHash(request),
  });

  if (outcome.status === 'rate-limited') {
    return { status: 'rate-limited', retryAfterSeconds: outcome.retry_after_seconds ?? 3600 };
  }
  if (outcome.status !== 'ok') return { status: 'no-such-code' };

  // `email_confirm: true` because the invite *is* the proof: somebody who could reach this person
  // out of band vouched for the address, and there is nothing in this system that ever sends mail
  // to it. Left unconfirmed the account would exist and be unable to sign in, which is the worst of
  // both — and the hosted project must have "Confirm email" off for the same reason (SETUP.md).
  const created = await createUser(email, password);
  if (created === 'exists') return { status: 'already-registered', email };

  // Membership is NOT granted here. `consume_invites()` runs on first successful sign-in and is the
  // only thing that turns an invite into membership; the extension signs in immediately after this
  // returns, on exactly the path an existing user takes. One path, one invariant.
  console.log(`redeemed an invite for ${email}`);
  return { status: 'redeemed', email };
}

async function createUser(email: string, password: string): Promise<'created' | 'exists'> {
  const response = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
    method: 'POST',
    headers: {
      apikey: SERVICE_KEY!,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ email, password, email_confirm: true }),
  });
  if (response.ok) return 'created';

  const text = await response.text();
  // Already registered. Not an error and not a way in: this path does not touch the password of an
  // account that already exists, because a code plus an address would then be a password reset for
  // somebody else's account. They sign in with what they have, or an admin resets it for them.
  if (response.status === 422 && /already been registered|email_exists/i.test(text)) return 'exists';
  throw new Error(`admin createUser: ${response.status} ${text.slice(0, 300)}`);
}

// ------------------------------------------------------------------------------------------------
// An admin setting somebody's password.
//
// There is no self-service reset, because a reset link is an email and email is the dependency this
// change removed. The replacement is a person: whoever runs the install sets a new password in the
// Admin view and tells the user what it is, the same way they told them their invite code.
// ------------------------------------------------------------------------------------------------

async function reset(request: Request, input: Request_): Promise<{ status: 'reset'; userId: string }> {
  const caller = await requireCaller(request);
  if (!caller.isAdmin) {
    throw new HttpError(403, 'not-allowed', "only an admin can set somebody else's password");
  }

  const userId = (input.userId ?? '').trim();
  if (!/^[0-9a-f-]{36}$/i.test(userId)) {
    throw new HttpError(400, 'bad-request', 'a user id is required');
  }
  const password = requirePassword(input.password);

  const response = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${userId}`, {
    method: 'PUT',
    headers: {
      apikey: SERVICE_KEY!,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ password }),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`admin updateUser: ${response.status} ${text.slice(0, 300)}`);
  }

  // The id and never the password. Function logs are readable by anyone with dashboard access, and
  // a password in a log is a password in a place nobody thinks to look for one.
  console.log(`${caller.email} set the password for ${userId}`);
  return { status: 'reset', userId };
}

// ------------------------------------------------------------------------------------------------

/** `create_invite` checks the address too. This is the same check written where it can be a 400
 *  with a sentence in it rather than a 500 with a stack behind it. */
function normalise(email: string | undefined): string {
  const trimmed = (email ?? '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
    throw new HttpError(400, 'bad-request', 'a valid email address is required');
  }
  return trimmed;
}

/** The password rule, in the one place it is enforced.
 *
 *  The message says the length and nothing else — no "must contain a symbol", because there is no
 *  such rule here, and a refusal that describes a rule the system does not have is how somebody
 *  ends up choosing a worse password than the one they started with. */
function requirePassword(password: string | undefined): string {
  const value = password ?? '';
  if (value.length < MIN_PASSWORD_LENGTH) {
    throw new HttpError(
      400,
      'password-too-short',
      `a password of at least ${MIN_PASSWORD_LENGTH} characters is required`,
    );
  }
  return value;
}
