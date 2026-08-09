-- Which lines serve a station, cached beside its coordinates: one extra TfL call the first time
-- a station is ever seen, and nothing thereafter.
alter table station_point add column if not exists lines jsonb not null default '[]'::jsonb;
