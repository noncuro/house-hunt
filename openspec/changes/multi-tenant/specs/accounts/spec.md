# accounts — who is using the extension

## ADDED Requirements

### Requirement: An account exists only because someone invited it

The Supabase project SHALL have public signup disabled. An `auth.users` row
SHALL come into existence only through the `invite` Edge Function, which runs
with the service role and validates the caller before creating anything: an
admin MAY invite any address; a non-admin member MAY invite only to their own
active project, and only while that project holds fewer than `max_members`
people (default 6). Pending invites SHALL count toward that ceiling, so six
outstanding invites cannot become a seventh member. Sign-in SHALL request the
code with `shouldCreateUser: false`, so a request from an uninvited address
creates nothing.

#### Scenario: A stranger with the bundle tries to sign in

- **WHEN** someone who was never invited installs the extension and asks for a
  code for their own email address
- **THEN** no account is created, no code is sent, and the sign-in view says the
  address has not been invited — rather than sending a code that will never
  verify

#### Scenario: A member invites a colleague to their project

- **WHEN** a signed-in member submits an email address to invite to their active
  project
- **THEN** an `invite` row is created against that project with `status:
  pending` and a 14-day `expires_at`, an account is created for that address,
  and the invitee can sign in and land in that project

#### Scenario: The project is already at its member cap

- **WHEN** a member of a project that already holds `max_members` people
  (default 6, admin-raisable) submits an invite
- **THEN** no invite row and no account are created, and the interface says the
  project is at its limit of 6 people and names how to raise it — the refusal
  is a stated state, not a generic failure, because the person will otherwise
  try the same address again

#### Scenario: A member tries to invite into a project they are not in

- **WHEN** a member submits an invite naming a project they are not a member of
- **THEN** the function refuses, no invite row and no account are created, and
  the refusal names the reason

#### Scenario: An invite is never used

- **WHEN** an invite passes its `expires_at` without the invitee signing in
- **THEN** it SHALL NOT confer membership, and it appears in the admin view as
  expired rather than pending

### Requirement: Sign-in is an emailed code, verified in the extension

Sign-in SHALL be a 6-digit one-time code sent to the user's email and entered on
the shortlist page. No part of sign-in SHALL depend on a hosted web page, a
redirect URL, or a token handed across an origin boundary. The Supabase email
template SHALL include `{{ .Token }}`.

#### Scenario: A user signs in for the first time

- **WHEN** an invited user enters their email and then the code they received
- **THEN** a session is established, their `profile` exists, their pending
  invite is consumed into a `project_member` row, that project becomes their
  active project, and the shortlist shows it

#### Scenario: The code is wrong or expired

- **WHEN** verification fails
- **THEN** the view says so and offers to send another code, keeping the email
  address already entered

#### Scenario: Codes are requested too often

- **WHEN** the provider's rate limit is hit
- **THEN** the view says the limit was hit and to wait, as its own state — not
  as a generic failure that invites another press of the button

### Requirement: The session survives a torn-down service worker

The Supabase client SHALL persist its session through a storage adapter over
`chrome.storage.local`, with `autoRefreshToken: false`. The background worker
SHALL call `ensureSession()` before any database access, refreshing when the
access token expires within five minutes, and SHALL additionally refresh on a
`chrome.alarms` heartbeat so an idle install does not lose its refresh token.

#### Scenario: The worker is torn down and a listing is opened hours later

- **WHEN** Chrome has suspended the service worker and the user opens a
  Rightmove listing
- **THEN** the worker wakes, recovers the session from `chrome.storage.local`,
  refreshes it if needed, and the panel renders normally with no sign-in prompt

#### Scenario: The extension is unused for a week

- **WHEN** no listing is opened for long enough that the access token has long
  expired
- **THEN** the alarm heartbeat has refreshed the session in the background, and
  the next use does not require signing in again

### Requirement: Exactly one context holds a Supabase client

`src/lib/supabase.ts` SHALL be imported for its runtime client only by
`src/entrypoints/background.ts`. Content scripts and the shortlist page SHALL
reach the database only through messages, and MAY import types.

#### Scenario: A new view needs data

- **WHEN** a view is added that needs to read or write the database
- **THEN** it adds a message type and the worker handles it; it does not
  construct a client, because two contexts refreshing one refresh token is how
  a session gets silently invalidated

### Requirement: Not being signed in is a state, never a blank or a stack trace

Every surface SHALL render an explicit signed-out state. The background worker
SHALL answer with a typed `unauthenticated` response rather than throwing.

#### Scenario: A signed-out user opens a listing

- **WHEN** the panel loads with no session
- **THEN** it shows one line inviting the user to sign in, linking to the
  shortlist, and does not record the property, request analysis, or render an
  empty panel that reads as a listing with no data

#### Scenario: A signed-out user opens a search page

- **WHEN** the search results or sweep surfaces load with no session
- **THEN** no card is badged and no card is dimmed, because a dimmed card
  asserts a verdict that no signed-out user can have

### Requirement: An admin can see the whole system

`profile.is_admin` SHALL gate an Admin view on the shortlist, hidden entirely
from non-admins and enforced in RLS rather than only in the UI. It SHALL show
users, projects, invites and month-to-date spend, and allow raising a cap or
revoking an invite. Membership and admin helper functions used inside policies
SHALL be `SECURITY DEFINER` with a pinned `search_path`.

#### Scenario: A non-admin looks for the admin data

- **WHEN** a non-admin queries the tables the admin view reads
- **THEN** RLS returns only their own rows, so hiding the tab is presentation
  and not the security boundary

#### Scenario: A policy asks whether the caller is an admin

- **WHEN** a policy on `profile` calls `is_admin()`
- **THEN** the call resolves without re-entering the policy, because the helper
  bypasses RLS — a plain function here fails with infinite recursion and an
  error that points nowhere near the cause
