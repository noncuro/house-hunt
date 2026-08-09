/** Replays exactly what the background does for one postcode, using the real saved places. */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

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
const head = { apikey: env.WXT_SUPABASE_PUBLISHABLE_KEY!, Authorization: `Bearer ${env.WXT_SUPABASE_PUBLISHABLE_KEY!}` };
const places = (await (await fetch(`${env.WXT_SUPABASE_URL}/rest/v1/place?select=id,label,postcode,lat,lon`, { headers: head })).json()) as any[];
console.log('places:', places.map((p) => `${p.label} pc=${p.postcode} lat=${p.lat} lon=${p.lon}`));

const FROM = process.argv[2] ?? 'N1 8DW';
const MODES: Record<string, string | null> = { transit: null, walking: 'walking', cycling: 'cycle' };
for (const place of places) {
  for (const [mode, tfl] of Object.entries(MODES)) {
    const dest = place.lat !== null && place.lon !== null ? `${place.lat},${place.lon}` : place.postcode;
    const params = new URLSearchParams();
    if (tfl) params.set('mode', tfl);
    const url = `https://api.tfl.gov.uk/journey/journeyresults/${encodeURIComponent(FROM)}/to/${encodeURIComponent(dest)}?${params}`;
    try {
      const r = await fetch(url);
      const body: any = await r.json().catch(() => ({}));
      const dur = body?.journeys?.[0]?.duration;
      console.log(`${place.label.padEnd(14)} ${mode.padEnd(8)} ${r.status} ${dur !== undefined ? dur + 'm' : (body?.message ?? '').slice(0, 90)}`);
    } catch (e) {
      console.log(`${place.label.padEnd(14)} ${mode.padEnd(8)} THREW ${(e as Error).message}`);
    }
  }
}
