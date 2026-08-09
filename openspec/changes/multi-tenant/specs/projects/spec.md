# projects — one house hunt, shared by the people in it

## ADDED Requirements

### Requirement: A project holds a house hunt, and a user has one active at a time

A user MAY be a member of several projects and SHALL have exactly one
`active_project_id`. Every project-scoped read and write the extension makes
SHALL be against the active project. Switching projects SHALL be explicit.

#### Scenario: A user is invited to a second project

- **WHEN** an existing user accepts an invite to another project
- **THEN** they gain a second membership, their first project's shortlist,
  places, verdicts and sweeps are untouched, and they choose which is active

#### Scenario: A user switches projects

- **WHEN** the active project changes
- **THEN** the shortlist, panels, search badges and sweep state all reflect the
  new project, and nothing from the previous one remains on screen

### Requirement: Row-level security is the boundary, and `anon` holds nothing

Every table SHALL have RLS enabled with policies granted `to authenticated`
only. No policy SHALL grant the `anon` role access to any table. Project-scoped
tables SHALL be predicated on the caller's membership.

#### Scenario: The publishable key leaks

- **WHEN** someone obtains the key that ships in the bundle
- **THEN** they can read and write nothing, because the key authorises nothing
  and the boundary is a session proving control of an invited email address

#### Scenario: A member of one project queries another project's data

- **WHEN** a signed-in user issues a query for verdicts, places, sightings,
  sweeps or hubs belonging to a project they are not a member of
- **THEN** the query returns no rows and the write is refused, enforced in the
  database rather than by the client passing the right filter

### Requirement: Facts about listings are shared; opinions are not

Shared fact tables SHALL be readable by any authenticated user, so a listing is
analysed once across all projects rather than once per project: `property`,
`property_analysis`, `station_point`, `station_walk` and `travel_time`. Of
those, `property_analysis` SHALL be
writable only by the service role. Everything carrying an opinion — `place`,
`verdict`, `verdict_history`, `search_sighting`, `hub_sweep`, `project_hub`,
`project_property`, `invite` and `api_usage` — SHALL be project-scoped.

#### Scenario: Two projects find the same flat

- **WHEN** a second project opens a listing a first project already analysed
- **THEN** the existing analysis is served immediately, no OpenAI call is made,
  and nothing is charged against either cap

#### Scenario: A client tries to write an analysis

- **WHEN** any authenticated client attempts to insert or update
  `property_analysis`
- **THEN** the write is refused, because a poisoned analysis would be served to
  every project with no way to tell which one wrote it

### Requirement: No client writes a shared fact table directly

The `authenticated` role SHALL hold no `INSERT`, `UPDATE` or `DELETE` policy on
any of `property`, `property_analysis`, `station_point`, `station_walk` or
`travel_time`. Writes SHALL go through named `SECURITY DEFINER` functions that
validate their arguments; `record_property` SHALL additionally require a
`project_property` link to one of the caller's projects. `DELETE` on these tables
SHALL be available to `service_role` alone.

#### Scenario: A client tries to delete from a shared cache

- **WHEN** any authenticated client issues a delete against `travel_time`,
  `property`, `station_point` or `station_walk`
- **THEN** no rows are removed — a blanket write grant would include DELETE, and
  one buggy client could empty a cache every project depends on

#### Scenario: A client writes on behalf of a project it is not in

- **WHEN** a member calls `record_property` naming a project they are not a
  member of
- **THEN** the call is refused. This, and a missing `rightmove_id`, `url` or
  `display_address`, are the refusals that remain — an earlier draft also
  required an existing `project_property` link, which made recording a listing
  nobody had ever opened impossible while leaving the case it meant to stop wide
  open, since linking a listing is something any member may do. Creating the
  link **is** opening the listing, and `record_property` now does both in one
  transaction

#### Scenario: A member records a fact about a listing another project found

- **WHEN** a member's client records a listing that a different project had
  already opened and analysed
- **THEN** the write succeeds — accepted as irreducible, since no server can
  verify a price read off a page — and `property.written_by_project` names the
  project that wrote it, so the risk D4 accepts is at least not anonymous

#### Scenario: A member writes a wrong fact about their own listing

- **WHEN** a member's client records an incorrect price for a listing their
  project did open, and another project later opens the same listing
- **THEN** the second project reads the incorrect value. This is accepted and
  irreducible: no server can independently verify a price read off a page.
  Membership is invite-only, capped, and revocable

### Requirement: A cached journey is keyed on the two postcodes, not on a place

`travel_time` SHALL be keyed on `(origin_postcode, dest_postcode, mode)` and
SHALL retain `basis` and the staleness rules unchanged.

#### Scenario: Two projects share a destination

- **WHEN** two projects each save a place at the same postcode and each open a
  listing at the same origin
- **THEN** the journey is looked up once and both read the same row

#### Scenario: The existing cache is migrated

- **WHEN** the re-keying migration runs
- **THEN** every existing row is carried across with its `basis` intact,
  because dropping it would invalidate the whole cache and turn a schema change
  into a bill

### Requirement: A verdict is one shared state per property per project

`verdict` SHALL hold at most one row per `(project_id, rightmove_id)`, carrying
`rating`, `note`, `set_by` and `updated_at`. Every surface showing a rating
SHALL also show who set it and when. Prior values SHALL be written to
`verdict_history`.

#### Scenario: Two members rate the same flat

- **WHEN** one member rates a flat "love" and the other later rates it "no"
- **THEN** the project's verdict is "no", the previous value is in
  `verdict_history`, and the UI shows the rating attributed to whoever set it
  and when — so the change is visible rather than silent

#### Scenario: The existing per-person verdicts are migrated

- **WHEN** the migration runs against the current per-person rows
- **THEN** every row is preserved in `verdict_history`, each property collapses
  to its most recently updated rating, and the author's name is kept so
  authorship can be mapped to user ids once both accounts exist

### Requirement: Hubs belong to a project

The neighbourhoods a project searches around SHALL live in `project_hub` rather
than in compiled constants. A hub with a Rightmove location identifier is
searchable and appears in the sweep; a hub without one only answers "what is
this listing near". Saved places SHALL continue to widen the second list.

#### Scenario: The existing hubs are preserved

- **WHEN** the migration runs
- **THEN** the five neighbourhoods are seeded into that project with their
  verified coordinates and location identifiers unchanged, because re-deriving
  a coordinate silently corrupts every bearing computed from it

#### Scenario: A new project opens the sweep view

- **WHEN** a project with no hubs opens the sweep
- **THEN** it says there are no neighbourhoods yet and offers to add one, rather
  than naming somewhere the user is not searching

#### Scenario: A user adds a neighbourhood

- **WHEN** a user adds a hub by name
- **THEN** exactly one request resolves its Rightmove location identifier, made
  because a person asked for it, never in the background and never enumerating —
  the standing no-crawl rule is unchanged and this is the same single, hand-run
  lookup `pnpm find:locations` performs today

### Requirement: Existing data is migrated into one seeded project

All data currently in the database SHALL be assigned to a single seeded project,
with no row orphaned and none deleted.

#### Scenario: The migration completes

- **WHEN** the schema migration has run
- **THEN** every `property` is linked through `project_property`, every `place`,
  `search_sighting` and `hub_sweep` carries the project id, and the shortlist
  as it stood before shows exactly the same properties afterwards
