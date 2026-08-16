'use client';

import { useEffect, useRef } from 'react';
import { Icon, useOverlayKeys } from '@house-hunt/ui';
import {
  addressBesidePostcode,
  type ArchiveReason,
  type Hub,
  type HuntPreferences,
  type Place,
  type PricePoint,
  type Rating,
  type Stage,
} from '@house-hunt/core';
import type { ShortlistEntry } from '@house-hunt/core/db';
import { FlatDetail } from '@/components/FlatDetail';

/** One flat, over whatever you were doing.
 *
 *  Opening a flat used to be navigation: a map pin took you to the shortlist, scrolled to a card,
 *  which meant unmounting the map, re-fitting it on the way back, and undoing whichever of the four
 *  things — a collapsed pile, a stage filter, paging, being off the market — had hidden the card
 *  you asked for. Four fixes for a problem that only existed because the flat was a place on a page
 *  rather than a thing you open and shut.
 *
 *  A panel keeps the screen behind it, which is the point: on the map you are looking at a street,
 *  in the table at a sort you built, in triage at a pile — and none of those should be spent to read
 *  one flat. Escape closes it, as does clicking the sheet behind it. */
export function FlatPanel({
  entry,
  places,
  hubs,
  prices,
  prefs,
  score,
  offMarket,
  onClose,
  onStep,
  onRate,
  onSetStage,
  onSetOffMarket,
  stageSaving,
}: {
  entry: ShortlistEntry;
  places: Place[];
  hubs: Hub[] | null | undefined;
  prices: Map<string, PricePoint[]> | undefined;
  prefs: HuntPreferences;
  score?: number;
  offMarket: ReadonlySet<string>;
  onClose: () => void;
  /** Move to the next (+1) or previous (-1) flat in the order the screen behind is showing them.
   *  Absent where there is no such order. */
  onStep?: (delta: number) => void;
  onRate: (rating: Rating, note: string) => void;
  onSetStage: (stage: Stage, archiveReason: ArchiveReason | null) => void;
  onSetOffMarket: (off: boolean) => void;
  stageSaving: Stage | null;
}) {
  const panel = useRef<HTMLDivElement>(null);

  // Through the stack, so a gallery open over this one takes these first: closing a photo used to
  // close the flat behind it as well, and j/k while a photo is up must not move the flat under it.
  //
  // j and k rather than the arrows, which the map already spends on walking its pins, and which on
  // a long panel are how you scroll what you are reading.
  useOverlayKeys({
    Escape: onClose,
    j: () => onStep?.(1),
    k: () => onStep?.(-1),
  });

  useEffect(() => {
    // Focus moves into the panel, so the screen reader starts reading the flat rather than the page
    // it opened over.
    panel.current?.focus();
  }, []);

  return (
    <div className="sheet" data-testid="flat-panel">
      {/* A button rather than a div with a click handler: the way out of a dialog has to be reachable
          without a mouse, and this is the one that is not also inside the dialog. */}
      <button type="button" className="sheet-behind" aria-label="Close" onClick={onClose} />
      <div
        className="panel"
        role="dialog"
        aria-modal="true"
        aria-label={entry.displayAddress}
        tabIndex={-1}
        ref={panel}
      >
        <div className="panel-bar">
          <span className="panel-where">
            {addressBesidePostcode(entry.displayAddress, entry.postcode)}
          </span>
          <button type="button" className="key" onClick={onClose} data-testid="panel-close">
            <Icon name="close" size={12} /> Close
          </button>
        </div>
        <div className="panel-body">
          <FlatDetail
            entry={entry}
            places={places}
            hubs={hubs}
            prices={prices}
            prefs={prefs}
            score={score}
            offMarket={offMarket}
            onRate={onRate}
            onSetStage={onSetStage}
            onSetOffMarket={onSetOffMarket}
            stageSaving={stageSaving}
          />
        </div>
      </div>
    </div>
  );
}
