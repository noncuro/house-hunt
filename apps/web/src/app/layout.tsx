import type { Metadata, Viewport } from 'next';
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
  // What makes this installable, and what makes a phone a first-class surface rather than a
  // narrow window: added to a home screen it opens in its own window, keeps its own service
  // worker, and appears in the system share sheet as somewhere to send a Rightmove listing
  // (`share_target` in the manifest). That last one is the whole capture story on a device that
  // cannot run the extension — see `screens/AddFlat.tsx`.
  manifest: '/manifest.webmanifest',
  // iOS reads none of the manifest for this. It wants its own icon — composited on white and
  // rounded by the system, so `apple-touch-icon.png` is deliberately square and opaque — and its
  // own capable/title tags, or "Add to Home Screen" produces a bookmark that opens Safari's
  // chrome around a screenshot of the page.
  appleWebApp: { capable: true, title: 'House hunt', statusBarStyle: 'default' },
  icons: {
    icon: [
      { url: '/icon-192.png', sizes: '192x192', type: 'image/png' },
      { url: '/icon-512.png', sizes: '512x512', type: 'image/png' },
    ],
    apple: '/apple-touch-icon.png',
  },
};

/** The viewport, and one line of it is load-bearing.
 *
 *  `viewportFit: 'cover'` is what makes `env(safe-area-inset-*)` report anything but zero. The
 *  phone's tab bar has padded itself with `safe-area-inset-bottom` since it was written, on a
 *  viewport that never opted into the display cutout — so the inset was always `0px`, and on every
 *  iPhone since the X the last row of that bar sat under the home indicator. It looked like a
 *  padding bug and was a missing meta tag.
 *
 *  One theme colour, no dark variant. That is not an oversight: `packages/ui/src/tokens.css` is
 *  light-only on purpose, and a dark status bar over a paper-coloured page would be the only dark
 *  thing on the screen. It matches `--raised`, the colour of the header directly beneath it, so
 *  the status bar reads as part of the app rather than as a strip above it. */
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: '#fdfcfa',
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
