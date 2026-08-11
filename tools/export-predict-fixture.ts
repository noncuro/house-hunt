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

const sql = `
select json_build_object(
  'project_id','${projectId}',
  'generated_note','frozen fixture for check:predict — no PII, ids/numbers/booleans only',
  'hubs', (select coalesce(json_agg(json_build_object('name',name,'lat',lat,'lon',lon) order by sort_order),'[]')
           from project_hub where project_id='${projectId}'),
  'rows', (select coalesce(json_agg(row_to_json(t)),'[]') from (
    select v.rightmove_id, v.rating, p.price, p.bedrooms, p.bathrooms, p.floor_area_sqft,
           p.furnish_type,
           coalesce(p.postcode_lat, p.latitude)  as lat,
           coalesce(p.postcode_lon, p.longitude) as lon,
           (select min((s->>'distance')::float) from jsonb_array_elements(p.nearest_stations) s) as nearest_station_dist,
           a.natural_light, a.has_outdoor_space, a.has_dishwasher, a.laundry, a.has_bathtub
    from verdict v
    join property p on p.rightmove_id = v.rightmove_id
    left join property_analysis a on a.rightmove_id = v.rightmove_id
    where v.project_id='${projectId}'
  ) t)
)`;

const out = execFileSync(
  'psql',
  [
    '-h', 'aws-1-eu-west-1.pooler.supabase.com',
    '-p', '5432',
    '-U', `postgres.${env('SUPABASE_PROJECT_REF')}`,
    '-d', 'postgres',
    '-At', '-c', sql,
  ],
  { env: { ...process.env, PGPASSWORD: env('SUPABASE_DB_PASSWORD') }, encoding: 'utf8' },
);

// Pretty-print so the committed fixture is diff-legible.
process.stdout.write(JSON.stringify(JSON.parse(out), null, 2) + '\n');
