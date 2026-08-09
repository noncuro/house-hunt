-- Map-accurate coordinates for each property.
--
-- Rightmove ships `location.latitude/longitude` with `pinType: "APPROXIMATE_POINT"` — the pin is
-- deliberately fuzzed, which is fine on their own map and wrong on ours, where two flats a
-- street apart matter. The full postcode IS in the page blob and is exact, so we geocode that
-- through postcodes.io once per property and keep it. Rightmove's own pin stays as the fallback
-- for anything without a postcode.
alter table property add column if not exists postcode_lat double precision;
alter table property add column if not exists postcode_lon double precision;
