/** The security boundary, asserted from the outside.
 *
 *  Every other check in this repo is a pure function. This one is not, and cannot be: row-level
 *  security is only real as observed by a real client holding a real JWT, going through PostgREST,
 *  with the policies deciding. A policy that reads correctly and denies nothing looks exactly like
 *  a policy that works, and no amount of reading the SQL tells them apart.
 *
 *  So this signs in as a member of project A and asserts the adversarial cases:
 *
 *    - every project-scoped table shows zero of project B's rows
 *    - every write into one of B's rows is refused
 *    - a DELETE against each of the five global fact tables removes nothing
 *    - `record_property` naming a project the caller is not in is refused
 *    - the `anon` role — the one the publishable key in the bundle carries — can read and write
 *      nothing, anywhere
 *    - an invite is consumed only by the person it was addressed to, and only through
 *      `consume_invites()`; a member cannot write an invite's status by any other route
 *    - `spend_summary` answers about the caller, whoever they name in the argument
 *    - the admin audit log is readable by admins alone and writable only by the functions that
 *      perform the change, and it records what the change was
 *    - a member can neither reserve TfL capacity nor record travel calls against their allowance
 *
 *  It also asserts a handful of things that must still WORK. A database that refuses everything
 *  passes an adversarial test perfectly, and that is the failure this whole change would be
 *  hardest to notice. One of those cases is load-bearing and was missing: recording a listing
 *  **nobody has ever opened**. Every fixture listing already existed, which hid a cycle between the
 *  foreign key and the link gate that made the extension's primary action impossible.
 *
 *  ## Running it
 *
 *  Against a LOCAL Supabase only. Never point this at the live project: it creates users, writes
 *  rows and deletes them again.
 *
 *      supabase start                 # in this directory
 *      pnpm check:rls
 *
 *  It reads the local instance's URL and keys from `supabase status -o env`. If those ports are
 *  taken by another project's stack, stand a scratch copy up on different ports and pass them in:
 *
 *      RLS_SUPABASE_URL=http://127.0.0.1:55321 RLS_ANON_KEY=... RLS_SERVICE_KEY=... pnpm check:rls
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { localCredentials } from './supabase-local';

// Where to point, and the refusal to point at the live project, both in `supabase-local.ts` —
// `check:spend` and the smoke harnesses need exactly the same two things.
const { url, anonKey, serviceKey } = localCredentials();

const noSession = { auth: { persistSession: false, autoRefreshToken: false } };
const admin = createClient(url, serviceKey, noSession);
const anon = createClient(url, anonKey, noSession);

// ------------------------------------------------------------------------------------------- //
// The harness. Loud on both sides: a check that could not run has to say so rather than pass.
// ------------------------------------------------------------------------------------------- //

let failures = 0;
let checks = 0;

function ok(name: string) {
  checks++;
  console.log(`  ok    ${name}`);
}

function fail(name: string, detail: string) {
  checks++;
  failures++;
  console.log(`  FAIL  ${name}\n        ${detail}`);
}

function is(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) ok(name);
  else fail(name, `expected ${e}, got ${a}`);
}

interface Result {
  data: unknown;
  error: { message: string } | null;
}

/** A write is refused if it errored, or if it silently affected no rows — RLS does the second and
 *  a revoked grant does the first, and both are refusals. */
function refused(name: string, result: Result) {
  if (result.error) return ok(`${name} (refused: ${result.error.message.split('\n')[0]})`);
  const rows = Array.isArray(result.data) ? result.data.length : result.data === null ? 0 : 1;
  if (rows === 0) return ok(`${name} (affected nothing)`);
  fail(name, `the write went through and affected ${rows} row(s)`);
}

/** Refused *by an error*, with no fallback to "nothing changed".
 *
 *  `refused` above accepts either, which is right for a write that RLS filters into a no-op — there
 *  is genuinely nothing to distinguish. It is wrong for a `void`-returning RPC: `data` is null
 *  whether the call was denied or ran perfectly, so `refused` passes either way. Four assertions
 *  about the travel caches sat in exactly that blind spot and reported "affected nothing" against a
 *  database where the grant had not been revoked at all. */
function denied(name: string, result: Result) {
  if (result.error) return ok(`${name} (refused: ${result.error.message.split('\n')[0]})`);
  fail(name, 'the call succeeded — this must be refused outright, not merely have no effect');
}

function allowed(name: string, result: Result) {
  if (result.error) fail(name, `expected this to work, got: ${result.error.message}`);
  else ok(name);
}

/** Nothing came back, whether because the read was refused outright or because RLS filtered
 *  everything away. Both are "you cannot see this". Distinct from `empty` below, which is for a
 *  caller who *may* read a table and must simply find none of another project's rows in it — there,
 *  an error would mean the query broke rather than that the boundary held. */
function nothing(name: string, result: Result) {
  if (result.error) return ok(`${name} (refused: ${result.error.message.split('\n')[0]})`);
  const rows = Array.isArray(result.data) ? result.data.length : result.data === null ? 0 : 1;
  if (rows === 0) return ok(`${name} (nothing visible)`);
  fail(name, `saw ${rows} row(s)`);
}

function empty(name: string, result: Result) {
  if (result.error) return fail(name, `errored instead of returning nothing: ${result.error.message}`);
  const rows = Array.isArray(result.data) ? result.data.length : result.data === null ? 0 : 1;
  if (rows === 0) ok(name);
  else fail(name, `saw ${rows} row(s) that belong to another project`);
}

/** Call an RPC, surviving the local PostgREST falling over.
 *
 *  PostgREST 12.0.1 — the version the Supabase CLI pins for local development — intermittently
 *  dies mid-request. The backend resets the connection, Kong turns that into a 502 reading "an
 *  invalid response was received from the upstream server", and the process respawns. It is not
 *  this schema: the statements that trigger it return their rows perfectly well when run through
 *  psql as `authenticated` with the same claims, and hosted Supabase runs a much later PostgREST.
 *
 *  What made it worth handling rather than ignoring is that it does not fail where it happens. A
 *  crash on one call restarts the server underneath the *next* one, so the run reports a boundary
 *  failure in a function that is entirely correct and sends you reading it line by line. Retrying
 *  is safe here only because the suite counts rows afterwards — "nothing was written", "exactly
 *  one still pending" — so a call that did commit before dying is caught by the next assertion
 *  rather than passing quietly. Do not copy this into anything that lacks those counts. */
const UPSTREAM_DIED = 'invalid response was received from the upstream server';

async function rpc(client: SupabaseClient, fn: string, args: Record<string, unknown>): Promise<Result> {
  for (let attempt = 1; ; attempt++) {
    const result = await client.rpc(fn, args);
    if (!result.error?.message.includes(UPSTREAM_DIED) || attempt === 3) return result;
    console.log(`  ..    the local PostgREST died calling ${fn}; retrying (${attempt}/2)`);
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
}

async function count(table: string, column: string, value: string): Promise<number> {
  const { count: n, error } = await admin
    .from(table)
    .select('*', { count: 'exact', head: true })
    .eq(column, value);
  if (error) throw new Error(`counting ${table}: ${error.message}`);
  return n ?? 0;
}

// ------------------------------------------------------------------------------------------- //
// The fixture. Two projects, two members, one flat each, and one flat both can see.
// ------------------------------------------------------------------------------------------- //

const PROJECT_A = '00000000-0000-4000-b000-00000000000a';
const PROJECT_B = '00000000-0000-4000-b000-00000000000b';
const LISTING_A = 'rlscheck-a';
const LISTING_B = 'rlscheck-b';
/** Deliberately never seeded: the case where no `property` row and no link exist yet. */
const LISTING_NEW = 'rlscheck-new';
const EMAIL_A = 'rls-check-a@example.test';
const EMAIL_B = 'rls-check-b@example.test';
const INVITEE = 'rls-check-invitee@example.test';
/** Invited with no project named, which is the invite that has to create one. */
const PLATFORM = 'rls-check-platform@example.test';
/** Invited while there was room, arriving after somebody else took the last place. */
const LATE = 'rls-check-late@example.test';
/** Invited into project B and never signing in, so somebody else calling consume_invites has an
 *  invite in front of them that is not theirs. */
const OUTSIDER = 'rls-check-outsider@example.test';
const EXTRA_USERS = [INVITEE, PLATFORM, LATE, OUTSIDER];
const PASSWORD = 'rls-check-password-9f3a';

async function tearDown() {
  // Order matters only where a foreign key does not cascade. Projects cascade to everything
  // project-scoped; the global rows and the users are cleared explicitly.
  await admin.from('api_usage').delete().in('project_id', [PROJECT_A, PROJECT_B]);
  // Both keep their row when the project goes — `on delete set null`, for the same reason
  // `api_usage` does — so neither is reached by the cascade.
  await admin.from('admin_action').delete().in('subject_project_id', [PROJECT_A, PROJECT_B]);
  await admin.from('travel_claim').delete().in('project_id', [PROJECT_A, PROJECT_B]);
  // Platform invites carry no project and so are not reached by the cascade below.
  await admin.from('invite').delete().in('email', [...EXTRA_USERS, 'another@example.test', EMAIL_A, EMAIL_B]);
  await admin.from('verdict_history').delete().in('project_id', [PROJECT_A, PROJECT_B]);
  await admin.from('project').delete().in('id', [PROJECT_A, PROJECT_B]);
  // A platform invite makes a project of its own, named after the local part of the address, and
  // it belongs to nothing this teardown otherwise reaches.
  await admin.from('project').delete().like('name', 'rls-check-%');
  await admin.from('property_analysis').delete().in('rightmove_id', [LISTING_A, LISTING_B, LISTING_NEW]);
  await admin.from('property').delete().in('rightmove_id', [LISTING_A, LISTING_B, LISTING_NEW]);
  await admin.from('travel_time').delete().eq('origin_postcode', 'RLS 1AA');
  await admin.from('station_walk').delete().eq('postcode', 'RLS 1AA');
  await admin.from('station_point').delete().eq('name', 'RLS Check Station');

  const { data } = await admin.auth.admin.listUsers({ perPage: 1000 });
  const fixtureUsers = (data?.users ?? []).filter((u) => [EMAIL_A, EMAIL_B, ...EXTRA_USERS].includes(u.email ?? ''));

  // Before the users go, not after. `admin_action` nulls both its subject and its actor on a user
  // delete rather than cascading — the point of the log is that it outlives what it is about — so a
  // row cleared up by user id afterwards is a row with no id left to find it by, and every run would
  // leave an all-null orphan behind on a long-lived local database.
  const ids = fixtureUsers.map((u) => u.id);
  if (ids.length > 0) await admin.from('admin_action').delete().in('subject_user_id', ids);

  for (const user of fixtureUsers) await admin.auth.admin.deleteUser(user.id);
}

async function createUser(email: string): Promise<string> {
  const { data, error } = await admin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error || !data.user) throw new Error(`creating ${email}: ${error?.message ?? 'no user returned'}`);
  return data.user.id;
}

function must(context: string, error: { message: string } | null) {
  if (error) throw new Error(`${context}: ${error.message}`);
}

async function setUp(): Promise<{ userA: string; userB: string }> {
  const userA = await createUser(EMAIL_A);
  const userB = await createUser(EMAIL_B);

  // The trigger on auth.users is what creates these. If it did not fire, everything below is
  // meaningless, so this is checked rather than assumed.
  const { data: profiles, error: profileError } = await admin
    .from('profile')
    .select('id, email, is_admin')
    .in('id', [userA, userB]);
  must('reading the profiles the trigger should have made', profileError);
  if ((profiles ?? []).length !== 2) {
    throw new Error(`the on_auth_user_created trigger made ${(profiles ?? []).length} of 2 profiles`);
  }
  if ((profiles ?? []).some((p) => p.is_admin)) {
    throw new Error('a test user came out an admin — admin_email must not contain example.test');
  }

  must('creating the projects', (await admin.from('project').insert([
    { id: PROJECT_A, name: 'RLS check A', created_by: userA },
    { id: PROJECT_B, name: 'RLS check B', created_by: userB },
  ])).error);

  must('creating memberships', (await admin.from('project_member').insert([
    { project_id: PROJECT_A, user_id: userA, role: 'owner' },
    { project_id: PROJECT_B, user_id: userB, role: 'owner' },
  ])).error);

  must('setting active projects', (await admin.from('profile')
    .update({ active_project_id: PROJECT_A }).eq('id', userA)).error);
  must('setting active projects', (await admin.from('profile')
    .update({ active_project_id: PROJECT_B }).eq('id', userB)).error);

  // Two listings, both global rows. A is linked to project A only, B to project B only, which is
  // what makes `record_property` for the wrong one refusable.
  must('creating the listings', (await admin.from('property').insert([
    { rightmove_id: LISTING_A, url: 'https://example.test/a', display_address: 'A Street', postcode: 'RLS 1AA' },
    { rightmove_id: LISTING_B, url: 'https://example.test/b', display_address: 'B Street', postcode: 'RLS 1BB' },
  ])).error);

  must('linking the listings', (await admin.from('project_property').insert([
    { project_id: PROJECT_A, rightmove_id: LISTING_A },
    { project_id: PROJECT_B, rightmove_id: LISTING_B },
  ])).error);

  must('seeding shared facts', (await admin.from('property_analysis').insert([
    { rightmove_id: LISTING_B, model: 'gpt-5.6-terra', status: 'done', image_count: 3, has_floorplan: true },
  ])).error);
  must('seeding shared facts', (await admin.from('station_point')
    .insert({ name: 'RLS Check Station', lat: 51.5, lon: -0.1 })).error);
  must('seeding shared facts', (await admin.from('station_walk')
    .insert({ postcode: 'RLS 1AA', station_name: 'RLS Check Station', seconds: 300 })).error);
  must('seeding shared facts', (await admin.from('travel_time')
    .insert({ origin_postcode: 'RLS 1AA', dest_postcode: 'RLS 2BB', mode: 'transit', seconds: 900, basis: 'weekday-0900' })).error);

  // Project B's opinions — the rows A must never see or touch.
  must("seeding B's place", (await admin.from('place')
    .insert({ project_id: PROJECT_B, label: 'B office', postcode: 'RLS 2BB' })).error);
  must("seeding B's verdict", (await admin.from('verdict')
    .insert({ project_id: PROJECT_B, rightmove_id: LISTING_B, rating: 'love', note: "B's opinion", set_by: userB })).error);
  // Upsert, not insert: the verdict above has already put this flat in B's funnel — that is what
  // `enter_funnel` is for — so this moves the row on rather than creating one, and a `viewed` flat
  // is a more useful thing for A to try to reach than a freshly shortlisted one.
  must("seeding B's funnel", (await admin.from('property_stage')
    .upsert({ project_id: PROJECT_B, rightmove_id: LISTING_B, stage: 'viewed', set_by: userB },
      { onConflict: 'project_id,rightmove_id' })).error);
  must("seeding B's history", (await admin.from('verdict_history')
    .insert({ project_id: PROJECT_B, rightmove_id: LISTING_B, rating: 'maybe', updated_at: new Date().toISOString() })).error);
  must("seeding B's sighting", (await admin.from('search_sighting')
    .insert({ project_id: PROJECT_B, rightmove_id: LISTING_B, hub: 'B hub', url: 'https://example.test/b' })).error);
  // A place B searches around, rather than a `project_hub` row: the two tables are one now (see the
  // `places_are_hubs` migration), and a sweep is keyed on the place it is a sweep of.
  const { data: sweptB, error: sweptError } = await admin.from('place')
    .insert({
      project_id: PROJECT_B,
      label: 'B hub',
      lat: 51.5,
      lon: -0.1,
      rightmove_location_id: 'STATION^1',
      display_location_id: 'B-Hub.html',
      sweep_radius_miles: 1,
    })
    .select('id').single();
  must("seeding B's swept place", sweptError);
  must("seeding B's sweep", (await admin.from('hub_sweep')
    .insert({ place_id: sweptB!.id, hub: 'B hub', project_id: PROJECT_B, last_result_count: 10 })).error);
  must("seeding B's invite", (await admin.from('invite')
    .insert({ email: 'someone-else@example.test', project_id: PROJECT_B, invited_by: userB })).error);
  must("seeding B's spend", (await admin.from('api_usage')
    .insert({ project_id: PROJECT_B, user_id: userB, model: 'gpt-5.6-terra', cost_usd: 1.5, rightmove_id: LISTING_B })).error);

  return { userA, userB };
}

async function signIn(email: string): Promise<SupabaseClient> {
  const client = createClient(url, anonKey, noSession);
  const { error } = await client.auth.signInWithPassword({ email, password: PASSWORD });
  if (error) throw new Error(`signing in as ${email}: ${error.message}`);
  return client;
}

// ------------------------------------------------------------------------------------------- //

async function main() {
  await tearDown();
  const { userA, userB } = await setUp();
  const a = await signIn(EMAIL_A);

  // ----------------------------------------------------------------------------------------- //
  console.log('\ninvite-only — the boundary every policy below is predicated on');

  // Asserted rather than assumed, and asserted here because everything after it is meaningless
  // without it: RLS is `to authenticated` throughout, so a stranger who can create an account has
  // already crossed the only line that matters. It is one setting — `enable_signup = false` under
  // [auth] — and `config.toml` now explicitly leans on it, because the email provider's own switch
  // cannot be used on this CLI without disabling login as well. See the comment there.
  const stranger = createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const signedUp = await stranger.auth.signUp({
    email: 'rls-check-stranger@example.test',
    password: 'rls-check-stranger-4b1e',
  });
  if (signedUp.error) ok(`signUp is refused outright — "${signedUp.error.message}"`);
  else fail('signUp is refused outright', 'a stranger holding only the publishable key got an account');

  const PROJECT_SCOPED = [
    'place', 'verdict', 'verdict_history', 'property_stage', 'search_sighting', 'hub_sweep',
    'project_property', 'invite', 'api_usage',
  ] as const;

  // ----------------------------------------------------------------------------------------- //
  console.log("\nas a member of project A — project B's rows are not there");

  for (const table of PROJECT_SCOPED) {
    empty(`${table}: filtered on B's project id`, await a.from(table).select('*').eq('project_id', PROJECT_B));
    const all = await a.from(table).select('project_id');
    if (all.error) {
      fail(`${table}: an unfiltered read`, `errored: ${all.error.message}`);
    } else {
      const leaked = (all.data as Array<{ project_id: string }>).filter((r) => r.project_id === PROJECT_B);
      is(`${table}: an unfiltered read leaks nothing of B's`, leaked.length, 0);
    }
  }

  // The one project-scoped table keyed differently: B's profile is not A's business either.
  empty("profile: B's profile is invisible to A", await a.from('profile').select('*').eq('id', userB));
  empty("project: B's project is invisible to A", await a.from('project').select('*').eq('id', PROJECT_B));
  empty("project_member: B's membership is invisible to A", await a.from('project_member').select('*').eq('project_id', PROJECT_B));
  empty('admin_email: only admins know who the admins are', await a.from('admin_email').select('*'));

  // ----------------------------------------------------------------------------------------- //
  console.log("\nas a member of project A — every write into project B is refused");

  refused("place: insert into B", await a.from('place').insert({ project_id: PROJECT_B, label: 'mine now', postcode: 'X' }).select());
  refused("place: update B's row", await a.from('place').update({ label: 'mine now' }).eq('project_id', PROJECT_B).select());
  refused("place: delete B's row", await a.from('place').delete().eq('project_id', PROJECT_B).select());

  refused("verdict: insert into B", await a.from('verdict').insert({ project_id: PROJECT_B, rightmove_id: LISTING_B, rating: 'no' }).select());
  refused("verdict: update B's row", await a.from('verdict').update({ rating: 'no', note: 'overwritten' }).eq('project_id', PROJECT_B).select());
  refused("verdict: delete B's row", await a.from('verdict').delete().eq('project_id', PROJECT_B).select());

  refused("property_stage: insert into B", await a.from('property_stage').insert({ project_id: PROJECT_B, rightmove_id: LISTING_B, stage: 'offer_made' }).select());
  refused("property_stage: archive B's flat", await a.from('property_stage').update({ stage: 'archived', archive_reason: 'gone' }).eq('project_id', PROJECT_B).select());
  refused("property_stage: delete B's row", await a.from('property_stage').delete().eq('project_id', PROJECT_B).select());

  refused("search_sighting: insert into B", await a.from('search_sighting').insert({ project_id: PROJECT_B, rightmove_id: 'x', hub: 'h', url: 'u' }).select());
  refused("search_sighting: delete B's rows", await a.from('search_sighting').delete().eq('project_id', PROJECT_B).select());

  // `place` carries the neighbourhoods now as well as the destinations, so this one assertion
  // covers what two used to: stealing a search centre and stealing a commute is the same write.
  refused("place: insert into B", await a.from('place').insert({ project_id: PROJECT_B, label: 'stolen', postcode: 'X' }).select());
  refused("place: delete B's places", await a.from('place').delete().eq('project_id', PROJECT_B).select());

  refused("hub_sweep: delete B's sweeps", await a.from('hub_sweep').delete().eq('project_id', PROJECT_B).select());
  refused("project_property: link B's listing to B", await a.from('project_property').insert({ project_id: PROJECT_B, rightmove_id: LISTING_A }).select());
  refused("project_property: unlink B's listing", await a.from('project_property').delete().eq('project_id', PROJECT_B).select());

  refused('verdict_history: fabricate a disagreement', await a.from('verdict_history').insert({ project_id: PROJECT_A, rightmove_id: LISTING_A, rating: 'no', updated_at: new Date().toISOString() }).select());
  refused('api_usage: invent spend for B', await a.from('api_usage').insert({ project_id: PROJECT_B, user_id: userB, cost_usd: 99 }).select());
  refused('api_usage: erase spend', await a.from('api_usage').delete().eq('project_id', PROJECT_B).select());
  refused("invite: forge an invite into B", await a.from('invite').insert({ email: 'x@example.test', project_id: PROJECT_B }).select());
  refused("project_member: join B", await a.from('project_member').insert({ project_id: PROJECT_B, user_id: userA }).select());
  refused("project: rename B", await a.from('project').update({ name: 'mine' }).eq('id', PROJECT_B).select());
  refused("profile: make B's project my active one", await a.from('profile').update({ active_project_id: PROJECT_B }).eq('id', userA).select());

  // Caps are the point of caps.
  refused('profile: make myself an admin', await a.from('profile').update({ is_admin: true }).eq('id', userA).select());
  refused('profile: raise my own cap', await a.from('profile').update({ monthly_cap_usd: 9999 }).eq('id', userA).select());
  refused("project: raise my project's cap", await a.from('project').update({ monthly_cap_usd: 9999 }).eq('id', PROJECT_A).select());
  refused('admin_set_user_cap: a non-admin raising a cap', await rpc(a, 'admin_set_user_cap', { p_user_id: userA, p_cap: 9999 }));

  console.log("\n  ...and project B's rows are all still there");
  // Two: the office B commutes to, and the place B searches around. One table does both jobs now,
  // so one assertion covers what two used to.
  is("B's places survived", await count('place', 'project_id', PROJECT_B), 2);
  is("B's verdict survived", await count('verdict', 'project_id', PROJECT_B), 1);
  is("B's verdict is unchanged", (await admin.from('verdict').select('note').eq('project_id', PROJECT_B).single()).data?.note, "B's opinion");
  is("B's funnel is untouched", (await admin.from('property_stage').select('stage').eq('project_id', PROJECT_B).single()).data?.stage, 'viewed');
  is("B's sighting survived", await count('search_sighting', 'project_id', PROJECT_B), 1);
  is("B's sweep survived", await count('hub_sweep', 'project_id', PROJECT_B), 1);
  is("B's link survived", await count('project_property', 'project_id', PROJECT_B), 1);
  is("B's invite survived", await count('invite', 'project_id', PROJECT_B), 1);
  is("B's spend survived", await count('api_usage', 'project_id', PROJECT_B), 1);
  is('A did not become an admin', (await admin.from('profile').select('is_admin').eq('id', userA).single()).data?.is_admin, false);
  is("A's cap is unchanged", Number((await admin.from('profile').select('monthly_cap_usd').eq('id', userA).single()).data?.monthly_cap_usd), 20);

  // ----------------------------------------------------------------------------------------- //
  console.log('\nthe five global fact tables: read by anyone signed in, written by nobody');

  const GLOBAL = ['property', 'property_analysis', 'station_point', 'station_walk', 'travel_time'] as const;
  const before: Record<string, number> = {};
  for (const table of GLOBAL) {
    const { count: n } = await admin.from(table).select('*', { count: 'exact', head: true });
    before[table] = n ?? 0;
    if ((n ?? 0) === 0) fail(`${table}: the fixture`, 'nothing in the table, so a DELETE proves nothing');
  }

  allowed('property: A can read a listing only B has linked', await a.from('property').select('*').eq('rightmove_id', LISTING_B).single());
  allowed('property_analysis: A can read an analysis B paid for', await a.from('property_analysis').select('*').eq('rightmove_id', LISTING_B).single());

  refused('property: delete everything', await a.from('property').delete().neq('rightmove_id', '').select());
  refused('property_analysis: delete everything', await a.from('property_analysis').delete().neq('rightmove_id', '').select());
  refused('station_point: delete everything', await a.from('station_point').delete().neq('name', '').select());
  refused('station_walk: delete everything', await a.from('station_walk').delete().neq('postcode', '').select());
  refused('travel_time: delete the whole cache', await a.from('travel_time').delete().neq('origin_postcode', '').select());

  refused('property: insert directly', await a.from('property').insert({ rightmove_id: 'rlscheck-forged', url: 'u', display_address: 'd' }).select());
  refused('property: update a listing directly', await a.from('property').update({ price: '£1 pcm' }).eq('rightmove_id', LISTING_A).select());
  refused('property_analysis: poison an analysis', await a.from('property_analysis').update({ summary: 'lovely' }).eq('rightmove_id', LISTING_B).select());
  refused('travel_time: write the cache directly', await a.from('travel_time').insert({ origin_postcode: 'X', dest_postcode: 'Y', mode: 'transit', seconds: 1 }).select());
  refused('station_point: write directly', await a.from('station_point').insert({ name: 'forged' }).select());
  refused('station_walk: write directly', await a.from('station_walk').insert({ postcode: 'X', station_name: 'Y', seconds: 1 }).select());

  for (const table of GLOBAL) {
    const { count: n } = await admin.from(table).select('*', { count: 'exact', head: true });
    is(`${table}: still holds every row`, n, before[table]);
  }

  // ----------------------------------------------------------------------------------------- //
  console.log('\nthe write RPCs: the only way a client touches a shared fact');

  // The case the whole extension exists for, and the one an earlier version of this file did not
  // cover: a listing nobody has ever opened. `project_property.rightmove_id` references `property`,
  // so a client cannot insert the link first, and `record_property` used to refuse without one.
  // Every fixture listing already existed, so the cycle went unnoticed until someone opened a new
  // flat. Both writes now happen inside the function, in one transaction.
  allowed(
    'record_property: a listing nobody has ever opened',
    await rpc(a, 'record_property', {
      p_project_id: PROJECT_A,
      p_property: { rightmove_id: LISTING_NEW, url: 'https://example.test/new', display_address: 'New Street', price: '£1,800 pcm' },
    }),
  );
  is('...the property row exists', (await admin.from('property').select('display_address').eq('rightmove_id', LISTING_NEW).single()).data?.display_address, 'New Street');
  is('...and the link was made on the same path', await count('project_property', 'rightmove_id', LISTING_NEW), 1);

  refused(
    "record_property: naming someone else's project",
    await rpc(a, 'record_property', {
      p_project_id: PROJECT_B,
      p_property: { rightmove_id: LISTING_B, url: 'https://example.test/b', display_address: 'stolen' },
    }),
  );

  allowed(
    'record_property: a listing my project has opened',
    await rpc(a, 'record_property', {
      p_project_id: PROJECT_A,
      p_property: { rightmove_id: LISTING_A, url: 'https://example.test/a', display_address: 'A Street', price: '£2,000 pcm' },
    }),
  );
  is('...and it actually wrote', (await admin.from('property').select('price').eq('rightmove_id', LISTING_A).single()).data?.price, '£2,000 pcm');

  // Writing a shared fact about a listing another project found is allowed, and D4 accepts it as
  // irreducible: no server can verify a price read off a page. What it must not be is anonymous.
  allowed(
    "record_property: a listing another project found (accepted by D4, and attributed)",
    await rpc(a, 'record_property', {
      p_project_id: PROJECT_A,
      p_property: { rightmove_id: LISTING_B, url: 'https://example.test/b', display_address: 'B Street', price: '£9 pcm' },
    }),
  );
  is('...and the row names who wrote it', (await admin.from('property').select('written_by_project').eq('rightmove_id', LISTING_B).single()).data?.written_by_project, PROJECT_A);

  // The three shared caches: a member may read them and may no longer write them.
  //
  // These used to check validation — a mode nobody planned for, a journey of negative length, half
  // a coordinate — because a signed-in member could write these rows and the RPC was the only thing
  // standing between them and the table. That validation is still there and still right, but it was
  // never the interesting question, because it can only ask whether a number is *plausible*. Whether
  // the journey really takes 41 minutes was knowable only to whoever asked TfL.
  //
  // `travel_time` and `station_point` are global, shared by every project by design. So one member
  // writing a wrong number was one member writing a fact everyone else reads, permanently, with
  // nothing detecting it. The `travel` Edge Function makes the calls now and holds the only grant.
  denied('cache_travel: a member writing a journey time', await rpc(a, 'cache_travel', { p_origin_postcode: 'RLS 1AA', p_dest_postcode: 'RLS 2BB', p_mode: 'walking', p_seconds: 1200, p_basis: 'anytime' }));
  denied('cache_travel: ...even a plausible one to a place they can see', await rpc(a, 'cache_travel', { p_origin_postcode: 'RLS 1AA', p_dest_postcode: 'RLS 2BB', p_mode: 'transit', p_seconds: 2400, p_changes: 1, p_basis: 'weekday 09:00' }));
  // The model's writers and the revision they compare against: service role only. A member who
  // could call set_project_model could post hand-written weights every surface then trusts.
  denied('project_training_revision: a member reading the training revision', await rpc(a, 'project_training_revision', { p_project_id: PROJECT_A }));
  denied('set_project_model: a member writing a model', await rpc(a, 'set_project_model', { p_project_id: PROJECT_A, p_model: {}, p_version: 1, p_label_mode: 'love-vs-no', p_n_examples: 1 }));
  denied('clear_project_model: a member deleting a model', await rpc(a, 'clear_project_model', { p_project_id: PROJECT_A }));
  denied('cache_station_point: a member moving a station', await rpc(a, 'cache_station_point', { p_name: 'RLS Check Station', p_lat: 51.5, p_lon: -0.1, p_lines: ['northern'] }));
  denied('cache_station_walk: a member writing a walk', await rpc(a, 'cache_station_walk', { p_postcode: 'RLS 1AA', p_station_name: 'RLS Check Station', p_seconds: 400 }));

  // The service role may, because it is the `travel` Edge Function. Written here rather than
  // assumed, because the first deploy of that function cached nothing at all: the RPCs guarded on
  // `auth.uid() is not null`, which is false for the service role — it is not a person and has no
  // profile — so the one caller that should have been allowed was the one being refused. Silently,
  // since a failed cache write is caught so it cannot turn a good answer into a bad one.
  //
  // These two rows are also what the anon section below checks are still standing afterwards.
  allowed('cache_travel: the travel function writing a leg', await rpc(admin, 'cache_travel', { p_origin_postcode: 'RLS 1AA', p_dest_postcode: 'RLS 2BB', p_mode: 'walking', p_seconds: 1200, p_basis: 'anytime' }));
  allowed('cache_travel: ...and a transit one', await rpc(admin, 'cache_travel', { p_origin_postcode: 'RLS 1AA', p_dest_postcode: 'RLS 2BB', p_mode: 'transit', p_seconds: 2400, p_changes: 1, p_basis: 'weekday 09:00' }));
  allowed('cache_station_point: the travel function resolving a station', await rpc(admin, 'cache_station_point', { p_name: 'RLS Check Station', p_lat: 51.5, p_lon: -0.1, p_lines: ['northern'] }));
  allowed('cache_station_walk: ...and measuring the walk to it', await rpc(admin, 'cache_station_walk', { p_postcode: 'RLS 1AA', p_station_name: 'RLS Check Station', p_seconds: 400 }));
  denied('cache_travel: a journey of negative length, even from the server', await rpc(admin, 'cache_travel', { p_origin_postcode: 'RLS 1AA', p_dest_postcode: 'RLS 2BB', p_mode: 'walking', p_seconds: -5 }));
  denied('cache_station_point: half a coordinate, even from the server', await rpc(admin, 'cache_station_point', { p_name: 'RLS Half Station', p_lat: 51.5 }));

  // And reading them is still exactly what every surface does.
  allowed('travel_time: a member reading the shared cache', await a.from('travel_time').select('origin_postcode').limit(1));
  allowed('station_point: a member reading the shared cache', await a.from('station_point').select('name').limit(1));
  allowed('station_walk: a member reading the shared cache', await a.from('station_walk').select('postcode').limit(1));

  refused('claim_analysis: a client claiming its own budget', await rpc(a, 'claim_analysis', { p_rightmove_id: LISTING_A, p_project_id: PROJECT_A, p_user_id: userA }));
  refused('record_api_usage: a client writing its own spend', await rpc(a, 'record_api_usage', { p_project_id: PROJECT_A, p_user_id: userA, p_model: 'gpt-5.6-terra', p_input_tokens: 1, p_cached_input_tokens: 0, p_output_tokens: 1 }));

  // The travel reservation, which is `claim_analysis`'s problem on TfL's allowance rather than on
  // money. `denied` rather than `refused` for both: one returns jsonb and the other returns void, so
  // "the call affected nothing" is what success looks like too — which is the blind spot the four
  // cache assertions above sat in for a deploy. A member who could claim would reserve somebody
  // else's whole minute; one who could release would record calls nobody made against them.
  denied('claim_travel_calls: a member reserving TfL capacity', await rpc(a, 'claim_travel_calls', { p_user_id: userA, p_project_id: PROJECT_A, p_calls: 1, p_limit: 300, p_window: '60 seconds' }));
  denied('release_travel_calls: a member recording travel calls', await rpc(a, 'release_travel_calls', { p_reservation: 1, p_user_id: userA, p_project_id: PROJECT_A, p_made: 1 }));

  // The audit log.
  //
  // THE ORDER HERE IS THE ASSERTION. A row is written first, and only then is the member asked to
  // read the table — because `nothing()` passes on an empty table, and the suite tears down and
  // starts from a fresh `supabase start` in CI, so a read asserted before anything had been logged
  // would have passed identically against `using (true)` or against no policy at all. That is the
  // same shape as the four cache assertions that sat green for a deploy against a grant that had
  // never been revoked.
  //
  // The log records both figures, because "raised to 200" is half an answer: from 150 is a decision
  // and from 5 is an incident. The starting cap is read rather than written as a literal — it is a
  // column default nobody here owns.
  const capBefore = Number((await admin.from('project').select('monthly_cap_usd').eq('id', PROJECT_A).single()).data?.monthly_cap_usd);
  allowed('admin_set_project_cap: the server raising a cap', await rpc(admin, 'admin_set_project_cap', { p_project_id: PROJECT_A, p_cap: capBefore + 1 }));
  const logged = (await admin.from('admin_action').select('action, previous_value, new_value').eq('subject_project_id', PROJECT_A).order('id', { ascending: false }).limit(1)).data?.[0];
  is('the audit log recorded what changed', [logged?.action, Number(logged?.previous_value), Number(logged?.new_value)], ['set_project_cap', capBefore, capBefore + 1]);

  // ...and now that there is provably a row in it, what a member can see of it. Not their own rows,
  // as `api_usage` would give them: nothing. What the log answers is which admin did this, and
  // showing that to the person whose cap moved would make it a notification.
  nothing('admin_action: a member reading the audit log, which is not empty', await a.from('admin_action').select('*'));
  refused('admin_action: a member writing an entry', await a.from('admin_action').insert({ action: 'set_project_cap', subject_project_id: PROJECT_A, new_value: 999 }).select());
  denied('admin_set_project_cap: a member raising their own project cap', await rpc(a, 'admin_set_project_cap', { p_project_id: PROJECT_A, p_cap: 999 }));
  denied('admin_set_max_members: a member raising their own member limit', await rpc(a, 'admin_set_max_members', { p_project_id: PROJECT_A, p_max: 99 }));
  is('the cap did not move', Number((await admin.from('project').select('monthly_cap_usd').eq('id', PROJECT_A).single()).data?.monthly_cap_usd), capBefore + 1);
  is('and the member wrote no entry', (await admin.from('admin_action').select('id').eq('new_value', 999)).data?.length, 0);

  // A cap named on a project that does not exist used to report success and change nothing, which
  // an audit row would then have recorded as a change that happened.
  denied('admin_set_project_cap: a project that is not there', await rpc(admin, 'admin_set_project_cap', { p_project_id: '00000000-0000-4000-b000-0000000000ff', p_cap: 12 }));
  await admin.rpc('admin_set_project_cap', { p_project_id: PROJECT_A, p_cap: capBefore });

  // ----------------------------------------------------------------------------------------- //
  // This section is what makes the publishable key safe to ship, and the reasoning is written here
  // because this is where somebody will be standing when they wonder about it.
  //
  // That key is inside `apps/web/public/rightmove-house-hunt.zip`, which anybody may download, so
  // anybody may read it out of the bundle. It is *publishable* — that is what the name means — and
  // today it authorises nothing: every policy is `to authenticated` and `anon` holds no grant, so
  // the key opens a door into an empty room. It is not a secret that has leaked and it is not worth
  // rotating, and nothing here should be redesigned to hide it.
  //
  // What it does do is set up a failure. One policy written `to public` instead of `to authenticated`
  // — a single word, in a migration that reads perfectly and denies nothing visible — would hand the
  // database to everyone holding the zip, and there is no other symptom: the app works, the tests
  // pass, and the only sign is a policy line nobody re-reads. That is the whole reason the block
  // below exists rather than being taken as read. It is not belt-and-braces on a boundary already
  // proved elsewhere; for the anon role it *is* the boundary. So it must keep running in CI
  // (`.github/workflows/check.yml`), and a new table or RPC belongs in the lists below on the day
  // it is added.
  //
  // Recorded against issue #70, which the owner settled as needing no code change — only that the
  // argument stop living in a backlog entry and start living beside the check it is about.
  console.log('\nthe anon role — the key that ships in the bundle — holds nothing');

  for (const table of [...PROJECT_SCOPED, ...GLOBAL, 'profile', 'project', 'project_member', 'model_price', 'admin_email', 'admin_action', 'travel_claim'] as const) {
    nothing(`anon: read ${table}`, await anon.from(table).select('*'));
  }
  refused('anon: insert a place', await anon.from('place').insert({ project_id: PROJECT_A, label: 'x', postcode: 'x' }).select());
  refused('anon: insert a verdict', await anon.from('verdict').insert({ project_id: PROJECT_A, rightmove_id: LISTING_A, rating: 'no' }).select());
  refused('anon: empty the travel cache', await anon.from('travel_time').delete().neq('origin_postcode', '').select());
  refused('anon: delete every property', await anon.from('property').delete().neq('rightmove_id', '').select());
  refused('anon: call record_property', await rpc(anon, 'record_property', { p_project_id: PROJECT_A, p_property: { rightmove_id: LISTING_A, url: 'u', display_address: 'd' } }));
  refused('anon: call cache_travel', await rpc(anon, 'cache_travel', { p_origin_postcode: 'X', p_dest_postcode: 'Y', p_mode: 'walking', p_seconds: 60 }));
  refused('anon: call claim_analysis', await rpc(anon, 'claim_analysis', { p_rightmove_id: LISTING_A, p_project_id: PROJECT_A, p_user_id: userA }));
  denied('anon: call claim_travel_calls', await rpc(anon, 'claim_travel_calls', { p_user_id: userA, p_project_id: PROJECT_A, p_calls: 1, p_limit: 300, p_window: '60 seconds' }));
  denied('anon: call admin_set_project_cap', await rpc(anon, 'admin_set_project_cap', { p_project_id: PROJECT_A, p_cap: 999 }));
  is('the travel cache is intact after anon', await count('travel_time', 'origin_postcode', 'RLS 1AA'), 2);

  // ----------------------------------------------------------------------------------------- //
  console.log('\nthe recursion trap: helpers called from inside a policy');

  // `profile`'s own policy calls is_admin(), which reads `profile`. An ordinary function here
  // fails with "infinite recursion detected in policy for relation profile" — an error naming the
  // relation and nothing about the cause. This is the check that would catch losing SECURITY
  // DEFINER on either helper in a later edit.
  const ownProfile = await a.from('profile').select('id, email, is_admin').eq('id', userA).single();
  if (ownProfile.error) fail('profile: reading my own row', `is_admin() recursed or was refused: ${ownProfile.error.message}`);
  else ok('profile: reading my own row resolves without recursion');

  const ownProject = await a.from('project').select('id, name').eq('id', PROJECT_A).single();
  if (ownProject.error) fail('project: reading my own project', `is_member() failed: ${ownProject.error.message}`);
  else ok('project: is_member() resolves from inside a policy');

  // ----------------------------------------------------------------------------------------- //
  console.log('\nand the things that must still work — a database that refuses everything is not secure, it is broken');

  allowed('place: adding one to my own project', await a.from('place').insert({ project_id: PROJECT_A, label: 'A office', postcode: 'RLS 3CC' }).select());
  allowed('verdict: rating a flat in my own project', await a.from('verdict').insert({ project_id: PROJECT_A, rightmove_id: LISTING_A, rating: 'maybe', note: 'worth a look', set_by: userA }).select());
  refused('verdict: attributing a rating to someone else', await a.from('verdict').update({ set_by: userB }).eq('project_id', PROJECT_A).select());
  allowed('verdict: changing it', await a.from('verdict').update({ rating: 'love' }).eq('project_id', PROJECT_A).eq('rightmove_id', LISTING_A).select());
  is('...and the previous rating went to history', await count('verdict_history', 'project_id', PROJECT_A), 1);
  // This used to upsert `project_property` directly, which is a call no client makes any more:
  // `record_property` creates the link, because the foreign key means neither write can go first
  // on its own. Two reasons it had to go rather than merely being redundant with the
  // `record_property` block above. It asserted a path we deleted, and it *crashes PostgREST
  // 12.0.1* — the backend resets the connection, Kong reports a 502, and the server restarts
  // mid-run, which then fails an unrelated invite assertion thirty lines later and sends you
  // looking for a bug in `create_invite`. The schema is not at fault: the identical statement run
  // through psql as `authenticated` with a member's claims returns the row.
  is('project_property: recording a listing is what links it', await count('project_property', 'rightmove_id', LISTING_NEW), 1);

  // ----------------------------------------------------------------------------------------- //
  console.log('\nthe funnel, and the one direction it is coupled to a verdict');

  // `enter_funnel` is a trigger rather than a follow-up write from whichever client rated the flat,
  // so this is the only place it can be asserted at all — and it is worth asserting, because a
  // trigger that silently stopped firing looks exactly like a hunt where nobody has liked anything.
  const stageOfA = async (rightmoveId: string) =>
    (await admin.from('property_stage').select('stage').eq('project_id', PROJECT_A).eq('rightmove_id', rightmoveId).maybeSingle()).data?.stage ?? null;

  is('liking a flat entered it into the funnel', await stageOfA(LISTING_A), 'shortlisted');
  allowed('property_stage: booking a viewing', await a.from('property_stage').update({ stage: 'viewing_booked', set_by: userA }).eq('project_id', PROJECT_A).eq('rightmove_id', LISTING_A).select());
  refused('property_stage: attributing a move to someone else', await a.from('property_stage').update({ set_by: userB }).eq('project_id', PROJECT_A).select());
  // `denied` rather than `refused`: this one must fail outright. An archive with no reason is a
  // check constraint, not a policy, and "affected nothing" would be a false pass.
  denied('property_stage: archiving without saying why', await a.from('property_stage').update({ stage: 'archived' }).eq('project_id', PROJECT_A).eq('rightmove_id', LISTING_A).select());

  // The rule the whole separation rests on: changing your mind about a flat you have already
  // viewed does not rewind the funnel — you really did book that viewing — and the rating moves on
  // its own, which is what keeps the score learning from what you actually thought.
  allowed('verdict: changing your mind after a viewing is booked', await a.from('verdict').update({ rating: 'no' }).eq('project_id', PROJECT_A).eq('rightmove_id', LISTING_A).select());
  is('...leaves the booked viewing on the record', await stageOfA(LISTING_A), 'viewing_booked');

  // The flow the insert policy nearly broke, and the reason it is written the way it is. A flat
  // rated `no` above, whose stage row predates that: archiving it is an upsert, and an upsert is
  // judged by the INSERT policy even when it takes the update path — so the first version of
  // `stage_needs_a_like`, which asked only for a current like, refused it. Recording how a flat
  // ended is exactly what the funnel is for, and it would have shipped unable to.
  allowed('property_stage: archiving a flat we have gone off, long after the like', await a.from('property_stage').upsert({ project_id: PROJECT_A, rightmove_id: LISTING_A, stage: 'archived', archive_reason: 'passed', set_by: userA }, { onConflict: 'project_id,rightmove_id' }).select());
  is('...and it records why', await stageOfA(LISTING_A), 'archived');

  // And the other half: a flat that never got past the step the like itself created leaves the
  // funnel when the like does. Otherwise every rejected flat would sit in the funnel for good.
  allowed('verdict: liking a flat nothing has happened to yet', await a.from('verdict').insert({ project_id: PROJECT_A, rightmove_id: LISTING_NEW, rating: 'love', set_by: userA }).select());
  is('...puts it in the funnel', await stageOfA(LISTING_NEW), 'shortlisted');
  allowed('verdict: and taking the like back', await a.from('verdict').update({ rating: 'no' }).eq('project_id', PROJECT_A).eq('rightmove_id', LISTING_NEW).select());
  is('...takes it back out again', await stageOfA(LISTING_NEW), null);

  // Entering the funnel is what liking a place does, and nothing else may do it. A member writing
  // straight through PostgREST — no verdict, no trigger — must not be able to claim a viewing on a
  // flat nobody has judged: the funnel bar and the triage pile both read "not in the funnel" as
  // "nobody has liked this".
  refused('property_stage: inventing a viewing for an unrated flat', await a.from('property_stage').insert({ project_id: PROJECT_A, rightmove_id: LISTING_NEW, stage: 'viewed', set_by: userA }).select());
  is('...and it stayed out of the funnel', await stageOfA(LISTING_NEW), null);
  allowed('profile: setting my own display name', await a.from('profile').update({ display_name: 'A' }).eq('id', userA).select());
  allowed('project: renaming my own project', await a.from('project').update({ name: 'A renamed' }).eq('id', PROJECT_A).select());
  allowed('spend_summary: reading my own budget', await rpc(a, 'spend_summary', { p_project_id: PROJECT_A }));
  allowed('model_price: reading the prices', await a.from('model_price').select('*'));

  // ----------------------------------------------------------------------------------------- //
  console.log('\nthe cap, from the service role that actually calls it');

  const claim = await rpc(admin, 'claim_analysis', { p_rightmove_id: LISTING_A, p_project_id: PROJECT_A, p_user_id: userA });
  is('an affordable listing is claimed', (claim.data as { status?: string } | null)?.status, 'claimed');
  const second = await rpc(admin, 'claim_analysis', { p_rightmove_id: LISTING_A, p_project_id: PROJECT_A, p_user_id: userA });
  is('a live claim on the same listing is busy, not a second charge', (second.data as { status?: string } | null)?.status, 'busy');

  must('lowering the cap', (await rpc(admin, 'admin_set_project_cap', { p_project_id: PROJECT_A, p_cap: 0.05 })).error);
  const capped = await rpc(admin, 'claim_analysis', { p_rightmove_id: LISTING_B, p_project_id: PROJECT_A, p_user_id: userA });
  const cappedResult = capped.data as { status?: string; scope?: string } | null;
  is('under the cap by less than one estimate, the claim is refused', cappedResult?.status, 'capped');
  is('...and it names the scope', cappedResult?.scope, 'project');

  // ----------------------------------------------------------------------------------------- //
  console.log('\nthe member ceiling, which is an invariant rather than something cleaned up afterwards');

  refused('create_invite: a member calling it directly', await rpc(a, 'create_invite', { p_email: 'x@example.test', p_project_id: PROJECT_A, p_invited_by: userA }));

  must('lowering the ceiling', (await rpc(admin, 'admin_set_max_members', { p_project_id: PROJECT_A, p_max: 2 })).error);
  const invited = await rpc(admin, 'create_invite', { p_email: INVITEE, p_project_id: PROJECT_A, p_invited_by: userA });
  const first = invited.data as { status?: string; members?: number; pending?: number } | null;
  is('a project with room admits an invite', first?.status, 'invited');
  is('...counting the member already in it', first?.members, 1);

  const full = await rpc(admin, 'create_invite', { p_email: 'another@example.test', p_project_id: PROJECT_A, p_invited_by: userA });
  const fullResult = full.data as { status?: string; members?: number; pending?: number; max_members?: number } | null;
  is('one member plus one pending invite fills a project of two', fullResult?.status, 'at-capacity');
  is('...and it says how many are in', fullResult?.members, 1);
  is('...and how many are outstanding', fullResult?.pending, 1);
  is('...and what the limit is', fullResult?.max_members, 2);
  is('nothing was written', await count('invite', 'project_id', PROJECT_A), 1);

  const again = await rpc(admin, 'create_invite', { p_email: INVITEE, p_project_id: PROJECT_A, p_invited_by: userA });
  is('inviting the same address twice reports the invite it already has', (again.data as { status?: string } | null)?.status, 'already-invited');

  const member = await rpc(admin, 'create_invite', { p_email: EMAIL_A, p_project_id: PROJECT_A, p_invited_by: userA });
  is('inviting somebody already in the project says so', (member.data as { status?: string } | null)?.status, 'already-a-member');

  // An invite that lapsed a month ago used to block a fresh one to the same address with a bare
  // 409, because the unique index is on `pending` and nothing aged anything out.
  must('backdating the invite', (await admin.from('invite')
    .update({ expires_at: new Date(Date.now() - 86_400_000).toISOString() })
    .eq('project_id', PROJECT_A)).error);
  const afterExpiry = await rpc(admin, 'create_invite', { p_email: INVITEE, p_project_id: PROJECT_A, p_invited_by: userA });
  is('a lapsed invite does not block a fresh one', (afterExpiry.data as { status?: string } | null)?.status, 'invited');
  const statuses = (await admin.from('invite').select('status').eq('project_id', PROJECT_A)).data as Array<{ status: string }> | null;
  is('...and the lapsed one now reads expired rather than pending', (statuses ?? []).filter((r) => r.status === 'expired').length, 1);
  is('...with exactly one still pending', (statuses ?? []).filter((r) => r.status === 'pending').length, 1);

  // ----------------------------------------------------------------------------------------- //
  console.log('\nconsuming an invite, which nothing did until it was noticed');

  // `invite.accepted_at` existed, three comments said consumption happened on first sign-in, and no
  // code anywhere inserted a membership. An invited person verified their code, signed in
  // perfectly, and landed in no project — permanently, and with nothing on screen or in any log
  // saying why. So these are the assertions that would have caught it, and the first of them is
  // the whole feature.
  //
  // PROJECT_A stands at one member with room for two and a live invite for INVITEE, left by the
  // section above. The invited user exists in `auth.users` because the invite Edge Function creates
  // them there through the Admin API; that is what this stands in for.
  await createUser(INVITEE);
  const invitee = await signIn(INVITEE);
  const consumed = (await rpc(invitee, 'consume_invites', {})).data as
    | { joined?: string[]; at_capacity?: string[]; active_project?: string | null }
    | null;
  is('an invited user who signs in joins the project', consumed?.joined, [PROJECT_A]);
  is('...and is landed in it', consumed?.active_project, PROJECT_A);
  is('...as a member row that actually exists', await count('project_member', 'project_id', PROJECT_A), 2);
  const inviteeProfile = await admin.from('profile').select('active_project_id').eq('email', INVITEE).single();
  is('...recorded on the profile, not only in the answer', inviteeProfile.data?.active_project_id, PROJECT_A);
  const acceptedRows = (await admin.from('invite').select('status').eq('email', INVITEE)).data as Array<{ status: string }> | null;
  is('...and the invite reads accepted', (acceptedRows ?? []).filter((r) => r.status === 'accepted').length, 1);

  // Idempotent. It is called on every successful sign-in, so the second time has to be nothing.
  const twice = (await rpc(invitee, 'consume_invites', {})).data as { joined?: string[] } | null;
  is('consuming again joins nothing', twice?.joined, []);

  // A caller with nothing outstanding. There is no argument to this function precisely so that it
  // cannot be pointed at somebody else's invite, and the way to demonstrate that is to leave one
  // outstanding for a third party and have somebody else call it.
  must("planting an invite for a third party into B", (await admin.from('invite')
    .insert({ email: OUTSIDER, project_id: PROJECT_B, invited_by: userB })).error);
  const b = await signIn(EMAIL_B);
  const notMine = (await rpc(b, 'consume_invites', {})).data as { joined?: string[] } | null;
  is('a user with no invite of their own joins nothing', notMine?.joined, []);
  is("...and somebody else's invite is still waiting for them", await count('invite', 'email', OUTSIDER), 1);
  const untouched = (await admin.from('invite').select('status').eq('email', OUTSIDER).single()).data;
  is('...still pending', untouched?.status, 'pending');

  // An invite issued when there was room, arriving after the last place went. Deliberately left
  // pending rather than revoked: throwing away somebody's place for being slow is worse than
  // telling them the hunt is full and letting a member make room.
  must('filling the project', (await admin.from('invite')
    .insert({ email: LATE, project_id: PROJECT_A, invited_by: userA })).error);
  await createUser(LATE);
  const late = await signIn(LATE);
  const atCapacity = (await rpc(late, 'consume_invites', {})).data as
    | { joined?: string[]; at_capacity?: string[] }
    | null;
  is('an invite to a project that filled up joins nothing', atCapacity?.joined, []);
  is('...and says which project was full', atCapacity?.at_capacity, [PROJECT_A]);
  is('...leaving the membership at the ceiling', await count('project_member', 'project_id', PROJECT_A), 2);
  const stillWaiting = (await admin.from('invite').select('status').eq('email', LATE).eq('project_id', PROJECT_A).single()).data;
  is('...with the invite still pending rather than thrown away', stillWaiting?.status, 'pending');

  // A platform invite carries no project and promises one.
  must('planting a platform invite', (await admin.from('invite')
    .insert({ email: PLATFORM, project_id: null, invited_by: userA })).error);
  await createUser(PLATFORM);
  const platform = await signIn(PLATFORM);
  const made = (await rpc(platform, 'consume_invites', {})).data as
    | { joined?: string[]; active_project?: string | null }
    | null;
  is('a platform invite creates a house hunt', made?.joined?.length, 1);
  is('...and lands them in it', made?.active_project, made?.joined?.[0]);
  const newProject = await admin.from('project').select('name').eq('id', made?.active_project ?? '').single();
  is('...named for them rather than left blank', newProject.data?.name, "rls-check-platform's house hunt");

  // ----------------------------------------------------------------------------------------- //
  console.log('\nrevoking, which used to be a column grant a member could write anything through');

  // `grant update (status) on invite` plus a membership-only policy let a member set any of the
  // project's invites to any value. Flipping pending to accepted frees a place against the ceiling
  // with nobody joining, repeatedly; flipping expired back to pending resurrects a row
  // `create_invite` refused to write. Either way `members + pending` stops meaning what the
  // advisory lock is carefully keeping true, and the ceiling holds only against the front door.
  const pendingId = (await admin.from('invite').select('id').eq('email', LATE).eq('project_id', PROJECT_A).single()).data?.id;
  refused('invite: a member writing a status directly',
    await a.from('invite').update({ status: 'accepted' }).eq('id', pendingId).select());
  const afterForge = (await admin.from('invite').select('status').eq('id', pendingId).single()).data;
  is('...and it is still pending', afterForge?.status, 'pending');

  const revoked = (await rpc(a, 'revoke_invite', { p_invite_id: pendingId })).data as { status?: string } | null;
  is('a member may revoke a pending invite of their own project', revoked?.status, 'revoked');

  const acceptedId = (await admin.from('invite').select('id').eq('email', INVITEE).eq('status', 'accepted').single()).data?.id;
  const onAccepted = (await rpc(a, 'revoke_invite', { p_invite_id: acceptedId })).data as { status?: string; was?: string } | null;
  // Revoking an accepted invite would leave the member in place with the paperwork saying
  // otherwise. Removing somebody is a different act, with a different confirmation.
  is('revoking an accepted invite is refused as a state, not done', onAccepted?.status, 'not-pending');
  is('...saying what it was', onAccepted?.was, 'accepted');
  const acceptedStill = (await admin.from('invite').select('status').eq('id', acceptedId).single()).data;
  is('...and it is untouched', acceptedStill?.status, 'accepted');

  const othersId = (await admin.from('invite').select('id').eq('project_id', PROJECT_B).eq('email', OUTSIDER).single()).data?.id;
  refused("revoke_invite: another project's invite", await rpc(a, 'revoke_invite', { p_invite_id: othersId }));

  // ----------------------------------------------------------------------------------------- //
  console.log("\nspend_summary answered for anybody whose id you could name");

  // It checked that the caller belonged to `p_project_id` and then took `p_user_id` on trust,
  // returning that person's spend across EVERY project plus their personal cap. Co-members' ids are
  // readable from `project_member`, so the argument was not a secret. The `default auth.uid()`
  // described how the client calls it, which is not a constraint on anybody who does not.
  must("giving B a distinctive cap", (await rpc(admin, 'admin_set_user_cap', { p_user_id: userB, p_cap: 7 })).error);
  must("giving A a different one", (await rpc(admin, 'admin_set_user_cap', { p_user_id: userA, p_cap: 33 })).error);
  must("recording spend against B", (await admin.from('api_usage')
    .insert({ project_id: PROJECT_B, user_id: userB, model: 'gpt-5.6-terra', cost_usd: 4.25 })).error);

  const asked = (await rpc(a, 'spend_summary', { p_project_id: PROJECT_A, p_user_id: userB })).data as
    | { user_cap?: number; user_spent?: number; error?: string }
    | null;
  is("naming another member's id gets your own cap back", Number(asked?.user_cap), 33);
  is('...and your own spend, not theirs', Number(asked?.user_spent), 0);

  await tearDown();

  console.log(`\n${checks - failures}/${checks} checks passed`);
  if (failures > 0) {
    console.log(`${failures} FAILED — the boundary is not where the specs say it is`);
    process.exit(1);
  }
}

main().catch(async (error: unknown) => {
  console.error(`\ncheck:rls could not run: ${error instanceof Error ? error.message : String(error)}`);
  await tearDown().catch(() => {});
  process.exit(1);
});
