/** TfL sits behind Cloudflare, which blocks Node's default User-Agent outright (error 1010,
 *  served as HTML). Chrome's own fetch is fine, so this only bites the tools. */
const UA = { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36' };
const names = process.argv.slice(2);
for (const name of names) {
  const q = name.replace(/\s+(Rail\s+)?Station$/i, '');
  const s: any = await (await fetch(`https://api.tfl.gov.uk/StopPoint/Search/${encodeURIComponent(q)}?modes=tube,dlr,overground,national-rail,elizabeth-line`, { headers: UA })).json();
  const m = (s.matches ?? [])[0];
  console.log(`--- ${name}: ${(s.matches ?? []).length} matches -> ${m?.id} ${m?.name}`);
  if (!m) continue;
  const sp: any = await (await fetch(`https://api.tfl.gov.uk/StopPoint/${m.id}`, { headers: UA })).json();
  for (const g of sp.lineModeGroups ?? []) {
    console.log(`   ${g.modeName}: ${(g.lineIdentifier ?? []).length} -> ${JSON.stringify(g.lineIdentifier)}`);
  }
}
