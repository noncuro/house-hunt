# spend — what each user costs, and the ceiling on it

## ADDED Requirements

### Requirement: Every paid API call is recorded with its cost

Each OpenAI request SHALL write one `api_usage` row carrying `occurred_at`,
`project_id`, `user_id`, `kind`, `model`, `input_tokens`,
`cached_input_tokens`, `output_tokens`, `cost_usd` and `rightmove_id`. The row
SHALL be written by the Edge Function with the service role, in the same step
that records the outcome of the call.

#### Scenario: A listing is analysed

- **WHEN** the analysis succeeds
- **THEN** the analysis row and the usage row are both written, so an analysis
  that nobody was charged for is not a reachable state

#### Scenario: The call fails after OpenAI produced tokens

- **WHEN** the request errors but the response carried a usage block
- **THEN** the usage is recorded before the claim is released, because tokens
  billed by OpenAI must be billed against a cap whether or not we got an answer

#### Scenario: A cached analysis is served

- **WHEN** a project reads an analysis another project already paid for
- **THEN** no usage row is written and nothing is charged to anyone

### Requirement: Prices are data, and a recorded cost never changes

Per-token prices SHALL live in a `model_price` table keyed on model with an
`effective_from`, replacing the hardcoded rates in the Edge Function. Cached
input tokens SHALL be priced at their own rate. `cost_usd` SHALL be stored on
the usage row and never recomputed.

#### Scenario: OpenAI changes its prices

- **WHEN** a new price is inserted with an `effective_from`
- **THEN** subsequent calls are costed at the new rate with no code change and
  no deploy, and every historical row still shows what it actually cost

#### Scenario: A response reports cached input tokens

- **WHEN** part of the prompt was served from OpenAI's cache
- **THEN** those tokens are costed at the cached rate rather than the full input
  rate, which the current implementation overstates by roughly an order of
  magnitude

### Requirement: $20 per calendar month, per project and per user

Analysis SHALL be refused once either the caller's project or the caller
personally has spent `monthly_cap_usd` (default $20) within the current calendar
month in Europe/London. Both caps SHALL be overridable per row by an admin.

#### Scenario: A project reaches its cap

- **WHEN** a project's month-to-date spend reaches its cap and a member opens an
  unanalysed listing
- **THEN** no OpenAI call is made, and the panel says the monthly analysis
  budget is used up and when it resets

#### Scenario: One member of a project is heavy-handed

- **WHEN** a single member reaches their personal cap while the project is still
  under its own
- **THEN** that member's analyses are refused and other members' continue,
  attributing the limit to the person rather than to the shared search

#### Scenario: The month rolls over

- **WHEN** the calendar month changes in Europe/London
- **THEN** month-to-date spend resets to zero and analysis resumes with no
  intervention

### Requirement: The cap check serialises on the budget, not on the listing

The cap check SHALL run before OpenAI is called, inside a transaction that holds
an advisory lock on the caller's project and then on the caller — always in that
order — and SHALL count both this month's recorded spend and the amount reserved
by calls already in flight. An in-flight call SHALL reserve `ESTIMATE_USD`
against both scopes, reconciled to its actual cost when its usage row is written
and released when its claim completes or goes stale.

Serialising only on the listing is **not sufficient**: `claim_analysis` makes
concurrent requests for the *same* listing contend, and requests for *different*
listings not contend at all, which is the case that matters.

#### Scenario: Several different listings are opened at once near the cap

- **WHEN** a project with $0.30 of headroom has a paced sweep open five
  unanalysed listings in quick succession
- **THEN** each request takes the budget lock in turn and sees the reservations
  the earlier ones made, so roughly three proceed and the rest are refused —
  rather than all five reading the same under-cap total and all calling OpenAI

#### Scenario: A call dies mid-flight

- **WHEN** the function crashes or times out after claiming and reserving
- **THEN** the reservation drains when the claim goes stale, through the existing
  stale-claim path, so a crash cannot permanently consume budget

#### Scenario: A call crosses the cap

- **WHEN** the last permitted call turns out to cost more than it reserved
- **THEN** the overshoot is the excess of that one call over `ESTIMATE_USD` and
  is accepted, because the cost of a call is not knowable before making it —
  concurrency does not widen this, because every in-flight call has already
  reserved against the same locked budget

### Requirement: Being capped is a state the interface explains

The Edge Function SHALL return a structured `capped` result naming the scope,
the spend, the cap and the reset date, and the extension SHALL render it as an
explicit state. Work that costs nothing SHALL continue.

#### Scenario: A capped user opens a listing

- **WHEN** the panel loads and analysis is refused for spend
- **THEN** it says so plainly, and travel times, nearest stations, extraction,
  verdicts and sweeps all still work — the photo findings are the only thing
  missing, and the panel says which

#### Scenario: Spend passes 80%

- **WHEN** month-to-date spend crosses 80% of a cap
- **THEN** a warning appears in the shortlist naming the remaining budget, so
  the first sign of a limit is not a listing that will not analyse

### Requirement: An admin can see and adjust what is being spent

The admin view SHALL show month-to-date and previous-month spend per user and
per project, and SHALL allow raising or lowering either cap.

#### Scenario: A user's spend looks wrong

- **WHEN** an admin opens the admin view
- **THEN** they can see each user's and project's spend for this month and last,
  drill into the individual charges, and change a cap without a deploy
