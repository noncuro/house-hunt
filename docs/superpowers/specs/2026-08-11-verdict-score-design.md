# Verdict score — predicting yes/no for unrated flats

A classical-ML pass that learns from a project's own verdicts and predicts, for any flat, the
probability that the project would say **yes**. Complements the LLM vision pass: that reads the
photos, this reads the project's taste. Cheap enough to retrain on a button and score on the fly,
so nothing is ever persisted stale.

## Why

Triage is a pile of unrated flats and no order to work them in. A per-flat P(yes) gives one: work
the near-certain yeses first, cull the near-certain nos, and spend real attention on the genuinely
uncertain middle. The signal is already there — a project accumulates dozens of verdicts — it just
isn't being used.

## The model

- **Logistic regression**, L2-regularized, fit by batch gradient descent. Hand-rolled in
  `packages/core/src/predict.ts` — ~40 lines of math, no dependency, Deno-clean (runs in the Edge
  Function *and* the extension). sklearn is deliberately **not** used: hosted Supabase has no
  Python runtime (Edge Functions are Deno; `plpython3u` is off), and on ~50 rows × ~12 features it
  buys nothing a closed-form gradient step doesn't.
- **Output** is a calibrated P(yes) in [0, 1]. Interpretable weights fall out for free (a later
  "why this score" is cheap; not in the MVP).

### Label

One shared verdict per flat (in practice `set_by` is null on the D&A project, so per-person
signal isn't there yet — treat it as project-level). Map ratings to a binary target:

- Primary: **`love` → 1, `no` → 0, drop `maybe`**.
- The k-fold harness also reports **`love`+`maybe` → 1** so we pick empirically ("whatever works").
  Whichever wins ships as the default; the loser stays a one-line switch.

### Features (MVP)

Built by `featuresFor(input, hubs)` — one vector per flat, where `input` is the `PredictInput` each
surface maps its own row into (the DB row server-side, `Listing` + `Analysis` in the panel):

| Feature | Source |
|---|---|
| `price_pcm` (£/month) | `property.price` (parsed; weekly rents normalised) |
| `price_per_sqft` | price ÷ `floor_area_sqft` |
| `bedrooms`, `bathrooms` | `property` |
| `floor_area_sqft` | `property.floor_area_sqft` |
| `min_hub_km`, `mean_hub_km` | haversine from the flat's point to each `project_hub` |
| `nearest_station_mi` | `property.nearest_stations` (Rightmove's miles; a km unit is converted) |
| `light_ordinal` (0/1/2) | `property_analysis.natural_light` |
| `has_outdoor`, `has_dishwasher`, `in_unit_laundry`, `has_bathtub` | `property_analysis` |
| `furnished` (0/1) | `property.furnish_type` |

> Distance is **straight-line kilometres**, not travel time. This design first reached for
> `travel_time` in seconds, but that cache is postcode-to-postcode and sparse — it would have been
> missing on exactly the unrated flats the score exists to rank, where lat/lon is always there.
> Station distance is **miles**, Rightmove's own unit, rather than a walking time we'd have to
> invent. The names above are the ones in `FEATURE_NAMES`, units included on purpose: a feature that
> quietly changes unit between training and serving is the failure this table exists to prevent.

Missing numerics → **mean-impute + a `was_missing` indicator column** (a blank floorplan is a fact,
not a zero). Standardize each column to mean 0 / sd 1 using the training fold's statistics; the
same `feature_spec` (means, sds, column order) is saved with the model so scoring reproduces it.

## Where it runs

**Persist the model, not the scores** (the classifier changes often; a stored per-flat score goes
stale the moment someone rates one more flat).

- **`project_model` table**: one row per project — `weights jsonb`, `feature_spec jsonb`,
  `metrics jsonb` (k-fold accuracy / AUC / n), `label_mode text`, `version int`, `trained_at`.
  RLS: readable by project members, written only by the Edge Function (`service_role`), same
  pattern as the other shared-fact tables.
- **`predict` Edge Function**: refits on the project's current verdicts + features and upserts the
  one model row. This *is* the "Rerun ratings" action.
- **`score(model, features) → number`** in `packages/core`: pure, synchronous, no I/O. Web triage
  scores its unrated list at render; the extension panel scores the open flat the same way. Always
  against current weights, so never stale.

## UI

- **Rerun ratings** button in the Triage bar (and Settings → Diagnostics). Calls `predict`, shows
  `trained_at` + the k-fold accuracy so the number is legible, not magic.
- **Sort control** in Triage: **→ Yes** (score desc), **→ No** (score asc), **Most uncertain**
  (|score − 0.5| asc). Score shown as a badge/column on each card and the Compare/triage table.
- Empty/again-loud states: if the project has too few verdicts to fit (fewer than `MIN_PER_CLASS`
  = 4 of either class), the button says so rather than training a model that's noise. A retrain that
  lands here also *clears* any model already stored, so "insufficient" never leaves stale weights
  scoring flats behind the message saying there aren't enough verdicts to score them.

## Validation (first, before any UI)

`pnpm check:predict` — **leave-one-out k-fold on the D&A project** (n = 49). Pulls a frozen
fixture (`.fixtures/predict-<project>.json`, generated once by a hand-run `tools/` script from
prod; no PII — rightmove ids and numbers only) so the check is deterministic and offline, per the
harness rules. Asserts the model beats the majority-class baseline (33/49 ≈ 0.67) by a real margin
and prints accuracy / AUC for both label modes. If it doesn't clear the bar, the feature set is
wrong and the UI waits.

## Out of scope (MVP)

Per-person models; "why this score" weight breakdown; anything non-logistic; scoring the whole
shortlist eagerly; auto-retrain on every verdict (the button is explicit on purpose).
