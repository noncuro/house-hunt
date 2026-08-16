import { useEffect, useMemo, useState } from 'react';
import { Hint } from './Hint';
import { formatDuration, ModeIcon } from './Journey';
import { dedupeStations, stationDistance, type Station } from '@house-hunt/core';
import { useHost } from './host';
import { FALLBACK_LINE_COLOUR, LINE_COLOURS, textOn } from '@house-hunt/core';
import './stations.css';

/** The nearest stations, with what you'd actually ride and how long it takes to get there.
 *
 *  This lives in `components/` because it was written twice and only one copy was finished. The
 *  panel fetched the walking time and the line colours; the shortlist listed the same station
 *  names with straight-line miles beside them and nothing else, so the same flat answered "how
 *  well connected is this" differently depending on which view you happened to be in. Straight-line
 *  miles are the weakest of the three numbers, too — they flatter a station across a river, a
 *  railway or the Regent's Canal — so the view showing only miles was showing only the misleading
 *  part.
 *
 *  One renderer, one fetch, one set of classes. See the standing rule in AGENTS.md. */

/** Four fits the panel; the shortlist's cards are denser and show three. Beyond four the list
 *  stops being "the nearest" and starts being a directory. */
export const STATIONS_SHOWN = 4;

type Walks = Record<string, { seconds?: number; lines: string[] }>;

export function Stations({
  postcode,
  stations,
  limit = STATIONS_SHOWN,
  empty = 'None listed',
}: {
  postcode: string | null;
  stations: Station[];
  limit?: number;
  empty?: string;
}) {
  const host = useHost();
  // Merged before the list is cut, not after: King's Cross arrives as four rows, and taking the
  // first four of those is a panel showing one interchange and calling it four stations.
  const shown = useMemo(() => dedupeStations(stations).slice(0, limit), [stations, limit]);
  const [walks, setWalks] = useState<Walks>({});

  // Keyed on the names rather than on the array, which is rebuilt on every render. The walk and
  // the lines are cached server-side per (postcode, station), so a second view asking the same
  // question costs a round trip and nothing more.
  const names = shown.map((s) => s.name);
  const key = names.join(',');
  useEffect(() => {
    if (!postcode || names.length === 0) return;
    let live = true;
    void host.stationWalks(postcode, names).then((found) => {
      if (live) setWalks(found);
    });
    return () => {
      live = false;
    };
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [postcode, key]);

  if (shown.length === 0) return <div className="rm-empty">{empty}</div>;

  return (
    <>
      {shown.map((s) => {
        const info = walks[s.name];
        return (
          <div className="rm-line" key={s.name}>
            <span className="rm-station">
              {s.name.replace(/\s+Station$/, '')}
              <LineDots lines={info?.lines ?? []} />
            </span>
            <span className="rm-value rm-modes">
              {/* The walk is the number that decides anything; the miles are context beside it. */}
              {info?.seconds !== undefined && (
                <span className="rm-mode">
                  <ModeIcon mode="walking" size={12} /> {formatDuration(info.seconds)}
                </span>
              )}
              <span className="rm-dim">{stationDistance(s.distance, s.unit)}</span>
            </span>
          </div>
        );
      })}
    </>
  );
}

/** Lines as colour dots. The colours are the whole point — a Londoner reads "dark blue" as
 *  Piccadilly instantly — and the names are one hover away for everyone else. */
function LineDots({ lines }: { lines: string[] }) {
  if (lines.length === 0) return null;
  // One hint for the whole group, not one per dot: reading them off individually means hovering
  // six times, and the colours only help if you already know them. On hover each line becomes a
  // named pill in its own colour, so the dot and the name teach each other.
  return (
    <Hint
      className="rm-lines"
      underline={false}
      text={
        <span className="rm-pills">
          {lines.map((line) => {
            const colour = LINE_COLOURS[line] ?? FALLBACK_LINE_COLOUR;
            return (
              <span key={line} className="rm-line-pill" style={{ background: colour, color: textOn(colour) }}>
                {lineName(line)}
              </span>
            );
          })}
        </span>
      }
    >
      {lines.map((line) => (
        <span
          key={line}
          className="rm-line-dot"
          style={{ background: LINE_COLOURS[line] ?? FALLBACK_LINE_COLOUR }}
        />
      ))}
    </Hint>
  );
}

function lineName(id: string): string {
  return id
    .split('-')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}
