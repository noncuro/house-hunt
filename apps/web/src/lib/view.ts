'use client';

import { useEffect, useState } from 'react';

/** Which screen is open, and which of Places' four renderings.
 *
 *  Two axes rather than one, because the redesign folded four tabs into one. Shortlist, Compare and
 *  Map were three destinations showing the same filtered list of the same flats, drawn three ways —
 *  so choosing between them was navigation when it is really a rendering choice, and the funnel
 *  filter you had set on one was not the one the next had. They are `Places` now, with a segmented
 *  control, and a fourth rendering (the board) that could not have existed as a fifth tab. */
export const VIEWS = ['places', 'triage', 'project', 'admin', 'install', 'settings'] as const;
export type View = (typeof VIEWS)[number];

export const PLACES_VIEWS = ['cards', 'table', 'board', 'map'] as const;
export type PlacesView = (typeof PLACES_VIEWS)[number];

/** The `?v=` values that predate the merge, and where each of them went.
 *
 *  These are in people's bookmarks, in links sent between the two laptops, and in the extension's
 *  own "open the shortlist" action — and `?v=sweep` has been a redirect since sweeping moved under
 *  Triage. A dead link here lands somebody on the shortlist wondering what they clicked, so the old
 *  names keep working and carry the rendering they used to name. */
const LEGACY: Record<string, { view: View; places?: PlacesView }> = {
  list: { view: 'places', places: 'cards' },
  table: { view: 'places', places: 'table' },
  map: { view: 'places', places: 'map' },
  board: { view: 'places', places: 'board' },
  cards: { view: 'places', places: 'cards' },
  sweep: { view: 'triage' },
};

export interface Route {
  view: View;
  places: PlacesView;
}

const DEFAULT: Route = { view: 'places', places: 'cards' };

function parse(search: string): Route {
  const v = new URLSearchParams(search).get('v');
  if (!v) return DEFAULT;
  const legacy = LEGACY[v];
  if (legacy) return { view: legacy.view, places: legacy.places ?? DEFAULT.places };
  if ((VIEWS as readonly string[]).includes(v)) return { view: v as View, places: DEFAULT.places };
  return DEFAULT;
}

/** What a route writes back into the address bar.
 *
 *  Places' four renderings each keep the `?v=` name they had as a tab, so a link to the map is still
 *  `?v=map` after the merge — and the default rendering carries no parameter at all, so the bare URL
 *  stays clean. */
function serialise({ view, places }: Route): string | null {
  if (view !== 'places') return view;
  return places === DEFAULT.places ? null : places;
}

/** The open screen lives in the URL, so a reload, a bookmark or a link sent to the other laptop
 *  lands on the same one rather than snapping back to the list.
 *
 *  Driven through the History API rather than Next's router on purpose: `useSearchParams` would force
 *  a Suspense boundary on this whole client page for prerendering, and there is nothing here to
 *  prerender. `popstate` makes the browser's own back and forward move between screens. */
export function useRoute(): [Route, (next: Partial<Route>) => void] {
  const [route, setRoute] = useState<Route>(DEFAULT);

  useEffect(() => {
    const read = () => setRoute(parse(window.location.search));
    read();
    window.addEventListener('popstate', read);
    return () => window.removeEventListener('popstate', read);
  }, []);

  const go = (next: Partial<Route>) => {
    const merged = { ...route, ...next };
    setRoute(merged);
    const params = new URLSearchParams(window.location.search);
    const value = serialise(merged);
    if (value === null) params.delete('v');
    else params.set('v', value);
    const qs = params.toString();
    // The hash comes along. It is the deep link to a flat, and rewriting the URL without it meant
    // that opening `#card-123` and then touching anything left an address bar that no longer
    // pointed at the flat on screen.
    window.history.pushState(null, '', `${qs ? `?${qs}` : window.location.pathname}${window.location.hash}`);
  };

  return [route, go];
}
