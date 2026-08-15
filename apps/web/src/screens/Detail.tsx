'use client';

import { useEffect, useState } from 'react';
import { Gallery } from '@house-hunt/ui';
import { Hint } from '@house-hunt/ui';
import { formatDuration, MapsButton, MODE_ICON, readTravel, Routes, TransitBasis } from '@house-hunt/ui';
import { Stations } from '@house-hunt/ui';
import { RatingButtons, VerdictLine } from '@house-hunt/ui';
import { StageLine, StagePicker } from '@house-hunt/ui';
import { RightmoveLink } from '@/components/RightmoveLink';
import { useTravel } from '@/lib/queries';
import {
  TRAVEL_MODES,
  galleryFor,
  type ArchiveReason,
  type Place,
  type Rating,
  type Stage,
  type TravelTime,
} from '@house-hunt/core';
import type { ShortlistEntry } from '@house-hunt/core/db';

/** The expanded half of a shortlist card: change your mind and see the commute without going
 *  back to Rightmove. Travel times come from the same shared cache the panel fills, so for
 *  anywhere either of you has already opened this costs nothing and arrives instantly.
 *
 *  The verdict is the project's one rating, rendered by the same component the panel uses
 *  (design D6) — the card and the panel used to word it differently, and neither said who. */
export function Detail({
  entry,
  places,
  onRate,
  onSetStage,
  stageSaving,
}: {
  entry: ShortlistEntry;
  places: Place[];
  onRate: (rating: Rating, note: string) => void;
  onSetStage: (stage: Stage, archiveReason: ArchiveReason | null) => void;
  /** The step this flat is being moved to, while that write is in flight. The picker draws it as
   *  pressed and refuses another click until it settles: two overlapping upserts can be answered in
   *  either order, and the funnel would end up wherever the slower one said rather than where the
   *  last click did. */
  stageSaving?: Stage | null;
}) {
  const [galleryAt, setGalleryAt] = useState<number | null>(null);

  const gallery = galleryFor(entry);
  // At most one verdict per property now — the project shares one rating (design D6).
  const verdict = entry.verdicts[0] ?? null;
  // The funnel opens when somebody likes the place: liking it is what puts it there (`enter_funnel`
  // in the migration), so before that there is no position to move and the control would only
  // invite you to skip the judgement.
  const funnelled = entry.stage !== null || verdict?.rating === 'love' || verdict?.rating === 'maybe';
  const [note, setNote] = useState(verdict?.note ?? '');

  // Re-seed when the card is pointed at a different listing. Deliberately not depending on the
  // note itself — a refetch landing mid-sentence would otherwise overwrite what you are typing.
  // oxlint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => setNote(verdict?.note ?? ''), [entry.rightmoveId]);

  // Keyed on the places as well as the postcode — see `useTravel`, which carries the reason. This
  // was a hand-rolled effect with its own `live` flag when the read had to cross into a background
  // worker; the query does the cancellation, and caches the answer across every card asking about
  // the same postcode.
  const placeKey = places.map((p) => p.id).join(',');
  const travelQuery = useTravel(entry.postcode, placeKey);
  const travel: TravelTime[] | null = travelQuery.data ?? null;

  return (
    <div className="detail">
      {/* The decision comes first and spans the width. Tucked into a third column it read as
          the least important thing on the card, which is backwards. */}
      <div className="detail-verdict">
        <VerdictLine verdict={verdict} />
        <RatingButtons compact value={verdict?.rating} onRate={(rating) => onRate(rating, note)} />
        <input
          className="note-edit"
          value={note}
          placeholder="Note…"
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

      {/* Under the verdict and separate from it, which is the whole design: what you think of a
          place and how far it has got are two facts, and an offer that fell through must not undo a
          love. Offered only once there is something in the funnel to move — a place nobody has
          liked yet has not entered it. */}
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

      <Photos entry={entry} images={gallery} onOpen={setGalleryAt} />
      {galleryAt !== null && (
        <Gallery
          images={gallery}
          startAt={galleryAt}
          caption={entry.displayAddress}
          onClose={() => setGalleryAt(null)}
        />
      )}

      <div className="detail-block">
        <h3>
          Travel times <TransitBasis />
        </h3>
        {!entry.postcode ? (
          <p className="dim">No postcode on this listing.</p>
        ) : places.length === 0 ? (
          <p className="dim">Add places in Settings.</p>
        ) : travelQuery.isError ? (
          // A refusal is not a wait. `travel` is `data ?? null`, and `data` stays undefined when the
          // query fails, so every failure used to render as "Working…" — a spinner that never
          // stops, which reads as a slow network rather than as something that already gave up and
          // is never coming back.
          //
          // That was not hypothetical. The Edge Functions did not allow the `x-client-info` header
          // supabase-js puts on every request, so the browser refused each travel call at the
          // preflight, and every card on the deployed site sat on "Working…" indefinitely. The
          // header is fixed, and this is the half that would have said so on day one.
          <p className="error">
            Could not work out travel times — {travelQuery.error instanceof Error ? travelQuery.error.message : 'the request failed'}.
          </p>
        ) : travel === null ? (
          <p className="dim working">Working…</p>
        ) : (
          places.map((place) => {
            const forPlace = travel.filter((t) => t.placeId === place.id);
            // Exactly what the panel shows, from the same components: the minutes stay plain
            // numbers, transit hovers to reveal which lines you'd ride, and one map button per
            // row opens the route. This used to make each number its own Google Maps link,
            // which is how the two views drifted apart.
            const verdict = readTravel(forPlace);
            const shown = TRAVEL_MODES.flatMap((mode) => {
              const t = verdict.usable.find((x) => x.mode === mode);
              if (!t) return [];
              const routes = mode === 'transit' ? t.options : undefined;
              return [
                <Hint
                  key={mode}
                  className="rm-mode"
                  underline={false}
                  text={routes && routes.length > 0 ? <Routes options={routes} /> : undefined}
                >
                  {MODE_ICON[mode]} {formatDuration(t.seconds)}
                </Hint>,
              ];
            });


            return (
              <div className="row" key={place.id}>
                <span>{place.label}</span>
                <span className={shown.length > 0 ? 'rm-modes' : 'flag-bad'}>
                  {shown.length > 0 ? (
                    <>
                      {shown}
                      {/* A mode that failed while others succeeded used to vanish silently. */}
                      {verdict.transient && (
                        <Hint text={`${verdict.transient.mode} did not come back: ${verdict.transient.error}`}>
                          <span className="flag-bad">↻</span>
                        </Hint>
                      )}
                      <MapsButton postcode={entry.postcode} place={place} />
                    </>
                  ) : verdict.transient ? (
                    <Hint text={`TfL did not answer: ${verdict.transient.error}`}>TfL failed</Hint>
                  ) : (
                    <Hint text="No journey between these two points.">
                      no route
                    </Hint>
                  )}
                </span>
              </div>
            );
          })
        )}
      </div>

      <div className="detail-block">
        <h3>Nearest stations</h3>
        <Stations postcode={entry.postcode} stations={entry.nearestStations} limit={3} />
      </div>

      {entry.analysis?.summary && <p className="summary dim">{entry.analysis.summary}</p>}

      <div className="detail-links">
        <RightmoveLink url={entry.url} />
      </div>
    </div>
  );
}

/** The gallery, scrolled sideways. Thumbnails are Rightmove's own URLs rendered straight from
 *  their CDN — displayed, never copied or re-hosted, which is the line their terms draw. */
function Photos({
  entry,
  images,
  onOpen,
}: {
  entry: ShortlistEntry;
  images: string[];
  onOpen: (at: number) => void;
}) {
  const photos = images.slice(0, 12);
  if (photos.length === 0) return null;

  return (
    <div className="photos">
      {photos.map((url, i) => {
        const isPlan = url === entry.floorplanUrl;
        return (
          <button
            className={isPlan ? 'photo photo-plan' : 'photo'}
            onClick={() => onOpen(i)}
            key={url}
            aria-label={isPlan ? 'Floorplan' : `Photo ${i + 1}`}
          >
            <img src={url} alt="" loading="lazy" />
            {isPlan && <span className="photo-tag">Floorplan</span>}
          </button>
        );
      })}
      {images.length > photos.length && (
        <button className="photo photo-more" onClick={() => onOpen(photos.length)}>
          +{images.length - photos.length}
        </button>
      )}
    </div>
  );
}

