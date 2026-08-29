/** Types, contracts and pure domain logic — everything both surfaces share that does not touch a
 *  database.
 *
 *  Nothing exported here imports `@supabase/supabase-js` for its *values*. That is what makes the
 *  boundary in `tools/check-one-client.ts` checkable rather than aspirational: `packages/ui` may
 *  import this entry point and may not import `@house-hunt/core/db`, so a component cannot reach
 *  the database by accident and no content-script bundle pulls the data layer in behind a stray
 *  import. */
export * from './types';
export * from './contracts';
export * from './search-card';
export * from './log';
export * from './bridge';

export * from './facts';
export * from './filter';
export * from './hubs';
export * from './listing';
export * from './shortlist';
export * from './stage';
export * from './sweep';
export * from './predict';
export * from './recheck';

// `postcode` and `tfl` each define a `Point`, and `tfl` also has its own `Journey`/`Leg`/
// `JourneyOption` — the shapes TfL answers in, as opposed to the ones we store, which are in
// `types.ts`. They are not the same and collapsing them into one name is how a raw API response
// ends up written to the database. So the barrel names what it carries, and anything wanting a
// TfL wire shape imports it from `@house-hunt/core/tfl` deliberately.
export { lookupPostcode, lookupPostcodes, type Point, type PostcodeLookup } from './postcode';
export {
  BUS_COLOUR,
  FALLBACK_LINE_COLOUR,
  LINE_COLOURS,
  NO_ROUTE_RETRY_DAYS,
  TflError,
  TRAVEL_BASIS,
  journeyTime,
  nextWeekdayMorning,
  resolveStation,
  staleTravel,
  textOn,
  walkTo,
  type StationInfo,
} from './tfl';

// `analysis` and `png` are deliberately absent. They are the source of truth for the `analyse`
// Edge Function, copied into it by `pnpm sync:function`, and the only things that import them are
// that function and the checks over it. Re-exporting them would put an image decoder in every
// bundle that wanted a type.
