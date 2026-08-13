/** A signed-in house hunt for the browser harnesses to look at.
 *
 *  Every smoke test in this repo used to open the shortlist and read whatever was in the real
 *  database. Two things ended that, and only the first is obvious.
 *
 *  **There is a sign-in screen now.** A harness that does not sign in lands on it and asserts
 *  nothing — the silent skip AGENTS.md singles out as worse than a failure, and the worst possible
 *  version of it, because every one of these checks would go green while testing a login form.
 *
 *  **Signing in needs a user, and creating one needs the service role key**, which exists for the
 *  local stack and does not exist for the hosted project. So a signed-in harness is a local-stack
 *  harness by construction. That is a better place to be anyway: the assertions stop depending on
 *  what anybody swept this afternoon, the harness stops writing to a real house hunt, and the
 *  fixture can contain the awkward cases on purpose — a flat with no verdict, a flat with no
 *  analysis, two listings of the same flat.
 *
 *  Which database the extension talks to is compiled in, so this cannot be arranged at runtime:
 *  `pnpm build:smoke` produces a build pointed at the local stack in `apps/extension/.output/smoke`,
 *  and
 *  `smokeBuild()` below refuses to run against anything else rather than letting a harness quietly
 *  test the wrong database.
 *
 *  Nothing here reaches Rightmove. The image URLs are real Rightmove CDN URLs because that is what
 *  the column holds in life, and `keepOffline` answers every one of them from memory.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createClient, type Session, type SupabaseClient } from '@supabase/supabase-js';
import type { Page, Worker } from 'playwright';
import { SEED_HUBS } from '../packages/core/src/hubs';
import { localCredentials } from './supabase-local';

/** Must match `SESSION_STORAGE_KEY` in `src/lib/auth.ts`. Imported rather than repeated would drag
 *  `import.meta.env` into a Node process, which throws at module load — so it is asserted instead,
 *  against the built bundle, in `smokeBuild()`. */
const SESSION_STORAGE_KEY = 'rm-supabase-session';

export const FIXTURE_PROJECT = '00000000-0000-4000-b000-0000000000f1';
export const FIXTURE_EMAIL = 'smoke-fixture@example.test';
export const FIXTURE_NAME = 'Smoke Fixture';
const OTHER_EMAIL = 'smoke-fixture-two@example.test';
/** Exported so a harness can assert the members list really lists both people rather than just the
 *  one whose session it is holding. */
export const OTHER_NAME = 'The Other One';
const PASSWORD = 'smoke-fixture-password-6c2d';

/** The address `smoke:web` invites and then redeems — the only account in this fixture that is not
 *  created by the service role, because being created the way a real person's is is the point of
 *  it. Torn down with the others, so the run after this one invites a stranger again rather than
 *  somebody who already has an account (which is a different, and separately correct, refusal). */
export const REDEEM_EMAIL = 'smoke-fixture-invitee@example.test';
export const REDEEM_PASSWORD = 'smoke-fixture-invitee-9d41';
/** Every row this fixture owns is named so, so tearing down is a prefix match rather than a list
 *  that drifts out of date and leaves rows behind for the next run to trip over.
 *
 *  Digits, because a Rightmove id is digits and the app validates that: `#card-<id>` on a cold load
 *  is read by `/^#card-(\d+)$/`, so a fixture with `smokefix-1` in it could never open a deep link
 *  and the harness could only ever test the in-app click. A fixture that cannot hold the shape
 *  production has is a fixture that quietly excuses the surface from being checked.
 *
 *  Leading zeros because that is the one thing a real id never has, which keeps teardown by prefix
 *  provably unable to reach the real listing `pnpm smoke` seeds beside these. */
const PREFIX = '000';

/** The nth flat this fixture seeds. Exported so the harness names them the same way the seed does,
 *  rather than repeating the scheme at every assertion that reads one. */
export function fixtureId(n: number): string {
  return `${PREFIX}${n}`;
}

const { url, anonKey, serviceKey } = localCredentials();

// ------------------------------------------------------------------------------------------- //
// The build. Pointed at the local stack, or this is not a check — it is a check of the wrong
// database, which is the failure mode hardest to see from the output.
// ------------------------------------------------------------------------------------------- //

export interface SmokeBuild {
  /** The unpacked extension directory to load into Chromium. */
  path: string;
  /** Everything the manifest asks for, as prefixes — what `keepOffline` is allowed to let out. */
  allowedHosts: string[];
}

export function smokeBuild(): SmokeBuild {
  const path = resolve(import.meta.dirname, '../apps/extension/.output/smoke/chrome-mv3');
  const manifestPath = resolve(path, 'manifest.json');
  if (!existsSync(manifestPath)) {
    throw new Error(
      `no smoke build at ${path}.\n\n` +
        'The browser harnesses need an extension pointed at the LOCAL Supabase, because signing a\n' +
        'fixture user in needs a service role key and only the local stack has one. Build it with:\n\n' +
        '    supabase start        # if it is not already up\n' +
        '    pnpm build:smoke\n',
    );
  }

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { host_permissions?: string[] };
  const permissions = manifest.host_permissions ?? [];
  // The one assertion that stops a stale build being used against the wrong database. A build made
  // by `pnpm build` carries the hosted project's host and would sign nobody in, land on the login
  // form and assert nothing.
  if (!permissions.some((pattern) => pattern.startsWith(url))) {
    throw new Error(
      `the build at ${path} is pointed at ${permissions.join(', ')}, not at the local stack (${url}).\n` +
        'Rebuild it with `pnpm build:smoke` — running it as it is would test the wrong database.',
    );
  }

  return {
    path,
    allowedHosts: permissions.map((pattern) => pattern.replace(/\*$/, '')),
  };
}

// ------------------------------------------------------------------------------------------- //
// The data. Small, and deliberately uneven: the interesting states are the ones a real database
// only sometimes has, and a harness that skips its assertion whenever the data is tidy is the
// harness that let the empty `journeys` column through review.
// ------------------------------------------------------------------------------------------- //

const db: SupabaseClient = createClient(url, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

/** The two saved places every property is measured against. Real postcodes with real coordinates,
 *  so nothing needs postcodes.io and the numbers are plausible when a screenshot is read. */
const PLACES = [
  { label: 'Work', postcode: 'EC2A 4NE', lat: 51.52427, lon: -0.08265 },
  { label: 'The in-laws', postcode: 'NW3 1QG', lat: 51.55552, lon: -0.17827 },
];

interface FixtureProperty {
  id: string;
  address: string;
  postcode: string;
  price: string;
  bedrooms: number;
  bathrooms: number;
  lat: number;
  lon: number;
  floorAreaSqft: number | null;
  floorAreaSource: 'sizings' | 'description' | null;
  furnishType: string;
  listingUpdate: string;
  /** Null for the one flat nobody has analysed — the state the flags and the compare table have
   *  to render as "not known" rather than as "no bathtub". */
  analysis: null | {
    hasBathtub: boolean;
    hasOutdoorSpace: boolean;
    outdoorKind: string | null;
    biggestRoomSqft: number;
    floorplanSqft: number | null;
    summary: string;
  };
  /** Null leaves it in the unrated pile, which is what triage is for. */
  verdict: null | { rating: 'love' | 'maybe' | 'no'; note: string; by: 'one' | 'two' };
}

/** Six flats. Three rated and three not, so the piles, the triage view and the default filters all
 *  have something to show; two of them share a postcode and a price, which is the relisted-flat
 *  case `duplicateIds` marks with ⧉. */
const PROPERTIES: FixtureProperty[] = [
  {
    id: fixtureId(1), address: '12 Flask Walk, Hampstead, London', postcode: 'NW3 1HE',
    price: '£2,600 pcm', bedrooms: 2, bathrooms: 1, lat: 51.55597, lon: -0.17705,
    floorAreaSqft: 780, floorAreaSource: 'sizings', furnishType: 'Furnished',
    listingUpdate: 'Added on 05/08/2026',
    analysis: { hasBathtub: true, hasOutdoorSpace: true, outdoorKind: 'garden', biggestRoomSqft: 210, floorplanSqft: 775, summary: 'Bright two bed with a small garden.' },
    verdict: { rating: 'love', note: 'The garden is the whole thing.', by: 'one' },
  },
  {
    id: fixtureId(2), address: '4 Danbury Street, Islington, London', postcode: 'N1 8JU',
    price: '£2,400 pcm', bedrooms: 2, bathrooms: 1, lat: 51.53601, lon: -0.10131,
    floorAreaSqft: 690, floorAreaSource: 'description', furnishType: 'Unfurnished',
    listingUpdate: 'Reduced on 07/08/2026',
    analysis: { hasBathtub: false, hasOutdoorSpace: false, outdoorKind: null, biggestRoomSqft: 145, floorplanSqft: 688, summary: 'No bath and nowhere to sit outside.' },
    verdict: { rating: 'no', note: 'No bath.', by: 'two' },
  },
  {
    // The same flat as the one above, by a second agent: same postcode, same rent, different
    // photos and therefore a different set of inferences. `duplicateIds` marks both ⧉.
    id: fixtureId(3), address: '4 Danbury St, Islington', postcode: 'N1 8JU',
    price: '£2,400 pcm', bedrooms: 2, bathrooms: 1, lat: 51.53601, lon: -0.10131,
    floorAreaSqft: 705, floorAreaSource: 'description', furnishType: 'Unfurnished',
    listingUpdate: 'Added on 01/08/2026',
    analysis: { hasBathtub: false, hasOutdoorSpace: true, outdoorKind: 'balcony', biggestRoomSqft: 150, floorplanSqft: null, summary: 'Relisting of the Danbury Street flat.' },
    verdict: null,
  },
  {
    id: fixtureId(4), address: '88 Regents Park Road, Primrose Hill, London', postcode: 'NW1 8UG',
    price: '£3,100 pcm', bedrooms: 3, bathrooms: 2, lat: 51.54101, lon: -0.15736,
    floorAreaSqft: 1020, floorAreaSource: 'sizings', furnishType: 'Part furnished',
    listingUpdate: 'Added on 08/08/2026',
    analysis: { hasBathtub: true, hasOutdoorSpace: false, outdoorKind: null, biggestRoomSqft: 260, floorplanSqft: 1015, summary: 'Large three bed, no outdoor space.' },
    verdict: { rating: 'maybe', note: 'Dear, but big.', by: 'one' },
  },
  {
    // Nobody has analysed this one. The flags, the compare table and the card all have to say
    // "not known" rather than rendering the absence as a finding.
    id: fixtureId(5), address: '21 Old Street, Clerkenwell, London', postcode: 'EC1V 9HL',
    price: '£2,150 pcm', bedrooms: 1, bathrooms: 1, lat: 51.52489, lon: -0.09705,
    floorAreaSqft: null, floorAreaSource: null, furnishType: 'Furnished',
    listingUpdate: 'Added on 09/08/2026',
    analysis: null,
    verdict: null,
  },
  {
    id: fixtureId(6), address: '7 Rochester Road, Camden, London', postcode: 'NW1 9JH',
    price: '£2,750 pcm', bedrooms: 2, bathrooms: 2, lat: 51.54339, lon: -0.13749,
    floorAreaSqft: 830, floorAreaSource: 'sizings', furnishType: 'Unfurnished',
    listingUpdate: 'Added on 06/08/2026',
    analysis: { hasBathtub: true, hasOutdoorSpace: true, outdoorKind: 'terrace', biggestRoomSqft: 190, floorplanSqft: 825, summary: 'Terrace off the kitchen.' },
    verdict: null,
  },
];

/** Rightmove's own CDN, which is where these URLs point in life. Nothing fetches them: every
 *  harness installs `keepOffline`, which answers Rightmove images from memory, and `OFFLINE_ARGS`
 *  stops the domain resolving at all. */
function imageUrls(id: string): string[] {
  return [1, 2, 3].map((n) => `https://media.rightmove.co.uk/dir/crop/10:9-16:9/${id}_IMG_0${n}_0000_max_476x317.jpeg`);
}

function floorplanUrl(id: string): string {
  return `https://media.rightmove.co.uk/dir/${id}_FLP_00_0000_max_600x600.gif`;
}

const STATIONS = [
  { name: 'Hampstead Station', types: ['LONDON_UNDERGROUND'], distance: 0.3, unit: 'miles' },
  { name: 'Belsize Park Station', types: ['LONDON_UNDERGROUND'], distance: 0.6, unit: 'miles' },
];

function must(context: string, error: { message: string } | null): void {
  if (error) throw new Error(`fixture: ${context}: ${error.message}`);
}

async function tearDown(alsoCache: ExtraCache[] = []): Promise<void> {
  const postcodes = [...PROPERTIES.map((p) => p.postcode), ...alsoCache.map((c) => c.postcode)];

  await db.from('api_usage').delete().eq('project_id', FIXTURE_PROJECT);
  await db.from('verdict_history').delete().eq('project_id', FIXTURE_PROJECT);
  await db.from('project').delete().eq('id', FIXTURE_PROJECT);
  await db.from('property_analysis').delete().like('rightmove_id', `${PREFIX}%`);
  await db.from('property').delete().like('rightmove_id', `${PREFIX}%`);
  // The listing the smoke harness opens is a real one, so no leading zeros and no prefix match. Left
  // behind, the second run finds the row already there and `record_property` takes its
  // on-conflict-update path — so the assertion that opening a new listing creates the row would
  // pass without that path ever running again.
  //
  // Deleted by id and not by postcode, which is what this did first: a real postcode holds real
  // listings, and matching on it would take out the flat next door because somebody else's project
  // happened to have opened it. `property_analysis` goes first for the foreign key.
  const alsoIds = alsoCache.map((c) => c.rightmoveId);
  if (alsoIds.length > 0) {
    await db.from('property_analysis').delete().in('rightmove_id', alsoIds);
    await db.from('property').delete().in('rightmove_id', alsoIds);
  }
  await db.from('travel_time').delete().in('origin_postcode', postcodes);
  await db.from('station_walk').delete().in('postcode', postcodes);

  // The invite guesses the harnesses leave behind. `redeem_code` counts failures per address for an
  // hour and `smoke:web` makes one on purpose, so the fifth run inside an hour was answered "too
  // many attempts" — the section that exists to check which refusal a person gets, refused about
  // the four runs before it. Matched on the prefix every fixture address shares, so this takes out
  // the fixture's own knocking and leaves the counting that protects a real invite alone.
  await db.from('redeem_attempt').delete().like('email', 'smoke-fixture%');

  const owned = new Set([FIXTURE_EMAIL, OTHER_EMAIL, REDEEM_EMAIL]);
  const { data } = await db.auth.admin.listUsers({ perPage: 1000 });
  for (const user of data?.users ?? []) {
    if (user.email && owned.has(user.email)) await db.auth.admin.deleteUser(user.id);
  }
}

async function createUser(email: string, name: string): Promise<string> {
  const { data, error } = await db.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error || !data.user) throw new Error(`fixture: creating ${email}: ${error?.message ?? 'no user'}`);
  // The profile is made by a trigger on auth.users. If it did not fire, nothing below is true, so
  // this updates it and checks the update found a row rather than assuming one exists.
  const { data: updated, error: nameError } = await db
    .from('profile').update({ display_name: name }).eq('id', data.user.id).select('id');
  must(`naming ${email}`, nameError);
  if ((updated ?? []).length !== 1) {
    throw new Error(`fixture: no profile row for ${email} — the on_auth_user_created trigger did not fire`);
  }
  return data.user.id;
}

export interface FixtureData {
  projectId: string;
  userId: string;
  otherUserId: string;
  /** How many hubs the fixture project has. The harnesses assert against `hubs:list` rather than
   *  this, but it is here so a mismatch can be reported as a number rather than as a shrug. */
  hubCount: number;
  /** Every listing id the fixture owns, newest sighting first. */
  listingIds: string[];
  unratedCount: number;
}

/** An origin the harness wants already in the travel cache, beyond the fixture's own flats.
 *
 *  `stations` is by name because that is the key `station_walk` is on and the name is what the
 *  panel asks with — it comes straight out of the listing blob's `nearestStations`. */
export interface ExtraCache {
  /** The listing itself, so tearing down removes this row and only this row. */
  rightmoveId: string;
  postcode: string;
  stations: string[];
}

async function seed(alsoCache: ExtraCache[]): Promise<FixtureData> {
  const userId = await createUser(FIXTURE_EMAIL, FIXTURE_NAME);
  const otherUserId = await createUser(OTHER_EMAIL, OTHER_NAME);

  must('creating the project', (await db.from('project').insert({
    id: FIXTURE_PROJECT, name: 'Smoke fixture hunt', created_by: userId,
  })).error);
  must('creating memberships', (await db.from('project_member').insert([
    { project_id: FIXTURE_PROJECT, user_id: userId, role: 'owner' },
    { project_id: FIXTURE_PROJECT, user_id: otherUserId, role: 'member' },
  ])).error);
  must('setting the active project', (await db.from('profile')
    .update({ active_project_id: FIXTURE_PROJECT }).in('id', [userId, otherUserId])).error);

  // The neighbourhoods, from `SEED_HUBS` — the same five the migration seeds for a new project,
  // and the same list `check:sweep` pins the search URLs against. A harness must still assert
  // against what `hubs:list` returns rather than against this: hubs are project data now, and a
  // check that reads the constant would pass for a project that has none.
  must('seeding the hubs', (await db.from('project_hub').insert(
    SEED_HUBS.map((hub, i) => ({
      project_id: FIXTURE_PROJECT,
      name: hub.name,
      lat: hub.lat,
      lon: hub.lon,
      rightmove_location_id: hub.rightmove?.locationIdentifier ?? null,
      display_location_id: hub.rightmove?.displayLocationIdentifier ?? null,
      sort_order: i,
    })),
  )).error);

  must('seeding the places', (await db.from('place').insert(
    PLACES.map((place, i) => ({ ...place, project_id: FIXTURE_PROJECT, sort_order: i })),
  )).error);

  const now = Date.now();
  must('seeding the properties', (await db.from('property').insert(
    PROPERTIES.map((p, i) => ({
      rightmove_id: p.id,
      url: `https://www.rightmove.co.uk/properties/${p.id}`,
      display_address: p.address,
      postcode: p.postcode,
      price: p.price,
      bedrooms: p.bedrooms,
      bathrooms: p.bathrooms,
      latitude: p.lat + 0.001,
      longitude: p.lon + 0.001,
      // The postcode-derived point, which is what the map and the hub bearings use. Present on
      // every row, so `locateProperties` has nothing to do and no harness calls postcodes.io.
      postcode_lat: p.lat,
      postcode_lon: p.lon,
      floor_area_sqft: p.floorAreaSqft,
      floor_area_source: p.floorAreaSource,
      floorplan_url: floorplanUrl(p.id),
      image_urls: imageUrls(p.id),
      furnish_type: p.furnishType,
      listing_update: p.listingUpdate,
      nearest_stations: STATIONS,
      last_seen_at: new Date(now - i * 3_600_000).toISOString(),
      written_by_project: FIXTURE_PROJECT,
    })),
  )).error);

  must('linking the properties', (await db.from('project_property').insert(
    PROPERTIES.map((p, i) => ({
      project_id: FIXTURE_PROJECT,
      rightmove_id: p.id,
      last_seen_at: new Date(now - i * 3_600_000).toISOString(),
    })),
  )).error);

  const analysed = PROPERTIES.filter((p) => p.analysis);
  must('seeding the analyses', (await db.from('property_analysis').insert(
    analysed.map((p) => ({
      rightmove_id: p.id,
      model: 'gpt-5.6-terra',
      status: 'done',
      image_count: 3,
      has_floorplan: true,
      floorplan_legible: true,
      floorplan_sqft: p.analysis!.floorplanSqft,
      floorplan_sqft_source: p.analysis!.floorplanSqft ? 'stated' : 'none',
      floorplan_confidence: 'high',
      bedrooms: p.bedrooms,
      bathrooms: p.bathrooms,
      biggest_room_label: 'living room',
      biggest_room_sqft: p.analysis!.biggestRoomSqft,
      biggest_room_confidence: 'medium',
      has_bathtub: p.analysis!.hasBathtub,
      bathtub_confidence: 'high',
      has_outdoor_space: p.analysis!.hasOutdoorSpace,
      outdoor_kind: p.analysis!.outdoorKind,
      outdoor_sqft: p.analysis!.hasOutdoorSpace ? 120 : null,
      outdoor_is_estimate: true,
      outdoor_confidence: 'low',
      summary: p.analysis!.summary,
    })),
  )).error);

  const rated = PROPERTIES.filter((p) => p.verdict);
  must('seeding the verdicts', (await db.from('verdict').insert(
    rated.map((p) => ({
      project_id: FIXTURE_PROJECT,
      rightmove_id: p.id,
      rating: p.verdict!.rating,
      note: p.verdict!.note,
      set_by: p.verdict!.by === 'one' ? userId : otherUserId,
      set_by_name: p.verdict!.by === 'one' ? FIXTURE_NAME : OTHER_NAME,
    })),
  )).error);

  // Travel: every property to every place, in all three modes, already cached and on the basis
  // the code currently asks for. Complete on purpose, and more load-bearing than it was when this
  // said "would make the panel call TfL" — travel resolution is server-side now, so an uncached
  // origin makes the panel call the `travel` Edge Function, which is not running in a harness. It
  // does not fail fast either: the panel sits on "Working…" and never settles, which the harness
  // then reports as "panel never left its loading state" with nothing to say about why.
  //
  // Hence `alsoCache`. The listing smoke deliberately opens a listing this project has never seen
  // (that is the point — it exercises `record_property`), and a listing nobody has seen is a
  // guaranteed cache miss by construction.
  const legs = [
    { mode: 'walking', basis: 'anytime' },
    { mode: 'cycling', basis: 'anytime' },
    { mode: 'transit', basis: 'weekday-0900' },
  ] as const;
  // Keyed on the postcode, not the listing — which is the whole point of the re-key in D5, and
  // which the two Danbury Street listings would otherwise break: they are one flat, one postcode
  // and therefore one cached journey, and inserting per property duplicates the primary key.
  const origins = [
    ...new Set([...PROPERTIES.map((p) => p.postcode), ...alsoCache.map((c) => c.postcode)]),
  ];
  const travel = origins.flatMap((postcode, pi) =>
    PLACES.flatMap((place, di) =>
      legs.map((leg, li) => ({
        origin_postcode: postcode,
        dest_postcode: place.postcode,
        mode: leg.mode,
        seconds: 900 + pi * 120 + di * 300 + li * 200,
        changes: leg.mode === 'transit' ? 1 : null,
        basis: leg.basis,
        no_route: false,
        // Only transit carries routes, which is what the tooltip draws. Two options so the
        // tooltip has something to choose between, and named lines so the chips have colours.
        journeys: leg.mode === 'transit'
          ? [
              { minutes: 24 + pi, legs: [
                { mode: 'walking', lineId: null, lineName: null, minutes: 6 },
                { mode: 'tube', lineId: 'northern', lineName: 'Northern', minutes: 12 },
                { mode: 'walking', lineId: null, lineName: null, minutes: 6 },
              ] },
              { minutes: 31 + pi, legs: [
                { mode: 'walking', lineId: null, lineName: null, minutes: 4 },
                { mode: 'bus', lineId: '24', lineName: '24', minutes: 21 },
                { mode: 'walking', lineId: null, lineName: null, minutes: 6 },
              ] },
            ]
          : null,
      })),
    ),
  );
  must('seeding the travel cache', (await db.from('travel_time').insert(travel)).error);

  // Each origin gets a walk to its *own* stations. The fixture flats all claim `STATIONS`; a real
  // listing claims whatever its blob says, and seeding the fixture's two names against its postcode
  // would leave the panel asking for walks it has no row for — a miss that goes to the Edge
  // Function exactly like an uncached journey does.
  const stationsFor = new Map<string, string[]>(origins.map((p) => [p, STATIONS.map((s) => s.name)]));
  for (const extra of alsoCache) stationsFor.set(extra.postcode, extra.stations);

  must('seeding the station walks', (await db.from('station_walk').insert(
    [...stationsFor].flatMap(([postcode, names]) =>
      names.map((station_name) => ({ postcode, station_name, seconds: 360 })),
    ),
  )).error);

  return {
    projectId: FIXTURE_PROJECT,
    userId,
    otherUserId,
    hubCount: SEED_HUBS.length,
    listingIds: PROPERTIES.map((p) => p.id),
    unratedCount: PROPERTIES.filter((p) => !p.verdict).length,
  };
}

// ------------------------------------------------------------------------------------------- //
// Standing it up, and putting the session where the extension looks for it.
// ------------------------------------------------------------------------------------------- //

export interface Fixture extends FixtureData {
  session: Session;
}

/** Rebuild the fixture from scratch and sign its owner in.
 *
 *  Torn down first rather than upserted: a run that inherits half of the previous run's rows is a
 *  run whose assertions are about something nobody wrote down. */
export async function seedFixture({ alsoCache = [] }: { alsoCache?: ExtraCache[] } = {}): Promise<Fixture> {
  await tearDown(alsoCache);
  const data = await seed(alsoCache);

  const client = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: signedIn, error } = await client.auth.signInWithPassword({
    email: FIXTURE_EMAIL, password: PASSWORD,
  });
  if (error || !signedIn.session) {
    throw new Error(`fixture: signing in as ${FIXTURE_EMAIL}: ${error?.message ?? 'no session returned'}`);
  }
  return { ...data, session: signedIn.session };
}

/** Write the session where `lib/auth.ts` reads it.
 *
 *  supabase-js reads `chrome.storage.local` on every `getSession()` rather than caching it in the
 *  worker, so this takes effect immediately and does not need the extension reloaded. The shape is
 *  whatever `signInWithPassword` returned, verbatim: supabase-js stores the session object as
 *  JSON, and inventing the shape here would be a fixture that drifts from the library. */
export async function plantSession(worker: Worker, session: Session): Promise<void> {
  await worker.evaluate(
    ([key, value]) => chrome.storage.local.set({ [key as string]: value as string }),
    [SESSION_STORAGE_KEY, JSON.stringify(session)],
  );

  // Read it back through the extension itself. A session written to the wrong key, or to a storage
  // area the worker does not read, is indistinguishable from being signed out — and being signed
  // out is a screen these harnesses would then assert against without noticing.
  const stored = await worker.evaluate(
    async (key) => (await chrome.storage.local.get(key as string))[key as string],
    SESSION_STORAGE_KEY,
  );
  if (typeof stored !== 'string' || !stored.includes(session.access_token.slice(0, 24))) {
    throw new Error(`fixture: the session did not land in chrome.storage.local under ${SESSION_STORAGE_KEY}`);
  }
}

/** The extension's own diagnostic ring buffer, read out of the worker it is written in.
 *
 *  Worth having because of where the failures actually are. Almost everything that can go wrong
 *  here goes wrong in the background worker — every database write, every TfL call — and a
 *  harness watching only the page console sees none of it. `record_property` refusing a listing
 *  surfaced as one flat line, "did not link it to the project", with the reason three clicks deep
 *  in a console Chrome wipes when it tears the worker down. That is the exact problem the ring
 *  buffer was built for (`lib/log.ts`); it just had no reader outside Settings until now.
 *
 *  Shape duplicated rather than imported: `lib/log.ts` reaches for `chrome.*` at module load and
 *  cannot be imported into a Node process. It is two fields, and `formatLog` is the thing that
 *  would actually hurt to duplicate — this deliberately does not reproduce it. */
interface WorkerLogEntry {
  at: string;
  level: 'info' | 'warn' | 'error';
  scope: string;
  message: string;
  detail?: unknown;
}

export async function extensionLog(
  worker: Worker,
  { levels = ['warn', 'error'] as Array<WorkerLogEntry['level']> } = {},
): Promise<string[]> {
  const entries = (await worker.evaluate(
    async () => (await chrome.storage.local.get('log'))['log'] ?? [],
  )) as WorkerLogEntry[];

  return entries
    .filter((e) => levels.includes(e.level))
    .map((e) => {
      let detail = '';
      if (e.detail !== undefined) {
        try {
          detail = ` ${JSON.stringify(e.detail)}`;
        } catch {
          detail = ` ${String(e.detail)}`;
        }
      }
      return `${e.level.toUpperCase()} [${e.scope}] ${e.message}${detail}`;
    });
}

/** Invite somebody, and get the code back in the clear.
 *
 *  Through the `invite` Edge Function rather than by writing a row, because the code is the whole
 *  point and the row never holds it: `create_invite` is given a *hash*, and the plaintext exists
 *  for exactly one moment, in that function's reply. A fixture that inserted its own invite row
 *  would have to hash a code itself, and would then be testing its own hashing rather than the
 *  path a real invite takes.
 *
 *  The address is deliberately a parameter with no default. This mints a real invite against the
 *  fixture project, and the caller is the one who knows whether it is about to redeem it. */
export async function createInvite(
  session: Session,
  email: string,
): Promise<{ status: string; code: string | null }> {
  const response = await fetch(`${url}/functions/v1/invite`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${session.access_token}`,
      apikey: anonKey,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ email, projectId: FIXTURE_PROJECT }),
  });

  if (!response.ok) {
    throw new Error(`fixture: inviting ${email}: HTTP ${response.status} ${await response.text()}`);
  }
  const reply = (await response.json()) as { status?: string; code?: string };
  return { status: reply.status ?? 'unknown', code: reply.code ?? null };
}

export interface FixtureHub {
  name: string;
  locationIdentifier: string | null;
}

/** The project's neighbourhoods, read from the database.
 *
 *  Hubs are project data now (design D11), so a harness asserting against `SEED_HUBS` is asserting
 *  a compile-time constant that no longer decides anything: it happens to agree for this fixture
 *  and for the first project, and agrees with nothing for anybody else's. Where a harness can ask
 *  the extension — `hubs:list`, from a page that has `chrome.runtime` — it should. This is for the
 *  harnesses that run on a Rightmove page, where Playwright evaluates in the main world and there
 *  is no extension to ask. */
export async function fixtureHubs(): Promise<FixtureHub[]> {
  const { data, error } = await db
    .from('project_hub')
    .select('name, rightmove_location_id')
    .eq('project_id', FIXTURE_PROJECT)
    .order('sort_order');
  if (error) throw new Error(`fixture: reading project_hub: ${error.message}`);
  return (data ?? []).map((row) => ({ name: row.name, locationIdentifier: row.rightmove_location_id }));
}

/** Did the fixture project end up linked to this listing?
 *
 *  The question `record_property` exists to answer, asked of the database rather than of the panel
 *  — a panel that rendered fine having written nothing is the failure this catches, and it is the
 *  one the two-step version of that function shipped with (design D15). */
export async function projectHasListing(rightmoveId: string): Promise<boolean> {
  const { count, error } = await db
    .from('project_property')
    .select('*', { count: 'exact', head: true })
    .eq('project_id', FIXTURE_PROJECT)
    .eq('rightmove_id', rightmoveId);
  if (error) throw new Error(`fixture: reading project_property: ${error.message}`);
  return (count ?? 0) > 0;
}

/** One stored rating, as the database holds it rather than as a screen states it.
 *
 *  `setBy` is the author and `setByName` is very nearly always null — the column exists for the
 *  eighteen verdicts written under the pre-auth identity model, and its own comment in the schema
 *  says new rows set `set_by` and leave it empty. The name on screen is resolved from project
 *  membership by `authorOf`, so a harness asserting on `setByName` is asserting against a legacy
 *  column and would report a perfectly attributed verdict as anonymous. */
export interface StoredVerdict {
  rating: string;
  note: string;
  setBy: string | null;
  setByName: string | null;
}

/** The project's rating for a listing, read past every view that renders one.
 *
 *  A verdict is the product's central action and the only write with a history table behind it, so
 *  a harness that stops at the button is checking the half that cannot silently do nothing. The
 *  mutation is optimistic: the card repaints from local state the instant it is clicked and only
 *  rolls back when the reply fails, so a rating that never reached Postgres looks exactly like one
 *  that did — until the next reload, on the other laptop, days later. */
export async function verdictOf(rightmoveId: string): Promise<StoredVerdict | null> {
  const { data, error } = await db
    .from('verdict')
    .select('rating, note, set_by, set_by_name')
    .eq('project_id', FIXTURE_PROJECT)
    .eq('rightmove_id', rightmoveId);
  if (error) throw new Error(`fixture: reading verdict: ${error.message}`);
  // Not `.single()`: two rows for one property is a real failure mode (the optimistic-update note
  // in `queries.ts` records the bug that produced it), and `.single()` reports it as "no rows",
  // which reads as a write that never happened.
  if ((data ?? []).length > 1) {
    throw new Error(`fixture: ${data!.length} verdicts for ${rightmoveId} — a project holds one`);
  }
  const row = (data ?? [])[0];
  return row
    ? { rating: row.rating, note: row.note, setBy: row.set_by, setByName: row.set_by_name }
    : null;
}

/** Where a listing has got to, as the database holds it.
 *
 *  Read alongside `verdictOf` rather than instead of it: the two are separate facts on purpose, and
 *  the failure worth catching is one write moving the other — an archived flat whose rating quietly
 *  became "no" is a training label nobody chose. */
export interface StoredStage {
  stage: string;
  archiveReason: string | null;
  setBy: string | null;
}

export async function stageOf(rightmoveId: string): Promise<StoredStage | null> {
  const { data, error } = await db
    .from('property_stage')
    .select('stage, archive_reason, set_by')
    .eq('project_id', FIXTURE_PROJECT)
    .eq('rightmove_id', rightmoveId)
    .maybeSingle();
  if (error) throw new Error(`fixture: reading property_stage: ${error.message}`);
  return data ? { stage: data.stage, archiveReason: data.archive_reason, setBy: data.set_by } : null;
}

/** What the previous ratings were, newest first. Empty is the honest answer for a flat rated once —
 *  the seed writes `verdict` directly, so anything here was archived by `set_verdict`. */
export async function verdictHistoryOf(rightmoveId: string): Promise<StoredVerdict[]> {
  const { data, error } = await db
    .from('verdict_history')
    .select('rating, note, set_by, set_by_name')
    .eq('project_id', FIXTURE_PROJECT)
    .eq('rightmove_id', rightmoveId)
    .order('updated_at', { ascending: false });
  if (error) throw new Error(`fixture: reading verdict_history: ${error.message}`);
  return (data ?? []).map((r) => ({
    rating: r.rating, note: r.note, setBy: r.set_by, setByName: r.set_by_name,
  }));
}

/** Ask the extension who it thinks is signed in, from a page it owns.
 *
 *  Worth doing loudly at the top of every harness: an expired token, a project the fixture forgot
 *  to make active, a build pointed elsewhere — all three produce a perfectly rendered sign-in
 *  screen, and every assertion after it is about a form. */
export async function assertSignedIn(
  page: Page,
  expect: { email: string; projectId: string },
): Promise<void> {
  const state = (await page.evaluate(
    `chrome.runtime.sendMessage({ type: 'auth:state' })`,
  )) as { ok?: boolean; data?: { status?: string; user?: { email?: string }; activeProject?: { id?: string } }; error?: string } | null;

  if (!state?.ok || !state.data) {
    throw new Error(`fixture: auth:state failed — ${state?.error ?? 'no answer from the worker'}`);
  }
  const auth = state.data;
  if (auth.status !== 'signed-in') {
    throw new Error(`fixture: the extension reports "${auth.status}" — the planted session was not accepted`);
  }
  if (auth.user?.email !== expect.email) {
    throw new Error(`fixture: signed in as ${auth.user?.email}, expected ${expect.email}`);
  }
  if (auth.activeProject?.id !== expect.projectId) {
    throw new Error(
      `fixture: active project is ${auth.activeProject?.id ?? 'none'}, expected ${expect.projectId}`,
    );
  }
}
