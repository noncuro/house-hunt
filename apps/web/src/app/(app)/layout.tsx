import { Splash } from '@/components/Splash';
import { Providers } from '../providers';
import '../style.css';
import '../hunt.css';
import '../admin.css';

/** Sends a first-time visitor to the landing page, before the app has drawn anything.
 *
 *  `/` is the app, and it has to stay the app: it is the manifest's `start_url`, the share target,
 *  the extension's button and the page the service worker keeps for the Underground. But a stranger
 *  typing househunt.london should see what this is, not a sign-in form for something they have
 *  never heard of. The server cannot tell the two apart, because the session lives in
 *  `localStorage` (`lib/client.ts`), so the page decides for itself, inline, before hydration.
 *
 *  Only the bare address redirects. Anything with a query or a hash is somebody going somewhere —
 *  a shared listing (`/?url=`), a view, a flat, or `/?signin` from the landing page's own buttons —
 *  and offline it stays put, because `/welcome` is not in the service worker's cache and the
 *  sign-in form is at least honest about needing a connection. See D16 in `design.md`. */
const WELCOME = `try{if(location.pathname==='/'&&!location.search&&!location.hash&&navigator.onLine&&!localStorage.getItem('house-hunt-session'))location.replace('/welcome')}catch(e){}`;

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <script dangerouslySetInnerHTML={{ __html: WELCOME }} />
      <Splash />
      <Providers>{children}</Providers>
    </>
  );
}
