-- The two values that belong to a deployment rather than to the schema.
--
-- Copy this file to `supabase/seed.sql` and edit it. That file is untracked, because who runs an
-- install and what they call their house hunt are facts about one deployment, not about the
-- project — a migration that hardcoded them would ship one person's address to everybody who
-- cloned the repo, and every re-run would put it back.
--
-- Supabase applies `supabase/seed.sql` on `supabase db reset` and on a first `supabase start`.
-- Against a hosted project, run it once by hand.

-- Who is an admin. Checked at sign-up: the trigger on `auth.users` sets `profile.is_admin` when
-- the address signing in appears here, which is why it can be seeded before anyone has an account.
--
-- Keep this to the addresses of actual people. Every row is another way to become admin, and an
-- admin can see every user, every project and every charge in the system.
insert into admin_email (email)
values ('you@example.com')
on conflict (email) do nothing;

-- What the first house hunt is called. The migration creates this project with a placeholder name
-- and attaches every pre-accounts row to it; this renames it. The uuid is fixed and must match the
-- one the migration seeds.
update project
   set name = 'Our house hunt'
 where id = '00000000-0000-4000-a000-000000000001';
