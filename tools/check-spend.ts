/** The $20 cap, asserted against a real Postgres.
 *
 *  This is the check that stands between a bug and somebody else's money. Everything it tests is
 *  in the database rather than in the extension — `claim_analysis`, `record_api_usage`,
 *  `month_start_london`, `spend_summary` — and none of it can be tested as a pure function,
 *  because the whole design rests on transactions, advisory locks and what two callers see of each
 *  other. A cap that is enforced in a single-threaded test and nowhere else is not a cap.
 *
 *  ## The race this exists for
 *
 *  The first draft of design D9 put the check "inside the claim transaction" and called it done.
 *  `claim_analysis` serialises on the *listing*: two requests for the same `rightmove_id` cannot
 *  both win. Requests for *different* listings never contend at all — so a paced sweep opening
 *  five unanalysed flats near the cap had five transactions each read the same under-cap total and
 *  all proceed. The budget is shared state and the claim never touched it.
 *
 *  The fix was to lock the budget rather than the listing (`pg_advisory_xact_lock` on the project,
 *  then the user, in that fixed order) and to reserve an estimate against it. So the assertion
 *  that matters here is **concurrent claims for different listing ids**, fired at once through
 *  separate HTTP requests so they are genuinely separate transactions, with a cap that only some
 *  of them fit under. Anything less would pass against the broken version.
 *
 *  It is run several times over. A race that passes once has told you almost nothing.
 *
 *  The assertion was checked against the bug it is for rather than merely written: a copy of
 *  `claim_analysis` with the two `pg_advisory_xact_lock` calls removed claimed **6 of 6** listings
 *  against a budget with room for 3, where the shipped one claims exactly 3. A concurrency test
 *  nobody has seen fail is a concurrency test nobody has tested.
 *
 *  ## What this does NOT prove, and must not be read as proving
 *
 *  **The $20 cap is a soft cap.** `claim_analysis` reserves a fixed `ESTIMATE_USD` and the real
 *  cost is recorded afterwards, with no bound on how many images, how many bytes or how many output
 *  tokens one call may produce. So "recorded spend never exceeds the cap" is false, and a suite
 *  asserting it would be lying about somebody's money in the reassuring direction. What is true is
 *  the weaker pair, and both are asserted below: concurrency cannot widen the overshoot, because
 *  every concurrent call has reserved against the same locked budget; and the first call to take
 *  the total past the cap is the last one allowed. The gap is one unusually expensive call, and
 *  closing it needs a bound in the Edge Function rather than another test here.
 *
 *  ## Running it
 *
 *  Against a LOCAL Supabase only — it writes and deletes. Deliberately NOT in `check:all`, which
 *  stays Docker-free and finishes in seconds; this is the same tier as `check:rls`.
 *
 *      supabase start
 *      pnpm check:spend
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { localCredentials } from './supabase-local';

const { url, anonKey, serviceKey } = localCredentials();

/** Service role throughout. `claim_analysis` and `record_api_usage` are granted to `service_role`
 *  alone — the extension must never be able to reserve budget with no call behind it — so calling
 *  them as anyone else is a different test, and `check:rls` is where it lives. */
const db: SupabaseClient = createClient(url, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// ------------------------------------------------------------------------------------------- //
// The harness. Loud on both sides: a check that could not run says so rather than passing.
// ------------------------------------------------------------------------------------------- //

let checks = 0;
let failures = 0;

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

/** Money, to the cent the schema stores it to. Comparing floats exactly is how a correct pricing
 *  test starts failing for a reason that has nothing to do with pricing. */
function isMoney(name: string, actual: unknown, expected: number) {
  const value = Number(actual);
  if (Number.isFinite(value) && Math.abs(value - expected) < 1e-6) ok(`${name} (${value})`);
  else fail(name, `expected ${expected}, got ${JSON.stringify(actual)}`);
}

function isTime(name: string, actual: unknown, expectedIso: string) {
  const got = new Date(String(actual)).getTime();
  const want = new Date(expectedIso).getTime();
  if (got === want) ok(`${name} (${new Date(got).toISOString()})`);
  else fail(name, `expected ${expectedIso}, got ${String(actual)}`);
}

/** PostgREST 12.0.1 — the version the Supabase CLI pins locally — intermittently dies mid-request
 *  and Kong turns that into a 502. It is not this schema; hosted Supabase runs a much later
 *  version. `check:rls` documents it at length.
 *
 *  Retried only for the calls that *set up* a section — capping a project, recording spend, reading
 *  a total. Never for `claim_analysis`: a claim that died after committing and before answering is
 *  exactly the ambiguity this suite is counting, and retrying it would turn a lost reply into a
 *  second reservation and a concurrency assertion into a coin toss. Those fail loudly instead. */
const UPSTREAM_DIED = 'invalid response was received from the upstream server';

async function survive<T extends { error: { message: string } | null }>(
  what: string,
  // `PromiseLike`, not `Promise`: a PostgREST query builder is a thenable that only becomes a
  // request when it is awaited, which is exactly what makes retrying it possible.
  call: () => PromiseLike<T>,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    const result = await call();
    if (!result.error?.message.toLowerCase().includes(UPSTREAM_DIED) || attempt === 3) return result;
    console.log(`  ..    the local PostgREST died ${what}; retrying (${attempt}/2)`);
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
}

/** Every RPC in this suite goes through here so a transport failure is never mistaken for a
 *  refusal. `claim_analysis` answering "capped" and PostgREST falling over are the same shape to a
 *  caller that only looks at whether it got a claim, and one of them is a passing test. */
async function rpc(fn: string, args: Record<string, unknown>): Promise<any> {
  const { data, error } = await survive(`calling ${fn}`, () => db.rpc(fn, args));
  if (error) throw new Error(`${fn}(${JSON.stringify(args)}) failed: ${error.message}`);
  return data;
}

function must(context: string, error: { message: string } | null): void {
  if (error) throw new Error(`${context}: ${error.message}`);
}

// ------------------------------------------------------------------------------------------- //
// The fixture. One project, two members, and a handful of listings nobody real has ever opened.
// ------------------------------------------------------------------------------------------- //

const PROJECT = '00000000-0000-4000-b000-0000000000c0';
const EMAIL_ONE = 'spend-check-one@example.test';
const EMAIL_TWO = 'spend-check-two@example.test';
const PASSWORD = 'spend-check-password-4b71';
const PREFIX = 'spendcheck-';
/** Enough listings for the concurrency rounds to use a fresh set each time. A round that reused
 *  ids would be back to serialising on the listing, which is the bug. */
const LISTINGS = Array.from({ length: 40 }, (_, i) => `${PREFIX}${i}`);
/** Indexed rather than subscripted, so an off-the-end read is a thrown error naming this suite
 *  rather than `undefined` quietly reaching the database as a listing id. */
function listing(i: number): string {
  const id = LISTINGS[i];
  if (id === undefined) throw new Error(`check-spend asked for listing ${i} of ${LISTINGS.length}`);
  return id;
}
const MODEL = 'spend-check-model';
const ESTIMATE = 0.1;

async function tearDown() {
  await db.from('api_usage').delete().eq('project_id', PROJECT);
  await db.from('api_usage').delete().like('rightmove_id', `${PREFIX}%`);
  await db.from('property_analysis').delete().like('rightmove_id', `${PREFIX}%`);
  await db.from('project_property').delete().eq('project_id', PROJECT);
  await db.from('property').delete().like('rightmove_id', `${PREFIX}%`);
  await db.from('project').delete().eq('id', PROJECT);
  await db.from('model_price').delete().eq('model', MODEL);

  const { data } = await db.auth.admin.listUsers({ perPage: 1000 });
  for (const user of data?.users ?? []) {
    if (user.email === EMAIL_ONE || user.email === EMAIL_TWO) await db.auth.admin.deleteUser(user.id);
  }
}

async function createUser(email: string): Promise<string> {
  const { data, error } = await db.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error || !data.user) throw new Error(`creating ${email}: ${error?.message ?? 'no user returned'}`);
  return data.user.id;
}

async function setUp(): Promise<{ one: string; two: string }> {
  const one = await createUser(EMAIL_ONE);
  const two = await createUser(EMAIL_TWO);

  must('creating the project', (await db.from('project').insert({
    id: PROJECT, name: 'Spend check', created_by: one,
  })).error);
  must('creating memberships', (await db.from('project_member').insert([
    { project_id: PROJECT, user_id: one, role: 'owner' },
    { project_id: PROJECT, user_id: two, role: 'member' },
  ])).error);

  must('creating the listings', (await db.from('property').insert(
    LISTINGS.map((id) => ({
      rightmove_id: id,
      url: `https://example.test/${id}`,
      display_address: `${id} Street`,
      postcode: 'SPD 1AA',
    })),
  )).error);
  must('linking the listings', (await db.from('project_property').insert(
    LISTINGS.map((id) => ({ project_id: PROJECT, rightmove_id: id })),
  )).error);

  // A price of this suite's own, so the assertions below say what they mean in round numbers and
  // do not break the day somebody reprices gpt-5.6-terra.
  must('pricing the test model', (await db.from('model_price').insert({
    model: MODEL,
    effective_from: 'epoch',
    input_usd_per_mtok: 2,
    cached_input_usd_per_mtok: 0.2,
    output_usd_per_mtok: 12,
  })).error);

  return { one, two };
}

/** Back to nothing spent and nothing in flight, without tearing the whole fixture down. Every
 *  section below starts from a known budget, and a leftover reservation from the section above is
 *  exactly the kind of cross-talk that makes a spend test lie. */
async function resetBudget(caps: { project: number; user: number }, users: string[]) {
  await db.from('api_usage').delete().eq('project_id', PROJECT);
  await db.from('api_usage').delete().like('rightmove_id', `${PREFIX}%`);
  await db.from('property_analysis').delete().like('rightmove_id', `${PREFIX}%`);
  must('setting the project cap', (await survive('setting the project cap', () => db.from('project')
    .update({ monthly_cap_usd: caps.project }).eq('id', PROJECT))).error);
  must('setting the user caps', (await survive('setting the user caps', () => db.from('profile')
    .update({ monthly_cap_usd: caps.user }).in('id', users))).error);
}

/** Deliberately not going through `rpc`'s retry — see `survive`. A claim is the thing under test. */
async function claim(rightmoveId: string, userId: string, estimate = ESTIMATE): Promise<any> {
  const { data, error } = await db.rpc('claim_analysis', {
    p_rightmove_id: rightmoveId,
    p_project_id: PROJECT,
    p_user_id: userId,
    p_estimate_usd: estimate,
  });
  if (error) throw new Error(`claiming ${rightmoveId}: ${error.message}`);
  return data;
}

/** Money already spent, put there directly rather than through a call, so a section can start at
 *  any point in the month's budget without pretending to have made an API request. */
async function spend(userId: string, costUsd: number, rightmoveId: string, occurredAt?: string) {
  must(`recording $${costUsd} of spend`, (await db.from('api_usage').insert({
    project_id: PROJECT,
    user_id: userId,
    model: MODEL,
    cost_usd: costUsd,
    rightmove_id: rightmoveId,
    ...(occurredAt ? { occurred_at: occurredAt } : {}),
  })).error);
}

/** A signed-in member, for the one function here the extension itself calls. `spend_summary` reads
 *  `auth.uid()` and refuses anyone who is not a member, so asking it as the service role — which is
 *  nobody — returns a refusal rather than a summary. That refusal was quietly arriving as
 *  `undefined` in every field and reading as five failures about money instead of one about who
 *  was asking. */
async function signIn(email: string): Promise<SupabaseClient> {
  const client = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { error } = await client.auth.signInWithPassword({ email, password: PASSWORD });
  if (error) throw new Error(`signing in as ${email}: ${error.message}`);
  return client;
}

async function runningClaims(): Promise<number> {
  const { count, error } = await db
    .from('property_analysis')
    .select('*', { count: 'exact', head: true })
    .eq('status', 'running')
    .like('rightmove_id', `${PREFIX}%`);
  if (error) throw new Error(`counting running claims: ${error.message}`);
  return count ?? 0;
}

async function usageRows(): Promise<number> {
  const { count, error } = await db
    .from('api_usage')
    .select('*', { count: 'exact', head: true })
    .eq('project_id', PROJECT);
  if (error) throw new Error(`counting usage rows: ${error.message}`);
  return count ?? 0;
}

// ------------------------------------------------------------------------------------------- //

async function main() {
  await tearDown();
  const { one, two } = await setUp();

  // ----------------------------------------------------------------------------------------- //
  console.log('\nthe month boundary is Europe/London, not UTC');

  // Winter: London is UTC, so the two agree and this proves nothing on its own. It is here as the
  // control for the three below, which are the cases where they part company.
  isTime('January starts at midnight UTC',
    await rpc('month_start_london', { p_at: '2026-01-15T12:00:00Z' }), '2026-01-01T00:00:00Z');

  // Summer: British Summer Time. 1 July 00:00 in London is 30 June 23:00 UTC, so a cap that reset
  // on the UTC month would hand out an extra hour of last month's budget — or charge the first
  // hour of the month against the last one, depending on which way you got it wrong.
  isTime('July starts an hour before midnight UTC',
    await rpc('month_start_london', { p_at: '2026-07-15T12:00:00Z' }), '2026-06-30T23:00:00Z');

  // The hour itself, from both sides. 23:30 UTC on 30 June is already 1 July in London...
  isTime('23:30 UTC on 30 June is July in London',
    await rpc('month_start_london', { p_at: '2026-06-30T23:30:00Z' }), '2026-06-30T23:00:00Z');
  // ...and 22:30 UTC is still 30 June, so it belongs to June's budget.
  isTime('22:30 UTC on 30 June is still June in London',
    await rpc('month_start_london', { p_at: '2026-06-30T22:30:00Z' }), '2026-05-31T23:00:00Z');

  // ----------------------------------------------------------------------------------------- //
  console.log('\ncached input is priced as cached input');

  await resetBudget({ project: 20, user: 20 }, [one, two]);

  // A million of each. At $2 / $0.20 / $12 per Mtok that is 2 + 0.2 + 12. The hardcoded cost() in
  // the Edge Function this replaced charged cached input at the full input rate, which would make
  // the same call $16 — an order of magnitude out on a prompt that reuses a system block, and
  // always in the direction of refusing work the budget could afford.
  const cost = await rpc('record_api_usage', {
    p_project_id: PROJECT, p_user_id: one, p_model: MODEL,
    p_input_tokens: 1_000_000, p_cached_input_tokens: 1_000_000, p_output_tokens: 1_000_000,
    p_rightmove_id: listing(0),
  });
  isMoney('1M input + 1M cached + 1M output costs $14.20', cost, 14.2);
  if (Math.abs(Number(cost) - 16) < 1e-6) {
    fail('cached input is not charged at the full input rate', 'it is — this is the old cost()');
  }

  const { data: recorded, error: recordedError } = await db
    .from('api_usage')
    .select('input_tokens, cached_input_tokens, output_tokens, cost_usd, kind, model')
    .eq('project_id', PROJECT)
    .single();
  must('reading back the usage row', recordedError);
  is('the row keeps the three token counts apart', {
    input: recorded!.input_tokens,
    cached: recorded!.cached_input_tokens,
    output: recorded!.output_tokens,
  }, { input: 1_000_000, cached: 1_000_000, output: 1_000_000 });
  is('and defaults to the analysis kind', recorded!.kind, 'analysis');

  // A repricing must not retroactively change what last month's cap counted, which is why the cost
  // is stored rather than recomputed from model_price on read.
  must('repricing the model', (await db.from('model_price').insert({
    model: MODEL, effective_from: new Date().toISOString(),
    input_usd_per_mtok: 99, cached_input_usd_per_mtok: 99, output_usd_per_mtok: 99,
  })).error);
  const { data: afterReprice } = await db.from('api_usage').select('cost_usd').eq('project_id', PROJECT).single();
  isMoney('a repricing does not change what an old call cost', afterReprice?.cost_usd, 14.2);
  await db.from('model_price').delete().eq('model', MODEL).neq('effective_from', 'epoch');

  // An unpriced model is a reason to refuse, never a reason to record a call as free.
  const unpriced = await db.rpc('record_api_usage', {
    p_project_id: PROJECT, p_user_id: one, p_model: 'a-model-nobody-priced',
    p_input_tokens: 10, p_cached_input_tokens: 0, p_output_tokens: 10,
  });
  if (unpriced.error) ok(`an unpriced model is refused (${unpriced.error.message.split('\n')[0]})`);
  else fail('an unpriced model is refused', 'it was recorded, and at some cost this test cannot name');

  // ----------------------------------------------------------------------------------------- //
  console.log('\nboth caps bind, and the refusal says which one');

  await resetBudget({ project: 20, user: 20 }, [one, two]);
  is('with the budget empty, a claim is granted', (await claim(listing(0), one)).status, 'claimed');

  // The project cap, with the user's untouched.
  await resetBudget({ project: 1, user: 20 }, [one, two]);
  await spend(one, 0.95, listing(0));
  const cappedProject = await claim(listing(1), one);
  is('over the project cap: refused', cappedProject.status, 'capped');
  is('...and it names the project', cappedProject.scope, 'project');
  isMoney('...and reports what has been spent', cappedProject.spent, 0.95);
  isMoney('...against the cap that bound', cappedProject.cap, 1);
  // The 1st of next month, in London. Asked of the database rather than computed here, because
  // "next month" across a DST change is exactly the arithmetic this whole section exists to pin —
  // and forty days past a month start always lands inside the following month, whatever its length.
  const thisMonth = new Date(await rpc('month_start_london', {}));
  const nextMonth = await rpc('month_start_london', {
    p_at: new Date(thisMonth.getTime() + 40 * 86_400_000).toISOString(),
  });
  isTime('...and when it resets', cappedProject.resets_at, new Date(nextMonth).toISOString());
  is('nothing was claimed', await runningClaims(), 0);

  // The user cap, with the project's untouched. Same shape, different scope — and this is the one
  // a shared project needs: one member cannot spend the whole house hunt's budget.
  await resetBudget({ project: 20, user: 1 }, [one, two]);
  await spend(one, 0.95, listing(0));
  const cappedUser = await claim(listing(1), one);
  is('over the user cap: refused', cappedUser.status, 'capped');
  is('...and it names the user', cappedUser.scope, 'user');
  isMoney('...and reports that user\'s spend', cappedUser.spent, 0.95);

  // The other member of the same project is unaffected by the first one's spending, up to the
  // project cap. A per-user cap that also stopped everybody else would be a project cap.
  is('the other member can still claim', (await claim(listing(2), two)).status, 'claimed');

  // Both over: the project is checked first, so that is the scope reported. Which one is named
  // matters — the panel tells you either "the house hunt's budget" or "yours".
  await resetBudget({ project: 1, user: 1 }, [one, two]);
  await spend(one, 0.95, listing(0));
  is('over both caps, the project is the one named', (await claim(listing(1), one)).scope, 'project');

  // Last month's spending is last month's. The boundary is the London one asserted above.
  await resetBudget({ project: 1, user: 20 }, [one, two]);
  const lastMonth = new Date(new Date(await rpc('month_start_london', {})).getTime() - 86_400_000);
  await spend(one, 19, listing(0), lastMonth.toISOString());
  is('last month\'s spend does not count against this month', (await claim(listing(1), one)).status, 'claimed');

  // A project or a user with no cap is an unknown budget, and an unknown budget is refused rather
  // than treated as unlimited. Not reachable through the schema's defaults — which is the point.
  await resetBudget({ project: 20, user: 20 }, [one, two]);
  const noSuchProject = await db.rpc('claim_analysis', {
    p_rightmove_id: listing(0),
    p_project_id: '00000000-0000-4000-b000-0000000000ff',
    p_user_id: one,
    p_estimate_usd: ESTIMATE,
  });
  if (noSuchProject.error) ok('an unknown budget is refused rather than treated as unlimited');
  else fail('an unknown budget is refused', `it returned ${JSON.stringify(noSuchProject.data)}`);

  // ----------------------------------------------------------------------------------------- //
  console.log('\na cached analysis charges nobody');

  await resetBudget({ project: 20, user: 20 }, [one, two]);
  must('seeding a finished analysis', (await db.from('property_analysis').insert({
    rightmove_id: listing(0), model: MODEL, status: 'done', image_count: 4, has_floorplan: true,
  })).error);
  const onDone = await claim(listing(0), one);
  // 'busy' rather than 'claimed': the row exists and is not stale or failed, so the upsert's WHERE
  // matches nothing. The Edge Function reads the finished analysis and returns it without calling
  // OpenAI; what matters here is that nothing was reserved and nothing was charged for it.
  is('claiming a listing that is already analysed does not re-claim it', onDone.status, 'busy');
  is('...and charges nobody', await usageRows(), 0);
  const { data: stillDone } = await db.from('property_analysis')
    .select('status, claimed_by_project').eq('rightmove_id', listing(0)).single();
  is('...and leaves the finished analysis alone', stillDone?.status, 'done');
  is('...unattributed to any budget', stillDone?.claimed_by_project, null);

  // ----------------------------------------------------------------------------------------- //
  console.log('\na failure that keeps failing stops being paid for');

  // The case this section exists for cost real money. `claim_analysis` used to re-take *any* row
  // sitting at `failed`, so a listing whose analysis fails deterministically — output truncated,
  // or output that will not validate — was re-analysed, and re-charged, on every sweep run,
  // for ever, with nothing on screen saying so.
  /** An analysis row in whatever state the case needs. `failed` is the default because most of
   *  these are about a failure; pass `status` for the ones that are not. */
  const seed = async (id: string, over: Record<string, unknown>) =>
    must(`seeding an analysis for ${id}`, (await db.from('property_analysis').upsert({
      rightmove_id: id, model: MODEL, status: 'failed', image_count: 0, has_floorplan: false,
      ...over,
    })).error);

  await resetBudget({ project: 20, user: 20 }, [one, two]);

  // Still retried while it has attempts left and its wait is up: a transient failure has to stay
  // recoverable, or one bad minute at OpenAI would write a listing off permanently.
  await seed(listing(0), { attempts: 1, next_attempt_at: new Date(Date.now() - 60_000).toISOString() });
  is('a failure whose wait is up is retried', (await claim(listing(0), one)).status, 'claimed');

  // Inside its backoff, nothing takes it — which is the doubling doing its job.
  await seed(listing(1), { attempts: 1, next_attempt_at: new Date(Date.now() + 3_600_000).toISOString() });
  is('a failure still inside its backoff is not retried', (await claim(listing(1), one)).status, 'busy');

  // And once the attempts are spent it is never taken again, whatever the clock says. A row with
  // its wait long past is the exact shape the old code re-claimed on every run.
  await seed(listing(2), { attempts: 5, next_attempt_at: new Date(Date.now() - 86_400_000).toISOString() });
  is('a failure that has spent its attempts is never retried', (await claim(listing(2), one)).status, 'busy');
  is('...and none of that charged anybody', await usageRows(), 0);

  // A null wait is a row that failed before the backoff existed. It reads as "now", so it gets one
  // more go rather than being written off on a count nobody was keeping.
  await seed(listing(3), { attempts: 0, next_attempt_at: null });
  is('a failure from before the backoff existed is retried once more', (await claim(listing(3), one)).status, 'claimed');

  // The count is incremented in SQL, not read and written back, so two runs failing the same
  // listing at once leave 2. Read-modify-write would leave 1 — and a count that does not climb is
  // a ceiling that is never reached, which is the bug wearing a fix's clothes.
  const heldAt = new Date().toISOString();
  await seed(listing(4), { attempts: 0, next_attempt_at: null, claimed_at: heldAt });
  await Promise.all([
    rpc('record_analysis_failure', { p_rightmove_id: listing(4), p_claimed_at: heldAt, p_error: 'one' }),
    rpc('record_analysis_failure', { p_rightmove_id: listing(4), p_claimed_at: heldAt, p_error: 'two' }),
  ]);
  const { data: counted } = await db.from('property_analysis')
    .select('attempts, next_attempt_at').eq('rightmove_id', listing(4)).single();
  is('two concurrent failures count as two', counted?.attempts, 2);
  is('...and a recorded failure sets a wait', counted?.next_attempt_at !== null, true);

  // A run slow enough to have had its claim taken over writes nothing at all. Keyed on the listing
  // alone — which is what a patch by `rightmove_id` does, and what this replaced — the late failure
  // lands on the row belonging to the run that took over: releasing a claim that is still spending,
  // which drains its reservation and lets a third run start on the same listing, and charging an
  // attempt to a run that has not failed.
  const tookOverAt = new Date().toISOString();
  await seed(listing(5), { status: 'running', attempts: 0, claimed_at: tookOverAt });
  await rpc('record_analysis_failure', {
    p_rightmove_id: listing(5),
    p_claimed_at: new Date(Date.now() - 3_600_000).toISOString(),
    p_error: 'from the run that was superseded',
  });
  const { data: survived } = await db.from('property_analysis')
    .select('status, attempts').eq('rightmove_id', listing(5)).single();
  is('a superseded run does not release the claim that replaced it', survived?.status, 'running');
  is('...nor charge it an attempt', survived?.attempts, 0);

  // A successful analysis clears the history, so a listing that failed twice and then worked is
  // not carrying two attempts against its next bad day.
  must('finishing the analysis', (await db.from('property_analysis')
    .update({ status: 'done' }).eq('rightmove_id', listing(4))).error);
  const { data: cleared } = await db.from('property_analysis')
    .select('attempts, next_attempt_at').eq('rightmove_id', listing(4)).single();
  is('a successful analysis clears the attempt count', cleared?.attempts, 0);
  is('...and the wait with it', cleared?.next_attempt_at, null);

  // ----------------------------------------------------------------------------------------- //
  console.log('\nin-flight claims hold budget, and stale ones give it back');

  // Cap 0.25, estimate 0.10. Nothing spent, so the first claim (0 + 0 + 0.10) fits and the second
  // (0 + 0.10 + 0.10) fits, and the third (0 + 0.20 + 0.10 = 0.30) does not.
  await resetBudget({ project: 0.25, user: 20 }, [one, two]);
  is('first claim, nothing reserved', (await claim(listing(0), one)).status, 'claimed');
  is('second claim, $0.10 reserved', (await claim(listing(1), one)).status, 'claimed');
  const third = await claim(listing(2), one);
  is('third claim: the two reservations have used the budget', third.status, 'capped');
  isMoney('...and the refusal counts them as reserved, not spent', third.reserved, 0.2);
  isMoney('...with nothing actually spent yet', third.spent, 0);

  // A claim that went stale has been given up on, and its reservation drains — which is what stops
  // one crashed run from consuming a slice of the budget until the month turns over.
  must('ageing the two claims', (await db.from('property_analysis')
    .update({ claimed_at: new Date(Date.now() - 60 * 60_000).toISOString() })
    .in('rightmove_id', [listing(0), listing(1)])).error);
  is('once they go stale the budget is free again', (await claim(listing(2), one)).status, 'claimed');

  // The reservation is attributed to a user as well as a project, so one member's in-flight run
  // counts against their own cap too.
  await resetBudget({ project: 20, user: 0.25 }, [one, two]);
  await claim(listing(0), one);
  await claim(listing(1), one);
  is('a user\'s own reservations bind their own cap', (await claim(listing(2), one)).scope, 'user');

  // ----------------------------------------------------------------------------------------- //
  console.log('\nconcurrent claims for DIFFERENT listings — the race D9 first got wrong');

  // Cap 0.35 with a $0.10 estimate leaves room for exactly three. Fired together, through separate
  // HTTP requests, so they are separate transactions racing for the same budget with no listing in
  // common — the case the old listing-level lock did not touch at all. Against that version every
  // one of these reads a spend of zero and all six proceed.
  for (let round = 0; round < 3; round++) {
    await resetBudget({ project: 0.35, user: 20 }, [one, two]);
    const ids = LISTINGS.slice(round * 6, round * 6 + 6);
    const results = await Promise.all(ids.map((id) => claim(id, one)));
    const claimed = results.filter((r) => r.status === 'claimed').length;
    const capped = results.filter((r) => r.status === 'capped').length;
    is(`round ${round + 1}: exactly three of six concurrent claims win`, { claimed, capped }, { claimed: 3, capped: 3 });
    is(`round ${round + 1}: and three reservations exist in the table`, await runningClaims(), 3);
  }

  // Two members racing inside one project. The project lock is what serialises them; the user lock
  // alone would let each member spend the project's budget in parallel.
  for (let round = 0; round < 2; round++) {
    await resetBudget({ project: 0.35, user: 20 }, [one, two]);
    const ids = LISTINGS.slice(20 + round * 6, 20 + round * 6 + 6);
    const results = await Promise.all(
      ids.map((id, i) => claim(id, i % 2 === 0 ? one : two)),
    );
    const claimed = results.filter((r) => r.status === 'claimed').length;
    is(`round ${round + 1}: two members racing still only get three between them`, claimed, 3);
  }

  // And the listing-level guarantee the old lock did give, which must survive the new one: the
  // same id claimed six times at once is claimed exactly once.
  await resetBudget({ project: 20, user: 20 }, [one, two]);
  const sameId = await Promise.all(Array.from({ length: 6 }, () => claim(listing(39), one)));
  is('the same listing claimed six times at once is claimed once', {
    claimed: sameId.filter((r) => r.status === 'claimed').length,
    busy: sameId.filter((r) => r.status === 'busy').length,
  }, { claimed: 1, busy: 5 });

  // ----------------------------------------------------------------------------------------- //
  console.log('\nthe cap is soft, and this is where that is written down');

  // Asserting what is true rather than what would be reassuring. A single call is not bounded: the
  // reservation is a flat estimate and the real cost is whatever OpenAI charged, so one listing
  // with forty photographs can take the month past the cap on its own. Recording it anyway is
  // correct — money that was spent has to be counted — and the claim that must not be made is that
  // the cap prevented it.
  await resetBudget({ project: 1, user: 20 }, [one, two]);
  is('a claim under the cap is granted', (await claim(listing(0), one)).status, 'claimed');
  const expensive = await rpc('record_api_usage', {
    p_project_id: PROJECT, p_user_id: one, p_model: MODEL,
    p_input_tokens: 0, p_cached_input_tokens: 0, p_output_tokens: 10_000_000,
    p_rightmove_id: listing(0),
  });
  isMoney('...and one call can then cost far more than the whole month\'s cap', expensive, 120);
  const member0 = await signIn(EMAIL_ONE);
  const blown = (await member0.rpc('spend_summary', { p_project_id: PROJECT, p_user_id: one })).data as any;
  is('...so recorded spend really is over the cap', Number(blown?.project_spent) > Number(blown?.project_cap), true);

  // What the cap does do: it is the last call allowed, not a ceiling on the total.
  is('...and it is the last call allowed', (await claim(listing(1), one)).status, 'capped');

  // ----------------------------------------------------------------------------------------- //
  console.log('\nwhat the panel reads');

  await resetBudget({ project: 20, user: 20 }, [one, two]);
  await spend(one, 3.5, listing(0));
  await spend(two, 1.25, listing(1));
  const member = await signIn(EMAIL_ONE);
  const asked = await member.rpc('spend_summary', { p_project_id: PROJECT, p_user_id: one });
  must('reading the spend summary as a member', asked.error);
  const summary = asked.data as any;
  if (summary?.error) fail('a member can read their own spend summary', String(summary.error));
  isMoney('the project has spent both members\' money', summary.project_spent, 4.75);
  isMoney('...and the user only their own', summary.user_spent, 3.5);
  isMoney('...against the project cap', summary.project_cap, 20);
  isTime('...and it agrees with month_start_london', summary.month_start, thisMonth.toISOString());

  // Spending outside the month is not this month's spending, on the same boundary as the cap.
  await spend(one, 100, listing(2), lastMonth.toISOString());
  const again = await member.rpc('spend_summary', { p_project_id: PROJECT, p_user_id: one });
  must('re-reading the spend summary', again.error);
  isMoney('last month\'s $100 is not in this month\'s total', (again.data as any)?.project_spent, 4.75);

  // And somebody who is not in the project gets a refusal rather than a number. The cap is a fact
  // about a house hunt's money; a stranger reading it would be a small leak of a real one.
  const { data: stranger } = await db.rpc('spend_summary', { p_project_id: PROJECT, p_user_id: one });
  is('a caller who is in no project is refused', Boolean((stranger as any)?.error), true);
}

try {
  await main();
} finally {
  await tearDown();
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) process.exit(1);
