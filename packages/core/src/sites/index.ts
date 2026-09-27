import type { Listing } from '../types';
import { austinhomes } from './austinhomes';
import { chestertons } from './chestertons';
import { dexters } from './dexters';
import { foxtons } from './foxtons';
import { johndwood } from './johndwood';
import { portico } from './portico';
import { rightmove } from './rightmove';
import { savills } from './savills';
import { tkinternational } from './tkinternational';
import { parseKey, propertyKey, type Site, type SiteId } from './types';

export * from './types';

/** The agency's own name, filled in where its own page did not state it.
 *
 *  Every site here except Rightmove is one agency's own website, so who is marketing the flat is
 *  settled by which host the page was on — Austin Homes' markup leaves `RealEstateAgent.name` empty
 *  on all four of its pages, and reading that as "we do not know who is letting this" is wrong in a
 *  way the page itself contradicts. Rightmove is excluded because it is a portal: it carries five
 *  hundred agencies and states which on every listing, so a default there would be a lie.
 *
 *  `agentCompany` is what the agent tally groups by, so a null is not a cosmetic gap — it is a
 *  site's whole book missing from the count of who we are dealing with. */
function withAgency(site: Site): Site {
  if (site.id === 'rightmove') return site;
  return {
    ...site,
    extract(html, url) {
      const listing = site.extract(html, url);
      return listing.agentCompany === null ? { ...listing, agentCompany: site.name } : listing;
    },
  };
}

/** Every site, Rightmove first.
 *
 *  Order matters only in that `siteForUrl` returns the first match, and no two sites claim a host,
 *  so it is a stable list rather than a priority. */
export const SITES: readonly Site[] = [
  rightmove,
  ...[austinhomes, chestertons, dexters, foxtons, johndwood, portico, savills, tkinternational].map(withAgency),
];

const BY_ID = new Map<SiteId, Site>(SITES.map((s) => [s.id, s]));

export function siteById(id: SiteId): Site | null {
  return BY_ID.get(id) ?? null;
}

/** Which site's listing page this URL is, and its id there.
 *
 *  Offered to every site in turn, and every site answers for itself — a URL no site claims comes
 *  back null rather than being guessed at from its hostname. That is what lets the `listing` route
 *  answer "we do not read that website" as a stated outcome instead of fetching something it cannot
 *  parse and reporting the failure as a broken listing. */
export function siteForUrl(url: string): { site: Site; externalId: string; key: string } | null {
  for (const site of SITES) {
    const externalId = site.listingId(url);
    if (externalId !== null) {
      return { site, externalId, key: propertyKey(site.id, externalId) };
    }
  }
  return null;
}

/** The site a stored key belongs to, or null when the key names no site we have. */
export function siteForKey(key: string): { site: Site; externalId: string } | null {
  const parsed = parseKey(key);
  if (!parsed) return null;
  const site = BY_ID.get(parsed.site);
  return site ? { site, externalId: parsed.externalId } : null;
}

/** The canonical URL for a stored key, rebuilt by the site that owns it, or null where there is
 *  none to build.
 *
 *  Two ways there is none, and they are the same answer here: no site claims the prefix, or the
 *  site claims it and refuses the id. `listingUrl` refuses on purpose — it is what stops anything
 *  a caller stored from pointing `api/listing`'s fetch at another page — and the refusal is a
 *  throw because at that end swallowing it would be the vulnerability. This end is the other end:
 *  every caller is drawing an optional link beside a row the database already holds, and a throw
 *  from a `?:` in JSX takes the screen down over one malformed key. So the question here is "is
 *  there a URL for this", it is answered rather than raised, and the callers draw no link. */
export function listingUrlForKey(key: string): string | null {
  const found = siteForKey(key);
  if (!found) return null;
  try {
    return found.site.listingUrl(found.externalId);
  } catch {
    return null;
  }
}

/** Read a saved listing page from whichever site the URL belongs to.
 *
 *  Throws `ListingWithdrawn` from the adapter when the page says the flat has gone, and a plain
 *  Error naming the URL when no site claims it — the caller has to tell those apart. */
export function listingFromUrl(html: string, url: string): Listing {
  const found = siteForUrl(url);
  if (!found) throw new Error(`no site reads ${url}`);
  return found.site.extract(html, url);
}

/** Every hostname any site serves listings on. The extension's content-script matches and its
 *  `host_permissions` are generated from this, so a site added to `SITES` without a host here is a
 *  site whose panel never loads and whose absence looks like a mounting bug. */
export function allHosts(): string[] {
  return [...new Set(SITES.flatMap((s) => s.hosts))].sort();
}
