import { createContext, useContext, type ReactNode } from 'react';

/** The two things a shared component needs that only its host can do.
 *
 *  Most of `packages/ui` takes its data as props and reaches nothing, which is what lets the same
 *  components render in a Rightmove overlay and on the website. Two do not: `Stations` fetches the
 *  walk to each station and the lines it carries, and `Opener` opens a tab per listing on a timer.
 *  Both used to call `send()` — the extension's `chrome.runtime` transport — straight out of a
 *  component, which was invisible while the extension was the only surface and is a hard error the
 *  moment a browser tab renders the same component.
 *
 *  Rather than move both components into the extension, or fetch in every caller and thread the
 *  results down as props, the operation itself is what gets injected. The extension provides
 *  implementations backed by a message to its background worker; the website provides ones backed
 *  by `@house-hunt/core/db` and an ordinary link. The component is unchanged in either.
 */
export interface UiHost {
  /** Walking seconds and the lines carried, per station name. A station the host cannot answer for
   *  is simply absent from the record — the component renders the distance alone rather than a
   *  spinner that never resolves. */
  stationWalks(
    postcode: string,
    stations: string[],
  ): Promise<Record<string, { seconds?: number; lines: string[] }>>;

  /** Open one Rightmove listing. Rejecting stops a paced run, which is deliberate: one failure to
   *  open a tab is usually the whole mechanism being unavailable, and grinding through forty more
   *  would bury the reason. */
  openListing(rightmoveId: string): Promise<void>;
}

const HostContext = createContext<UiHost | null>(null);

export function UiHostProvider({ host, children }: { host: UiHost; children: ReactNode }) {
  return <HostContext.Provider value={host}>{children}</HostContext.Provider>;
}

/** Throws rather than degrading. A missing provider means a whole surface has been mounted without
 *  one, and the symptom would otherwise be station times that never arrive on one screen only. */
export function useHost(): UiHost {
  const host = useContext(HostContext);
  if (!host) {
    throw new Error(
      'no UiHostProvider above this component — the extension and the website each supply their ' +
        'own, because fetching a station walk means a message to the background worker in one and ' +
        'a database read in the other',
    );
  }
  return host;
}
