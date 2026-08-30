-- A sweep is stamped with what it searched for.
--
-- `last_swept_at` means "we have seen everything this search returns up to here", and that sentence
-- is about one search. The criteria a hunt sweeps with became editable (`project_setting`'s
-- `search`) without anything connecting the edit to this table, so raising the rent ceiling left
-- every place dated by a sweep of the old ceiling: a flat listed three months ago and let in by the
-- change is older than that date, and the next window stepped over it, permanently, while the
-- panel reported the page fully recorded (#80). The hazard was written down before the feature was
-- built and the feature shipped without it.
--
-- A stamp on the row rather than a reset when the criteria are saved. A reset is a second write
-- that every surface able to save criteria has to remember, and one that fails leaves a row that
-- looks exactly like a good one; a stamp is read by whatever is about to sweep and says for itself
-- which search its date belongs to. `criteriaFingerprint` in packages/core/src/sweep.ts is the one
-- writer and the one reader — the parsed filters, keys sorted, minus the parameters a sweep decides
-- for itself — and `lastSweptFor` treats a row stamped for a different search as never swept.
--
-- Nullable, and not backfilled: a row from before this column is a complete pass of a search nobody
-- can name any more, and the reading that cannot drop listings is "never swept" — one widest-window
-- pass per place, once. Computing the stamp here in SQL would be a second implementation of the
-- fingerprint, and the day the two disagreed every place would re-sweep anyway, without saying why.
alter table hub_sweep add column if not exists criteria_fingerprint text;

comment on column hub_sweep.criteria_fingerprint is
  'The search criteria the last complete sweep ran with, as packages/core/src/sweep.ts '
  'criteriaFingerprint writes them. last_swept_at is only a date for that search: a mismatch with '
  'the hunt''s current criteria reads as never swept. Null for sweeps recorded before this existed.';
