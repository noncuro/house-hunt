# House hunt

A shared shortlist for finding somewhere to live in London, for the people looking together.

Renting a place with somebody else means the same three arguments on every listing: how long is it
really to work, how big is it actually, and did we already say no to this one. This is a website that
answers all three, for everybody in the hunt, off one list — plus a Chrome extension that fills that
list in as you browse Rightmove, and an app you can add to your phone.

- **Travel times you can compare.** Every flat shows how long it takes to the places you care about,
  on foot, by bike and by public transport. Transport times come from Transport for London and are
  all measured the same way — a weekday 09:00 departure — so two flats can honestly be compared.
- **One verdict, shared.** You and the people you are looking with share one rating per flat, not
  one each. It says who set it and when, so nobody views a place the other person already rejected.
- **What the photographs actually show.** It reads the floorplan and the photographs and reports
  usable floor area, the smallest bedroom, whether the "garden" is a balcony, whether the washing
  machine is in the flat. Each finding says how confident it is, so you can tell a measurement from
  a guess.
- **A shortlist you can decide from.** Everything the hunt has looked at, as cards, a sortable
  table, a map and a board — under one filter, with a triage view for the pile nobody has judged
  yet, and a funnel from shortlisted through viewed to archived.

London rentals on Rightmove, specifically. Travel times are Transport for London, so the further you
get from London the less the transport numbers mean.

## The three pieces

The hunt itself is a website, and it is the whole product. The other two put flats into it.

| | What it is | Where it runs |
|---|---|---|
| **The website** | The hunt: shortlist, compare, map, triage, the funnel, travel times, who is in it | Any browser. Install it and your hunt stays readable with no signal |
| **The extension** | The Rightmove half: the panel on a listing page, badges on search results, sweeps | A desktop Chrome, Edge or Brave |
| **The app on your phone** | The same website, added to your home screen | iPhone and Android |

You need the website. You do not need the extension — it is the fastest way to add flats on a
laptop, and there is nothing it can do that the website cannot, apart from appear on Rightmove
itself.

## You need an invitation

**This is invite-only, and there is no way around that.** You cannot create an account yourself —
sign-up is disabled on the server, not just hidden in the interface. If nobody has given you an
invite code, opening this gets you a sign-in screen you cannot pass, and nothing else.

If you were given a code, it looks like `ABCD-EFGH-JKMN` and somebody read it out or texted it to
you. Nothing is ever emailed to you, including the code.

## Getting started

1. Open the website and sign in: your email address, a password you choose, and your invite code.
   Nothing arrives by email and there is nothing to click.
2. Save the places you travel to — work, the gym, whoever you visit on Sundays. Every flat from then
   on gets its journey times to each of them.
3. Add a flat. On a laptop, put the extension in Chrome and it records listings as you look at them.
   On a phone, paste or share the address.

## On your phone

Open the website on your phone and add it to your home screen — **Share → Add to Home Screen** in
Safari, or Chrome's ⋮ menu → **Install app**. There is no extension to install and nothing to sign
in to twice; a phone cannot run a Chrome extension at all, and none of this needs one.

What you get by installing rather than bookmarking:

- **It reads underground.** The shortlist, the verdicts, what the photographs showed, and the
  photographs themselves are kept on the device, so the app opens and reads on the Tube. Reading is
  the whole of it: signing in, adding a flat and rating one all need the network, and the app says
  so rather than pretending. It also says when what you are looking at was last read — because a
  shared verdict may have changed since, and a cached one that looked live would be the one thing
  this app must never do.
- **Rightmove can share into it.** Sharing a listing from the Rightmove app, or from your browser,
  lists this hunt in the share sheet. The flat lands in the shortlist with its photographs, its
  floorplan and its postcode already read — the same as if the extension had picked it up.
- **You can paste one instead.** **Add a flat**, at the top of every screen, takes a Rightmove
  listing address.

Changes you make offline are not saved. The app says so rather than pretending.

## The extension, on a laptop

It is not in the Chrome Web Store, so it installs from a file. It takes about a minute, and the
**Install** screen behind your initials has the download, a one-line terminal installer, and the
steps.

1. Download `rightmove-house-hunt.zip` from the Install screen.
2. **Unzip it.** Chrome loads a folder, not a zip. Put the folder somewhere you will not delete by
   accident — Chrome reads it from that path every time it starts, so if the folder moves the
   extension breaks.
3. Open `chrome://extensions`, turn on **Developer mode** (top right), click **Load unpacked**, and
   choose the folder.
4. Open any Rightmove rental listing. The panel appears at the top right.

Chrome shows a "Disable developer mode extensions" warning each time it starts. That is Chrome
saying this did not come from the Web Store, which is true. It is safe to dismiss.

To update it: download the zip again, unzip it over the same folder, and press **Reload** on the
extension's card in `chrome://extensions`. Chrome does not update load-unpacked extensions on its
own, and the website tells you when the copy in your browser is behind.

## If you forget your password

There is no reset link, because nothing here sends email. Whoever invited you sets a new one for
you.

## Privacy

[The privacy policy](https://noncuro.github.io/house-hunt/privacy) says exactly what is collected and
who can see it. The short version: your house hunt is visible only to the people in it, there are no
adverts, no analytics and no trackers, and nothing is sold or shared.

It does not crawl Rightmove. It reads listing pages one at a time, when somebody asks for that page —
the extension reads the one you have open, and pasting or sharing an address reads that one address.
Rightmove's photographs are never copied onto our servers: they are shown from Rightmove's own
addresses, and the offline copy described above is your own browser keeping the pictures it has
already fetched, on your own device, the way any browser cache does.

## Building it yourself

```bash
pnpm install
cp .env.example .env      # fill in your own Supabase project
pnpm dev:web              # the website, on http://localhost:3100
pnpm dev                  # the extension, in a Chrome that hot-reloads it
pnpm check:all            # lint, typecheck and every pure-function check
```

`AGENTS.md` has the architecture and the rules the code follows, `RESEARCH.md` has why it is built
this way, and `SETUP.md` covers standing up the Supabase side from scratch.
