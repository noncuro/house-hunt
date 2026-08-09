# Chrome Web Store listing

Everything the developer console asks for, written out so it can be pasted rather than composed at
the keyboard. Visibility: **Unlisted**. Category: **Productivity**. Language: **English (UK)**.

---

## Name

```
House hunt
```

## Summary (132 characters max — this is 108)

```
Commute times, floorplan facts and one shared verdict per flat, on the Rightmove listing itself.
```

## Description

```
Renting a place with someone else means the same three arguments on every listing: how long is it actually to work, how big is it really, and did we already say no to this one.

House hunt answers all three on the listing page itself.

TRAVEL TIMES THAT ARE COMPARABLE
Add the places that matter — work, the in-laws, the climbing gym — and every listing shows how long it takes to each on foot, by bike and by public transport. Transport times come from Transport for London and are all measured the same way, a weekday 09:00 departure, so two flats can honestly be compared. Hover any transport time to see which lines you would ride.

ONE VERDICT, SHARED
You and the people you are looking with share one rating per flat, not one each. It says who set it and when. Rate from the listing page or from the shortlist, and everyone sees it immediately — which means nobody views a flat the other person already rejected.

WHAT THE PHOTOGRAPHS ACTUALLY SHOW
Listings are written to flatter. The extension reads the floorplan and the photographs and reports what it finds: usable floor area, the size of the smallest bedroom, whether the "garden" is a balcony, whether the washing machine is in the flat or in a shared basement, whether there is a bed in the kitchen. Each finding says how confident it is, so you can tell a measurement from a guess.

A SHORTLIST YOU CAN ACTUALLY DECIDE FROM
Everything you have opened, in one place: a sortable table for comparing, a map for seeing which are near each other, and a triage view for working through the pile you have not judged yet.

PRIVATE BY DESIGN
Invite-only. You cannot sign in without an invitation, your house hunt is visible only to the people in it, and nothing is sold, shared or advertised against. No trackers, no analytics.

You will need an invitation to use this. If you do not have one, this extension will not do anything for you.
```

## Single purpose

```
To help people renting a home together evaluate Rightmove listings, by adding commute times, floorplan and photograph analysis, and a shared rating to the listing pages they open.
```

## Permission justifications

Each field below is the console's own prompt; the text under it is the answer.

**`storage`**
```
Stores the user's sign-in session and their interface preferences (which columns the comparison table shows) on their own machine. No listing data is kept in local storage.
```

**`tabs`**
```
The user can ask the extension to work through the listings from a search they have run. It opens them one at a time, on a timer, using chrome.tabs.create, so that the pacing is deliberate and stoppable rather than opening dozens of tabs at once. The extension does not read, monitor or enumerate the user's other tabs.
```

**`alarms`**
```
The MV3 service worker is shut down by Chrome after a short idle period, which kills any timer it holds. An alarm is used to wake it in order to refresh the user's authentication session before it expires. Without this the user is signed out every few days for no reason they can see.
```

**Host access — `https://www.rightmove.co.uk/*`**
```
The extension's entire purpose is to add information to Rightmove listing pages. Its content scripts run only on listing pages and search result pages, read the listing details already present on the page the user has opened, and inject the panel. It never fetches pages the user did not open and does no crawling.
```

**Host access — `https://api.tfl.gov.uk/*`**
```
Transport for London's journey planner, used to calculate walking, cycling and public transport times between a listing's postcode and destinations the user has entered. Only a postcode and a destination are sent.
```

**Host access — `https://api.postcodes.io/*`**
```
Converts a UK postcode into coordinates so a journey can be planned and a listing placed on a map. Only a postcode is sent.
```

**Host access — the Supabase project**
```
The extension's own backend: authentication, and the database holding the user's saved listings, ratings and destinations. Also hosts the serverless function that performs the photograph analysis.
```

**Remote code**
```
No. All code is contained in the uploaded package. Nothing is fetched and executed at runtime.
```

## Data use disclosures

Tick these, and no others:

- **Personally identifiable information** — yes. Email address, for sign-in; display name, if set.
- **Authentication information** — yes. Sign-in is a password since the change away from emailed
  codes. It is sent over HTTPS to Supabase Auth, which stores a salted bcrypt hash; the extension
  keeps only the resulting session token. Tick this even though the extension never stores the
  password itself — the field asks what the item collects, and it collects one.
- **User activity** — yes, in the narrow sense that the extension records which listings the user
  opened and how they rated them. This is the content of the product, not behavioural analytics.
- **Website content** — yes. Public details of the Rightmove listings the user opens.

Not collected: health, financial, personal communications, location (a postcode the user types is
not device location), or web history.

Then certify all three:

- Data is not sold to third parties.
- Data is not used or transferred for any purpose unrelated to the item's single purpose.
- Data is not used or transferred to determine creditworthiness or for lending.

## Test instructions (the "sign-in required" field)

The console asks whether the item requires an account, and if so for working credentials. This one
does, and a reviewer cannot obtain an invitation — so without this field the review fails at the
first screen and the rejection reads as "we could not access the functionality".

The account below has to exist on the live project before you submit, and it has to have something
in it: an empty shortlist and a listing with no analysis looks broken rather than invite-only. Seed
it with the demo data (`pnpm seed:demo`) so the reviewer sees the product working.

```
This extension is invite-only, so please use the account below.

1. Install the extension, then click its toolbar icon and choose "Open shortlist".
2. Sign in with:
      email:    reviewer@<domain>
      password: <password>
   There is no email step and no code — the address and password are all that is needed.
3. Open any Rightmove rental listing, for example
   https://www.rightmove.co.uk/properties/88023648
   The panel appears at the top right of the listing. It shows travel times, findings read from
   the floorplan and photographs, and the shared rating.
4. The shortlist tab (toolbar icon -> "Open shortlist") shows the same properties as a sortable
   table, a map and a triage view.

The account is already a member of a demo house hunt containing several saved listings, so every
view has content in it. Ratings you set are shared with that demo project only.
```

**Before submitting**, create it and check it:

```bash
# Create the reviewer account on the live project (service role; run from the repo root).
pnpm reviewer:create            # prints the address and the generated password

# Then sign in with it yourself once, in a clean Chrome profile, and walk the four steps above.
```

Rotate or delete the account once the review passes — it is a real account with a real password,
and it should not outlive the reason it existed.

## Privacy policy URL

```
https://<github-username>.github.io/<repo>/privacy
```

## Assets to upload

| Asset | Requirement | Where it is |
|---|---|---|
| Store icon | 128×128 PNG | `public/icon/128.png` |
| Screenshot (≥1, up to 5) | 1280×800 or 640×400 PNG | `.fixtures/shots/` — see below |
| Small promo tile (optional) | 440×280 PNG | not made yet |

Screenshots worth using, in this order: the panel on a listing (`88023648.png`), the comparison
table (`columns.png`), the map (`map.png`), the gallery over Rightmove (`88023648-gallery.png`).
They need re-cutting to 1280×800 — they are currently element screenshots at their natural size.

**Check before uploading**: these were taken against the real database and show real addresses and
real ratings. That is fine — the listings are public advertisements — but any that show an email
address or a display name should be retaken against the local fixture.
