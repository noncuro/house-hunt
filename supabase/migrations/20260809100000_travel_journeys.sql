-- The leg-by-leg breakdown of a transit journey, so the panel can show which lines you ride and
-- how much of the trip is walking — not just a total. Up to three genuinely distinct routes,
-- deduped by which lines they use, because TfL's three results are often the same trip with a
-- different bus at the front.
alter table travel_time add column if not exists journeys jsonb;
