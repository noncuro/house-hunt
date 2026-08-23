'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { UiHostProvider } from '@house-hunt/ui';
import { configureOnce } from '@/lib/client';
import { registerServiceWorker } from '@/lib/offline';
import { persist, restore } from '@/lib/persist';
import { queryClient } from '@/lib/queries';
import { webHost } from '@/lib/ui-host';

/** Nothing renders until the Supabase client exists, and the last snapshot is back.
 *
 *  Everything below this reads the database on its first render, so `configureOnce` has to have run
 *  by then — and it cannot run at module scope, because building the client touches `localStorage`
 *  and Next renders this page on the server first. So the server sends an empty body and the first
 *  browser paint is one tick later. That costs nothing worth having: every screen here is behind a
 *  session, so there is no server-rendered content to lose.
 *
 *  `restore()` is awaited in that same gap, and has to be. React Query takes a query's starting data
 *  on its first render and never again, so a snapshot put back after the shell has mounted goes into
 *  queries that have already decided they had nothing — which offline is an error screen, drawn over
 *  a perfectly good copy of the hunt sitting in IndexedDB. One IndexedDB read is a millisecond or
 *  two on a load that was already waiting for a tick. */
export function Providers({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let stop: (() => void) | null = null;
    let gone = false;
    configureOnce();
    // Beside the client rather than in a layout of its own: both are one-time browser setup that
    // cannot run on the server, and this is already the one effect that says so.
    registerServiceWorker();
    // `finally`, not `then`: a restore that failed is a cold start, which is what every version of
    // this app before it did on every load. It must never be a page that does not render.
    void restore().finally(() => {
      // `gone` because this resolves a tick or two later: unmounting in that window would otherwise
      // subscribe to the query cache after the cleanup that was meant to unsubscribe had run.
      if (gone) return;
      stop = persist();
      setReady(true);
    });
    return () => {
      gone = true;
      stop?.();
    };
  }, []);

  if (!ready) return null;

  return (
    <QueryClientProvider client={queryClient}>
      <UiHostProvider host={webHost}>{children}</UiHostProvider>
    </QueryClientProvider>
  );
}
