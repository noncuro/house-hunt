import type { Listing } from '../types';

/** Every site this app can read a listing from.
 *
 *  `rightmove` is not one of a set of equals and the rest of the code should not pretend it is:
 *  it is the only one that gets swept, the only one whose ids are bare, and the only one whose
 *  page the extension has ever had to read in the MAIN world. The others are additive. */
export const SITE_IDS = [
  'rightmove',
  'foxtons',
  'savills',
  'chestertons',
  'dexters',
  'johndwood',
  'portico',
  'austinhomes',
  'tkinternational',
] as const;

export type SiteId = (typeof SITE_IDS)[number];

/** Whether a value read back out of the database names a site. A column, unlike a literal, can
 *  hold anything — and a row written by a newer client than this one can name a site this build
 *  has never heard of, which reads as "not one of ours" rather than as a crash. */
export function isSiteId(v: unknown): v is SiteId {
  return typeof v === 'string' && (SITE_IDS as readonly string[]).includes(v);
}

/** How the app reads one letting-agent website.
 *
 *  Every method takes HTML as a **string** and never a `Document`. That is the whole constraint
 *  that keeps a site addable from a phone: `app/api/listing` calls these on `await response.text()`
 *  server-side, which is the only way a flat gets added without the extension, and a `Document`
 *  parameter would quietly make a site extension-only. `packages/core/src/listing.ts` brace-matches
 *  a string for exactly this reason and every adapter here follows it. */
export interface Site {
  id: SiteId;
  /** As a person would name the agent. Shown wherever a flat says where it came from. */
  name: string;
  /** The hostnames it serves listings on, without a scheme. Drives URL matching here, the
   *  extension's content-script matches, and its `host_permissions`, so a host missing from this
   *  list is a site that silently never loads its panel. */
  hosts: string[];
  /** This site's own id for the listing at `url`, or null when the URL is not one of its listing
   *  pages. Never throws: "not a listing here" is an answer every caller has to handle, because
   *  every URL is offered to every site in turn. */
  listingId(url: string): string | null;
  /** A canonical listing URL, rebuilt from an id.
   *
   *  Rebuilt rather than passed through, and that is a security property rather than a tidiness
   *  one: `app/api/listing` fetches whatever this returns, so a caller who sends a doctored URL
   *  must not be able to point the server's fetch at another host. Same rule Rightmove's side has
   *  always had — see `sweep.ts`. */
  listingUrl(id: string): string;
  /** Decode a saved listing page.
   *
   *  Throws `ListingWithdrawn` when the page is the site's own "this has gone" answer, and a plain
   *  `Error` when it cannot be read at all. Those are different facts with different consequences
   *  — one is about the flat and one is about us — and collapsing them is how a site that changed
   *  its markup gets reported as a hundred flats coming off the market in one evening. */
  extract(html: string, url: string): Listing;
}

/** The separator between a site and its own id in a property key.
 *
 *  An underscore, and the reason is narrow: the key is written into a DOM id (`#card-<key>`) and
 *  then selected with `querySelector`, so it has to survive being a CSS identifier. A colon does
 *  not — `#card-foxtons:chpk123` parses as a pseudo-class and matches nothing, with no error. A
 *  hyphen would be ambiguous against the many ids that contain one. No site id contains an
 *  underscore, so splitting on the first one is unambiguous. */
const SEPARATOR = '_';

/** What a site's own id may be made of.
 *
 *  Narrow on purpose, and enforced at both ends — `propertyKey` throws on anything else and
 *  `parseKey` refuses to read it back. Two things downstream depend on it and neither would fail
 *  loudly: the key is interpolated into PostgREST filter strings on the `predict` and `analyse`
 *  routes, where a comma or a bracket rewrites the query rather than erroring; and it goes into a
 *  DOM id that is selected as `#card-<key>`, where anything outside this class needs escaping and
 *  silently matches nothing without it. */
const ID_SHAPE = /^[A-Za-z0-9-]+$/;

/** The primary key for a listing, across every site.
 *
 *  Rightmove keeps its bare numeric id. That is deliberate and load-bearing: every row already in
 *  the database, every `#card-12345` anchor somebody has bookmarked, and the `/^\d+$/` gates on the
 *  `predict` and `analyse` routes all keep working untouched. Adding sites cost the existing data
 *  nothing, which is the property that made this worth doing without renaming a primary key that
 *  ten tables and eight SQL functions reference. */
export function propertyKey(site: SiteId, externalId: string): string {
  const id = externalId.trim();
  if (!ID_SHAPE.test(id)) {
    throw new Error(`propertyKey: ${site} gave an id outside [A-Za-z0-9-]: ${JSON.stringify(externalId)}`);
  }
  if (site !== 'rightmove') return `${site}${SEPARATOR}${id}`;
  // The price of leaving Rightmove's ids bare: a key with no prefix is read back as Rightmove's
  // only when it is all digits, so Rightmove may only mint all-digit ids. `rightmoveListingId`
  // returns nothing else, and this is where that stops being a coincidence.
  if (!/^\d+$/.test(id)) {
    throw new Error(`propertyKey: a rightmove id must be all digits, got ${JSON.stringify(externalId)}`);
  }
  return id;
}

/** A key read back into the two facts it carries.
 *
 *  A bare key with no separator is Rightmove's, which is what makes every pre-existing row read
 *  correctly without being rewritten. An unknown prefix is *not* silently treated as Rightmove —
 *  it returns null, because a key we cannot place is a bug and guessing would attach a flat to the
 *  wrong site's URL builder. */
export function parseKey(key: string): { site: SiteId; externalId: string } | null {
  const at = key.indexOf(SEPARATOR);
  if (at < 0) return /^\d+$/.test(key) ? { site: 'rightmove', externalId: key } : null;
  const site = key.slice(0, at);
  const externalId = key.slice(at + 1);
  if (!isSiteId(site) || !ID_SHAPE.test(externalId)) return null;
  return { site, externalId };
}

/** Whether a string is a key this app could have written.
 *
 *  The one predicate to use wherever a caller-supplied or database-supplied id is about to be
 *  trusted — a PostgREST filter, a URL fragment, a DOM selector. It replaced a `/^\d+$/` test in
 *  three places, which was the same check back when every listing was Rightmove's and which would
 *  now drop every agent-site flat rather than reject anything. */
export function isPropertyKey(key: string): boolean {
  return parseKey(key) !== null;
}
