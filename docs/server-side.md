# The server side

Everything this app does that a browser cannot is a route under `apps/web/src/app/api/`. There are
seven — `predict`, `listing`, `analyse`, `travel`, `invite`, `resolve-location`, `password` — and
they hold the service-role key, which is the whole reason they exist rather than being queries a
client makes under RLS.

They were Supabase Edge Functions until 2026-08-30. This file is what survived that move: not how it
was done, which is finished, but the shape a route here has and the four things about it that are
load-bearing.

## One deployment

A Vercel deploy is the whole server side. There is no `supabase functions deploy`, no second
artefact, no `_shared/` copies of `packages/core` to keep in step, and no Deno-clean rule on any
file. When something server-side is wrong there is one place to look and one thing to redeploy.

That was the point. The two runtimes cost a class of bug that never looked like one: a shared fix
landed in `packages/core`, shipped to the website, and sat unshipped in the function's copy of the
same file with every check green.

## The reply convention is a contract

A non-2xx means the caller got something wrong or something broke. **Every product-level outcome** —
`capped`, `at-capacity`, `rate-limited`, `already-invited`, `in-progress`, `withdrawn`, `unreadable`,
`insufficient` — is a **200 with a `status` field**.

`callRoute` in `packages/core/src/db/route.ts` throws the server's own sentence for a non-2xx and
returns the body otherwise, so a route that answers 400 where a 200 is expected turns a sentence
somebody can act on into "something went wrong". `apps/web/src/server/handler.ts` exists to hold that
shape rather than letting each route adopt Next's conventions.

## The gate is hand-written, and unskippable by construction

Nothing sits in front of a route. A handler that forgets to resolve its caller is open to the
internet in the quietest possible way: it works. So the gate lives in the wrapper a route needs in
order to exist — `authedRoute` resolves the caller before the work runs; `publicRoute` takes a
sentence saying why it is open, and `pnpm check:routes` holds every one of those against
`PUBLIC_ROUTES`, which is the whole record of what this deployment answers without a session.

Membership is checked in code, not by RLS, because these routes hold the service role and RLS does
not apply to them at all. Every existing gate is load-bearing and has no platform behind it.

## The region is pinned

`apps/web/vercel.json` pins the project to `lhr1`, beside the database in `eu-west-1`. A new Vercel
project defaults to `iad1`, which would put every server-side query an Atlantic round trip from
Postgres.

It matters unevenly and most to `travel`, which reads three caches, writes to all three, and works a
backfill budget of up to 200 legs in one invocation — every one a REST round trip, so a US region
multiplies ~80ms by the number of queries and turns a comfortable five-minute budget into a timeout.
It is a project setting rather than a per-route one on purpose: an exception is a thing somebody has
to remember.

## The environment

Supabase injected `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` into every function. **Vercel
injects neither**, and that is the trap the move left behind. `SETUP.md` has the list and what each
one breaks when it is absent; the short version is that the project URL comes from
`NEXT_PUBLIC_SUPABASE_URL`, which the browser bundle already needs, and the privileged key has to be
added by hand as `SUPABASE_SECRET_KEY`.

It is read per request through `serviceConfig()` rather than at module scope, so a missing key fails
that request with a sentence naming the variable instead of failing the website's build.

## What must not change

- **Listing photographs and floorplans are never re-hosted.** `analyse` fetches images to send to
  OpenAI and holds them in memory. It must not gain a cache, a blob store, or a proxy route — on this
  platform all three are one line away.
- **No crawling.** `listing` stays a single server-side read of one page, for the person who has just
  pasted or shared that exact address, with the URL rebuilt from a numeric id so nothing a caller
  sends can steer it elsewhere. `resolve-location` stays one SEO page per call. A list of sightings
  is never handed to either — the sweep's paced opener opens them in front of the reader. The blocks
  at the top of those two files are the whole permission they have.
- **The per-user hourly limits on both of those are claimed, not checked.** `claim_hourly_call`
  makes the count and the row one step; a read-then-write limit is bounded by concurrency rather than
  by the limit.
