/** Freeze one project's rated flats into a fixture for `check:predict`.
 *
 *  Hand-run, not part of any check — the same category as `find:locations`: it reads production
 *  once so the offline check can run deterministically forever after. It selects only ids, numbers
 *  and booleans (no address, no url, no postcode string) so the committed fixture holds no PII, per
 *  the standing rule. Regenerate when the schema or a project's verdicts change enough to matter.
 *
 *    tsx tools/export-predict-fixture.ts <project_id> > .fixtures/predict-<name>.json
 *
 *  Reads SUPABASE_PROJECT_REF / SUPABASE_DB_PASSWORD from .env (same as the psql recipe in
 *  AGENTS.md). Requires `psql` on PATH.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

function env(name: string): string {
  const line = readFileSync('.env', 'utf8').split('\n').find((l) => l.startsWith(`${name}=`));
  const value = line?.slice(name.length + 1).trim().replace(/^["']|["']$/g, '');
  if (!value) throw new Error(`missing ${name} in .env`);
  return value;
}

const projectId = process.argv[2];
if (!projectId) throw new Error('usage: tsx tools/export-predict-fixture.ts <project_id>');
// The connection below is the database owner's, so an argument that isn't a project id is a
// privileged SQL statement, not a typo. Bound through psql's `:'project_id'` and refused here
// unless it is a UUID — the same guard `train-model.ts` carries, for the same reason.
if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(projectId)) {
  throw new Error(`not a project id: ${projectId}`);
}

// `order by` on both aggregates: json_agg leaves its input order unspecified otherwise, and the
// fixture's row order decides how `check:predict` deals its cross-validation folds. A regeneration
// that silently reshuffled the rows would move the numbers the check asserts on.
const sql = `
select json_build_object(
  'project_id',:'project_id',
  'generated_note','frozen fixture for check:predict — no PII, ids/numbers/booleans only',
  'hubs', (select coalesce(json_agg(json_build_object('name',name,'lat',lat,'lon',lon) order by sort_order),'[]')
           from project_hub where project_id=:'project_id'),
  'rows', (select coalesce(json_agg(row_to_json(t) order by t.rightmove_id),'[]') from (
    select v.rightmove_id, v.rating, p.price, p.bedrooms, p.bathrooms, p.floor_area_sqft,
           p.furnish_type,
           coalesce(p.postcode_lat, p.latitude)  as lat,
           coalesce(p.postcode_lon, p.longitude) as lon,
           -- Miles, as the Edge Function and both client adapters read it. An unconverted km would
           -- freeze a much closer station into the fixture than the live path would ever see.
           (select min(case when s->>'unit' = 'km' then (s->>'distance')::float * 0.621371
                            else (s->>'distance')::float end)
              from jsonb_array_elements(p.nearest_stations) s) as nearest_station_dist,
           a.natural_light, a.has_outdoor_space, a.has_dishwasher, a.laundry, a.has_bathtub
    from verdict v
    join property p on p.rightmove_id = v.rightmove_id
    left join property_analysis a on a.rightmove_id = v.rightmove_id
    where v.project_id=:'project_id'
  ) t)
)`;

const out = execFileSync(
  'psql',
  [
    '-h', 'aws-1-eu-west-1.pooler.supabase.com',
    '-p', '5432',
    '-U', `postgres.${env('SUPABASE_PROJECT_REF')}`,
    '-d', 'postgres',
    '-v', `project_id=${projectId}`,
    '-At', '-c', sql,
  ],
  { env: { ...process.env, PGPASSWORD: env('SUPABASE_DB_PASSWORD') }, encoding: 'utf8' },
);

// Pretty-print so the committed fixture is diff-legible.
process.stdout.write(JSON.stringify(JSON.parse(out), null, 2) + '\n');
