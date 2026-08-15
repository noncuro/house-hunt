-- Whether the kitchen and the place to sleep are the same room in practice. A grading rather than
-- the boolean it replaces: `bed_in_kitchen` was true for every studio, so it said the same thing
-- about a mezzanine reached by a ladder as about a hob at the foot of the bed, and those are
-- different flats to live in.
--
-- `bed_in_kitchen` and its confidence are left in place and stop being read, and nothing backfills
-- the new column from them. So the analyses we already have do not carry this fact and will not
-- acquire it. Nothing re-reads their photographs: `claim_analysis` only takes a row whose status is
-- `failed`, or one left `running` past the stale window, so against a finished row it claims
-- nothing and answers `busy` — which the analyse function turns into `cached` after reading the
-- row back. (It can also answer `capped` before it looks at the row at all.) Either way a `done`
-- analysis is handed back as it stands. The fact appears on listings analysed from here on, and the
-- ones analysed before this read as "we could not tell".
--
-- Translating was the alternative and is worse. `true` covered both the mezzanine and the hob at
-- the foot of the bed, so filling the column in from it would write `same-space` onto some flats
-- where that is plainly wrong — in the one place this column exists to get right, and afterwards
-- indistinguishable from an answer the model actually gave.
alter table property_analysis
  -- 'separate-room' | 'practically-separate' | 'same-space'. Validity is enforced in
  -- validateAnalysis, as it is for laundry and natural_light, and by `toSleepingSeparation` on the
  -- way back out of this column. The database constraint that says the same thing is a migration of
  -- its own — 20260816010000 — because a `check` written into the `add column` below would be
  -- skipped along with the column on any stack that has already run this file.
  add column if not exists sleeping_separation text,
  add column if not exists sleeping_separation_confidence text;
