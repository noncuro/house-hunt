/** A listing address arriving from outside the app.
 *
 *  Two ways in, and they land in the same place. The share target in the manifest hands us
 *  `?title=&text=&url=` when somebody shares a listing from Rightmove's app or from the browser's
 *  own share sheet; `?add=<url>` is the plain link form, which is what a message thread, a bookmark
 *  or a shortcut can carry.
 *
 *  `text` is checked as well as `url` because Android is inconsistent about which one it fills. Both
 *  Chrome and the Rightmove app frequently send the whole "Look at this — https://…" string as
 *  `text` and no `url` at all, so a share target reading only `url` receives an empty share and
 *  looks broken on exactly the platform it was written for. So the URL is pulled out of the text.
 *
 *  Nothing here decides whether the address is a listing — `rightmoveListingId` does, in one place,
 *  on both sides of the network. This only finds the candidate.
 */

/** The first http(s) URL in a shared string. Shares carry prose around the link ("2 bed flat,
 *  Kentish Town — https://…"), so a whole-string parse finds nothing on the commonest share of all. */
function firstUrlIn(text: string): string | null {
  return /https?:\/\/\S+/.exec(text)?.[0] ?? null;
}

/** The address somebody shared or linked to, or null if this navigation carries none.
 *
 *  An `?add=` with nothing after it is not "none": it is the manifest's own Add-a-flat shortcut,
 *  which opens the dialog with an empty field. So the presence of the parameter is what is tested,
 *  never its truthiness — the empty string is a value here, and `?.trim()` on its own would throw it
 *  away and land somebody who long-pressed the app icon on the shortlist instead. */
export function sharedLink(search: string): string | null {
  const params = new URLSearchParams(search);
  const direct = params.get('add');
  if (direct !== null) return direct.trim();

  const url = params.get('url')?.trim();
  if (url) return url;

  const text = params.get('text')?.trim();
  return text ? firstUrlIn(text) : null;
}

/** The share's own parameters, taken back out of the address bar once they have been read.
 *
 *  A share target is a navigation, so its parameters sit in the URL and survive a reload — which
 *  would re-open the add dialog every time, including after the flat has been added. Reloading a
 *  page must not repeat the action that created it. Returns the search string to keep, `''` when
 *  nothing is left. */
export function withoutSharedLink(search: string): string {
  const params = new URLSearchParams(search);
  for (const key of ['add', 'url', 'text', 'title']) params.delete(key);
  const rest = params.toString();
  return rest ? `?${rest}` : '';
}
