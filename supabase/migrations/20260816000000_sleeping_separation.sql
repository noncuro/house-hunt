-- Whether the kitchen and the place to sleep are the same room in practice. A grading rather than
-- the boolean it replaces: `bed_in_kitchen` was true for every studio, so it said the same thing
-- about a mezzanine reached by a ladder as about a hob at the foot of the bed, and those are
-- different flats to live in.
--
-- `bed_in_kitchen` and its confidence are left in place and stop being read, and nothing backfills
-- the new column from them. So the analyses we already have do not carry this fact and will not
-- acquire it: `claim_analysis` returns a finished row as cached and only ever re-runs a failed or
-- stranded one, so nothing re-reads their photographs. The fact appears on listings analysed from
-- here on, and the ones analysed before this read as "we could not tell".
--
-- Translating was the alternative and is worse. `true` covered both the mezzanine and the hob at
-- the foot of the bed, so filling the column in from it would write `same-space` onto both — a
-- confident wrong answer about half of them, in the one place this column exists to get right, and
-- afterwards indistinguishable from an answer the model actually gave.
alter table property_analysis
  -- 'separate-room' | 'practically-separate' | 'same-space'. The sibling text gradings (laundry,
  -- natural_light) are validated in validateAnalysis alone; this one is constrained here as well,
  -- because everything downstream reads any value that is not 'same-space' as a bedroom of its own.
  -- The constraint is not the guard on its own — it is on the deployment, not in the code — so
  -- `toSleepingSeparation` parses the column on the way back out too.
  add column if not exists sleeping_separation text
    check (sleeping_separation in ('separate-room', 'practically-separate', 'same-space')),
  add column if not exists sleeping_separation_confidence text;
