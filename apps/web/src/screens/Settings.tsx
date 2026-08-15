'use client';

import { useEffect, useState } from 'react';
import {
  addPlace as addPlaceRow,
  removePlace as removePlaceRow,
  setDisplayName,
} from '@house-hunt/core/db';
import type { Place } from '@house-hunt/core';
import { TRANSIT_BASIS_NOTE } from '@house-hunt/ui';
import { attempt } from '@/lib/attempt';

/** Everything that used to live in the browser-action popup.
 *
 *  It moved here because the popup and this page were two front doors to one tool: you set who
 *  you are in one and looked at the results in the other, and the popup shut itself every time
 *  you clicked away from it. Clicking the extension now opens this page, and settings are a tab
 *  on it. */
export function Settings({
  places,
  setPlaces,
  person,
  setPerson,
  notify,
}: {
  places: Place[];
  setPlaces: (places: Place[]) => void;
  person: string | null;
  setPerson: (person: string | null) => void;
  notify: (text: string, kind?: 'error' | 'info') => void;
}) {
  const [name, setName] = useState(person ?? '');
  const [label, setLabel] = useState('');
  const [postcode, setPostcode] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => setName(person ?? ''), [person]);

  /** A display name, not an identity.
   *
   *  This field used to be who you were: there was no login, and the name typed here was written
   *  onto every verdict. Now the session says who you are and this only decides how that person is
   *  written down — on a verdict, in the members list, on an invite. Changing it renames you
   *  everywhere rather than making you somebody else, which is why it no longer says "on this
   *  laptop". */
  async function saveName() {
    const next = name.trim();
    const saved = await attempt(async () => {
      await setDisplayName(next);
      return true;
    }, notify);
    if (!saved) return;
    setPerson(next);
    notify(`You appear as ${next}.`, 'info');
  }

  async function addPlace() {
    setBusy(true);
    const place = await attempt(() => addPlaceRow(label, postcode.toUpperCase()), notify);
    setBusy(false);
    if (!place) return;
    setPlaces([...places, place]);
    setLabel('');
    setPostcode('');
  }

  async function removePlace(id: string) {
    const gone = await attempt(async () => {
      await removePlaceRow(id);
      return true;
    }, notify);
    if (!gone) return;
    setPlaces(places.filter((p) => p.id !== id));
  }

  return (
    <div className="settings">
      <section className="setting">
        <h2>How your name appears</h2>
        <p className="dim">
          You are signed in as yourself; this is the name everyone in the hunt sees against your
          verdicts and in the members list. Change it here and it changes everywhere.
        </p>
        <div className="fields">
          <input value={name} placeholder="Your name" onChange={(e) => setName(e.target.value)} />
          <button className="primary" disabled={!name.trim() || name.trim() === person} onClick={() => void saveName()}>
            Save
          </button>
        </div>
      </section>

      <section className="setting">
        <h2>Places we measure against</h2>
        <p className="dim">
          Each is measured by walking, bike and public transport. {TRANSIT_BASIS_NOTE}
        </p>
        {places.length === 0 && <p className="dim">Nothing yet — add the office, the in-laws, Heathrow.</p>}
        {places.map((p) => (
          <div className="place" key={p.id}>
            <span>
              {p.label} <span className="dim">{p.postcode}</span>
            </span>
            <button className="remove" title="Remove" onClick={() => void removePlace(p.id)}>
              ×
            </button>
          </div>
        ))}
        <div className="fields">
          <input value={label} placeholder="Label" onChange={(e) => setLabel(e.target.value)} />
          <input
            value={postcode}
            placeholder="Postcode or lat,lon"
            title="A UK postcode, or coordinates pasted from Google Maps (51.4708,-0.4523)"
            onChange={(e) => setPostcode(e.target.value)}
          />
          <button className="primary" disabled={busy || !label.trim() || !postcode.trim()} onClick={() => void addPlace()}>
            Add
          </button>
        </div>
      </section>

      {/* Neighbourhoods used to sit here, and moved to Your Hunt. Which places this hunt searches
          is a property of the hunt — shared, and the same for everyone in it — where everything
          left on this page is one person's own: their display name, and the destinations they
          measure journeys to. Filing a shared setting under a personal heading is how it comes to
          be edited by whoever happened to find it. */}

      {/* The extension keeps a Diagnostics section here — a ring buffer in `chrome.storage` with a
          Copy log button — because a background worker's console is wiped every time Chrome idles it
          out, so there was nowhere else for it to go. A tab has devtools. `configureOnce` points
          core's log sink at the console and there is nothing to store or copy. */}
    </div>
  );
}
