-- Whether the kitchen and the place to sleep are the same room in practice. A grading rather than
-- the boolean it replaces: `bed_in_kitchen` was true for every studio, so it said the same thing
-- about a mezzanine reached by a ladder as about a hob at the foot of the bed, and those are
-- different flats to live in.
--
-- `bed_in_kitchen` and its confidence are left in place and stop being read. Nothing backfills the
-- new column from the old one, and that is the point: `true` there means "a studio", which is
-- exactly the question this column exists to answer more precisely. Filling it in from what we
-- already have would write `same-space` onto every mezzanine we have ever seen. Rows analysed
-- before this stay null — "we could not tell" — until they are analysed again.
alter table property_analysis
  -- 'separate-room' | 'practically-separate' | 'same-space'. Validity is enforced in
  -- validateAnalysis, as it is for laundry and natural_light.
  add column if not exists sleeping_separation text,
  add column if not exists sleeping_separation_confidence text;
