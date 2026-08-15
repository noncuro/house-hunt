/** Train a project's verdict-score model from live data and write it to `project_model`.
 *
 *  This is what the `predict` Edge Function does, run by hand against the database — the same
 *  queries, the same `fitProjectModel` from core. It exists for two moments the function can't
 *  cover: seeding the row before the function is deployed, and verifying (read-only, with
 *  `--dry-run`) that the training path works on the real, current data rather than only on the
 *  frozen `check:predict` fixture.
 *
 *    tsx tools/train-model.ts <project_id> [--dry-run]
 *
 *  Reads SUPABASE_PROJECT_REF / SUPABASE_DB_PASSWORD from .env; needs `psql`. It writes the model
 *  by a direct upsert as the database owner (which bypasses RLS and the service-role guard on
 *  `set_project_model`) — appropriate for a hand-run seed, not a path any client takes.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_LABEL_MODE,
  featuresFor,
  fitProjectModel,
  labelFor,
  scoreFeatures,
  type Example,
  type HubPoint,
} from '../packages/core/src/predict';

function env(name: string): string {
  const line = readFileSync('.env', 'utf8').split('\n').find((l) => l.startsWith(`${name}=`));
  const value = line?.slice(name.length + 1).trim().replace(/^["']|["']$/g, '');
  if (!value) throw new Error(`missing ${name} in .env`);
  return value;
}

const PROJECT_REF = env('SUPABASE_PROJECT_REF');
const PGARGS = ['-h', 'aws-1-eu-west-1.pooler.supabase.com', '-p', '5432', '-U', `postgres.${PROJECT_REF}`, '-d', 'postgres'];
const PGENV = { ...process.env, PGPASSWORD: env('SUPABASE_DB_PASSWORD') };

function psql(args: string[]): string {
  return execFileSync('psql', [...PGARGS, ...args], { env: PGENV, encoding: 'utf8' });
}

const projectId = process.argv[2];
const dryRun = process.argv.includes('--dry-run');
if (!projectId) throw new Error('usage: tsx tools/train-model.ts <project_id> [--dry-run]');
// This connects as the database owner, which bypasses RLS, so an argument that is not a project id
// is not a typo to shrug at — it is arbitrary SQL with the highest rights in the database. The
// queries below bind it through psql's `:'project_id'`, and this refuses anything that isn't a
// UUID before it gets that far. One line, and the tool has no injection surface left.
if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(projectId)) {
  throw new Error(`not a project id: ${projectId}`);
}

// The same shape the predict function reads: verdicts minus exclusions, joined to property and
// analysis, plus the project's hubs. Ordered by id, because the fit deals rows into stratified
// folds by position — an unordered `json_agg` would cross-validate a different partition each run.
const sql = `
select json_build_object(
  'hubs', (select coalesce(json_agg(json_build_object('lat',lat,'lon',lon) order by sort_order),'[]') from place where project_id=:'project_id'),
  'rows', (select coalesce(json_agg(row_to_json(t) order by t.rightmove_id),'[]') from (
    select v.rightmove_id, v.rating, p.price, p.bedrooms, p.bathrooms, p.floor_area_sqft, p.furnish_type,
           coalesce(p.postcode_lat, p.latitude) as lat, coalesce(p.postcode_lon, p.longitude) as lon,
           -- Miles, matching the Edge Function. Rightmove gives miles but a stray km unit would
           -- otherwise read as a much closer station, and a model seeded here would then differ
           -- from the one the predict function fits on the very same rows.
           (select min(case when s->>'unit' = 'km' then (s->>'distance')::float * 0.621371
                            else (s->>'distance')::float end)
              from jsonb_array_elements(p.nearest_stations) s) as nearest_station_dist,
           a.natural_light, a.has_outdoor_space, a.has_dishwasher, a.laundry, a.has_bathtub
    from verdict v
    join property p on p.rightmove_id = v.rightmove_id
    left join property_analysis a on a.rightmove_id = v.rightmove_id
    where v.project_id=:'project_id'
      and v.rightmove_id not in (select rightmove_id from training_exclusion where project_id=:'project_id')
  ) t)
)`;
const data = JSON.parse(psql(['-v', `project_id=${projectId}`, '-At', '-c', sql])) as {
  hubs: HubPoint[];
  rows: any[];
};

const examples: Example[] = [];
for (const r of data.rows) {
  const label = labelFor(r.rating, DEFAULT_LABEL_MODE);
  if (label == null) continue;
  const input = {
    price: r.price,
    bedrooms: r.bedrooms,
    bathrooms: r.bathrooms,
    floorAreaSqft: r.floor_area_sqft,
    lat: r.lat,
    lon: r.lon,
    nearestStationMiles: r.nearest_station_dist,
    furnishType: r.furnish_type,
    naturalLight: r.natural_light,
    hasOutdoorSpace: r.has_outdoor_space,
    hasDishwasher: r.has_dishwasher,
    laundry: r.laundry,
    hasBathtub: r.has_bathtub,
  };
  examples.push({ raw: featuresFor(input, data.hubs), label });
}

const model = fitProjectModel(examples, DEFAULT_LABEL_MODE);
if (!model) {
  console.error(`insufficient: ${examples.length} labelled flats — need more of each class`);
  process.exit(1);
}

console.log(`fitted on ${examples.length} flats (${examples.filter((e) => e.label === 1).length} positive)`);
console.log(`  columns: ${model.columns.length}  λ=${model.hyperparams.lambda}`);
console.log(`  metrics: ${JSON.stringify(model.metrics)}`);
// A quick self-check that the serialised model scores the way the fit does: score two rows back.
console.log(`  sample scores: ${examples.slice(0, 3).map((e) => scoreFeatures(model, e.raw).toFixed(3)).join(', ')}`);

if (dryRun) {
  console.log('dry run — not written');
  process.exit(0);
}

// Upsert via a psql variable so the jsonb is quoted safely: `\set` reads the file, and :'model'
// emits a properly-escaped string literal we then cast to jsonb. Piped through stdin because \set
// is a meta-command, not something -c accepts.
const dir = mkdtempSync(join(tmpdir(), 'train-model-'));
const modelFile = join(dir, 'model.json');
writeFileSync(modelFile, JSON.stringify(model));
const script = `\\set model \`cat ${modelFile}\`
insert into project_model (project_id, model, version, label_mode, n_examples, trained_at)
values (:'project_id', :'model'::jsonb, ${model.version}, '${DEFAULT_LABEL_MODE}', ${examples.length}, now())
on conflict (project_id) do update set
  model = excluded.model, version = excluded.version, label_mode = excluded.label_mode,
  n_examples = excluded.n_examples, trained_at = now();
`;
execFileSync('psql', [...PGARGS, '-v', 'ON_ERROR_STOP=1', '-v', `project_id=${projectId}`], {
  env: PGENV,
  input: script,
  encoding: 'utf8',
});
console.log('written to project_model');
