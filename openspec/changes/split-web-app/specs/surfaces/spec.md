# surfaces — the website, the extension, and what passes between them

## ADDED Requirements

### Requirement: The house hunt is a website; the extension is the Rightmove overlay

The shortlist, compare table, map, listing detail, settings, project management,
invites, admin and sign-in SHALL be served from the web application at its own
domain. The extension SHALL contain no extension page of its own: clicking its
icon SHALL open the web application in a tab.

The extension SHALL keep only what requires a browser extension — the content
scripts on Rightmove listing, search and sweep pages, the background worker that
serves them, its own session, and its diagnostics log. A person who wants to
read the shortlist, rate a flat or manage a project SHALL be able to do all of
it with no extension installed.

#### Scenario: Someone is invited who has installed nothing

- **WHEN** an invited person opens the web application's address and signs in
- **THEN** they see the shortlist, can rate flats, add places and read analyses,
  and are told — not blocked by — the fact that the Rightmove overlay needs the
  extension

#### Scenario: A flat is shared with someone

- **WHEN** a member sends another member a link to one listing in the house hunt
- **THEN** it is an ordinary `https://` address that opens that listing's detail
  view, rather than a `chrome-extension://` address that is different on the
  recipient's machine and meaningless without an install

#### Scenario: The extension is clicked

- **WHEN** the extension icon is clicked
- **THEN** the web application opens in a tab, and no page hosted inside the
  extension is shown

### Requirement: One sign-in, two independent sessions

Sign-in SHALL happen only in the web application. The extension SHALL NOT
present a sign-in form or an invite-redemption form.

When sign-in succeeds, the web application SHALL pass the submitted email
address and password across the extension bridge, once and from memory, and the
extension SHALL perform its own password sign-in with them. The web application
SHALL NOT store the credentials and SHALL NOT pass its own access or refresh
token to the extension.

The two surfaces SHALL therefore hold two independent Supabase sessions. Sharing
one session is prohibited: Supabase rotates a refresh token on use and revokes
the family when a spent one is presented, so two holders of one token sign the
user out unpredictably and long after the cause.

Signing out in the web application SHALL sign the extension out too.

#### Scenario: Signing in for the first time with the extension installed

- **WHEN** a person signs in on the website with the extension installed
- **THEN** the website is signed in, the extension is signed in on its own
  session, and the panel works on the next Rightmove listing without any second
  sign-in

#### Scenario: The extension is installed later

- **WHEN** someone who is already signed in on the website installs the
  extension, so no password is in memory
- **THEN** the website detects an installed but signed-out extension and offers
  to connect it, asking for the password once — rather than leaving an extension
  that silently does nothing on every listing

#### Scenario: Either session refreshes

- **WHEN** the website's session and the extension's session each refresh on
  their own schedule
- **THEN** neither invalidates the other, because they are separate
  refresh-token families rather than two holders of one

#### Scenario: Signing out

- **WHEN** a person signs out on the website
- **THEN** the extension is signed out as well, and the overlay stops showing
  the house hunt's data on Rightmove

### Requirement: The bridge carries sessions and nothing else

The extension SHALL inject a bridge content script on the web application's
origin only, and it SHALL carry exactly three messages: `hello` (is an extension
installed, and is it signed in), `sign-in` (credentials, one way) and `sign-out`.

No property, verdict, place, hub, project or analysis SHALL cross the bridge.
Both surfaces read the database directly; the bridge exists solely to keep two
sessions in step.

The bridge SHALL be addressed by origin and SHALL NOT require the web
application to know the extension's id, because the unpacked build and the
Chrome Web Store build of the same code have different ids.

#### Scenario: A page on another origin tries to talk to the extension

- **WHEN** any page other than the web application's own origin attempts to send
  a bridge message
- **THEN** nothing receives it, because the bridge content script is not
  injected anywhere else and the extension is not externally connectable

#### Scenario: The store build and the unpacked build

- **WHEN** the same web application is used with the unpacked build on one
  laptop and the store build on another
- **THEN** both are detected and both sign in, because the bridge is matched on
  the website's origin rather than on an extension id that differs between them

### Requirement: The web application loads no third-party scripts

The deployed web application SHALL serve a Content-Security-Policy permitting
scripts from `'self'` and connections to `'self'` and the Supabase origin, and
nothing else. No analytics, embedded widget, CDN-hosted library or other
third-party script SHALL be added to it.

This is load-bearing rather than hygienic: the credential handoff is a
`window.postMessage` on this origin, and any script running on the origin can
read it.

#### Scenario: A third-party script is proposed

- **WHEN** any change would load a script from an origin other than the
  application's own
- **THEN** it is refused, or the credential handoff is replaced first with a
  server-minted second session that carries no password

## MODIFIED Requirements

### Requirement: Exactly one Supabase client per process

`packages/core` SHALL NOT construct a Supabase client. Each application SHALL
construct exactly one and hand it to core through `configure()` before any data
access, and the data layer SHALL reach it only through `db()`.

The extension's client SHALL keep the `chrome.storage.local` adapter,
`autoRefreshToken: false`, the explicit `ensureSession()` before every handler
that touches the database, and the `chrome.alarms` heartbeat — the MV3 trap
these answer is unchanged. The web application's client SHALL use supabase-js's
defaults and SHALL NOT carry any of that machinery, because a browser tab has
`localStorage`, an event loop and visibility events.

`tools/check-one-client.ts` SHALL be rewritten to assert the new shape rather
than deleted: one `createClient` call per application, none in `packages/core`
or `packages/ui`, no React in core, no `supabase.ts` in ui, and no import
crossing between the two applications.

#### Scenario: A component reaches for the database

- **WHEN** a component in `packages/ui` imports a value from the data layer
- **THEN** `pnpm check:all` fails and names the reason — a component takes data
  as props, and an import here pulls the whole data layer into the extension's
  content-script bundle

#### Scenario: Core is imported before it is configured

- **WHEN** any data-layer function is called before `configure()` has run
- **THEN** it throws saying so, rather than constructing a default client that
  would persist a session in the wrong place
