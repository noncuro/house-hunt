import type { Metadata } from 'next';
import { IBM_Plex_Mono, IBM_Plex_Sans, Newsreader } from 'next/font/google';
import { Providers } from './providers';
import '@house-hunt/ui/tokens.css';
import './style.css';
import './hunt.css';
import './admin.css';

/** Three faces, each doing one job.
 *
 *  Newsreader for addresses, because an address is the name of a place and a serif reads as a name
 *  rather than as data. IBM Plex Sans for everything you read as prose. IBM Plex Mono, small-caps,
 *  for the labels over a group of facts — mono at that size stops a label being mistaken for the
 *  thing it labels, which is what happened when both were the same face two weights apart.
 *
 *  Self-hosted by `next/font`, which downloads the files at build time and serves them from this
 *  origin. Not a taste decision: the CSP has no `font-src` for Google's CDN and adding one would
 *  hand a third party a request on every page load of a private house hunt. It also means no
 *  flash — the fallback metrics are computed from the real face. */
const serif = Newsreader({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-serif-loaded',
  display: 'swap',
});

const sans = IBM_Plex_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-sans-loaded',
  display: 'swap',
});

const mono = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400', '500'],
  variable: '--font-mono-loaded',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'House hunt',
  // Belt and braces with the `X-Robots-Tag` in next.config.ts. A private house hunt, with two
  // people's addresses and opinions in it, has no business in a search index.
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en-GB" className={`${sans.variable} ${serif.variable} ${mono.variable}`}>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
