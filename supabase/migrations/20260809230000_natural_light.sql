-- How much daylight a place gets, as low/medium/high. A rating rather than a boolean: every flat
-- has some light and the question is how much, so a yes/no would have to invent a threshold.
alter table property_analysis
  add column if not exists natural_light text,
  add column if not exists natural_light_confidence text;
