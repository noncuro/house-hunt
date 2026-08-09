/** The invite code: what it is made of, how it is read back, and how it is stored.
 *
 *  A person reads this off a phone screen and types it into a laptop, or reads it down a phone
 *  line. Every decision here follows from that and from nothing else.
 *
 *  Hand-written, like `http.ts` and `caller.ts` — not one of the generated copies of `src/lib/`
 *  that `tools/sync-edge-function.ts` maintains. It lives here rather than in `src/lib/` because
 *  only the server side ever generates or hashes a code: the extension sends the plaintext exactly
 *  as it was typed and never learns what it hashes to.
 */

/** Thirty-one characters: digits 2-9 and A-Z without I, L or O.
 *
 *  The excluded ones are the pairs a human confuses when transcribing — 0/O, 1/I/l — and dropping
 *  a character from the alphabet is the only fix that works, because every other fix is a guess
 *  about what somebody meant. 8 digits and 23 letters. */
export const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

/** Twelve characters, which is about 59 bits.
 *
 *  Long enough that the offline attack on `invite.code_hash` is expensive rather than instant, and
 *  the online one is not worth describing. Short enough to read out loud in three groups of four,
 *  which is the constraint that actually decided it — a code nobody will read out is a code that
 *  gets emailed, and email is the dependency this whole change exists to remove. */
export const CODE_LENGTH = 12;

/** A fresh code, and the only place one is made.
 *
 *  Rejection sampling rather than `byte % 31`: 256 is not a multiple of 31, so the plain modulo
 *  makes the first eight characters of the alphabet about 3% likelier than the rest. That is a
 *  small bias and it is a completely free one to avoid — 248 is 8 x 31, so any byte at or above it
 *  is thrown away and redrawn. */
export function generateCode(): string {
  const limit = 256 - (256 % CODE_ALPHABET.length);
  let code = '';
  while (code.length < CODE_LENGTH) {
    const bytes = crypto.getRandomValues(new Uint8Array(CODE_LENGTH));
    for (const byte of bytes) {
      if (byte >= limit) continue;
      code += CODE_ALPHABET[byte % CODE_ALPHABET.length];
      if (code.length === CODE_LENGTH) break;
    }
  }
  return code;
}

/** How the code is written down for a human: three groups of four, dashed.
 *
 *  Only ever presentation. `normaliseCode` throws the dashes away again, so nothing anywhere
 *  depends on them being there. */
export function formatCode(code: string): string {
  return (code.match(/.{1,4}/g) ?? [code]).join('-');
}

/** What somebody typed -> what it has to be to be a code at all.
 *
 *  Uppercased, and everything outside the alphabet dropped — which handles the dashes, the spaces,
 *  and the trailing space a phone keyboard adds after a paste. It deliberately does NOT rewrite the
 *  excluded characters: a typed `0`, `1`, `I`, `L` or `O` cannot be a misread of a specific
 *  character, because none of them is a character a code contains, so there is nothing to correct
 *  it *to*. Dropping it silently would shift every character after it and turn "you misread one
 *  letter" into "that code does not exist". Returns null instead, and the caller says so.
 */
export function normaliseCode(input: string | undefined): string | null {
  const raw = (input ?? '').toUpperCase().replaceAll(/[\s-]+/g, '');
  if (raw.length !== CODE_LENGTH) return null;
  for (const character of raw) {
    if (!CODE_ALPHABET.includes(character)) return null;
  }
  return raw;
}

/** SHA-256, hex. The stored form of a code, and the only form the database ever sees.
 *
 *  Bare digest and not a KDF on purpose: the input is twelve characters of machine-generated
 *  randomness, which is the one case where stretching adds almost nothing — there is no low-entropy
 *  guess list to slow down. What it buys is that `invite.code_hash` is not a column of working
 *  codes sitting in front of every member of a project, which is what `read_invite` would otherwise
 *  make it. The migration says what it does not buy. */
export async function hashCode(code: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(code));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

/** The caller's address, hashed, for the redemption limiter — or null when the platform gave us
 *  none.
 *
 *  `x-forwarded-for` is a header, and a header is a claim. It is worth counting only because this
 *  function is unreachable except through Supabase's edge, which sets it; if that ever stopped
 *  being true the per-address ceiling would quietly become decorative, and nothing here would
 *  notice. The other two ceilings in `redeem_code` are what still hold in that case. */
export async function callerAddressHash(request: Request): Promise<string | null> {
  const forwarded = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  if (!forwarded) return null;
  return await hashCode(forwarded);
}
