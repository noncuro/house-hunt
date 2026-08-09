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

1. Unzip it somewhere you will not move or delete — `~/Applications/rightmove-house-hunt` is fine.
   **The folder has to stay where it is**; Chrome loads it from disk every time it starts.
2. Go to `chrome://extensions`.
3. Turn on **Developer mode**, top right.
4. **Load unpacked**, and pick the unzipped folder.
5. Click the extension icon. It opens the shortlist page, which will ask you to sign in.
6. Type the email address the invite went to. A six-digit code arrives; type that in.
7. If you were invited to a house hunt, you are in it. If you belong to more than one, pick which
   is active — everything you see is that one house hunt, and switching is explicit.

Open any Rightmove rental listing and the panel appears.

Set your display name under **Settings → How your name appears**. It is not a login — it is what
the others see next to a rating you set. Ratings are shared: one per flat per house hunt, showing
who set it and when.

## Updating it

Rebuild, re-zip, send. Replace the contents of the same folder and hit **Reload** on
`chrome://extensions`.

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

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected by the platform; don't set them.

**It verifies its caller now.** It used to deploy `--no-verify-jwt`, which was defensible when
there was no auth and the worst a stranger could do was make us re-analyse a flat we had already
chosen to look at. It is not defensible once calls are charged against somebody's monthly cap:
`analyse` resolves the caller's JWT, checks they are a member of the project they name, checks the
project has actually opened the listing, and claims against both caps before it spends anything.

## Admin (admins only)

The **Admin** tab appears only for addresses listed in the `admin_email` table, which a deployment
seeds for itself (see `supabase/seed.example.sql`). It shows every user and every project
ordered by what they have spent this month against their cap, plus outstanding invites and a
charge-by-charge list. Caps and the six-person limit are editable there. Hiding the tab is
presentation only — the boundary is `is_admin()` in the database, and every admin operation checks
it.
