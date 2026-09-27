import type { Metadata } from 'next';
import { Film } from './Film';
import './welcome.css';

/** The landing page: what House hunt is, for somebody who has never heard of it.
 *
 *  Server-rendered and static, outside the app's `Providers` (which draw nothing until a Supabase
 *  client exists), so it paints on the first response and a search engine can read it. The app at
 *  `/` sends signed-out first-time visitors here; see `(app)/layout.tsx` and D16 in `design.md`.
 *
 *  Every claim is one the code backs, with one exception on purpose: the sweep across the eight
 *  agents' sites is on its own branch, and this page is meant to merge after it. Reading and
 *  adding a flat from all nine sites, and the re-check's let-agreed mark, are on main. A sweep
 *  runs in the user's own browser (nothing is scheduled for them) and nothing sends an alert, so
 *  neither is promised. The comparison with Rightmove is written as of the date in its footnote and
 *  gives Rightmove what it has: saved searches, email alerts and a travel-time search.
 *
 *  The product shots in `public/welcome/` are frames from the promo video, which draws the app's
 *  own components (`tools/promo`), and its homes are generated images, never listing photographs. */

const SIGN_IN = '/?signin';
const GITHUB = 'https://github.com/noncuro/house-hunt';
const PRIVACY = 'https://noncuro.github.io/house-hunt/privacy';

export const metadata: Metadata = {
  metadataBase: new URL('https://www.househunt.london'),
  title: 'House hunt · Find a London flat together',
  description:
    'One shared shortlist for renting in London together: new listings from Rightmove and eight London agents ranked, TfL commutes timed, floorplans read, one verdict per flat. Invite-only.',
  // The one page here meant to be found. The root layout and the `X-Robots-Tag` header say
  // `noindex` for everything else, and next.config.ts leaves this path out of that header.
  robots: { index: true, follow: true },
  alternates: { canonical: '/welcome' },
  openGraph: {
    type: 'website',
    url: '/welcome',
    siteName: 'House hunt',
    title: 'Find the flat worth moving for.',
    description: 'One shared shortlist for everyone you’re renting with. New listings ranked, commutes timed, floorplans read.',
    images: [{ url: '/welcome/og.jpg', width: 1200, height: 630 }],
  },
  twitter: { card: 'summary_large_image', images: ['/welcome/og.jpg'] },
};

const FEATURES = [
  {
    shot: 'sweeps',
    label: 'Sweeps',
    title: 'New flats, already ranked.',
    body: 'One sweep works through your saved searches on Rightmove and London agents’ own sites, and pulls in every new listing with travel times and photo reading done and the likeliest yes on top. Rechecks catch price drops, and flats that are let agreed or taken down.',
    tag: 'Rightmove and eight London agents',
  },
  {
    shot: 'travel',
    label: 'Commute',
    title: 'A lovely flat. A workable Tuesday.',
    body: 'Transport for London times to work, the gym and your friends, on foot, by bike and by Tube. Every journey leaves at 09:00 on a weekday, so two flats compare fairly.',
    tag: 'Filter to 35 minutes or less',
  },
  {
    shot: 'details',
    label: 'Details',
    title: 'Look past the wide-angle lens.',
    body: 'It reads the floorplan and the photos: usable floor area, the smallest bedroom, whether the garden is a balcony, the washing machine, the bath. Each finding says how sure it is.',
    tag: 'Estimates are marked as estimates',
  },
  {
    shot: 'verdict',
    label: 'Verdict',
    title: 'One flat. One verdict.',
    body: 'Love it, like it or not our place, shared by everyone in the hunt, with who set it and when. Nobody books a viewing the others have already turned down.',
    tag: 'Up to six people per hunt',
  },
];

const MORE = [
  {
    shot: 'triage',
    label: 'Triage',
    title: 'Your likely favourites first.',
    body: 'Unrated flats one at a time, best guess first, from a model trained on your own verdicts. Rate with 1, 2 and 3.',
  },
  {
    shot: 'shortlist',
    label: 'The whole hunt',
    title: 'From shortlist to offer.',
    body: 'Cards, a table, a map and a board under one filter. Move each flat from shortlisted to enquired, viewing booked, viewed and offer made.',
  },
  {
    shot: 'everywhere',
    label: 'Everywhere',
    title: 'Rightmove to the Northern line.',
    body: 'The Chrome extension puts your hunt beside every listing on Rightmove and the agents’ sites. On your phone, share listings in from the Rightmove app and read your shortlist offline on the Tube.',
  },
];

type Mark = 'yes' | 'part' | 'no';
const COLUMNS = ['House hunt', 'Rightmove on its own', 'A spreadsheet and a group chat'] as const;
const COMPARE: Array<[string, ...Array<[Mark, string]>]> = [
  ['A shortlist everyone shares', ['yes', 'Up to six people, one list'], ['no', 'Saved to one account'], ['part', 'If everyone keeps it up']],
  ['New listings from your searches', ['yes', 'Pulled in and ranked by a sweep'], ['yes', 'Saved searches and email alerts'], ['no', 'Paste links in yourself']],
  ['Travel time to a place', ['yes', 'TfL, to each of your places'], ['yes', 'Search by travel time'], ['part', 'Look it up yourself']],
  ['Several places, compared across flats', ['yes', 'Work, gym and friends side by side'], ['no', 'One place per search'], ['part', 'Look each one up yourself']],
  ['One verdict, with who and when', ['yes', 'Shared, with a name and a time'], ['no', 'Personal saves and notes'], ['part', 'A column someone forgets']],
  ['Usable floor area from the plan', ['yes', 'Read from the floorplan, with confidence'], ['no', 'Shows the plan, you do the maths'], ['no', 'Measure it yourself']],
  ['Unrated flats ranked by your taste', ['yes', 'Learned from your verdicts'], ['no', 'Not offered'], ['no', 'Sort them yourself']],
  ['Viewing and offer stages', ['yes', 'Shortlisted through to offer made'], ['part', 'Notes on saved properties'], ['yes', 'A status column']],
];
const GLYPH: Record<Mark, string> = { yes: '✓', part: '~', no: '–' };

const STEPS = [
  ['Get an invite', 'Someone already hunting sends you a code. A hunt holds up to six people.'],
  ['Bring your searches', 'Bring your saved searches from Rightmove and the agents, and add the places you go. Run a sweep and the new flats arrive, ranked.'],
  ['Decide together', 'Rate the best guesses first, check the details, share one verdict and book the viewing.'],
];

const FAQ = [
  ['Is it free?', 'There is no charge today. House hunt has no billing.'],
  ['Why invite-only?', 'Reading photos and floorplans costs money to run, so for now it grows by invitation. Ask whoever you’re hunting with: if they’re in, they can add you.'],
  ['Which sites does it cover?', 'Rightmove, and eight London agents’ own sites: Foxtons, Savills, Chestertons, Dexters, John D Wood, Portico, TK International and Austin Homes. Paste or share a listing from any of them. It reads a listing only when you or a sweep asks for it, and never copies its photos.'],
  ['Does it work on my phone?', 'Yes. Add the website to your home screen and it behaves like an app. Share a listing from the Rightmove app straight into it, and your shortlist stays readable with no signal.'],
  ['Who can see my hunt?', 'Only the people in it. There are no adverts, no analytics and no trackers, and nothing is sold.'],
  ['Does it work outside London?', 'It’s built for London rentals. Travel times come from Transport for London, so the further out you go, the less they mean.'],
  ['Do I need the Chrome extension?', 'No. The website does everything. The extension adds a panel to listings on Rightmove and the agents’ sites, and badges to Rightmove search results, while you browse on a laptop.'],
];

function Brand() {
  return (
    <a className="lp-brand" href="/welcome">
      <img src="/icon-192.png" alt="" />
      House hunt
    </a>
  );
}

export default function Welcome() {
  return (
    <div className="lp">
      <header className="lp-nav">
        <div className="lp-wrap lp-nav-in">
          <Brand />
          <nav className="lp-nav-links">
            <a href="#features">Features</a>
            <a href="#compare">Compare</a>
            <a href="#faq">FAQ</a>
          </nav>
          <a className="lp-btn lp-btn-ghost" href={SIGN_IN}>
            Sign in
          </a>
        </div>
      </header>

      <section className="lp-hero">
        <img className="lp-hero-photo" src="/welcome/street.jpg" alt="" />
        <div className="lp-wrap lp-hero-in">
          <div className="lp-label">For Londoners renting together</div>
          <h1>Find the flat worth moving for.</h1>
          <p className="lp-hero-sub">
            New listings from Rightmove and eight London agents pulled in and ranked, commutes timed, floorplans read, and one shortlist for everyone
            you’re hunting with.
          </p>
          <div className="lp-hero-ctas">
            <a className="lp-btn lp-btn-primary" href={SIGN_IN}>
              Sign in with your invite
            </a>
            <a className="lp-btn lp-btn-ghost" href="#film">
              ▶&nbsp; Watch the film · 0:45
            </a>
          </div>
        </div>
      </section>

      <section className="lp-film" id="film">
        <div className="lp-wrap">
          <Film />
          <div className="lp-film-note">Forty-five seconds, sound on</div>
        </div>
      </section>

      <section className="lp-problem">
        <div className="lp-wrap lp-problem-grid">
          <div>
            <div className="lp-label">Hunting together, until now</div>
            <h2>Twelve tabs, one group chat, the same arguments.</h2>
            <p className="lp-problem-answer">
              House hunt keeps <b>the flat and the decision in one place</b>, for everyone in the hunt.
            </p>
          </div>
          <div className="lp-bubbles">
            <div className="lp-bubble">
              <small>Sam</small>The link is somewhere in the group chat.
            </div>
            <div className="lp-bubble">
              <small>Jo</small>The spreadsheet still says we like it?
            </div>
            <div className="lp-bubble">
              <small>Sam</small>We ruled it out yesterday. Why is there a viewing booked?
            </div>
          </div>
        </div>
      </section>

      <section className="lp-features" id="features">
        <div className="lp-wrap">
          {FEATURES.map((f) => (
            <div className="lp-feature" key={f.shot}>
              <div className="lp-feature-copy">
                <div className="lp-label">{f.label}</div>
                <h2>{f.title}</h2>
                <p>{f.body}</p>
                <div className="lp-feature-tag">{f.tag}</div>
              </div>
              <div className="lp-shot">
                <img src={`/welcome/${f.shot}.jpg`} alt="" loading="lazy" />
              </div>
            </div>
          ))}
          <div className="lp-grid3">
            {MORE.map((f) => (
              <div className="lp-card" key={f.shot}>
                <div className="lp-shot">
                  <img src={`/welcome/${f.shot}.jpg`} alt="" loading="lazy" />
                </div>
                <div className="lp-card-copy">
                  <div className="lp-label">{f.label}</div>
                  <h3>{f.title}</h3>
                  <p>{f.body}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      <div className="lp-strip">
        {['kitchen', 'canal', 'stucco', 'bedroom'].map((n) => (
          <img key={n} src={`/welcome/${n}.jpg`} alt="" loading="lazy" />
        ))}
      </div>

      <section className="lp-compare" id="compare">
        <div className="lp-wrap">
          <div className="lp-compare-head">
            <div className="lp-label">How it compares</div>
            <h2>Rightmove finds flats. House hunt helps you pick one, together.</h2>
            <p>Keep Rightmove for searching. House hunt is where the people you’re renting with decide.</p>
          </div>
          <table className="lp-table">
            <thead>
              <tr>
                <th />
                {COLUMNS.map((c, i) => (
                  <th key={c} className={i === 0 ? 'us' : undefined}>
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {COMPARE.map(([row, ...cells]) => (
                <tr key={row}>
                  <th>{row}</th>
                  {cells.map(([mark, text], i) => (
                    <td key={COLUMNS[i]} data-col={COLUMNS[i]} className={i === 0 ? 'us' : undefined}>
                      <div className="lp-cell">
                        <span className={`lp-mark lp-${mark}`} aria-label={mark === 'yes' ? 'Yes' : mark === 'no' ? 'No' : 'Partly'}>
                          {GLYPH[mark]}
                        </span>
                        <span>{text}</span>
                      </div>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          <p className="lp-compare-note">
            Compared with Rightmove’s own website and app as of September 2026. House hunt is not affiliated with Rightmove.
          </p>
        </div>
      </section>

      <section className="lp-steps">
        <div className="lp-wrap">
          <div className="lp-label">How it works</div>
          <h2>Three steps to a viewing you all want.</h2>
          <div className="lp-steps-grid">
            {STEPS.map(([title, body], i) => (
              <div className="lp-step" key={title}>
                <div className="lp-step-n">{i + 1}</div>
                <h3>{title}</h3>
                <p>{body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="lp-trust">
        <div className="lp-wrap">
          <div className="lp-trust-box">
            <div>
              <div className="lp-label">Privacy</div>
              <h2>Your hunt stays between you.</h2>
            </div>
            <div className="lp-trust-list">
              <div>
                <b>Only your people see it.</b>
                <span>A hunt is visible to the people in it and nobody else.</span>
              </div>
              <div>
                <b>No adverts, analytics or trackers.</b>
                <span>Nothing about your hunt is sold or shared.</span>
              </div>
              <div>
                <b>Open source.</b>
                <span>
                  Read every line on <a href={GITHUB}>GitHub</a>, and the <a href={PRIVACY}>privacy policy</a>.
                </span>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="lp-faq" id="faq">
        <div className="lp-wrap lp-faq-grid">
          <div>
            <div className="lp-label">Questions</div>
            <h2>Before you ask.</h2>
          </div>
          <div>
            {FAQ.map(([q, a], i) => (
              <details key={q} open={i === 0}>
                <summary>{q}</summary>
                <p>{a}</p>
              </details>
            ))}
          </div>
        </div>
      </section>

      <section className="lp-closing">
        <img src="/welcome/rooftop.jpg" alt="" loading="lazy" />
        <div className="lp-wrap">
          <h2>Find a flat you can agree on.</h2>
          <div className="lp-hero-ctas">
            <a className="lp-btn lp-btn-primary" href={SIGN_IN}>
              Sign in with your invite
            </a>
            <a className="lp-btn lp-btn-ghost" href={GITHUB}>
              See the code on GitHub
            </a>
          </div>
        </div>
      </section>

      <footer className="lp-foot">
        <div className="lp-wrap lp-foot-in">
          <Brand />
          <span>Listings and photos stay on the sites they came from. Not affiliated with Rightmove or any agent.</span>
          <nav>
            <a href={PRIVACY}>Privacy</a>
            <a href={GITHUB}>GitHub</a>
            <a href={SIGN_IN}>Sign in</a>
          </nav>
        </div>
      </footer>
    </div>
  );
}
