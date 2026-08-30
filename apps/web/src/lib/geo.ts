'use client';

/** Where you are, and where a flat is, in the form a phone can act on.
 *
 *  Two questions the map screen asks and nothing else here does: put me on this map, and hand this
 *  flat to whatever the phone uses for directions. Both are one line of arithmetic and one string,
 *  and both are the kind of thing that fails silently — a refused position drawn as a map that
 *  simply did not move, a maps link that does nothing on half the phones that exist — so they live
 *  here, pure, where `tools/check-geo.ts` can hold them to it. */

/** How far in you go when somebody asks to be shown where they are. A street, not a borough:
 *  "the properties around me" is a question about the next few roads. */
export const LOCATE_ZOOM = 15;

/** Never zoom *out* to answer "where am I". Somebody already at 17 has chosen that, and pulling
 *  back to 15 would throw away the detail they went looking for on the way to giving them what they
 *  asked for. */
export function zoomForLocate(current: number): number {
  return Math.max(current, LOCATE_ZOOM);
}

/** High accuracy because the answer is used to zoom to a street; a ten-second ceiling because a
 *  request that never returns is the failure this whole module exists to make visible, and the
 *  browser's own default is no timeout at all. A half-minute-old fix is fine — nobody has moved far
 *  while the map was drawing. */
export const LOCATE_OPTIONS: PositionOptions = {
  enableHighAccuracy: true,
  timeout: 10_000,
  maximumAge: 30_000,
};

/** The three codes the geolocation spec defines. Written out rather than read off
 *  `GeolocationPositionError`, whose constants live on an instance only the browser can make — and
 *  the cases below are exactly the ones a check has to be able to construct by hand. */
const PERMISSION_DENIED = 1;
const POSITION_UNAVAILABLE = 2;
const TIMEOUT = 3;

/** What went wrong, as a sentence to put on the screen.
 *
 *  There is no fallback position and there must never be one. A map centred on London when the
 *  answer was "you refused permission" is this app being confidently wrong about the one thing the
 *  button was asked, and it looks exactly like success. So every path out of here is a sentence,
 *  including the one nobody planned for: an unknown code keeps the browser's own message rather
 *  than being flattened into a tidy phrase that says nothing.
 *
 *  Takes the shape rather than the DOM class, so it can be called with an error nobody's browser
 *  had to produce. */
export function locateProblem(error: { code?: number; message?: string }): string {
  switch (error.code) {
    case PERMISSION_DENIED:
      // Naming the browser is the point: nothing on this page can undo this, and the person needs
      // to know that the switch is somewhere else.
      return 'Your browser would not share where you are. Allow location for this site and try again.';
    case POSITION_UNAVAILABLE:
      return 'Your device could not work out where you are.';
    case TIMEOUT:
      return 'Working out where you are took too long.';
    default: {
      const said = error.message?.trim();
      return said
        ? `Could not work out where you are — ${said}`
        : 'Could not work out where you are, and the browser did not say why.';
    }
  }
}

/** A link to this place in whatever the reader uses for maps.
 *
 *  Google's cross-platform maps URL, and deliberately not a scheme chosen per device. `geo:` is the
 *  neutral-looking answer and is an Android one: iOS registers no handler for it, so the link is
 *  dead on every iPhone — and `maps://` is the same mistake pointed the other way. This is a plain
 *  https link, which is the only form every surface this app runs on can follow: iOS and Android
 *  both hand it to the Google Maps app where that is installed, and everywhere else, phone or
 *  desktop, it opens the web map. No user-agent is read, because there is nothing left to decide.
 *
 *  Coordinates before the postcode, because where the pin is exact the coordinates *are* the
 *  postcode, while a postcode handed to a search box is a text query that can land on the wrong side
 *  of it. Five decimals is about a metre and is what `CopyLocation` puts on the clipboard, so the
 *  link and the copied value cannot disagree about where this flat is.
 *
 *  **Except where the pin is approximate, and then it is the other way round.** Rightmove fuzzes the
 *  pin on some listings while the blob still carries the full postcode — which is the fourth of the
 *  four facts this whole design rests on, and the reason we route from the postcode rather than the
 *  lat/lon everywhere else. Sending the fuzzed point to a maps app would walk somebody to a spot
 *  chosen to not be the flat, confidently, with no way to tell from the screen. The postcode is the
 *  better answer there even though it is coarser: coarse and honest beats precise and wrong.
 *
 *  Null when there is neither, so the caller can say so. A button that opened a map of nowhere
 *  would be the blank pretending to be an answer. */
export function mapsUrl(
  point: { lat: number; lon: number } | null,
  postcode: string | null,
  approximate = false,
): string | null {
  const known = postcode?.trim() ?? '';
  const usePoint = point !== null && !(approximate && known !== '');
  const query = usePoint ? `${point.lat.toFixed(5)},${point.lon.toFixed(5)}` : known;
  if (!query) return null;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
}
