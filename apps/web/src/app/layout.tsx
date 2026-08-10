import type { Metadata } from 'next';
import { Providers } from './providers';
import './style.css';
import './admin.css';

export const metadata: Metadata = {
  title: 'House hunt',
  // Belt and braces with the `X-Robots-Tag` in next.config.ts. A private house hunt, with two
  // people's addresses and opinions in it, has no business in a search index.
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en-GB">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
