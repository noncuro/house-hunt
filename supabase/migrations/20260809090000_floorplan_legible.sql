-- Whether the floorplan could actually be read.
--
-- "No floorplan" and "a floorplan we couldn't read" are different facts and the UI must not
-- conflate them: the first is a gap in the listing, the second means we have not assessed the
-- place. Verified case: a plan that came back "almost entirely obscured/blackened" still
-- produced has_bathtub=false at high confidence, for a flat with two bathrooms.
alter table property_analysis add column if not exists floorplan_legible boolean;
