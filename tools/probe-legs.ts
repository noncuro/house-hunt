const UA = { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126.0 Safari/537.36' };
const from = process.argv[2] ?? 'N1 8DW';
const to = process.argv[3] ?? '51.514957,-0.141528';
const r: any = await (await fetch(
  `https://api.tfl.gov.uk/journey/journeyresults/${encodeURIComponent(from)}/to/${encodeURIComponent(to)}`,
  { headers: UA },
)).json();
console.log('journeys returned:', r.journeys?.length);
for (const [i, j] of (r.journeys ?? []).entries()) {
  console.log(`\n--- journey ${i}: ${j.duration}m ---`);
  for (const leg of j.legs ?? []) {
    console.log('  leg:', JSON.stringify({
      mode: leg.mode?.id,
      duration: leg.duration,
      instruction: leg.instruction?.summary?.slice(0, 60),
      routeOptions: (leg.routeOptions ?? []).map((o: any) => ({
        name: o.name,
        lineId: o.lineIdentifier?.id,
        direction: o.directions?.[0],
      })),
      departure: leg.departurePoint?.commonName,
      arrival: leg.arrivalPoint?.commonName,
    }));
  }
}
