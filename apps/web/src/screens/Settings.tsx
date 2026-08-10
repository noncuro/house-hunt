'use client';

import { useEffect, useState } from 'react';
import { distanceMiles } from '@house-hunt/core';
import {
  addHub,
  addPlace as addPlaceRow,
  listHubs,
  removeHub,
  removePlace as removePlaceRow,
  resolveLocation,
  setDisplayName,
  updateHub,
} from '@house-hunt/core/db';
import { SWEEP_WINDOWS } from '@house-hunt/core';
import type { LocationResult, Place, ProjectHub } from '@house-hunt/core';
import { TRANSIT_BASIS_NOTE } from '@house-hunt/ui';

/** Every write on this page reports its own failure through `notify` rather than throwing.
 *
 *  The extension's version got this from the message envelope — `result.ok` was the shape of every
 *  reply, so handling the failure was unavoidable. Calling core directly, a rejection would unmount
 *  the whole page through the error boundary and lose what you had typed. */
async function attempt<T>(
  work: () => Promise<T>,
  notify: (text: string, kind?: 'error' | 'info') => void,
): Promise<T | null> {
  try {
    return await work();
  } catch (e) {
    notify(e instanceof Error ? e.message : String(e));
    return null;
  }
}

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

      <Neighbourhoods notify={notify} />

      {/* The extension keeps a Diagnostics section here — a ring buffer in `chrome.storage` with a
          Copy log button — because a background worker's console is wiped every time Chrome idles it
          out, so there was nowhere else for it to go. A tab has devtools. `configureOnce` points
          core's log sink at the console and there is nothing to store or copy. */}
    </div>
  );
}

/** The neighbourhoods this project searches around.
 *
 *  They used to be five constants in `lib/hubs.ts`, which was right while the hubs *were* the
 *  search. They are project rows now (design D11), so this section is the only way to change what
 *  we are looking for, and it has to be honest about a row being able to answer one question and
 *  not the other:
 *
 *    - A **point** (lat/lon) is what lets a listing read "0.4 mi NE of Angel". Without one the hub
 *      names nothing, and we say so rather than placing it somewhere plausible — a hub in the wrong
 *      place silently rotates every bearing computed from it.
 *    - A **Rightmove location** is what lets a sweep open that neighbourhood's search. Without one
 *      the hub is not searchable, and the sweep view says that instead of offering a dead link.
 *
 *  Both are resolved by a person pressing a button, never in the background. */
function Neighbourhoods({ notify }: { notify: (text: string, kind?: 'error' | 'info') => void }) {
  const [hubs, setHubs] = useState<ProjectHub[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [name, setName] = useState('');
  const [where, setWhere] = useState('');
  const [busy, setBusy] = useState(false);
  /** Hub id -> what the last resolve attempt said. Kept per hub rather than as one banner: two
   *  hubs can be in different states at once and a shared line would attribute one's failure to
   *  the other. */
  const [located, setLocated] = useState<Record<string, LocationResult>>({});

  useEffect(() => {
    void (async () => {
      try {
        setHubs(await listHubs());
      } catch {
        setFailed(true);
      }
    })();
  }, []);

  async function add() {
    setBusy(true);
    // `postcode` also takes a pasted "lat,lon" — the same field `places:add` accepts, resolved by
    // the same code. A hub added with neither is legitimate: it can be given a location identifier
    // and swept without ever being placeable.
    const hub = await attempt(() => addHub({ name, postcode: where.trim() || undefined }), notify);
    setBusy(false);
    if (!hub) return;
    setHubs([...(hubs ?? []), hub]);
    setName('');
    setWhere('');
  }

  async function remove(hub: ProjectHub) {
    // Removing a hub takes its sweep history with it — `hub_sweep` cascades on `project_hub`. That
    // is the whole record of having worked that neighbourhood to the end, so it is worth a stop.
    if (!confirm(`Remove ${hub.name}? Its sweep history goes with it.`)) return;
    const gone = await attempt(async () => {
      await removeHub(hub.id);
      return true;
    }, notify);
    if (!gone) return;
    setHubs((hubs ?? []).filter((h) => h.id !== hub.id));
  }

  /** Ask Rightmove what it calls this neighbourhood, once, because somebody pressed a button.
   *
   *  This is the standing no-crawl rule's one sanctioned fetch, and the reasoning is repeated here
   *  rather than left in AGENTS.md because this is exactly the kind of call that gets cited as
   *  precedent later: **one** request, for **one** hub, initiated by a person who is looking at the
   *  screen. Nothing here loops, nothing here runs in the background, and nothing here enumerates.
   *  It is `pnpm find:locations` with the terminal taken out. */
  async function resolve(hub: ProjectHub) {
    setBusy(true);
    const result = await attempt(() => resolveLocation(hub.name), notify);
    setBusy(false);
    if (!result) return;
    setLocated({ ...located, [hub.id]: result });
    if (result.status !== 'resolved') return;

    const saved = await attempt(
      () =>
        updateHub(hub.id, {
          locationIdentifier: result.locationIdentifier,
          displayLocationIdentifier: result.displayLocationIdentifier,
        }),
      notify,
    );
    if (!saved) return;
    setHubs((hubs ?? []).map((h) => (h.id === hub.id ? saved : h)));
  }

  async function setWindow(hub: ProjectHub, days: number | null) {
    const saved = await attempt(() => updateHub(hub.id, { maxDaysSinceAdded: days ?? undefined }), notify);
    if (!saved) return;
    setHubs((hubs ?? []).map((h) => (h.id === hub.id ? saved : h)));
  }

  return (
    <section className="setting">
      <h2>Neighbourhoods we search</h2>
      <p className="dim">
        Each one fixes a listing — "0.4 mi NE of Angel" — and, once Rightmove's own name for it is
        resolved, gives the sweep a search to work through.
      </p>

      {hubs === null && !failed && <p className="working">Working…</p>}
      {failed && <p className="error">Could not read this project's neighbourhoods.</p>}
      {hubs !== null && hubs.length === 0 && (
        <p className="dim">Nothing yet — add the neighbourhoods you are actually looking in.</p>
      )}

      {(hubs ?? []).map((hub) => (
        <div className="place" key={hub.id}>
          <span>
            {hub.name}{' '}
            <span className="dim">
              {hub.lat === null || hub.lon === null
                ? 'no coordinates — cannot place a listing against it'
                : `${hub.lat.toFixed(4)}, ${hub.lon.toFixed(4)}`}
              {' · '}
              {hub.locationIdentifier ?? 'not searchable yet'}
              {hub.maxDaysSinceAdded !== null && ` · always looks back ${hub.maxDaysSinceAdded} days`}
            </span>
            {located[hub.id] && <LocationNote result={located[hub.id]!} hub={hub} />}
          </span>
          <span className="fields">
            <select
              value={hub.maxDaysSinceAdded ?? ''}
              title="A floor on how far back this hub's sweep looks. It can only widen the window — a setting that narrowed it would drop listings and still report the page fully recorded."
              onChange={(e) => void setWindow(hub, e.target.value === '' ? null : Number(e.target.value))}
            >
              <option value="">window from the last sweep</option>
              {SWEEP_WINDOWS.map((days) => (
                <option key={days} value={days}>
                  at least {days} {days === 1 ? 'day' : 'days'}
                </option>
              ))}
            </select>
            <button disabled={busy} onClick={() => void resolve(hub)}>
              {hub.locationIdentifier ? 'Re-resolve' : 'Resolve'}
            </button>
            <button className="remove" title="Remove" onClick={() => void remove(hub)}>
              ×
            </button>
          </span>
        </div>
      ))}

      <div className="fields">
        <input value={name} placeholder="Hampstead" onChange={(e) => setName(e.target.value)} />
        <input
          value={where}
          placeholder="Postcode or lat,lon (optional)"
          title="Where the neighbourhood is, for the compass on every listing. A UK postcode, or coordinates pasted from Google Maps. Leave it blank and the hub can still be swept — it just cannot say what a flat is near."
          onChange={(e) => setWhere(e.target.value)}
        />
        <button className="primary" disabled={busy || !name.trim()} onClick={() => void add()}>
          Add
        </button>
      </div>
    </section>
  );
}

/** What one resolve attempt said. All four states are rendered: a silent failure here is a hub
 *  that looks added and never appears in the sweep. */
function LocationNote({ result, hub }: { result: LocationResult; hub: ProjectHub }) {
  if (result.status === 'not-found') {
    return (
      <div className="error">
        Rightmove has no page at <code>{result.slug}</code>. Its own spelling is the one that works
        — try "{hub.name} Station", or the area rather than the stop.
      </div>
    );
  }
  if (result.status === 'rate-limited') {
    return (
      <div className="error">
        {result.used} of {result.limit} lookups used. This is capped on purpose — it is the one
        place the extension asks Rightmove anything. Try again in{' '}
        {Math.ceil(result.retryAfterSeconds / 60)} minutes.
      </div>
    );
  }
  if (result.status === 'failed') return <div className="error">{result.message}</div>;

  // Resolved. The centroid is Rightmove's own centre for that search, and it is the *verification*
  // rather than decoration: an identifier on its own is a number somebody wrote down, and one that
  // points at the wrong neighbourhood returns a page full of plausible flats and reports nothing
  // new. Two independent sources agreeing is what makes it trustworthy, so a disagreement is shown
  // rather than assumed away — and Rightmove's centre is never written over the hub's own point.
  const apart =
    result.centroid !== null && hub.lat !== null && hub.lon !== null
      ? distanceMiles({ lat: hub.lat, lon: hub.lon }, result.centroid)
      : null;
  return (
    <div className="dim">
      {result.displayName} ({result.locationIdentifier}), read out of {result.slug}.
      {apart === null
        ? ' No coordinate here to check it against — worth adding one before you trust the sweep.'
        : apart > 1
          ? ` Rightmove puts its centre ${apart.toFixed(1)} mi from where this hub is — check which of the two is wrong before sweeping it.`
          : ` Rightmove's centre agrees to within ${apart.toFixed(1)} mi.`}
    </div>
  );
}
