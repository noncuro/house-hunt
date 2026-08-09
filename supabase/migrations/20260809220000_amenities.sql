-- Five things a rental listing decides for you and never puts in a field.
--
-- Two of them (house share, bills included) are only ever stated in the agent's prose, which is
-- why `property.description` arrives in the same migration: the vision pass could not answer them
-- from photographs, and asking it to guess would have produced confident nonsense about bills.
alter table property add column if not exists description text;

alter table property_analysis
  add column if not exists is_house_share boolean,
  add column if not exists house_share_confidence text,
  -- 'in-unit' | 'in-building' | 'none'. Where the machine is, not whether one exists: a communal
  -- basement laundry and a machine in the kitchen are not the same offer.
  add column if not exists laundry text,
  add column if not exists laundry_confidence text,
  add column if not exists has_dishwasher boolean,
  add column if not exists dishwasher_confidence text,
  add column if not exists bed_in_kitchen boolean,
  add column if not exists bed_in_kitchen_confidence text,
  add column if not exists utilities_included boolean,
  add column if not exists utilities_confidence text;
