# travel — journeys, stations and postcodes, resolved server-side

## ADDED Requirements

### Requirement: The server is the only writer of the shared caches

`travel_time`, `station_point` and `station_walk` are global tables, shared
across every project by design. Their contents SHALL be written only by the
`travel` Edge Function running with the service role.

`cache_travel`, `cache_station_point` and `cache_station_walk` SHALL be revoked
from `authenticated` and granted to `service_role` alone. Clients SHALL read
these tables and SHALL NOT write them.

The reason is that the RPCs can validate plausibility and cannot validate truth.
A mode is checkable, a duration between 0 and 86400 seconds is checkable, a
coordinate on Earth is checkable; whether the journey really takes 41 minutes is
knowable only to whoever asked TfL. While that was the client, any signed-in
member of any project could write a wrong journey time or move a station, and
every other project would read it as fact — permanently, and with nothing
detecting or expiring it.

#### Scenario: A client tries to write a travel time

- **WHEN** any client holding an ordinary authenticated session calls
  `cache_travel`, `cache_station_point` or `cache_station_walk`
- **THEN** the call is refused for want of execute permission, whatever the
  values it carried

#### Scenario: A journey is asked for that nothing has resolved

- **WHEN** a surface asks for a journey that is not in the cache
- **THEN** the Edge Function calls TfL, writes the answer with the service role,
  and returns it — so the value in the shared cache came from TfL and not from
  whoever asked

#### Scenario: A journey is asked for that is already cached

- **WHEN** the same journey is asked for again
- **THEN** it is answered from the cache and TfL is not called

### Requirement: The TfL key is not distributed

The TfL application key SHALL exist only in the Edge Function's environment. It
SHALL NOT appear in the extension bundle, the web application bundle, or any
`.env.example`.

Calls to TfL SHALL be attributable to the caller that prompted them and SHALL be
rate-limited per user, on the same footing as the `analyse` function, because
the key is now ours rather than the caller's.

#### Scenario: The bundle is inspected

- **WHEN** either shipped bundle is searched for the TfL key
- **THEN** it is not there, and `api.tfl.gov.uk` is absent from the extension's
  `host_permissions`

### Requirement: The comparison basis is enforced where the value is written

Transit journeys SHALL be resolved against the pinned weekday 09:00 departure,
and that pinning SHALL be applied inside the Edge Function rather than by the
caller. The `basis` recorded on the row SHALL describe what was actually asked
for.

Two flats measured on different evenings are only comparable if every row in the
cache was computed the same way, and a client-side convention is a convention
that one client can forget.

#### Scenario: A journey is requested at 6pm on a Sunday

- **WHEN** someone opens a listing on a Sunday evening and a transit journey is
  resolved
- **THEN** the journey returned and cached is the weekday 09:00 one, with
  `basis` recording that, rather than a Sunday-evening journey that would be
  cached forever and compared against weekday ones

## MODIFIED Requirements

### Requirement: The shared modules that run under Deno

`analysis.ts` and `png.ts` are the source of truth in `packages/core`, copied
into their Edge Function by `pnpm sync:function`, with `pnpm deploy:function`
refusing to deploy a stale copy. `tfl.ts` and `postcode.ts` SHALL join them
under that same rule.

All four SHALL remain free of `node:` imports and `import.meta.env` reads so
they run unchanged under Deno.

#### Scenario: A shared module is edited and not synced

- **WHEN** `tfl.ts` is changed in `packages/core` and `pnpm deploy:function` is
  run without syncing
- **THEN** the deploy is refused and names the stale file, rather than shipping
  a function whose behaviour has quietly diverged from the source of truth
