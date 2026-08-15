# What the verdict score learns, and how we know

The verdict score fits a logistic regression to a hunt's own verdicts and predicts P(yes) for any
flat. This is the record of a study that asked whether it was any good, and what would make it
better. It is here because the answers are not obvious from the code, several of them are the
opposite of what we assumed, and the next person to reach for a fancier model should read what
happened when we tried.

Everything below is measured on one real hunt as it stood on 2026-08-15: **379 rated
flats, 331 no / 25 maybe / 23 love**. Every number is nested leave-one-out — hyperparameters chosen
inside the training fold, never on the held-out flat — which is what `pnpm check:predict` already
does, and every experiment reproduced the production baseline to four decimals before it was
trusted with anything else.

## Where it started and where it ended

| | love-vs-no | love+maybe-vs-no |
|---|---|---|
| The model as it was (14 features, shrink toward zero) | 0.8441 | 0.8557 |
| Better features | 0.9327 | 0.9111 |
| \+ what the hunt said it wants, as features | 0.9461 | 0.9276 |
| \+ what the hunt said it wants, as priors | **0.9615** | **0.9318** |
| \+ the size resolved the way the rest of the app resolves it | **0.9653** | 0.9245 |

Log-loss falls from 0.189 to 0.106 alongside, so this is a better-calibrated model and not only a
better-ordered one.

Those are leave-one-out figures, which is what the study ran on. What ships and what
`pnpm check:predict` prints is a nested **10-fold** estimate of the same model — **0.952 and
0.924** — a little lower because each fold trains on 90% of the data rather than 99%. Leave-one-out
was affordable when this fixture held 49 flats; at 379, against a two-dimensional hyperparameter
grid, it is twelve minutes a mode and 10-fold answers the same question in forty seconds.

Two honesty adjustments apply to every figure. About 130 of the 379 rows are relistings of flats
already in the set, so plain leave-one-out trains on a near-twin of the flat it is testing; collapsing
them by postcode, beds and price costs between 0.004 and 0.021. And this is one hunt, in one city,
with 23 positives — the confidence interval on any of these AUCs is roughly ±0.03, which is wider
than most of the differences argued about below.

## The uncomfortable finding

Two hand-written booleans — at least 1,000 sq ft, and has outdoor space — score **0.865** on their
own. The fourteen-feature model in production scored 0.853. For most of its life the verdict score
has been an expensive way to express two rules its owner could have written on a napkin.

That is not the whole story, and the rest of it is worth stating precisely, because "the model is
just two rules" would be the wrong lesson. Applying those two rules as a gate leaves 66 flats
holding 20 of the 23 loves, which lifts the love rate from 6.5% to 30%. Inside that pool a rule-only
model is a constant, so its AUC is 0.5 by construction, and anything above 0.5 there is knowledge
the rules do not contain. The model scores **0.84** in the pool, with a bootstrap probability of
1.000 that it beats chance. So there is real signal among the genuine candidates.

What that signal *is* deserves the same honesty: distance to the nearest saved place scores 0.8435
inside the pool **on its own**, which is the same number the entire model gets. The model's
knowledge about flats that clear the obvious bars is, as far as 23 loves can tell us, one more rule
— *close to somewhere you already like*. Light, outdoor size and biggest room each carry signal
individually and none of them adds anything measurable on top.

One consequence for how the improvements below should be read: the feature work is worth +0.079 on
the full set and nothing at all inside the pool (0.844 against the old model's 0.847). It is much
better at eliminating obvious nos and no better at judging the flats that are actually in contention.
That is still most of the product — the pile it works through is mostly obvious nos — and it is not
what "a better model" sounds like it means.

## What worked

**Resolving a floor area more often.** The largest single gain, and it is not a modelling change at
all. A quarter of the flats had no `floor_area_sqft` but did have a floorplan the vision pass had
already measured. Reading the size the way the rest of the app reads it, instead of trusting one
column, gives 89 more flats a number, and takes love-vs-no from 0.853 to 0.887 on its own.

**How much outdoor space, not merely whether.** `log1p(outdoor_sqft)` is the most important feature
in the final model by permutation importance, three times the next one. The existing boolean says a
balcony and a garden are the same fact. They are not.

**Missing indicators only where missingness is a fact about the flat.** A missing size means the
listing did not publish one, which is itself a signal. A missing `natural_light` meant the analysis
ran before that field existed, which is a signal about our own deployment history — and because
those 90 listings were the original hand-curated shortlist with a 20% love rate against 4% for
everything after, the indicator was quietly encoding "was on the first shortlist". Keeping
indicators for size fields and dropping them elsewhere beat both keeping all and dropping all.

**Asking the hunt what it wants.** The Your Hunt page already collects a size bar, a great-room bar
and must-have/nice-to-have amenities. Turning those into features — does this flat clear your bar,
how many of your must-haves is it known to miss — is worth about +0.013, and `unmet_musts` is the
most valuable single column added. It counts only amenities a flat is *known* to lack, so an unknown
never counts against it.

**Shrinking toward what the hunt wants instead of toward zero.** Standard L2 pulls every coefficient
to zero, which encodes the belief that no feature matters. Pulling them instead toward the signs the
preferences imply is worth another +0.015 on love-vs-no, and it is worth three times as much when a
project has only 20 to 60 verdicts, which is where every project starts. The strength is chosen by
cross-validation with zero in the grid, so a hunt whose data disagrees can still overrule it.

## What did not work

**Calibration.** The model was already calibrated: equal-mass ECE of 0.02 to 0.03, and the top decile
of predicted scores really does contain about the promised share of loves. Monotone calibration
cannot improve ranking by construction, and no calibrator improved probabilities in both label modes.
The thing that makes scores look untrustworthy is prevalence — with 6.5% positives almost every score
sits below 0.5 — and the fix for that is showing rank, not rescaling the number.

**Kernels.** RBF SVMs, a Gaussian process, Nystroem features and k-nearest-neighbours all lost to
plain logistic regression. A linear SVM was 0.02 ahead and inside the noise. The signal is linear;
kernels bought variance.

**The listing description.** TF-IDF reached 0.75 and MiniLM sentence embeddings 0.65, against 0.93 for
the numbers alone, and concatenating text with the tabular features was significantly *worse* than
the tabular features by themselves. The vocabulary that carried weight was neighbourhood names, one
building, agent boilerplate like "long let", and words for outdoor space we already have as a number.
Text would only be worth revisiting to extract specific new facts, not as a bag of words.

**Trees, in the end.** A random forest beat logistic regression by +0.05 on the old feature set,
which was the strongest single result in the study for a while. On the improved features the margin
falls to +0.016 and stops being significant: the trees were finding the size threshold, and the
features now say it outright. Shipping a forest would also mean shipping native missing-value
handling, since the gain was measured on raw features with NaNs rather than the imputing pipeline the
scorer uses.

**Supervised discretization.** Binning `best_sqft` by a tree's own split points and feeding the bins
to the regression scored 0.9329 against 0.9327 for the plain column. The threshold is already
expressible once the bar is a feature. RuleFit, the general form of the same idea, lost outright
(0.896) and produced conjunctions no one could be shown.

**Class balancing and L1.** Balancing was slightly negative on AUC and wrecked calibration (ECE 0.19).
Elastic net was flat to negative. Imbalance was not the constraint.

## Feature importance

Permutation importance on out-of-fold predictions, love-vs-no, for the model that shipped:

| feature | AUC drop when shuffled |
|---|---|
| `log1p_outdoor` — how much outdoor space | +0.112 |
| `unmet_musts` — must-haves the flat is known to lack | +0.038 |
| `has_outdoor` | +0.035 |
| `min_hub_km` — distance to the nearest saved place | +0.030 |
| `best_sqft`, `meets_min_sqft` | +0.017, +0.011 |
| `biggest_room_sqft`, `meets_great_room` | +0.010, +0.008 |
| bathtub, bathrooms, mean hub distance, light | ≤ +0.003 |
| dishwasher, price, station distance, furnishing, bedrooms, price per sq ft | ≤ 0 |

Four features do nearly all the work. Price is inert, which is what you would expect when the search
itself already filters to a £4,000–6,000 band: everything in the pile is affordable, so price stops
discriminating. Price per square foot is inert too, despite scoring 0.81 on its own — the size term
absorbs it.

The preference features add to the raw ones rather than replacing them. `best_sqft` and
`meets_min_sqft` both matter, because "how big" and "big enough for us" are different questions.

## Why preferences and not a hardcoded threshold

Adding `best_sqft >= 1000` as a feature scores about the same as reading the bar from the hunt's
settings — every paired interval between the two contains zero. The case for preferences is not
accuracy. It is that 1,000 was one person's number, and a shared constant would put one hunt's taste
on every other hunt's flats, which is the mistake `SEED_HUBS` already exists to warn about. The
settings bar is project data, the same as a hub.

It also happens that the three ways of arriving at the number agree: the owner typed 900, a decision
tree relearned 936.5 in 378 of 379 folds, and rule mining put the bootstrap median at 979. The
sensitivity sweep is broad rather than perfectly flat — anything from about 950 to 1,250 does as well
or better, and on the love+maybe target 900 does about as much as no bar at all — so the design
tolerates whatever a hunt types without every value being equally good.

## Could a hunt be told its own dealbreakers?

Yes, and the machinery is small: for each feature, scan candidate thresholds and score each rule by
a Wilson lower bound on "given this fires, it is a no", keeping only rules with enough support. It
recovers exactly the two rules — no outdoor space excludes 0 of 23 loves, and a size bar around
1,023 — in about sixty lines of dependency-free TypeScript.

It is not shipped, and the reason is a warning. At a 0.95 bound with 23 positives the miner stacks
four correlated rules and throws away 11 of the 23 loves; one notch stricter it finds only the
outdoor rule, and one notch beyond that, nothing. Only two rules survive a 90% bootstrap stability
bar, and a project needs roughly 200 verdicts before anything is trustworthy — the binding constraint
being the count of loves, not of rows. If it is ever built it should explain and sort, never filter,
and it should reject any rule that excludes more than 5% of known positives.

## Things this turned up that were not about the model

`in_unit_laundry` had been a dead feature for as long as it has existed: all 79 non-null values are
`in-unit`, so the column is constant and `chooseColumns` drops it on every fit.

`tools/export-predict-fixture.ts` could not run against production at all. It passed its SQL through
`psql -c`, which skips `:'var'` interpolation, and its hubs subquery selected `place.name` where the
column has been `label` since places and hubs became one table.

Some columns must never become features because they are consequences of the verdict rather than
causes. `seen_span_days` scores 0.899 on its own, which looks like the best feature in the study
until you notice that a flat stays on the worklist precisely because it was loved. `stage` and
`archive_reason` are the same trap, more obviously.

## Reproducing this

The experiments were Python, thrown away deliberately: they were a way to answer questions quickly
against a frozen fixture, not a second implementation to keep in step with the first. What survives
is this document, the model in `packages/core/src/predict.ts`, and `pnpm check:predict`, which
asserts the headline numbers on the committed fixture and fails if they regress.

To regenerate the fixture after more verdicts accumulate:

```bash
tsx tools/export-predict-fixture.ts <project_id> > .fixtures/predict-project.json
pnpm check:predict
```
