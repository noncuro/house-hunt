-- What a cached travel time *means*.
--
-- TfL's planner, asked without a date, plans against right now, so every transit number in this
-- table was measured at whatever moment somebody happened to open that listing — a Sunday
-- evening, a night-bus hour, a morning with the Northern line part-suspended — and was then shown
-- forever as "the commute". The compare table was ranking those against each other as though they
-- answered the same question.
--
-- Transit is now pinned to a weekday 09:00 departure. This column records the basis a row was
-- measured on so the code can tell an old number from a current one; a row whose basis is not the
-- current one is treated as a cache miss and recomputed on the next visit. NULL is exactly right
-- as the default: it is what every existing row was measured on, which is to say, unknown.
alter table travel_time add column if not exists basis text;

comment on column travel_time.basis is
  'The measurement basis: "anytime" for walking/cycling, "weekday-0900" for transit. NULL means '
  'the row predates basis tracking and was measured at an unknown time of day. See TRAVEL_BASIS '
  'in src/lib/tfl.ts — a row whose basis differs from the current one is refetched.';
