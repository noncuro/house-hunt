-- Route places by coordinates, not by postcode string.
--
-- TfL's geocoder accepted "TW6 1JH" (a postcode terminated in 2009) and resolved it to a point
-- in northwest London — nowhere near Heathrow — returning a 300 disambiguation that we treated
-- as "no route". Resolving the postcode ourselves means a bad one fails loudly at entry instead
-- of silently producing a wrong or missing number.
alter table place add column if not exists lat double precision;
alter table place add column if not exists lon double precision;
