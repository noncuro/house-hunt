-- Cache the negative answer too.
--
-- "No journey found" is a stable fact about a (postcode, place, mode) triple — TfL will not plan
-- a five-mile walk today and change its mind tomorrow. Caching only successes meant those legs
-- were retried on every single page load, which is most of what the panel was waiting on: a
-- revisit showed 5 cache hits and 4 lookups, and all 4 were the same permanent 404s.
--
-- Transient failures are still not cached — those are exactly the ones worth retrying.
alter table travel_time add column if not exists no_route boolean not null default false;
alter table travel_time alter column seconds drop not null;
