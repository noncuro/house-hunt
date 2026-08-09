-- Floor area, so search-card badging can show size without reopening each listing.
-- `floor_area_source` records whether Rightmove published the number as data or we parsed it out
-- of the description prose — the second deserves less trust and the UI marks it.
alter table property add column if not exists floor_area_sqft int;
alter table property add column if not exists floor_area_source text
  check (floor_area_source is null or floor_area_source in ('sizings', 'description'));
alter table property add column if not exists floorplan_url text;
