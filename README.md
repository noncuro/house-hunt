# House hunt

A Chrome extension for looking at flats with somebody else.

Renting a place with another person means the same three arguments on every listing: how long is it
really to work, how big is it actually, and did we already say no to this one. This answers all
three on the Rightmove listing page itself.

- **Travel times you can compare.** Every listing shows how long it takes to the places you care
  about, on foot, by bike and by public transport. Transport times come from Transport for London
  and are all measured the same way — a weekday 09:00 departure — so two flats can honestly be
  compared.
- **One verdict, shared.** You and the people you are looking with share one rating per flat, not
  one each. It says who set it and when, so nobody views a place the other person already rejected.
- **What the photographs actually show.** It reads the floorplan and the photographs and reports
  usable floor area, the smallest bedroom, whether the "garden" is a balcony, whether the washing
  machine is in the flat. Each finding says how confident it is, so you can tell a measurement from
  a guess.
- **A shortlist you can decide from.** Everything you have opened as a sortable table, a map, and a
  triage view for the pile you have not judged yet.

London rentals on Rightmove, specifically. Travel times are Transport for London, so the further you
get from London the less the transport numbers mean.

## You need an invitation

**This is invite-only, and there is no way around that.** You cannot create an account yourself —
sign-up is disabled on the server, not just hidden in the interface. If nobody has given you an
invite code, installing this will get you a sign-in screen you cannot pass, and nothing else.

If you were given a code, it looks like `ABCD-EFGH-JKMN` and somebody read it out or texted it to
you. Nothing is ever emailed to you, including the code.

## Installing it

It is not in the Chrome Web Store yet, so it installs from a file. This takes about a minute.

1. Download `house-hunt-<version>.zip` from the [latest release](../../releases/latest).
2. **Unzip it.** Chrome loads a folder, not a zip. Put the folder somewhere you will not delete by
   accident — Chrome reads it from that path every time it starts, so if the folder moves the
   extension breaks.
3. Open `chrome://extensions` in Chrome.
4. Turn on **Developer mode**, top right.
5. Click **Load unpacked**, top left, and choose the folder you unzipped.
6. **House hunt** appears in your extensions. Pin it to the toolbar if you want it to hand.

Chrome will show a "Disable developer mode extensions" warning each time it starts. That is Chrome
telling you this did not come from the Web Store, which is true. It is safe to dismiss.

### Signing in the first time

1. Click the House hunt icon in the toolbar and choose **Open shortlist**.
2. Enter your email address, choose a password, and type your invite code.
3. That is it — no email arrives, and there is nothing to click.

Your code works once. If you lose it before you use it, ask for another; there is deliberately no
way to read a code back out, so the answer is always a fresh one rather than a reminder.

If you forget your password later, there is no reset link, because nothing here sends email. Whoever
invited you sets a new one for you.

### Using it

Open any Rightmove rental listing. The panel appears at the top right of the page. Add the places
you travel to often, and every listing from then on shows the journey times to each.

The shortlist tab — the toolbar icon, then **Open shortlist** — collects everything you have opened.

## Updating it

Download the new zip, unzip it over the old folder, then press **Reload** on the extension's card in
`chrome://extensions`. Chrome does not update load-unpacked extensions on its own.

## Privacy

[The privacy policy](https://noncuro.github.io/house-hunt/privacy) says exactly what is collected and
who can see it. The short version: your house hunt is visible only to the people you invited into
it, there are no adverts, no analytics and no trackers, and nothing is sold or shared.

It does not crawl Rightmove — it reads only the pages you yourself open — and it never copies or
re-hosts Rightmove's photographs.

## Building it yourself

```bash
pnpm install
cp .env.example .env      # fill in your own Supabase project
pnpm dev                  # or: pnpm build, then load .output/chrome-mv3 unpacked
```

`AGENTS.md` has the architecture and the rules the code follows. `SETUP.md` covers standing up the
Supabase side from scratch.
