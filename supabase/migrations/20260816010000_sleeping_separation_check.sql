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
--
-- Finding the name already taken is not the same as finding the constraint already there. Postgres
-- identifies a constraint by name alone, so a database carrying
-- `property_analysis_sleeping_separation_check` defined as `check (true)` — or over a wider set of
-- values than this one — refuses the `add` with exactly the error a second run of this file
-- produces. Swallowing that would record the migration as applied over a column that goes on
-- accepting anything, permanently, with every check green: the failure mode this file was split
-- out to prevent, arrived by the other door. So what is already there is read back and compared,
-- and anything else stops the migration rather than being recorded as done.
do $$
declare
  v_wanted text;
  v_found  text;
begin
  -- The definition is written once, here, and both sides of the comparison are derived from it.
  -- Spelling it out a second time as a string to compare against would be a copy free to drift
  -- from the one that runs — and it would drift silently, since the two agreeing is the only
  -- thing anybody would ever see. Added under a throwaway name so Postgres itself normalises it;
  -- if the real name is free this same constraint is renamed into place rather than rebuilt.
  alter table property_analysis
    add constraint property_analysis_sleeping_separation_probe
    check (sleeping_separation in ('separate-room', 'practically-separate', 'same-space'));

  select pg_get_constraintdef(oid) into v_wanted
    from pg_constraint
   where conrelid = 'property_analysis'::regclass
     and conname = 'property_analysis_sleeping_separation_probe';

  select pg_get_constraintdef(oid) into v_found
    from pg_constraint
   where conrelid = 'property_analysis'::regclass
     and conname = 'property_analysis_sleeping_separation_check';

  if v_found is null then
    alter table property_analysis
      rename constraint property_analysis_sleeping_separation_probe
                     to property_analysis_sleeping_separation_check;
    return;
  end if;

  alter table property_analysis
    drop constraint property_analysis_sleeping_separation_probe;

  -- Already correct: a stack that ran the constraint while it still lived in the `add column`, or
  -- this file a second time. Having it is what the migration is for, so having it is success.
  if v_found is distinct from v_wanted then
    raise exception
      'property_analysis_sleeping_separation_check already exists with a different definition: % — expected %',
      v_found, v_wanted
      using hint = 'Drop or correct the existing constraint, then re-run this migration. It has '
                   'not been applied: the column is not constrained to the three separations.';
  end if;
end $$;
