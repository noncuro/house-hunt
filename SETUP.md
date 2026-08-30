# Getting set up

Everything the extension needs runs on Supabase. Nothing has to be running on anyone's machine —
no terminal, no local server, no laptop left awake. Load the folder into Chrome, sign in with a
code sent to your email, and that is the whole installation.

## What runs where

| Piece | Where it runs |
|---|---|
| Panel on Rightmove, shortlist page | The browser |
| Database (properties, verdicts, notes, travel cache) | Supabase Postgres |
| Sign-in, invites | Supabase Auth |
| Photo/floorplan analysis (holds the OpenAI key) | Supabase Edge Function `analyse` |
| Travel times | TfL's public API, called from the browser |
| Postcode → coordinates | postcodes.io, called from the browser |

The one thing that used to be local was the analysis. It was a Node process on one laptop
holding the OpenAI key, which meant a listing was only ever analysed while that laptop was awake
with a terminal open. It is now `supabase/functions/analyse`, deployed to the same project as the
database.

## The zip is no longer the password

It used to be. There was no login, the Supabase publishable key was compiled into the bundle, and
anyone holding the zip could read and write everything. That is over: every table is behind
row-level security, the key in the bundle authorises nothing on its own, and access is **an invite
to your email address**. Sending someone the zip without inviting them gives them a sign-in screen
that will refuse them, by name — the code request says no code was sent and to ask whoever shared
the extension.

Still send it privately, and still never through the Chrome Web Store. That rule survives auth for
a different reason: a tool that reads Rightmove listing pages is one thing when a handful of
invited people run it on pages they opened themselves, and another thing distributed at scale.

```bash
cd ~/GitHub/hub/rightmove-extension
pnpm install
pnpm package        # builds, then writes rightmove-house-hunt.zip
```

## Inviting somebody

Anyone on a house hunt can invite anyone else to it — you do not have to be the person who set it
up. Open the shortlist, go to **House hunt**, and put in their email.

- The invitation goes to that address. It works whether or not they already have an account.
- **A house hunt holds six people.** Outstanding invites count toward that, so six pending invites
  fill a project of six. At the limit the field is disabled and says so, and says what to do about
  it: revoke a pending invite to make room, or ask an admin to raise the limit.
- An invite lapses after fourteen days. A lapsed one does not block a fresh one to the same
  address, and reads "expired, never used" rather than sitting there looking like it is still
  waiting.

## Installing it

On macOS or Linux the **Install** tab has a one-liner that does the download and the unzipping for
you — copy it from there rather than from here, since it carries the address of the site you are
signed in to. It asks where to keep the folder the first time (`~/Applications/rightmove-house-hunt`
by default), remembers the answer in `~/.config/rightmove-house-hunt/install.conf`, and every run
after that replaces the contents of that same folder, which is the step that goes wrong by hand. It
still cannot reload Chrome — nothing outside the browser can — so it ends by printing steps 2–4 of
**Updating it** below and the version number you should see once you have done them.

By hand, on any machine:

1. Unzip it somewhere you will not move or delete — `~/Applications/rightmove-house-hunt` is fine.
   **The folder has to stay where it is**; Chrome loads it from disk every time it starts.
2. Go to `chrome://extensions`.
3. Turn on **Developer mode**, top right.
4. **Load unpacked**, and pick the unzipped folder. On macOS the picker opens on `/Applications`,
   which is not `~/Applications` and does not contain it — press <kbd>⌘⇧G</kbd> and type the path
   to go straight there.
5. Click the extension icon. It opens the shortlist page, which will ask you to sign in.
6. Type the email address the invite went to. A six-digit code arrives; type that in.
7. If you were invited to a house hunt, you are in it. If you belong to more than one, pick which
   is active — everything you see is that one house hunt, and switching is explicit.

Open any Rightmove rental listing and the panel appears.

Set your display name under **Settings → How your name appears**. It is not a login — it is what
the others see next to a rating you set. Ratings are shared: one per flat per house hunt, showing
who set it and when.

## Updating it

Rebuild, re-zip, send. Run the one-liner again — it goes back to the folder it used last time — or
replace the contents of the same folder by hand, then hit **Reload** on `chrome://extensions` and
check the card shows the new version.

**Your session and settings survive that**, and they survive moving the folder too. The manifest
carries a fixed `key`, which pins the extension id. Without it Chrome derives the id from the
folder's absolute path, so renaming or moving the folder would mint a new id, which means a new
`chrome.storage` — you would be signed out and the extension would look broken.

## If something is wrong

Settings → Diagnostics → **Copy log**. That is what the extension actually did: every TfL call,
every retry, every failure. Paste it to whoever runs the install.

Two things that look like bugs and are not:

- **A blank panel that says you are signed out.** Sign-in state is read once when a page loads, so
  signing in from another tab does not repaint a Rightmove page you already had open. Reload it.
- **"Photos not analysed" with a note about a limit.** Each house hunt and each person can spend
  $20 a month against the owner's OpenAI key. Past that, analysis stops until the month rolls over;
  everything else — travel times, verdicts, the shortlist, sweeping — keeps working.

## Deploying the analysis function (admins only)

```bash
pnpm sync:function --check          # the function's copy of src/lib must be current
pnpm deploy:function                # does the check, then deploys
```

The function needs `OPENAI_API_KEY` set once as a project secret:

```bash
supabase secrets set OPENAI_API_KEY=... --project-ref <ref>
```

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected into *Edge Functions* by the platform;
don't set them there.

**A route on the website is a different matter, and this is a trap worth reading twice.** Vercel
injects neither. Anything under `apps/web/src/app/api/` reads the project URL from
`NEXT_PUBLIC_SUPABASE_URL`, which is already set — but the privileged key has no such substitute and
has to be added to the Vercel project (Settings → Environment Variables), and to the workspace-root
`.env` for `pnpm dev:web`.

Set it as **`SUPABASE_SECRET_KEY`** (an `sb_secret_…`), which is the counterpart of the
`sb_publishable_…` this project already uses. The routes also accept the legacy
`SUPABASE_SERVICE_ROLE_KEY`, because that is the name the Supabase↔Vercel integration syncs — so a
project with that integration connected has a working key already, under a name nobody chose.

Without either, the failure is a 500 at the moment somebody presses the button. `docs/vercel-migration.md`
says why these are moving.

`pnpm deploy:function` deploys every function, not only `analyse`. What lets a phone add a flat is no
longer among them: `listing` is a route on the website now (`apps/web/src/app/api/listing/`), so it
ships with a Vercel deploy and needs the secret key above rather than a function deploy. A phone
whose **Add a flat** button fails is therefore a website problem, not a missed `deploy:function`.

**It verifies its caller now.** It used to deploy `--no-verify-jwt`, which was defensible when
there was no auth and the worst a stranger could do was make us re-analyse a flat we had already
chosen to look at. It is not defensible once calls are charged against somebody's monthly cap:
`analyse` resolves the caller's JWT, checks they are a member of the project they name, checks the
project has actually opened the listing, and claims against both caps before it spends anything.

## The travel backfill's three secrets (admins only)

A pg_cron job asks the `travel` function to work the journey backlog down every fifteen minutes.
The credentials it calls with live in the project's own vault rather than in the repository, so a
fresh deployment has to put them there once.

First generate the token and give it to the function, from a shell:

```bash
export TRAVEL_BACKFILL_TOKEN="$(openssl rand -hex 32)"
supabase secrets set TRAVEL_BACKFILL_TOKEN="$TRAVEL_BACKFILL_TOKEN" --project-ref "$SUPABASE_PROJECT_REF"
```

Then hand the same value to the vault from that shell, so it goes into the database without ever
being printed — `psql -v` interpolates it and the token stays out of scrollback and shell history:

```bash
PGPASSWORD="$SUPABASE_DB_PASSWORD" psql -h ... -U "postgres.$SUPABASE_PROJECT_REF" -d postgres \
  -v tok="$TRAVEL_BACKFILL_TOKEN" -v pub="$NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY" <<'SQL'
select vault.create_secret(
  'https://<project-ref>.supabase.co/functions/v1', 'travel_functions_url',
  'Where run_travel_backfill posts. No trailing slash.'
);
select vault.create_secret(:'pub', 'travel_publishable_key',
  'Gets the scheduled call past the gateway. Grants nothing on its own.');
select vault.create_secret(:'tok', 'travel_backfill_token',
  'What tells the travel function this is the schedule. Must match the TRAVEL_BACKFILL_TOKEN secret.');
SQL
```

(The connection line is the one in AGENTS.md.)

All three names are exactly what `run_travel_backfill` looks for; missing any of them it raises and
says which, rather than returning quietly — the whole reason this moved out of GitHub Actions is
that the workflow it replaced needed two repository secrets nobody knew were missing and failed 40
runs out of 40 while the app showed a column of dashes that looked like a slow backlog.

**Why three rather than the one service-role key this used to send.** That key opens every table in
the database and the schedule needs to do exactly one thing with it, so a leak of the thing that
spends the TfL budget was a leak of everything, and neither purpose could be rotated without the
other. It was also tied to a moving part: Supabase issues both a legacy JWT and a newer `sb_secret_`
service key and injects whichever is current as `SUPABASE_SERVICE_ROLE_KEY`, so the vault's copy and
the function's copy stopped being the same string with nothing on either side to show it — every
scheduled run came back 401 while a hand-rolled call with the other key returned 200 on the same
deployment. The token above is ours, means one thing, and is not tied to the platform's key rotation
at all. It cannot go in `Authorization` or `apikey` because the gateway validates those as project
keys, which is what the publishable key is for; the token travels in `X-Backfill-Token`.

**Upgrading an existing deployment:** add the two new secrets, confirm a run works, then drop the
old one — `delete from vault.secrets where name = 'travel_service_role_key';`. Nothing removes it
for you: a migration that deletes a secret it did not create destroys a working deployment if it is
ever re-run mid-rollout.

To check it, on the database connection in AGENTS.md:

```sql
select * from cron.job where jobname = 'travel-backfill';
select status, return_message, start_time from cron.job_run_details
  where jobid = (select jobid from cron.job where jobname = 'travel-backfill')
  order by start_time desc limit 5;
select * from travel_backfill_run;              -- what the last run handed pg_net
select id, status_code, created from net._http_response order by created desc limit 5;
```

`select run_travel_backfill(10);` runs one small pass by hand. It returns null — and says so as a
notice — when the previous request was made within the last sixteen minutes and has not answered
yet, which is how two runs are kept off the same gaps. Sixteen rather than fifteen: the window has
to outlast the gap between slots or the next slot never sees anything as outstanding.

## Admin (admins only)

The **Admin** tab appears only for addresses listed in the `admin_email` table, which a deployment
seeds for itself (see `supabase/seed.example.sql`). It shows every user and every project
ordered by what they have spent this month against their cap, plus outstanding invites and a
charge-by-charge list. Caps and the six-person limit are editable there. Hiding the tab is
presentation only — the boundary is `is_admin()` in the database, and every admin operation checks
it.
