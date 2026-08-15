-- The database's half of the guard on `sleeping_separation`, which the migration that added the
-- column could not carry.
--
-- It was written there first, as a `check` on the `add column if not exists` — and that is a
-- constraint that only ever reaches a stack seeing the column for the first time. Postgres skips
-- the whole subcommand when the column is already there, the `check` with it, and Supabase records
-- the version either way, so editing 20260816000000 in place is a change that can never run again
-- anywhere it has already been applied. A constraint belongs in a file of its own for the same
-- reason every other backfill does.
--
-- Why the column is worth constraining at all when its siblings (laundry, natural_light) are not:
-- everything downstream reads any value that is not 'same-space' as a bedroom of its own, so an
-- unrecognised string here does not read as a gap, it reads as a fact — a flat counted among the
-- ones we know about rather than among the ones we could not tell. `toSleepingSeparation` is the
-- other half and the half that travels with the code; this half travels with the deployment, and
-- a row can predate it.
do $$
begin
  alter table property_analysis
    add constraint property_analysis_sleeping_separation_check
    check (sleeping_separation in ('separate-room', 'practically-separate', 'same-space'));
exception
  -- Already there: a stack that ran the constraint while it still lived in the `add column`, or
  -- this file a second time. Adding it is the whole of the migration, so having it is success.
  when duplicate_object then null;
end $$;
