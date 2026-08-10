/** Re-runs the vision pass over properties whose floorplan is a transparent PNG.
 *
 *  Those were sent to the model composited onto black and came back unreadable, which produced
 *  confidently wrong answers rather than missing ones — one flat reported "no bathtub" and one
 *  bathroom when the plan clearly shows a bath and two. */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { looksTransparent } from '../packages/core/src/png';

// The repo's own `.env`, or `ENV_FILE` if it lives somewhere else. Whatever is already exported
// wins, so this works with no file at all.
const ENV_FILE = process.env.ENV_FILE ?? resolve(import.meta.dirname, '../.env');
const env: Record<string, string> = {};
if (existsSync(ENV_FILE)) {
  for (const line of readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) env[m[1]!] = m[2]!;
  }
}
Object.assign(env, process.env as Record<string, string>);
const SUPA = env.WXT_SUPABASE_URL!;
const KEY = env.WXT_SUPABASE_PUBLISHABLE_KEY!;
const head = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };

const rows = (await (
  await fetch(`${SUPA}/rest/v1/property?select=rightmove_id,display_address,floorplan_urls`, { headers: head })
).json()) as Array<{ rightmove_id: string; display_address: string; floorplan_urls: string[] }>;

const dryRun = !process.argv.includes('--apply');
let done = 0;

for (const [i, row] of rows.entries()) {
  const url = row.floorplan_urls?.[0];
  const label = `${i + 1}/${rows.length} ${row.rightmove_id} ${row.display_address.slice(0, 40)}`;
  if (!url) {
    console.log(`${label}: no floorplan, skipping`);
    continue;
  }

  const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
  if (!looksTransparent(bytes)) {
    console.log(`${label}: floorplan already opaque, skipping`);
    continue;
  }

  if (dryRun) {
    console.log(`${label}: WOULD re-analyse (transparent floorplan)`);
    done++;
    continue;
  }

  await fetch(`${SUPA}/rest/v1/property_analysis?rightmove_id=eq.${row.rightmove_id}`, {
    method: 'DELETE',
    headers: head,
  });
  const started = Date.now();
  const result = await fetch('http://127.0.0.1:8787/analyse', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rightmoveId: row.rightmove_id }),
  });
  console.log(`${label}: ${(await result.text()).trim()} in ${Math.round((Date.now() - started) / 1000)}s`);
  done++;
}

console.log(`\n${done} ${dryRun ? 'would be re-analysed — pass --apply to do it' : 're-analysed'}`);
