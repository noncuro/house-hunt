'use client';

import { useEffect, useState } from 'react';
import {
  Flags,
  Gallery,
  HubFact,
  Hint,
  Icon,
  OffMarketRow,
  PriceMove,
  RatingButtons,
  ScoreGauge,
  SizeFact,
  StageLine,
  StagePicker,
  Stations,
  TravelGrid,
  VerdictLine,
} from '@house-hunt/ui';
import {
  addressBesidePostcode,
  galleryFor,
  groupOf,
  relativeUpdate,
  sizeOf,
  type ArchiveReason,
  type Hub,
  type HuntPreferences,
  type Place,
  type PricePoint,
  type Rating,
  type Stage,
} from '@house-hunt/core';
import type { ShortlistEntry } from '@house-hunt/core/db';
import { RightmoveLink } from '@/components/RightmoveLink';
import { useTravel } from '@/lib/queries';
import { isSurprise } from '@/lib/score';

/** The whole of one flat: what it is, where it is, what the photos said, and what we think.
 *
 *  One renderer for three surfaces — triage's right-hand pane, the panel that opens from a card on
 *  Places, and the sheet the map docks at its foot. They used to be two: a `Detail` that lived
 *  inside every shortlist card and a triage table that opened its own copy of the same thing
 *  underneath a row. Two meant the audit could find the verdict stated three times in one of them
 *  and twice in the other, and the travel block laid out differently in each.
 *
 *  The order is the order a decision is made in: the pictures, then the numbers, then the objections,
 *  then the journeys, and the verdict last because it is the thing you do having read the rest. */
export function FlatDetail({
  entry,
  places,
  hubs,
  prices,
  prefs,
  score,
  offMarket,
  onRate,
  onSetStage,
  onSetOffMarket,
  stageSaving,
  /** Draws the `1` `2` `3` keycaps on the rating buttons. Only triage binds those keys, and a
   *  keycap on a screen where the key does nothing is an instruction that fails when followed. */
  keys = false,
}: {
  entry: ShortlistEntry;
  places: Place[];
  hubs: Hub[] | null | undefined;
  prices: Map<string, PricePoint[]> | undefined;
  /** This hunt's preferences, so a must-have absence flags red and the great-room bar is this
   *  hunt's rather than the default. Without it the flat's own view would grade it more gently than
   *  the card that led you here. */
  prefs: HuntPreferences;
  score?: number;
  offMarket: ReadonlySet<string>;
  onRate: (rating: Rating, note: string) => void;
  onSetStage: (stage: Stage, archiveReason: ArchiveReason | null) => void;
  onSetOffMarket: (off: boolean) => void;
  stageSaving?: Stage | null;
  keys?: boolean;
}) {
  const [galleryAt, setGalleryAt] = useState<number | null>(null);
  const images = galleryFor(entry);
  // At most one verdict per property — the project shares one rating (design D6).
  const verdict = entry.verdicts[0] ?? null;
  const [note, setNote] = useState(verdict?.note ?? '');

  // Re-seed when the pane is pointed at a different listing. Deliberately not depending on the note
  // itself — a refetch landing mid-sentence would otherwise overwrite what you are typing. This
  // matters far more here than it did on a card: in triage the pane is *re-pointed* thirty times in
  // a sitting, and a note left over from the previous flat would be saved onto this one.
  // oxlint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => setNote(verdict?.note ?? ''), [entry.rightmoveId]);

  // Keyed on the places as well as the postcode — see `useTravel`. This is the one surface allowed
  // to resolve a missing journey, because it is the one flat somebody is actually looking at.
  const placeKey = places.map((p) => p.id).join(',');
  const travelQuery = useTravel(entry.postcode, placeKey);

  const group = groupOf(entry.verdicts);
  // A love or maybe you can act on can be taken off the market; a rejection has nothing to withhold
  // (it is already out of the positive class), and an unrated flat is not in training yet.
  const canGoOffMarket = group === 'excited' || group === 'maybe';
  // The funnel opens when somebody likes the place: liking it is what puts it there (`enter_funnel`
  // in the migration), so before that there is no position to move.
  const funnelled = entry.stage !== null || verdict?.rating === 'love' || verdict?.rating === 'maybe';
  const point = entry.lat !== null && entry.lon !== null ? { lat: entry.lat, lon: entry.lon } : null;

  return (
    <div className="detail" data-testid="flat-detail">
      <Shots entry={entry} images={images} onOpen={setGalleryAt} />
      {galleryAt !== null && (
        <Gallery
          images={images}
          startAt={galleryAt}
          caption={entry.displayAddress}
          onClose={() => setGalleryAt(null)}
        />
      )}

      <div className="detail-head">
        <h2 className="detail-address">{addressBesidePostcode(entry.displayAddress, entry.postcode)}</h2>
        {score !== undefined && <ScoreGauge score={score} surprise={isSurprise(entry, score)} />}
      </div>

      <p className="detail-facts">
        {entry.price && <span className="detail-rent">{entry.price}</span>}
        <PriceMove history={prices?.get(entry.rightmoveId)} />
        {entry.bedrooms !== null && <span>{entry.bedrooms} bed</span>}
        {entry.bathrooms !== null && <span>{entry.bathrooms} bath</span>}
        <span>
          <SizeFact source={sizeOf(entry)} missing="size unknown" />
        </span>
        {entry.furnishType && <span>{entry.furnishType}</span>}
        {/* The same fix the panel draws, from the same component — a detail view that placed a flat
            against a different neighbourhood would be the two views disagreeing about where it is. */}
        <HubFact point={point} hubs={hubs} approximate={!entry.exactLocation} />
        {/* "3 weeks ago" is the useful form and Rightmove's own sentence is the fact behind it, so
            the sentence is a hint rather than a `title` — reachable by keyboard. */}
        {entry.listingUpdate && (
          <Hint
            underline={false}
            className={/reduc/i.test(entry.listingUpdate) ? 'reduced' : 'dim'}
            text={entry.listingUpdate}
          >
            {relativeUpdate(entry.listingUpdate)}
          </Hint>
        )}
      </p>

      <Flags
        source={{ analysis: entry.analysis, floorplanUrl: entry.floorplanUrl, size: sizeOf(entry) }}
        prefs={prefs}
      />

      <div className="detail-journeys">
        <TravelGrid
          places={places}
          travel={travelQuery.data ?? null}
          postcode={entry.postcode}
        />
        {/* A refusal is not a wait. `data` stays undefined when the query fails, so every failure
            used to render as "Working…" — a spinner that never stops, which reads as a slow network
            rather than as something that already gave up and is never coming back. */}
        {travelQuery.isError && (
          <p className="error">
            Could not work out travel times —{' '}
            {travelQuery.error instanceof Error ? travelQuery.error.message : 'the request failed'}.
          </p>
        )}
        <div className="detail-stations">
          <h3 className="label">Nearest stations</h3>
          <Stations postcode={entry.postcode} stations={entry.nearestStations} limit={3} />
        </div>
      </div>

      {entry.analysis?.summary && <p className="detail-summary dim">{entry.analysis.summary}</p>}

      {/* The decision, last and on its own rule. Everything above it is what the flat is; this is
          the only part of the pane that writes anything. */}
      <div className="detail-decide">
        <VerdictLine verdict={verdict} />
        <RatingButtons
          compact
          keys={keys}
          value={verdict?.rating}
          onRate={(rating) => onRate(rating, note)}
        />
        <input
          className="note-edit"
          value={note}
          placeholder="Note…"
          aria-label="Note on this flat"
          onChange={(e) => setNote(e.target.value)}
          // Blur fires before the click that caused it, so leaving the note to click a different
          // rating would race two saves — one at the old rating, one at the new — and the later
          // reply won. The rating buttons pass the note themselves.
          onBlur={(e) => {
            if (e.relatedTarget instanceof Element && e.relatedTarget.closest('.rm-ratings')) return;
            if (verdict && note !== verdict.note) onRate(verdict.rating, note);
          }}
        />
      </div>

      {/* Under the verdict and deliberately quieter: what you think of a place and how far it has
          got are two facts, and an offer that fell through must not undo a love. Offered only once
          there is something in the funnel to move. */}
      {funnelled && (
        <div className="detail-stage">
          <StageLine stage={entry.stage} />
          <StagePicker
            stage={entry.stage}
            pending={stageSaving ?? null}
            onSet={onSetStage}
            disabled={stageSaving ? 'Saving…' : undefined}
          />
        </div>
      )}

      <div className="detail-exits">
        <OffMarketRow
          isOff={offMarket.has(entry.rightmoveId)}
          canGoOffMarket={canGoOffMarket}
          onToggle={onSetOffMarket}
        />
        <RightmoveLink url={entry.url} />
      </div>
    </div>
  );
}

/** The photographs, floorplan first.
 *
 *  Floorplan-first is the right call and was already how this worked; what it lacked was any sign
 *  that the strip continued past the edge of the box, so the last thumbnail was clipped by the card
 *  and read as a layout fault rather than as an invitation. A fade at the right edge and a count on
 *  the last tile make it deliberate.
 *
 *  Thumbnails are Rightmove's own URLs rendered straight from their CDN — displayed, never copied or
 *  re-hosted, which is the line their terms draw. */
function Shots({
  entry,
  images,
  onOpen,
}: {
  entry: ShortlistEntry;
  images: string[];
  onOpen: (at: number) => void;
}) {
  const shown = images.slice(0, 8);
  if (shown.length === 0) {
    return (
      <p className="detail-noshots dim">
        <Icon name="warning" size={14} /> No photographs on this listing.
      </p>
    );
  }

  return (
    <div className="shots" data-more={images.length > shown.length ? 'yes' : 'no'}>
      {shown.map((url, i) => {
        const isPlan = url === entry.floorplanUrl;
        return (
          <button
            type="button"
            className={isPlan ? 'shot shot-plan' : 'shot'}
            onClick={() => onOpen(i)}
            key={url}
            aria-label={isPlan ? 'Floorplan' : `Photo ${i + 1}`}
          >
            <img src={url} alt="" loading="lazy" />
            {isPlan && <span className="shot-tag">floorplan</span>}
            {i === shown.length - 1 && images.length > shown.length && (
              <span className="shot-more">+{images.length - shown.length}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
