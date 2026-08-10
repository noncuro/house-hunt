/** The data layer, and the client it runs on.
 *
 *  A separate entry point from `@house-hunt/core` on purpose: importing this pulls in
 *  `@supabase/supabase-js`, and there are two places that must never do so — `packages/ui`, whose
 *  components take data as props, and any content-script bundle that only wanted a type.
 *  `tools/check-one-client.ts` checks it. */
export * from './client';
export * from './session';
export * from './supabase';
