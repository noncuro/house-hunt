# How this gets built: the subagent plan

This change is too large for one pass and too interconnected for naive
parallelism. Nearly every feature wants to touch `background.ts`,
`lib/supabase.ts` and `lib/messages.ts`, so **the decomposition is by layer, not
by feature.** Agents are given disjoint file ownership; anything shared is
written once, by one agent, before the agents that consume it start.

Read `proposal.md`, `design.md` and the three specs before starting. Read the
repo's `AGENTS.md` — its standing rules (never crawl, never re-host images, fail
loudly, one fact one renderer, select on `data-testid`) are binding and this
change does not relax any of them.

## File ownership

No two concurrent agents may write the same file. If an agent needs a change in
a file it does not own, it says so in its report and the orchestrator applies it.

| Wave | Agent | Owns |
|---|---|---|
| 1 | **schema** | `supabase/migrations/*`, `tools/check-rls.ts` |
| 2 | **core** | `src/lib/auth.ts`, `src/lib/supabase.ts`, `src/lib/messages.ts`, `src/entrypoints/background.ts`, deletes `src/lib/identity.ts` |
| 2 | **functions** | `supabase/functions/**`, `tools/sync-edge-function.ts`, the `deploy:function` script |
| 3 | **signin** | `src/entrypoints/shortlist/SignIn.tsx`, the shell wiring in `main.tsx` |
| 3 | **project** | `src/entrypoints/shortlist/Project.tsx`, `Settings.tsx` |
| 3 | **admin** | `src/entrypoints/shortlist/Admin.tsx` |
| 3 | **hubs** | `src/lib/hubs.ts`, `src/lib/sweep.ts`, `src/entrypoints/shortlist/Sweep.tsx` |
| 3 | **surfaces** | `src/entrypoints/panel.content/**`, `src/entrypoints/search.content/**`, `src/entrypoints/sweep.content/**` |
| 4 | **harness** | `tools/check-*.ts`, `tools/smoke*.ts` |
| 5 | **docs** | `AGENTS.md`, `SETUP.md`, `../registry/tools/rightmove-extension.yaml`, `../TODO.md` |

`main.tsx` is contended in wave 3. **signin** owns it; the other wave-3 agents
export their view and report the one-line mount they need, which the
orchestrator applies after the wave.

## Waves

**Wave 1 — schema (alone).** Nothing else can start: every other agent needs the
tables to exist and the policies to be real. Ends with `tools/check-rls.ts`
passing — the cross-project isolation assertion from tasks 1.13, which is the
single most important test in this change and the easiest to skip.

**Wave 2 — core and functions (parallel, disjoint trees).** `core` writes the
session handling, the project context and every message type the wave-3 agents
will call; it publishes the full `Request`/`ResponseMap` union first so wave 3
codes against a fixed contract. `functions` works entirely under
`supabase/functions/` and shares nothing with it.

**Wave 3 — the five UI/data agents (parallel).** Each consumes the message
contract from wave 2 and writes only its own files.

**Wave 4 — harness.** Every existing check and smoke test now needs a signed-in
session; each grows a fixture session rather than being skipped. Runs after the
code it tests exists.

**Wave 5 — docs.** Last, so it describes what was built rather than what was
planned. Reverses the "No user auth" decision in `AGENTS.md`, re-argues the
private-distribution rule on the new footing, and files the D14 follow-up.

## Rules for every agent

- **Report, don't reach.** Needing a file you don't own is a line in your report,
  not an edit.
- **`pnpm check` (oxlint + tsc) must pass** before you report done. It takes
  under a second.
- **Fail loudly.** A missing session, a hit cap and a refused invite are named
  states with their own rendering, never blanks and never a generic error.
- **One fact, one renderer.** Anything two views show belongs in
  `src/components/` or `src/lib/facts.ts`. Do not restate a fact in a view.
- **Do not construct a Supabase client** anywhere but `background.ts`. This is
  the invariant the whole session design rests on (design D2) and there is a
  check for it.
- Say what you did not do, and why. A silently narrowed scope is the one failure
  here that looks exactly like success.
