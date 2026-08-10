'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { UiHostProvider } from '@house-hunt/ui';
import { configureOnce } from '@/lib/client';
import { queryClient } from '@/lib/queries';
import { webHost } from '@/lib/ui-host';

/** Nothing renders until the Supabase client exists.
 *
 *  Everything below this reads the database on its first render, so `configureOnce` has to have run
 *  by then — and it cannot run at module scope, because building the client touches `localStorage`
 *  and Next renders this page on the server first. So the server sends an empty body and the first
 *  browser paint is one tick later. That costs nothing worth having: every screen here is behind a
 *  session, so there is no server-rendered content to lose. */
export function Providers({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    configureOnce();
    setReady(true);
  }, []);

  if (!ready) return null;

  return (
    <QueryClientProvider client={queryClient}>
      <UiHostProvider host={webHost}>{children}</UiHostProvider>
    </QueryClientProvider>
  );
}
