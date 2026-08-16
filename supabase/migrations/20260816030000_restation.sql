-- ------------------------------------------------------------------------------------------------
-- Drop every cached station, because some of them are a different station.
--
-- `resolveStation` used to take TfL's first search result, and TfL's search is fuzzy and ranked by
-- its own idea of relevance: "Hampstead" comes back as **West Hampstead** first, with Hampstead
-- itself second. So a Hampstead flat was given West Hampstead's coordinates and West Hampstead's
-- lines — a nineteen-minute walk where it is eight, and Jubilee and Mildmay dots beside a station
-- that has only the Northern line. It reads as a measurement, because it is one; it is just a
-- measurement of somewhere else.
--
-- The code now accepts a match only where the name it got back is the name it asked for. Nothing in
-- either cache records which resolution was fuzzy, so there is no way to correct the wrong rows
-- without also refusing to trust the right ones — and a cache that cannot be audited has to be
-- emptied. Both tables, in this order: a walk is measured *to* a point, so the walks computed
-- against a wrong point are wrong even where the name was right.
--
-- Cheap to lose. Both are lazily rebuilt the next time a listing in that postcode is opened, one
-- TfL call per station and one per station-postcode pair, and the allowance is 500 a minute.
-- ------------------------------------------------------------------------------------------------

delete from station_walk;
delete from station_point;
