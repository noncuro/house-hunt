-- Photo analysis, and travel times for every mode.

-- Places no longer carry a single mode: we show walking, cycling and transit together, so the
-- column was dead and misleading. travel_time is already keyed on mode, so nothing else changes.
alter table place drop column if exists mode;

-- The gallery, so the analyser can work from a property row without reopening the page. We store
-- Rightmove's URLs and never the images themselves (their ToS 13.4).
alter table property add column if not exists image_urls jsonb not null default '[]'::jsonb;
alter table property add column if not exists floorplan_urls jsonb not null default '[]'::jsonb;

-- One row per property: the analysis runs once, not once per page view.
create table if not exists property_analysis (
  rightmove_id text primary key references property(rightmove_id) on delete cascade,
  model        text not null,
  analysed_at  timestamptz not null default now(),
  image_count  int  not null,

  -- Absence is a finding, not a gap: "no floorplan published" is something we show loudly.
  has_floorplan          boolean not null,
  floorplan_sqft         int,
  -- stated = read off the plan, computed = summed from room dimensions, none = not derivable.
  floorplan_sqft_source  text check (floorplan_sqft_source in ('stated', 'computed', 'none')),
  floorplan_confidence   text check (floorplan_confidence in ('high', 'medium', 'low')),

  bedrooms  int,
  bathrooms int,

  biggest_room_label      text,
  biggest_room_sqft       int,
  biggest_room_confidence text check (biggest_room_confidence in ('high', 'medium', 'low')),

  has_bathtub        boolean,
  bathtub_confidence text check (bathtub_confidence in ('high', 'medium', 'low')),

  has_outdoor_space   boolean,
  outdoor_kind        text,
  outdoor_sqft        int,
  -- A measured number has to be tellable from a guess at a glance.
  outdoor_is_estimate boolean,
  outdoor_confidence  text check (outdoor_confidence in ('high', 'medium', 'low')),

  summary  text,
  captions jsonb not null default '[]'::jsonb,
  raw      jsonb
);

alter table property_analysis enable row level security;
drop policy if exists shared_household on property_analysis;
create policy shared_household on property_analysis for all to anon using (true) with check (true);

alter publication supabase_realtime add table property_analysis;
