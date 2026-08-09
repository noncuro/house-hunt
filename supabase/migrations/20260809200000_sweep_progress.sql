-- Which pages of a hub's sweep have been recorded.
--
-- "Mark swept" was a button, and the button was gated on the one condition the data already knew:
-- that you were on the last page. It existed because recording a single page is not finishing a
-- sweep — results come back newest first, so marking a hub swept from page three of three would
-- narrow the next window past everything on pages one and two, which is the only failure here that
-- looks exactly like success.
--
-- Tracking which pages have been recorded answers that properly. The hub marks itself swept when
-- the recorded pages cover 1..pages_total, and until then the shortlist can say how far through
-- you are — across tabs, which is where the button could never help.
--
-- `last_swept_at` keeps its meaning exactly: the last time this hub was swept *completely*. What
-- changes is that nobody has to assert it.
alter table hub_sweep
  add column if not exists pages_total integer,
  add column if not exists pages_seen integer[] not null default '{}';

-- Nullable rather than defaulted: a hub swept before this column existed has a real
-- `last_swept_at` and no idea how many pages that sweep had, and inventing a number would make an
-- incomplete sweep look finished.
comment on column hub_sweep.pages_total is
  'How many pages the current sweep has, as Rightmove reported it. Null for sweeps recorded before '
  'pages were tracked.';
comment on column hub_sweep.pages_seen is
  'Which pages of the current sweep have been recorded. Reset to {1} whenever page 1 is recorded, '
  'which is what starts a new sweep. When it covers 1..pages_total the hub marks itself swept.';

-- A hub whose pages are only half recorded has no complete sweep to date from, and the honest
-- value for that is null — the same thing a hub nobody has ever swept holds. `sweepWindow` already
-- reads null as "never swept, use the widest window", which is exactly right for a partial pass:
-- nothing may narrow a window on the strength of pages nobody finished.
alter table hub_sweep alter column last_swept_at drop not null;
alter table hub_sweep alter column last_swept_at drop default;
