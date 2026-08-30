# Moving the Edge Functions to `apps/web`

Seven Supabase Edge Functions become seven Next.js route handlers in `apps/web`, and
`supabase/functions/` is deleted. One is done: `apps/web/src/app/api/predict/route.ts`. This
document is the argument for the move, what it costs, the order to do it in, and the checklist for
each remaining function. It is written to be picked up cold, several sessions apart.

## Why

The trigger is not a preference. Supabase's hosted Edge runtime caps **CPU at 2 seconds per
request** — not wall clock, and not configurable at any price. The verdict-score fit in `predict`
is pure CPU inside one request, and it crossed that ceiling as the hunt grew: the last successful
retrain was at 187 training examples, and at 604 every attempt came back "Function failed due to
not having enough compute resources". Nothing about the code was wrong. Making it faster would only
have moved the number of verdicts at which a hunt stops being able to retrain, which is the wrong
thing for that number to depend on. Vercel Functions have no separate CPU cap; the only ceiling is
wall clock, 300s on Hobby and 800s on Pro, declared per route as `maxDuration`.

That is the whole reason. The rest are real but secondary, and worth stating honestly so nobody
oversells the move later:

- **One deployment instead of two.** Function deploys are manual today (`package.json:54`
  `deploy:function`; nothing in `.github/workflows/` deploys them), so the website can ship a change
  whose server half is still last month's. On Vercel the two ship together or not at all.
- **One typechecker.** `pnpm check:functions` runs `deno check` over
  `supabase/functions/_shared/*.ts supabase/functions/*/index.ts` because those files are outside
  `tsc` and `oxlint` entirely. A route is inside both.
- **The `_shared/` byte-copy layer disappears.** `tools/sync-edge-function.ts:38-50` lists eleven
  files copied verbatim out of `packages/core/src/` with an import rewrite, because Deno cannot
  reach into the workspace. With it go `pnpm sync:function`, `pnpm check:sync`,
  `pnpm check:functions`, the `--check` gate inside `deploy:function`, and the standing rule that
  `analysis.ts`, `png.ts` and `predict.ts` must stay Deno-clean. `apps/web` already lists
  `@house-hunt/core` in `transpilePackages`, so a route imports the original.
- **Same-origin routes remove a whole class of CORS bug.** `cors()` at
  `supabase/functions/_shared/http.ts:51-75` echoes back exactly three kinds of origin: anything
  `chrome-extension://`, `https://www.rightmove.co.uk`, and the single literal value of
  `WEB_APP_ORIGIN`. *Exactly one* browser origin. That is how the site's custom domain came to be
  served the app happily while every function call from it was refused — the app was on one origin
  and `WEB_APP_ORIGIN` named another, and the browser discarded the replies with nothing on screen
  to say so. A same-origin `/api/*` call sends no preflight and cannot have this failure.

None of that touches the pieces of the product that stay on Supabase. PostgREST, GoTrue and
Realtime are still called directly from the page (`packages/core/src/db/supabase.ts` is
`db().from(...)` throughout), the migrations still deploy on merge, and RLS is unchanged.

## What is lost

**`verify_jwt` at the gateway.** Every function except `password` is deployed with Supabase's
gateway verifying the bearer token before the function runs. That was a second lock behind the
first: `requireCaller` (`supabase/functions/_shared/caller.ts:26`) verified the token again by
asking GoTrue. On Vercel **nothing sits in front of a route.** `apps/web/src/server/caller.ts` is
the only gate, and a route that forgets to call it is open to the internet in the quietest way
there is: it works.

That is why the gate has been moved into the wrapper a route needs in order to exist at all.
`authedRoute` in `apps/web/src/server/handler.ts:34` resolves the caller before the work runs and
hands it in, so the work cannot see an unauthenticated request; `publicRoute` (`handler.ts:43`) is
the deliberate exception and takes a sentence saying why. `pnpm check:routes`
(`tools/check-routes.ts`) reads every route file back and holds three things: that every exported
method is built by one of the two wrappers, that every `publicRoute` is on the `PUBLIC_ROUTES` list
in that file, and that every entry on the list is still a public route. It also holds that
`apps/web/src/server/` — where the service-role key is reachable — is imported by routes and by
itself and by nothing else. It is in `check:all`. Being public is once again an edit somebody has to
mean.

Middleware was the other candidate for that gate and is weaker. A middleware that checks a token is
*present* still lets a route that forgot its caller run for anyone holding any string; a middleware
that verifies properly does a GoTrue round trip that the route then repeats, on every request, for
the chatty functions as much as the slow ones. The check gives the guarantee at build time and costs
nothing at run time. And note what the move is not: `requireCaller` verifies the token by asking
GoTrue rather than decoding it, deliberately (`apps/web/src/server/caller.ts`), and that has always
been the real authority — putting it behind a wrapper makes it unskippable, it does not make it
stronger.

**So the `[functions.password] verify_jwt = false` exception becomes a `PUBLIC_ROUTES` entry.**
Today it is declared twice — in `supabase/config.toml`, and as the `--no-verify-jwt` flag on the
last line of `deploy:function` — so the one function anybody may call is greppable. After the move
it is `publicRoute('…', …)` in `app/api/password/route.ts` plus the matching line in
`tools/check-routes.ts`, and the reason to write there is the one that was true of the flag: that
`redeem` is deliberately unauthenticated, gated by the invite code and by `redeem_code()`'s
in-database guess limiter, and that `reset` checks `caller.isAdmin` itself
(`supabase/functions/password/index.ts:141-142`) precisely because nothing verified the token first.
Note that `password` is one route with two actions and only one of them is public, so the route is
public and `reset` does its own `requireCaller` — the wrapper cannot split a body.

**The scheduled caller is a database secret, not a config file.** `run_travel_backfill`
(`supabase/migrations/20260816120000_travel_backfill_token.sql:89-101`) posts to
`<travel_functions_url>/travel` through `pg_net`, reading three vault secrets —
`travel_functions_url`, `travel_publishable_key`, `travel_backfill_token`. Moving `travel` is
therefore a vault edit as well as a code change, done by hand on the database connection, and it is
not covered by any check. Get it wrong and the symptom is a column of dashes in the app that looks
exactly like a slow backlog — the failure mode `SETUP.md` already records from the GitHub Actions
version of this job, which failed 40 runs out of 40 at its own guard.

**`x-forwarded-for` stops being trustworthy for the same reason it was.**
`_shared/code.ts:95` `callerAddressHash()` hashes that header, and is documented as safe only
because the request is unreachable except through Supabase's edge, which overwrites it. Vercel also
sets it, but the assumption is a different one and should be re-read rather than inherited; Vercel's
own `x-vercel-forwarded-for` is the header that cannot be spoofed past the edge.

## Order, and why that order

The axis that matters is *who calls it*. A browser-only function is a route plus a client change. A
function with an extension caller is that, plus reproducing CORS, plus a manifest host permission,
plus an extension version bump on both sides — which is the standing rule in `AGENTS.md` and the
most common bug in this project when it is forgotten.

1. **`predict` — done.** Browser-only (`apps/web/src/screens/Triage.tsx` → `retrainModel` at
   `packages/core/src/db/supabase.ts:624`), no CORS, no extension, and the one that motivated the
   move. It also built the three server helpers everything else reuses:
   `apps/web/src/server/{supabase,caller,handler}.ts`. Read `retrainModel` before porting anything
   else — it is the worked example of a client repointed at a relative `/api/*` URL, including the
   explicit refusal for a non-`http(s)` origin so the extension gets a sentence rather than a 404
   that parses as nothing.

2. **`listing`.** Also browser-only — `packages/core/src/db/supabase.ts:412` inside
   `addListingByUrl`, from `apps/web/src/screens/AddFlat.tsx`. Second because it is the same shape
   as `predict` with one new ingredient: it makes an outbound fetch to Rightmove, so it proves the
   pattern for `resolve-location` and `analyse` without any CORS work.
   *Hazards.* The no-crawl block at `supabase/functions/listing/index.ts:12-36` is the whole
   permission this function has and must be carried over verbatim, not summarised. It writes its
   `api_usage` row *before* the fetch (`index.ts:92`), which is what makes the 60/hour limit
   (`index.ts:56`) survive a crash; keep the order. The hardcoded desktop `USER_AGENT`
   (`index.ts:46-47`) moves as-is. `AbortSignal.timeout` is fine on Node. `refusalFrom`
   (`packages/core/src/db/supabase.ts:1644`) reads the body off a `FunctionsHttpError.context` and
   will need the `fetch` equivalent — see "The client side" below.

3. **`invite`, `resolve-location`, `password`, `analyse`.** Each has an extension caller, so each
   costs the same extra work and they can be done in any order among themselves; taking them as one
   batch means one extension version bump rather than four. If they are split, every split costs
   another bump.
   - **`invite`** (`packages/core/src/db/supabase.ts:1668`; browser
     `apps/web/src/screens/Project.tsx`, extension `background.ts:249,256`). The plaintext code
     exists in the clear exactly once, in the reply — do not add logging around it. Web Crypto
     (`_shared/code.ts:37,81`) is a Node global. **`tools/fixture-session.ts:616` posts directly to
     `{url}/functions/v1/invite`** as harness setup, before the website is necessarily up; repoint
     it at the `create_invite` RPC with the service key rather than at the route, or the seed
     acquires a dependency on the server it is seeding for.
   - **`resolve-location`** (`packages/core/src/db/supabase.ts:1814`; browser `Project.tsx`,
     extension `background.ts:349`). Same shape as `listing`: a single SEO page fetch
     (`index.ts:153`), a `LIMIT_PER_HOUR = 10` (`index.ts:52`) counted in `api_usage` and written
     before the fetch (`index.ts:83`), and its own no-crawl block at `index.ts:15-38`.
   - **`password`** (`packages/core/src/db/supabase.ts:1746` redeem — **no auth header** — and
     `:1783` reset; browser `SignIn.tsx` and `Admin.tsx`, extension `background.ts:209,384`). The
     unauthenticated half, discussed above. It reaches GoTrue's admin API
     (`index.ts:113` create, `index.ts:152` update), so it needs `supabaseUrl()` and `serviceKey()`
     rather than only `rest()`. `MIN_PASSWORD_LENGTH = 10` (`index.ts:44`) is hand-kept in step with
     the client copy; keep them in step.
   - **`analyse`** (extension only — `apps/extension/src/entrypoints/background.ts:74` builds the
     URL and `:461` does a raw `fetch`; `apps/web` never calls it). The only function with no
     browser caller at all, so it is pure extension work and its CORS allowance is the
     `chrome-extension://` arm alone. It holds `OPENAI_API_KEY` (`index.ts:50`) and
     `ANALYSIS_ESTIMATE_USD` (`index.ts:56`), both of which must be added to the Vercel project
     before the route ships or the first analysis fails loudly for everyone. It is the long-pole
     *wall-clock* function (up to `MAX_IMAGES = 40` photographs through OpenAI's vision endpoint,
     `packages/core/src/analysis.ts:20`) but it is I/O-bound, so `maxDuration` matters here in a way
     CPU never did. `packages/core/src/png.ts` uses `CompressionStream`/`DecompressionStream`
     ('deflate'): Node globals since 18, but verify on the deployed runtime rather than locally.
     Preserve the claim/release pairing exactly — `claim_analysis` before spending,
     `record_analysis_failure` on every failure path, or a crash leaves budget reserved forever.

4. **`travel`, last.** 841 lines, and the only function with more than one thing that can go wrong.
   - **Two auth paths.** `isBackfill(request)` (`index.ts:678`) compares `x-backfill-token`
     constant-time and is checked *before* `requireCaller` (`index.ts:816` vs `:827`). Both paths
     must survive, and the backfill path must not accidentally acquire a JWT requirement.
   - **Module-level semaphores that deliberately span invocations.** `MAX_TFL_CONCURRENCY = 6`
     (`index.ts:78`) and `MAX_BACKFILL_CONCURRENCY = 2` (`index.ts:90`), instantiated at
     `index.ts:123-124`, with the comment at `index.ts:75-77` stating the assumption: a warm isolate
     serving many invocations. On Vercel that holds only where one instance serves concurrent
     requests. The backfill's limiter paces work *within* a single invocation and survives
     regardless. The interactive limiter does not: if each request gets its own instance, six
     becomes six-per-request and the pacing quietly stops existing. **Check what the project's
     concurrency model actually is before shipping this one**, and if the cross-invocation
     assumption no longer holds, say so in the code rather than leaving a constant that no longer
     limits anything — a limiter that silently stops limiting is exactly the "blanks look like real
     data" failure this repo refuses elsewhere.
   - **It is the pg_cron target.** See "Repointing the schedule" below.
   - **It is the harness's readiness probe.** `tools/edge-functions.ts:110` sends an origin-matched
     `OPTIONS` to `{supabaseUrl}/functions/v1/travel` and asserts the five allow-headers come back.
     When `travel` moves, that probe has nothing left to probe, and `tools/edge-functions.ts`,
     `supabase/.env`, and the `startFunctions()` calls in `smoke` and `smoke:web` are deleted with
     it. That is the last step of the whole migration.

## The per-function checklist

For each function, in this order:

1. **Port the handler** into `apps/web/src/app/api/<name>/route.ts`. Import `@house-hunt/core`
   directly, never a `_shared/` copy. Wrap the work in `authedRoute` from `@/server/handler` — it
   resolves the caller and hands it in, and it is what `check:routes` looks for — or, for `password`
   alone, `publicRoute` with its reason. Both give the reply convention: 405 for anything but POST,
   `HttpError` at its own status, everything else a 500 that still says what happened. `jsonBody`
   parses the body; `requireActiveProject` and `requireMembership` come from `@/server/caller` and
   are still called by hand where the function called them. Declare the three route-segment
   constants deliberately:
   `export const runtime = 'nodejs'`, a `maxDuration` chosen for that function's real ceiling, and
   `export const dynamic = 'force-dynamic'`. Keep every rate limit, every `api_usage` write and, in
   particular, every *ordering* between a usage row and the work it accounts for.
2. **Reproduce CORS if and only if a non-browser caller exists.** `apps/web/src/server/` has no
   `cors()` today, on purpose — `predict` is same-origin. The first function with an extension
   caller adds one, in `@/server/cors`, matching `_shared/http.ts:51-75`: `chrome-extension://` by
   **scheme** (the unpacked and store builds have different ids), `https://www.rightmove.co.uk`
   exactly, plus the site's own origins. Send all five allow-headers —
   `content-type, authorization, apikey, x-client-info, x-retry-count` — because that is
   supabase-js's own set and omitting `x-client-info` once broke every travel lookup in production
   (`http.ts:61-70`). Answer `OPTIONS` with 204 and set `Vary: Origin`. Do not carry
   `WEB_APP_ORIGIN`'s single-origin design across: it is the bug described at the top of this
   document. Allow the site's origins as a list.
3. **Repoint the client** — see below.
4. **Remove the function from `deploy:function`'s list** in `package.json:54`, so a deploy stops
   overwriting a function nobody calls with a copy of code that has moved. `password` is the
   separate `--no-verify-jwt` line at the end of that script.
5. **Delete the Deno copy** (`supabase/functions/<name>/`) and any entry in
   `tools/sync-edge-function.ts:38-50` that no remaining function still imports. Deleting a `FILES`
   entry while a function still imports it breaks that function at deploy time and nowhere earlier,
   so remove entries only after grepping `supabase/functions/` for the import. Delete
   `[functions.password] verify_jwt = false` from `supabase/config.toml` with `password`.
6. **Bump the extension if its bundle changed** — `apps/extension/package.json` `version` and
   `EXPECTED_EXTENSION_VERSION` in `apps/web/src/lib/extension-version.ts` to match (both `0.5.1`
   today). Nothing enforces this and a forgotten bump ships as a confident "up to date" on a browser
   running last week's extension.
7. **Run `pnpm check:all`**, and `pnpm smoke:web` for anything it exercises (`joining` covers
   invites; `AddFlat` covers `listing`).

### The client side

Five of the seven are called through `db().functions.invoke(...)` in `packages/core/src/db/`:
`travel.ts:42`, and `supabase.ts:412` (listing), `:1668` (invite), `:1746`/`:1783` (password),
`:1814` (resolve-location). Those calls carry two things a plain `fetch` does not: the project URL,
and the publishable key alongside the bearer. Both go away — the URL becomes the website's, and the
publishable key existed only to satisfy the Supabase gateway.

Two consequences, and they are the substance of this step:

- **Origin resolution.** A browser wants a *relative* `/api/<name>`, so it follows whichever origin
  the page is served from — production, a Vercel preview, or localhost — instead of becoming another
  copy of a URL to keep in step. The extension's background worker cannot use a relative URL: it
  would resolve against `chrome-extension://` and 404. `predict` solved this by refusing
  (`supabase.ts:637-642`), which is right for a website-only button and wrong for the five shared
  ones. The natural place for the answer is the `Host` interface in `packages/core/src/db/client.ts`
  — it already exists to hold exactly this kind of "where am I running" difference, is set once per
  application (`apps/web/src/lib/client.ts:62`, `apps/extension/src/lib/auth.ts:160`), and can carry
  an optional `apiOrigin` that the extension fills from `WXT_WEB_APP_URL` and the website leaves
  unset. Write one `callRoute()` helper beside it rather than repeating the fetch five times.
- **Error reading.** `describeInvokeError` (`packages/core/src/db/travel.ts:52-80`) and
  `refusalFrom` (`packages/core/src/db/supabase.ts:1644`) both dig the JSON body out of
  supabase-js's `FunctionsHttpError.context`, because supabase-js collapses every refusal to the
  string "Edge Function returned a non-2xx status code". With a plain `fetch` the body is simply
  there, so both readers collapse into the `callRoute()` helper — read `payload.error` and throw it.
  Both are deleted with the last `functions.invoke` caller, not before.

The extension additionally needs the website's origin in `host_permissions`
(`apps/extension/wxt.config.ts:91`, currently the Supabase host alone and commented as "one host,
and that is the whole list on purpose" — that comment stops being true with the first migrated
function the extension calls, and should be updated with the change rather than left).

No CSP change is needed for any of this. `connect-src` in `apps/web/next.config.ts` already contains
`'self'`, and the Supabase origin must stay there regardless because PostgREST, GoTrue and Realtime
still go direct from the page. CSP governs the page, never the extension's own fetches.

### Repointing the schedule (with `travel`)

`run_travel_backfill` posts to `<travel_functions_url>/travel`. After the move it should post to
`https://<the site>/api/travel`, which means:

- Update the `travel_functions_url` vault secret. The vault holds the *base*, and the function name
  is appended, so the new value is the site origin plus `/api` and no trailing slash.
- Decide what happens to `travel_publishable_key`. `Authorization: Bearer <publishable key>` and
  `apikey` exist only to get past Kong; a Vercel route ignores both. The token in `X-Backfill-Token`
  is the thing the function actually decides on, and it stays. Dropping the publishable key from the
  headers is the honest change; if it is dropped, delete the secret too
  (`delete from vault.secrets where name = 'travel_publishable_key';`) rather than leaving a secret
  that nothing reads.
- `TRAVEL_BACKFILL_TOKEN` moves from a Supabase function secret to a Vercel environment variable,
  with the same value the vault holds. Rotating it means changing both, in either order, with one
  failed run in between.
- The `timeout_milliseconds := 300000` on the `net.http_post` is five minutes, which is exactly the
  Hobby `maxDuration` ceiling. Keep `maxDuration` at or below it so the timeout that fires is the
  one whose failure is recorded.
- Verify on the database connection in `AGENTS.md`, with the queries in `SETUP.md`:
  `cron.job_run_details` for the schedule, `travel_backfill_run` for what was handed to pg_net, and
  `net._http_response` for what came back. A 404 there is the vault URL; a 401 is the token.

If Vercel's Deployment Protection is enabled on the project, an unauthenticated `pg_net` POST will
be bounced by the platform before the route sees it. Production deployments are normally exempt;
check before assuming, because the symptom is again a column of dashes.

## Environment

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected into every Edge Function by Supabase.
**Vercel injects neither.** `SETUP.md:122` currently says "`SUPABASE_URL` and
`SUPABASE_SERVICE_ROLE_KEY` are injected by the platform; don't set them" — true of an Edge
Function, false of a Vercel route, and it needs a sentence saying which is which as the migration
proceeds.

- `apps/web/src/server/supabase.ts` reads the URL from `NEXT_PUBLIC_SUPABASE_URL`, which the browser
  bundle already needs, so there is nothing new to set for it.
- **A privileged key must exist on the Vercel project**, and the name matters less than it looks.
  This project is on Supabase's current API keys — the browser holds an `sb_publishable_…`, not the
  legacy anon JWT — so the server half is an `sb_secret_…` and `SUPABASE_SECRET_KEY` is what to set
  by hand. `serviceConfig()` also accepts the legacy `SUPABASE_SERVICE_ROLE_KEY`, for one reason:
  that is the name the Supabase↔Vercel integration syncs, so a project with the integration
  connected already has a working key under a name nobody chose, and refusing it would mean asking
  somebody to add a credential the platform had already supplied.

  Both map to the `service_role` database role, which is the part that matters. It is *not*
  incidental privilege: `set_project_model` and `clear_project_model` are granted to that role alone,
  because `project_model` is the row every surface trusts to score flats and its writer must not be
  something a browser can impersonate. Every read a route here does could run as the caller under
  RLS; the write is the reason there is a key at all. Weakening that grant to `authenticated` to
  avoid the key would hand any browser the ability to post hand-crafted model weights.

  It is read per-request through `serviceConfig()` rather than at module scope, so a missing key
  fails that request with a sentence naming the variable instead of failing the website's build.
- With `analyse`: `OPENAI_API_KEY` and `ANALYSIS_ESTIMATE_USD`.
- With `travel`: `TFL_PRIMARY_KEY`, `TFL_SECONDARY_KEY`, `TFL_APP_KEY` (the function takes the first
  non-null, `index.ts:63-64`) and `TRAVEL_BACKFILL_TOKEN`.
- `WEB_APP_ORIGIN` is retired with the last CORS-bearing function, and unset as a Supabase secret at
  the same time.

**Local harnesses need the service key too.** `startWebApp()` in `tools/smoke-web.ts:1471-1480`
passes only `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` to `next build`
and `next start`. `localCredentials()` already returns `serviceKey` and the harness discards it
(`smoke-web.ts:73`). Nothing is broken today only because no `smoke:web` section exercises
"Rerun ratings" — but `listing` and `invite` *are* exercised, so add
`SUPABASE_SECRET_KEY: serviceKey` to that `env` before either lands. It is read at runtime,
not baked into the bundle, so it costs no rebuild. (The local stack issues a legacy service-role
JWT rather than an `sb_secret_…`; the routes accept either, and the variable name is what the route
reads, not a claim about the key's format.)

## Region

The Edge Functions run in Supabase's `eu-west-1`, beside the database. A new Vercel project defaults
to `iad1` (Washington), which would put every server-side query an Atlantic round trip away from
Postgres. There is no `vercel.json` in this repo yet; add one at the project's root directory
(`apps/web`) with `{"regions": ["lhr1"]}` — or `dub1`, which is the same side of the ocean and
nearer to `eu-west-1`.

It matters unevenly, which is worth knowing when deciding how much to care:

- **`travel` most.** It is chatty against the database — it reads three caches, writes to all three,
  and works a backfill budget of up to 200 legs in one invocation (`index.ts:605,610`). Every one of
  those is a REST round trip, so a US-region function against an EU database multiplies ~80ms by the
  number of queries and can turn a comfortable five-minute budget into a timeout.
- **`analyse` and `listing` next**, but for a different reason: their wall clock is dominated by one
  outbound call each (OpenAI, Rightmove), so the database latency is a smaller share — though
  `analyse` is also the function whose per-request cost is real money, and a request that times out
  after spending it is the worst outcome available.
- **`predict` least.** Four reads, one write, and a fit that dwarfs all of them. It would work from
  anywhere; it should still be pinned with the rest, because a per-route region exception is a thing
  somebody has to remember.

### The one thing in `travel` not to port faithfully

`travel` makes **five sequential HTTPS round trips over the public Supabase hostname** per request —
auth, profile, rate limit, `station_walk`, `station_point` — while the SQL behind them runs in about
a tenth of a millisecond on a primary key index. That is most of the latency on every travel read,
and it is invisible in a diff: port it line by line and it survives the move intact, having been
made slightly worse by the region change and no longer explicable by it.

It is a shape the Edge runtime encouraged and a Vercel route does not need. The reads go through one
server-side client rather than five HTTP calls, and the ones that do not depend on each other go
concurrently rather than in a chain. Auth has to come first — nothing else should run for a caller
who is not one — but the profile, the rate-limit read and the two caches do not depend on one
another.

Flagged as a deliberate change rather than a port, so it is reviewable as one: if the moved function
is faster than the old one by more than the region accounts for, this is why, and it should not be
mistaken for the move having done it. Found while triaging #44, whose own subject (station walks
refetched on every triage step, 150–250ms) is the smaller half of what it turned up.

## What must not change

- **The reply convention is a contract.** A non-2xx means the caller got something wrong or
  something broke. *Every* product-level outcome — `capped`, `at-capacity`, `rate-limited`,
  `already-invited`, `in-progress`, `withdrawn`, `unreadable`, `insufficient` — is a **200 with a
  `status` field**. `describeInvokeError` and `refusalFrom` parse refusals back out of the body, and
  a route that answers 400 where the function answered 200 turns a sentence somebody can act on into
  "something went wrong". `apps/web/src/server/handler.ts` exists to keep this shape rather than
  letting each route adopt Next's conventions.
- **Listing photographs and floorplans are never re-hosted.** They are rendered from Rightmove's own
  CDN URLs. `analyse` fetches images to send to OpenAI and holds them in memory; it must not gain a
  cache, a blob store, or a proxy route on the way to Vercel, where both are one line away.
- **No crawling.** `listing` stays a single server-side read of one page, for the person who has just
  pasted or shared that exact address, rate-limited per user, with the URL rebuilt from a numeric id
  so nothing a caller sends can steer it elsewhere. `resolve-location` stays one SEO page per call at
  ten an hour. A list of sightings is never handed to either — the sweep's paced opener opens them in
  front of the reader. The blocks at `listing/index.ts:12-36` and `resolve-location/index.ts:15-38`
  are the whole permission these have and move across word for word.
- **The gates are all hand-written now.** Membership is checked in code because these routes hold the
  service role and RLS does not apply to them at all. Every function's existing gate — the
  `project_property` link check at `analyse/index.ts:88-97`, `target()`'s admin/member rule at
  `invite/index.ts:115-137`, `caller.isAdmin` at `password/index.ts:142` — is load-bearing and has
  no platform behind it any more.

## Done when

`supabase/functions/` does not exist; `sync:function`, `check:sync`, `check:functions` and
`deploy:function` are gone from `package.json`; `tools/sync-edge-function.ts`,
`tools/edge-functions.ts`, `supabase/.env` and `supabase/.env.example` are deleted; `config.toml`
has no `[functions.*]` stanza; `SETUP.md` no longer tells anybody to deploy a function; and
`docs/coverage.md` no longer counts the Edge Function runtime in its timings. `pnpm check:routes`
stays, and `PUBLIC_ROUTES` in `tools/check-routes.ts` becomes the whole record of what this
deployment answers without a session — the successor to the `config.toml` stanza, and the one file
to read when asking that question. `AGENTS.md`'s
architecture map loses its `supabase/functions/` row and gains one for `apps/web/src/app/api/`, and
the Deno-clean rule on `packages/core/src/{analysis,png}.ts` is struck — it is the one rule in this
repo that will otherwise outlive its reason by years.
