'use client';

import { useEffect, useState } from 'react';

/** One line, and only when there is no network: what you are looking at, and when it was true.
 *
 *  Everything on this screen is shared — the verdict is one verdict for the whole hunt, and the
 *  point of it is that it is what the other person said. So a shortlist drawn from the copy on this
 *  device is the one case where the app can be confidently wrong: the flat you are standing outside
 *  may have been rated, moved along the funnel or marked gone in the hour since this was read, and
 *  nothing about the screen would look any different.
 *
 *  Which is the fail-loudly rule pointed at a cache: the offline copy is worth having — it is the
 *  reason the app opens at all on the Underground — and it must never be mistaken for live. Hence a
 *  time rather than a word. "Offline" alone says the network is down, which the reader knows; "as it
 *  was at 18:42" says how much they should trust the verdict in front of them, which they cannot
 *  work out any other way.
 */
export function Offline({ lastRead }: { lastRead: number | undefined }) {
  const offline = useOffline();
  if (!offline) return null;

  return (
    <p className="notice notice-warn" data-testid="offline-notice">
      No connection — this is the hunt as it was
      {lastRead ? ` at ${new Date(lastRead).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}` : ''}
      . Anything anyone has said since is not here yet, and nothing you change now will be saved.
    </p>
  );
}

/** `navigator.onLine` and the two events that move it.
 *
 *  It is a weak signal — it means "this device has a network interface with a route", not "the
 *  database is reachable", so a captive portal or a Supabase outage both read as online. That is
 *  fine for what this is used for: the false negative (offline, says online) leaves the reader with
 *  exactly what they had before this notice existed, and the false positive it avoids — announcing
 *  an outage that is not happening — is the one that would cost trust.
 *
 *  Read after mount rather than during render. The server has no `navigator`, and starting from
 *  "online" makes the prerender and the first client render agree; a device that is genuinely
 *  offline gets the notice a frame later. */
function useOffline(): boolean {
  const [offline, setOffline] = useState(false);

  useEffect(() => {
    const read = () => setOffline(!navigator.onLine);
    read();
    window.addEventListener('online', read);
    window.addEventListener('offline', read);
    return () => {
      window.removeEventListener('online', read);
      window.removeEventListener('offline', read);
    };
  }, []);

  return offline;
}
