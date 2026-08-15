/** The extension build the website currently ships, and how to tell an older one apart.
 *
 *  There is no automatic link between this and the extension: Vercel builds only `apps/web` and
 *  cannot build or read the extension, so the committed download (`public/rightmove-house-hunt.zip`)
 *  and this constant are both refreshed by hand in the same step that runs `pnpm package:web`. Keep
 *  this equal to `apps/extension/package.json`'s `version` — the value WXT writes into the shipped
 *  manifest, which is what an installed extension reports back over the bridge on `hello`.
 *
 *  When they drift, the website tells the reader their extension is out of date. That is the whole
 *  point, so the failure of forgetting to bump this is a false "up to date", never a false alarm —
 *  which is why the comparison below only ever flags an install that is *behind* this, not one ahead
 *  (a dev build loaded unpacked is usually ahead, and must not nag). */
export const EXPECTED_EXTENSION_VERSION = '0.3.0';

/** Is the installed version behind what we ship? `null` (an extension too old to report its version
 *  at all — it predates the `hello` version field) counts as behind. A version equal to or ahead of
 *  ours does not. Compares dot-separated numeric parts; anything unparseable is treated as behind,
 *  because a version string we cannot read is not one we can vouch for. */
export function extensionBehind(installed: string | null | undefined): boolean {
  // No usable version — null, undefined (a build predating the handshake), or empty — counts as
  // behind, and guards the `.split()` below against ever running on a non-string.
  if (!installed) return true;
  const parse = (v: string) => v.split('.').map((p) => Number(p));
  const got = parse(installed);
  const want = parse(EXPECTED_EXTENSION_VERSION);
  if (got.some((n) => !Number.isFinite(n))) return true;
  for (let i = 0; i < Math.max(got.length, want.length); i++) {
    const a = got[i] ?? 0;
    const b = want[i] ?? 0;
    if (a < b) return true;
    if (a > b) return false;
  }
  return false; // equal — up to date
}
