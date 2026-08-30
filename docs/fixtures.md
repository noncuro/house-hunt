# Fixtures, and standing a test client up from nothing

Everything a fresh checkout needs before the browser harnesses will run, and why the saved
Rightmove pages are fetched rather than committed.

## The short version

```bash
pnpm install
pnpm exec playwright install chromium         # once per machine

cp supabase/.env.example supabase/.env        # the functions' environment
supabase start                                # ports 5434x, not the defaults

pnpm build:smoke                              # an extension pointed at the local stack
pnpm fixture 88023648                         # a saved listing page
pnpm fixture:search Hampstead                 # a saved search-results page
```

Then:

```bash
pnpm check:all                                # no database, no browser, seconds
pnpm check:rls && pnpm check:spend            # needs the local stack
pnpm smoke:web                                # the website, needs no fixture
pnpm smoke .fixtures/88023648.html            # the listing panel
pnpm smoke:search                             # the search badges and sweep panel
```

## The three things a test client needs

**1. A local Supabase.** `supabase start` in the repo root. This project's stack sits on **5434x**
because another project holds the default 54321-54324. It applies every migration from scratch, so
a stack that has been up for days can be behind `main` — two migrations' worth of drift is what
made `project_model` missing look like a panel bug. `supabase db reset` re-applies them without a
full restart.

The harnesses need a local stack rather than the hosted one for a reason that is not
squeamishness: signing a fixture user in needs the **service role key**, which exists locally and
does not exist for the hosted project. A signed-in harness is a local-stack harness by
construction. `tools/fixture-session.ts` explains why that is an improvement rather than a
concession.

There used to be a second thing here: `supabase/.env`, copied from its template, holding the
environment for the local Edge Runtime. There is no Edge Runtime. Everything this app runs
server-side is a route on the website, so what a harness needs is the workspace-root `.env` — which
it already has — and the local stack's own keys, which `tools/supabase-local.ts` reads out of
`supabase status` and hands to the website it starts. Nothing to copy and nothing to fill in.

**2. A smoke build of the extension.** `pnpm build:smoke`, which writes
`apps/extension/.output/smoke/chrome-mv3` pointed at the local stack. Which database the extension
talks to is compiled in, so this cannot be arranged at runtime. It is a separate output directory
from `pnpm build` on purpose — repointing the extension you have loaded in Chrome at a database
that is empty whenever Docker is down would turn a working install into an empty one with nothing
on screen to say why. The harnesses refuse to run against a build aimed anywhere else.

**3. The saved Rightmove pages.** Two, and only the last two harnesses need them:

| Command | Writes | Needed by |
|---|---|---|
| `pnpm fixture <listing-id>` | `.fixtures/<id>.html` | `check:extractor`, `smoke` |
| `pnpm fixture:search <hub>` | `.fixtures/search-<hub>.html` | `check:sweep`, `smoke:search` |

Any live listing id works — take one off Rightmove. If it has been taken down the page still
returns HTTP 200 with no `__PAGE_MODEL` in it, and `pnpm fixture` says so rather than saving a
file that fails two commands later. The search fixture takes a hub name (`Hampstead`,
`Primrose Hill`, `Belsize Park`, `Angel`, `Old Street`) and builds the URL with the same function
the sweep panel's links use, so the page saved is the page the sweep opens.

Both fetch one page, by hand, when you ask for them. That is the same act as opening the page and
hitting save, and it is not a crawl — nothing in the extension fetches Rightmove, and the standing
rule in `AGENTS.md` is what these tools are arranged around.

## Why the pages are not committed

The obvious reason is whose content it is: `.gitignore` has said "their content is theirs" since
the beginning, and a 1.4 MB pair of their pages in the repository is a different thing from a file
on your laptop.

The better reason is that committing them would quietly destroy what the fixture tier is *for*.
`check:extractor` and `smoke` exist to answer **"has Rightmove changed the page?"** — that is why
`AGENTS.md` says to run them after a Rightmove deploy. A fixture frozen in git answers a different
question ("do we still parse the page as it looked the day it was committed?") and would go on
answering it, green, for as long as nobody refreshed it — while the live page drifted and the
panel broke in exactly the way the check was written to catch.

So a committed fixture is worse than no fixture for the thing it is named after, and CI runs
everything that does not need one instead. There is a real check hiding in the other half of that
— "did *we* break the extractor against a known-good page" — and if it is ever wanted, the honest
way to have it is a **reduced** fixture: the `__PAGE_MODEL` script and a skeleton, a few kilobytes
of derived data rather than a copy of their page, committed and named for what it is. It has not
been built, because nothing has needed it yet.

The one committed exception is already in `.gitignore` and worth reading as the precedent it is:
`!.fixtures/predict-*.json`, un-ignored because it is ids, numbers and booleans by construction and
because "a check whose data is untracked is a check that only ever runs on one laptop."

## What CI does and does not run

`.github/workflows/check.yml` runs three jobs:

- **check** — `pnpm check:all`. No Docker, no network.
- **database** — `check:rls` and `check:spend` against a stack it starts itself.
- **browser** — `smoke:web`, which needs no Rightmove page at all. That is exactly what makes it
  the browser check that can live in CI, and it is the one covering the half of the product a
  person actually spends the evening in.

`smoke` and `smoke:search` stay local and deliberate, run after a Rightmove deploy against a page
fetched that day. `check:predict` currently **skips** in CI: it needs
`.fixtures/predict-*.json`, which is committable by design but has not been generated
(`tools/export-predict-fixture.ts`). It says so loudly rather than passing quietly — "this proves
nothing; it only declines to fail" — but it is still a green tick for a check that did not run.

## Things that will waste an hour if you do not know them

- **Docker needs room.** The stack wants more than a 2 GB / 2 CPU Docker Desktop can give it if
  another project's Supabase is also running. Degraded containers do not fail cleanly: they surface
  as statement timeouts, `upstream server is timing out` on sign-in, and browser harnesses that
  stall in different places each run. `docker ps` and count the stacks before debugging anything
  subtle.
- **`next dev` cannot serve this app to a harness.** The website ships a strict CSP with no
  `unsafe-eval`, and React's development build needs `eval()`. Under `next dev` the bundle dies on
  load and the page renders nothing. `smoke:web` builds and serves the production bundle, which is
  also the more honest test — it is the one that ships, CSP and all.
- **A stale stack is not a fresh one.** Config in `supabase/config.toml` reaches the containers only
  at `supabase start`. A stack started before a config change keeps the old behaviour, so a config
  break presents as flakiness that follows the machine rather than the branch.
