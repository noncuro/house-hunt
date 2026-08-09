# Privacy policy — House hunt

*Last updated: 9 August 2026*

House hunt is a private, invite-only Chrome extension for people renting a home
together. This policy describes every piece of data it handles and why. It is written to be read,
not to be survived.

## Who runs it

An individual, not a company. The extension is not a company product and is not sold. There are no
adverts, no analytics, no tracking pixels and no third-party trackers of any kind.

## What the extension collects

**Your email address.** It is stored so we know who you are between sessions and so your ratings
can say who set them. The extension never sends you email — the address is an identifier here, not
a channel.

**Your password.** You choose one when you redeem your invitation. It is handled by Supabase Auth,
which stores it as a salted bcrypt hash; the plaintext exists only in transit over HTTPS while you
are signing in, and is never written to a log or to any table. Because no email is ever sent, there
is no self-service reset link: if you forget it, whoever runs your house hunt sets a new one for
you and tells you what it is.

**Your display name**, if you set one. It appears next to ratings you leave.

**The listings you open, and what you say about them.** When you open a Rightmove listing with the
extension running, it records the listing's public details — address, price, bedrooms, floor area,
photograph URLs, nearest stations — along with anything you add: your rating, your notes, and the
places you measure commutes against (for example a work address you enter yourself).

**Nothing else.** The extension does not read pages other than Rightmove listing and search pages,
does not see your browsing history, does not read your other tabs, and has no access to any other
site.

## What it does not do

- It does not crawl Rightmove. It reads only pages you yourself opened.
- It does not copy or re-host Rightmove's photographs. Images are displayed from Rightmove's own
  servers by URL.
- It does not sell, rent, or share your data with anyone.
- It does not use your data to train any model.
- It does not show adverts or profile you for advertising.

## Who can see your data

Only the people in your house hunt. A "house hunt" is a private group of up to six people that you
join by invitation. Access is enforced in the database itself, by row-level security, not merely in
the interface: a signed-in person can read the ratings, notes and saved places of their own house
hunt and of no other.

One category is deliberately shared more widely. The automated description of a listing's
photographs — its room sizes, whether it has outdoor space, how much natural light — is stored
against the listing rather than against your group, so that if two households look at the same flat
it is analysed once instead of twice. That record holds no opinion, no name and no note; it is a
description of a public advertisement.

## Where it is stored, and who processes it

- **Supabase** (Amazon Web Services, London region, `eu-west-1`) hosts the database and the sign-in
  system. Your data stays in the United Kingdom.
- **OpenAI** receives listing photographs and listing descriptions in order to produce the
  automated summary above. It receives no personal data: no name, no email, no rating, no note.
  This is done through OpenAI's API, which does not train on data submitted through it.
- **Transport for London** and **postcodes.io** receive a postcode and a destination in order to
  return a journey time. They receive no identifying information.

## How long it is kept

Your listings, ratings and notes are kept until you delete them or ask for your account to be
removed. Once removal is asked for, everything associated with you is deleted, in full, within 30
days.

## Your rights

You can ask to see everything held about you, correct it, export it, or have it deleted, and every
such request is honoured. If you are in the UK or the EU you may also complain to your data
protection authority; in the UK that is the Information Commissioner's Office.

## Permissions the extension asks for, and why

| Permission | Why |
|---|---|
| `storage` | Keeps your sign-in session and your column choices on your own machine. |
| `tabs` | Opens listings one at a time when you ask it to work through a search, so it can pace itself rather than opening forty tabs at once. |
| `alarms` | Wakes the extension's background worker after Chrome has shut it down, so your session survives and you are not asked to sign in every few days. |
| Access to `rightmove.co.uk` | Reads the listing page you are looking at, and adds the panel to it. Limited to listing and search pages. |
| Access to `api.tfl.gov.uk` | Journey times by tube, bus, bike and on foot. |
| Access to `api.postcodes.io` | Turns a UK postcode into coordinates. |
| Access to the Supabase project | The extension's own database and sign-in. |

## Children

The extension is not intended for, and is not offered to, anyone under 18.

## Changes

If this policy changes materially, the date at the top changes. Nothing here sends email, so there
is no notification to expect: the current version is always the one on this page, and every past
version is visible in the history of the repository this file lives in.
