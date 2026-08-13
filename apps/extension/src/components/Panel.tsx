import { useEffect, useRef, useState } from 'react';
import { Confidence } from '@house-hunt/ui';
import { Hint } from '@house-hunt/ui';
import { Toasts, useToasts } from '@house-hunt/ui';
import { CappedNotice, SpendWarning } from '@house-hunt/ui';
import { VerdictLine, RatingButtons } from '@house-hunt/ui';
import { StageLine, StagePicker } from '@house-hunt/ui';
import { ScoreBadge } from '@house-hunt/ui';
import { OffMarketRow } from '@house-hunt/ui';
import { scoreListing } from '@/lib/score';
import { send, type AnalysisRequest, type SessionUser, type SpendSummary } from '@/lib/messages';
import {
  BIGGEST_ROOM_BIG_SQFT,
  BIGGEST_ROOM_SMALL_SQFT,
  FLAG_ICON,
  OUTDOOR_MINIMUM_SQFT,
  claimLabel,
  explainReading,
  relativeUpdate,
  resolveReading,
  type Reading,
} from '@house-hunt/core';
import { HubFact } from '@house-hunt/ui';
import { hubsFromProject, type Hub } from '@house-hunt/core';
import { formatDuration, MapsButton, MODE_ICON, readTravel, Routes, TransitBasis } from '@house-hunt/ui';
import { Stations, STATIONS_SHOWN } from '@house-hunt/ui';
import { Gallery } from '@house-hunt/ui';
import '@house-hunt/ui/flags.css';
// The section caveat's styling lived in this file and was imported by nothing, so it never
// applied. One import, and the rule that was written for it takes effect.
import './panel.css';
import { SizeFact, sqft } from '@house-hunt/ui';
import type { Point } from '@house-hunt/core';
import {
  TRAVEL_MODES,
  type Analysis,
  type ArchiveReason,
  type Listing,
  type Model,
  type Place,
  type PropertyStage,
  type Rating,
  type Stage,
  type TravelTime,
  type Verdict,
} from '@house-hunt/core';


/** The analysis runs on an Edge Function that may be queued behind somebody else's claim, so we
 *  poll rather than wait. Giving up is said out loud — see `AnalysisState`. */
const ANALYSIS_POLL_MS = 4000;
const ANALYSIS_POLLS = 15;

/** The panel is only ever mounted for a signed-in user with an active project: `panel.content`
 *  resolves `auth:state` first and renders the sign-in line itself otherwise (design D13). So
 *  `user` is a value here, not a maybe — the rating buttons no longer gate on a locally-set name,
 *  because there is no local identity any more. */
export function Panel({ listing, user }: { listing: Listing; user: SessionUser }) {
  /** The project's one rating for this property, or null when nobody has judged it (design D6). */
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  const [places, setPlaces] = useState<Place[]>([]);
  /** The project's neighbourhoods (design D11). Undefined while the list is being read, null when
   *  the read failed — `HubFact` says which, because "no hub within a mile" and "we could not find
   *  out" are the same blank and opposite claims. */
  const [hubs, setHubs] = useState<Hub[] | null | undefined>(undefined);
  const [travel, setTravel] = useState<TravelTime[] | null>(null);
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [analysisPending, setAnalysisPending] = useState(true);
  /** The project's verdict-score model, read once. Null when it has never been trained; scoring is
   *  done in render against these weights, so it costs nothing to keep here. */
  const [model, setModel] = useState<Model | null>(null);
  const [galleryAt, setGalleryAt] = useState<number | null>(null);
  /** What the analyser said when we asked. Null until it has answered — `capped` and `failed` are
   *  states the panel spells out rather than absences it renders as a missing paragraph. */
  const [request, setRequest] = useState<AnalysisRequest | null>(null);
  const [spend, setSpend] = useState<SpendSummary | null>(null);
  const [note, setNote] = useState('');
  /** The panel's own element, only so the gallery knows which shadow root to portal into. */
  const root = useRef<HTMLDivElement | null>(null);
  // The floorplan leads, exactly as it does on the shortlist. It is the single most useful image
  // for deciding whether to view a place, and Rightmove buries it behind its own gallery.
  const plan = listing.floorplans[0]?.url;
  const gallery = plan ? [plan, ...listing.imageUrls.filter((u) => u !== plan)] : listing.imageUrls;
  const [error, setError] = useState<string | null>(null);
  /** The rating we've shown but haven't confirmed. Null means everything on screen is saved. */
  const [pending, setPending] = useState<Rating | null>(null);
  /** Where this place has got to for the project, and the step clicked but not yet acknowledged.
   *  Read beside the verdict and kept apart from it — see `packages/core/src/stage.ts`. */
  const [stage, setStage] = useState<PropertyStage | null>(null);
  const [stagePending, setStagePending] = useState<Stage | null>(null);
  const { toasts, push, dismiss } = useToasts();
  /** Counts verdict saves so an older one that lands late cannot overwrite a newer choice. */
  const saves = useRef(0);
  const [collapsed, setCollapsed] = useState(false);
  /** Undefined until the postcode has been resolved — the hub fix distinguishes "still looking"
   *  from "nowhere near a hub", which are not the same claim. */
  const [point, setPoint] = useState<Point | null | undefined>(undefined);
  /** Whether this flat is off the market for the project — kept in the shortlist with its verdict,
   *  withheld only from the score's training. Read alongside the verdict, toggled from the footer. */
  const [offMarket, setOffMarket] = useState(false);
  const [offMarketBusy, setOffMarketBusy] = useState(false);
  /** The page says this flat is off the market and it is rated love/maybe, so we ask before
   *  withholding it rather than doing so silently — see the load effect. */
  const [confirmOffMarket, setConfirmOffMarket] = useState(false);
  /** The listing on screen right now, readable from inside an in-flight async without capturing a
   *  stale closure — so a reply for the flat you were just looking at cannot paint the one you have
   *  moved on to. */
  const listingIdRef = useRef(listing.rightmoveId);
  listingIdRef.current = listing.rightmoveId;

  // The hub fix is drawn from the postcode, never from listing.latitude/longitude: Rightmove
  // fuzzes the pin, and a fuzzed origin rotates a bearing taken from half a mile away by tens of
  // degrees. No postcode means no fix rather than a plausible wrong one.
  useEffect(() => {
    if (!listing.postcode) {
      setPoint(null);
      return;
    }
    let live = true;
    setPoint(undefined);
    void send({ type: 'postcode:point', postcode: listing.postcode }).then((r) => {
      if (live) setPoint(r.ok ? r.data : null);
    });
    return () => {
      live = false;
    };
  }, [listing.postcode]);

  useEffect(() => {
    let live = true;
    // A new listing starts from nothing it did not earn. Left standing, the previous flat's
    // analysis keeps answering for this one until polling lands — and the score below reads its
    // amenities and its natural light, so the panel states a confident number about the wrong
    // flat. "Still reading" is the honest state for the second or two it takes.
    setAnalysis(null);
    setRequest(null);
    setAnalysisPending(true);
    // A new listing starts from "on the market, not asking, not saving" until its own read lands.
    // Left standing, a failed off-market read would keep the previous flat's status on screen.
    setOffMarket(false);
    setOffMarketBusy(false);
    setConfirmOffMarket(false);

    // A new listing starts outside the funnel until its own read lands, for the same reason the
    // analysis is cleared above: the previous flat's viewing is not this one's.
    setStage(null);
    setStagePending(null);

    void (async () => {
      const [existing, placeList, spending, hubList, storedModel, offState, stageState] = await Promise.all([
        send({ type: 'verdicts:get', rightmoveIds: [listing.rightmoveId] }),
        send({ type: 'places:list' }),
        send({ type: 'spend:summary' }),
        send({ type: 'hubs:list' }),
        send({ type: 'model:get' }),
        send({ type: 'off-market:get', rightmoveId: listing.rightmoveId }),
        send({ type: 'stage:get', rightmoveId: listing.rightmoveId }),
      ]);
      if (!live) return;

      if (stageState.ok) setStage(stageState.data);

      // A failed read leaves this false — "on the market" is the safe default, since it only ever
      // withholds a flat from training and the toggle re-reads on the next open anyway.
      if (offState.ok) setOffMarket(offState.data);

      if (placeList.ok) setPlaces(placeList.data);
      if (spending.ok) setSpend(spending.data);
      // Unlike the analysis cleared above, the model is project-scoped — it is as true of this flat
      // as of the last one, so a failed refresh is no reason to throw away a model that is still
      // valid. A model that has genuinely gone (retrained into insufficiency, and deleted server
      // side) comes back as a successful read of nothing, which does null it. What must not happen
      // is the failure passing unmentioned, so it joins the list below.
      if (storedModel.ok) setModel(storedModel.data?.model ?? null);
      // Rows with no coordinate are dropped by `hubsFromProject` rather than guessed at, so a hub
      // kept only for its sweep history never rotates a bearing.
      setHubs(hubList.ok ? hubsFromProject(hubList.data) : null);
      if (existing.ok) {
        // At most one row comes back now — the project shares one rating (design D6).
        const current = existing.data[0] ?? null;
        setVerdict(current);
        setNote(current?.note ?? '');
      }

      // Off the market according to Rightmove itself, and not yet marked here. The model should not
      // keep learning from a flat nobody can rent, so mark it — but only silently when there is no
      // positive verdict to reconsider. A love or maybe is a judgement worth a second thought before
      // it is withheld, so that case asks first (the banner below) rather than acting behind your
      // back. Decided here, with the verdict and the off-market state both freshly in hand, so it
      // cannot race a half-loaded verdict and auto-withhold a flat it should have asked about.
      setConfirmOffMarket(false);
      if (listing.archived === true && offState.ok && !offState.data) {
        const rating = existing.ok ? (existing.data[0]?.rating ?? null) : null;
        if (rating === 'love' || rating === 'maybe') setConfirmOffMarket(true);
        else void toggleOffMarket(true, 'Marked off the market — it is no longer listed on Rightmove.');
      }

      // Surface the first failure of the five. Swallowing these is what made a broken
      // background look like an empty database.
      const failure = [placeList, existing, spending, hubList, storedModel, stageState].find((r) => !r.ok);
      if (failure && !failure.ok) setError(failure.error);

      // Recording the listing is what gives this project a `project_property` link, and the
      // analyser refuses a listing the caller's project has never opened. So it goes first, and
      // the request that follows is what tells us whether the budget allowed it — `listing:seen`
      // fires its own request and throws the answer away, which is fine: a second ask for a
      // claimed listing reads the claim, and a capped one is capped either way.
      await send({ type: 'listing:seen', listing });
      const asked = await send({ type: 'analysis:request', rightmoveId: listing.rightmoveId });
      if (!live) return;
      setRequest(asked.ok ? asked.data : { status: 'failed', message: asked.error });
    })();

    return () => {
      live = false;
    };
    // Keyed on the id alone: the listing object is rebuilt on every page message, and depending
    // on it would refetch identity, places and verdicts in a loop.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [listing.rightmoveId]);

  // Travel times are a second, slower pass so the panel paints immediately with the free data.
  // It does NOT wait for the places list: both are round trips to the same background worker,
  // and gating one on the other doubled how long the section sat on "Working…" even when every
  // number was already cached.
  useEffect(() => {
    if (!listing.postcode) return;
    let live = true;
    void loadTravel(listing.postcode).then((result) => {
      if (!live) return;
      if (result.ok) setTravel(result.data);
      else setError(result.error);
    });
    return () => {
      live = false;
    };
  }, [listing.postcode]);

  async function loadTravel(postcode: string, refresh = false) {
    return await send({ type: 'travel:get', postcode, refresh });
  }

  /** Retry after a transient TfL failure: ask the background to skip its cache and try again. */
  async function refreshTravel() {
    if (!listing.postcode) return;
    setTravel(null);
    const result = await loadTravel(listing.postcode, true);
    if (result.ok) setTravel(result.data);
    else setError(result.error);
  }

  // Poll for the photo analysis, which is computed once per property and shared across projects.
  // A capped or failed request is the end of the story — polling on would turn a stated reason
  // into a minute of "reading photos…" followed by nothing.
  useEffect(() => {
    if (request?.status === 'capped' || request?.status === 'failed') {
      setAnalysisPending(false);
      return;
    }
    let live = true;
    let polls = 0;

    const check = async () => {
      const result = await send({ type: 'analysis:get', rightmoveId: listing.rightmoveId });
      if (!live) return;
      if (result.ok && result.data) {
        setAnalysis(result.data);
        setAnalysisPending(false);
        return;
      }
      if (++polls >= ANALYSIS_POLLS) {
        setAnalysisPending(false);
        return;
      }
      timer = setTimeout(() => void check(), ANALYSIS_POLL_MS);
    };

    let timer: ReturnType<typeof setTimeout>;
    void check();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [listing.rightmoveId, request?.status]);

  /** Ask again after a refusal that might not be permanent — a function that was unreachable, or
   *  a claim that has since gone stale. Capped is not offered a retry: the month has to turn. */
  async function retryAnalysis() {
    setRequest(null);
    setAnalysisPending(true);
    const asked = await send({ type: 'analysis:request', rightmoveId: listing.rightmoveId });
    setRequest(asked.ok ? asked.data : { status: 'failed', message: asked.error });
  }

  /** Optimistic: the button reads as pressed the moment you click it, because waiting on a
   *  round trip to acknowledge a click feels broken. The risk of optimism is claiming a save
   *  that never happened, so the rating is marked unconfirmed until the write lands, and a
   *  failure rolls it back and says so loudly rather than leaving a lie on screen. */
  async function rate(rating: Rating, noteOverride?: string) {
    const text = noteOverride ?? note;
    const before = verdict;

    // Clicking maybe then exciting runs two saves at once, and without a sequence number the
    // slower one gets the last word whichever was clicked last: a failed first request would
    // restore the snapshot it captured — from before either click — and undo the second, and a
    // late refetch from the first would paint the intermediate rating back over the final one.
    // Only the newest attempt is allowed to touch what is on screen.
    const attempt = ++saves.current;
    const newest = () => attempt === saves.current;

    setPending(rating);
    // Attributed to you straight away, because that is what the write will say: one rating per
    // project, authored by whoever last set it.
    setVerdict({
      rightmoveId: listing.rightmoveId,
      person: user.displayName,
      rating,
      note: text,
      updatedAt: new Date().toISOString(),
    });

    const result = await send({ type: 'verdict:set', rightmoveId: listing.rightmoveId, rating, note: text });
    if (!result.ok) {
      // The toast fires whichever attempt this was — a failed save has to be said out loud even
      // when a later click has already moved the buttons on.
      push(`Not saved — ${result.error}`);
      if (!newest()) return;
      setVerdict(before);
      setPending(null);
      return;
    }

    // Re-read rather than trusting our own optimistic row: this is also how the other laptop's
    // verdict arrives, and how the attribution becomes the database's answer rather than ours.
    //
    // The funnel comes back with it, because liking a place is what enters it — the `enter_funnel`
    // trigger writes the `shortlisted` row inside the same statement, and reading it here is how the
    // steps appear the moment you press "Like it" rather than on the next page load.
    const [fresh, freshStage] = await Promise.all([
      send({ type: 'verdicts:get', rightmoveIds: [listing.rightmoveId] }),
      send({ type: 'stage:get', rightmoveId: listing.rightmoveId }),
    ]);
    if (!newest()) return;
    if (fresh.ok) setVerdict(fresh.data[0] ?? null);
    if (freshStage.ok) setStage(freshStage.data);
    setPending(null);
    setError(null);
  }

  /** Move this place along the funnel. Deliberately not optimistic in the way a rating is: this is
   *  a handful of clicks over a flat's life rather than the gesture you make thirty times working a
   *  pile, and what it records — who moved it, and when — is worth showing as the database has it.
   *  The step reads as pressed while the write is in flight, and a failure says so. */
  async function moveStage(next: Stage, archiveReason: ArchiveReason | null) {
    const id = listing.rightmoveId;
    setStagePending(next);
    const result = await send({
      type: 'stage:set',
      rightmoveId: id,
      stage: next,
      archiveReason,
      note: '',
    });
    // A late reply must not touch the flat now on screen, whose own load has already set its state.
    if (listingIdRef.current !== id) return;
    if (!result.ok) {
      setStagePending(null);
      push(`Not saved — ${result.error}`);
      return;
    }
    const fresh = await send({ type: 'stage:get', rightmoveId: id });
    if (listingIdRef.current !== id) return;
    if (fresh.ok) setStage(fresh.data);
    setStagePending(null);
  }

  /** Off the market, or back on. Optimistic like the rating, and rolled back with a toast on
   *  failure — a control that silently did nothing would leave the model still learning from a flat
   *  you meant to withhold. */
  async function toggleOffMarket(next: boolean, announce?: string) {
    const id = listing.rightmoveId;
    const before = offMarket;
    setOffMarketBusy(true);
    setOffMarket(next);
    const result = await send({ type: 'off-market:set', rightmoveId: id, off: next });
    // The listing may have changed while this was in flight; a late reply must not touch the flat
    // now on screen, whose own load has already set its state.
    if (listingIdRef.current !== id) return;
    setOffMarketBusy(false);
    if (!result.ok) {
      setOffMarket(before);
      push(`Not saved — ${result.error}`);
      return;
    }
    // An auto-mark says so, so an unattended change is never silent; a hand toggle stays quiet.
    if (announce) push(announce);
  }

  if (collapsed) {
    return (
      <button className="rm-reopen" onClick={() => setCollapsed(false)}>
        🏠 House hunt
      </button>
    );
  }

  // The project's one rating tints the whole panel, so which pile a place is in is legible before
  // you read a word of it. There is nothing to reconcile any more: whoever set it last set it for
  // both of you, which is why the attribution above the buttons is not optional.
  const rejected = verdict?.rating === 'no';
  const mood = verdict?.rating ?? null;
  // In the funnel, or one click from being: liking a place is what enters it (`enter_funnel`).
  const funnelled = stage !== null || mood === 'love' || mood === 'maybe';

  // The model's guess for this listing, computed here in the panel against weights already fetched
  // — pure arithmetic, well under a second, no round trip. Null until the model and the hub fix are
  // both in hand; it sharpens once the photo analysis lands, but shows before it, because price,
  // size and distance to your neighbourhoods already carry most of the signal.
  //
  // `point` has three states and the middle one matters: undefined is "still resolving the
  // postcode", null is "resolved, and there is no point". Scoring on undefined falls back to
  // Rightmove's fuzzed pin, so the panel would show one number and then quietly replace it with a
  // different one a moment later. Wait; a null point is a finished answer and scores fine.
  const modelScore =
    model && Array.isArray(hubs) && point !== undefined
      ? scoreListing(model, listing, analysis, hubs, point)
      : null;

  return (
    <div
      ref={root}
      className={`rm-panel${mood ? ` rm-mood-${mood}` : ''}${rejected ? ' rm-panel-rejected' : ''}`}
    >
      <header className="rm-head">
        <div>
          <div className="rm-address">{listing.displayAddress}</div>
          {/* Grouped by what you compare together: the counts, then how big and how it comes,
              then the two things that most often rule a place out. */}
          <div className="rm-facts">
            <div className="rm-fact-row">
              {listing.price && <span className="rm-price">{listing.price}</span>}
              {listing.listingUpdate && (
                <Hint
                  className={/reduc/i.test(listing.listingUpdate) ? 'rm-since rm-reduced' : 'rm-since rm-dim'}
                  text={listing.listingUpdate}
                >
                  {relativeUpdate(listing.listingUpdate)}
                </Hint>
              )}
            </div>
            <div className="rm-fact-row">
              <CountFact icon="🛏" word="bed" listed={listing.bedrooms} seen={analysis?.bedrooms} />
              <CountFact icon="🚿" word="bath" listed={listing.bathrooms} seen={analysis?.bathrooms} />
            </div>
            <div className="rm-fact-row">
              <SizeFact
          source={{
            floorplanSqft: analysis?.floorplanSqft,
            floorplanLegible: analysis?.floorplanLegible,
            listedSqft: listing.floorArea?.sqft ?? null,
            listedSource: listing.floorArea?.source ?? null,
          }}
        />
              {listing.furnishType && <span>{listing.furnishType}</span>}
            </div>
            <div className="rm-fact-row">
              <BathtubFact analysis={analysis} />
              <OutdoorFact analysis={analysis} />
            </div>
            <RoomFact analysis={analysis} />
            {!analysis && (
              <AnalysisState
                request={request}
                pending={analysisPending}
                photos={listing.imageUrls.length}
                retry={() => void retryAnalysis()}
              />
            )}
          </div>
        </div>
        <button className="rm-collapse" onClick={() => setCollapsed(true)} title="Hide">
          ×
        </button>
      </header>

      {/* Directly under the address, because it is the answer to the same question the address
          is asking and mostly failing to answer. */}
      <div className="rm-row rm-row-hub">
        <HubFact point={point} hubs={hubs} places={places} />
      </div>

      <div className="rm-row">
        <CopyablePostcode postcode={listing.postcode ?? listing.outcode} />
        <FloorplanChip listing={listing} analysis={analysis} pending={analysisPending} />
        <PhotosChip listing={listing} onOpen={() => setGalleryAt(0)} />
      </div>

      {galleryAt !== null && (
        <Gallery
          images={gallery}
          startAt={galleryAt}
          caption={listing.displayAddress}
          onClose={() => setGalleryAt(null)}
          container={root.current?.getRootNode() as ShadowRoot | undefined}
        />
      )}

      <Section title="Nearest stations">
        <Stations
          postcode={listing.postcode}
          stations={listing.nearestStations}
          limit={STATIONS_SHOWN}
        />
      </Section>

      <Section title="Travel times" note={<TransitBasis />}>
        {places.length === 0 ? (
          <div className="rm-empty">Add places in Settings, on the website</div>
        ) : !listing.postcode ? (
          <div className="rm-empty">No postcode on this listing</div>
        ) : travel === null ? (
          <div className="rm-empty rm-working">Working…</div>
        ) : (
          places.map((place) => {
            const forPlace = travel.filter((x) => x.placeId === place.id);
            const verdict = readTravel(forPlace);
            const shown = TRAVEL_MODES.map((mode) => {
              const t = verdict.usable.find((x) => x.mode === mode);
              if (!t) return null;
              // Only transit has a route worth explaining. Walking and cycling are one leg, and
              // "you walk, for 15 minutes" is not worth a hover.
              const routes = mode === 'transit' ? t.options : undefined;
              return (
                <Hint
                  key={mode}
                  className="rm-mode"
                  underline={false}
                  text={routes && routes.length > 0 ? <Routes options={routes} /> : undefined}
                >
                  {MODE_ICON[mode]} {formatDuration(t.seconds)}
                </Hint>
              );
            }).filter(Boolean);


            return (
              <div className="rm-line" key={place.id}>
                <span>{place.label}</span>
                {/* An empty row would read as "no travel time needed" rather than "every mode
                    failed" — usually a place TfL can't route to, like outside London. */}
                <span className={shown.length > 0 ? 'rm-value rm-modes' : 'rm-value rm-bad'}>
                  {shown.length > 0 ? (
                    <>
                      {shown}
                      {/* A mode that failed while others succeeded used to vanish, which reads as
                          "we didn't think cycling was worth showing" rather than "we asked and
                          got nothing back". */}
                      {verdict.transient && (
                        <Hint
                          text={`${verdict.transient.mode} did not come back: ${verdict.transient.error}`}
                        >
                          <button className="rm-retry" onClick={() => void refreshTravel()}>
                            ↻
                          </button>
                        </Hint>
                      )}
                      {/* One button per row rather than per mode: the map is the same place
                          whichever way you'd travel, and it picks the mode you last looked at. */}
                      <MapsButton postcode={listing.postcode} place={place} />
                    </>
                  ) : verdict.transient ? (
                    <Hint text={`TfL did not answer: ${verdict.transient.error}`}>
                      <button className="rm-retry" onClick={() => void refreshTravel()}>
                        ↻ TfL failed — retry
                      </button>
                    </Hint>
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
      </Section>


      {/* The budget, before it bites. A warning here rather than only in the shortlist because
          this is the surface you are on when the next analysis would be the one refused. */}
      <SpendWarning summary={spend} />

      {error && <div className="rm-error">{error}</div>}

      <Toasts toasts={toasts} dismiss={dismiss} />

      {/* Sticky rather than sitting at the top: the verdict needs to be reachable from anywhere
          in the panel, and above the address it competed with the thing being judged. */}
      <div className="rm-decide">
        {/* The model's guess from your past verdicts, beside the buttons that settle it. A hint,
            not a verdict — it orders a sweep's worth of listings; you still decide this one. */}
        {modelScore !== null && (
          <div className="rm-score">
            <ScoreBadge score={modelScore} />
          </div>
        )}
        {/* Whose opinion this is, above the buttons that would replace it. */}
        <VerdictLine verdict={verdict} />
        <RatingButtons value={verdict?.rating} pending={pending} onRate={(r) => void rate(r)} />
        {/* The funnel, under the rating and separate from it. It appears the moment a place is
            liked — that is what puts it there — and never before: a place nobody has judged has
            nothing to move along, and offering the steps first would invite skipping the judgement
            the whole shortlist is ordered by. */}
        {funnelled && (
          <>
            <StageLine stage={stage} />
            <StagePicker
              stage={stage}
              pending={stagePending}
              onSet={(next, reason) => void moveStage(next, reason)}
            />
          </>
        )}
        <NoteEditor
          note={note}
          author={verdict?.person ?? null}
          setNote={setNote}
          save={(text) => verdict && void rate(verdict.rating, text)}
        />
        {/* The page said this is off the market and it is rated love/maybe, so we asked rather than
            withdrawing that judgement from the model behind your back. */}
        {confirmOffMarket && (
          <div className="rm-offmarket-confirm">
            <span>
              This listing looks off the market. Mark it off — kept in your shortlist, just withheld
              from the score?
            </span>
            <div className="rm-offmarket-confirm-actions">
              <button
                type="button"
                onClick={() => {
                  setConfirmOffMarket(false);
                  void toggleOffMarket(true);
                }}
              >
                Mark off
              </button>
              <button type="button" onClick={() => setConfirmOffMarket(false)}>
                Keep on
              </button>
            </div>
          </div>
        )}
        {/* Same control, and same rules for when it shows, as the website card — one renderer in
            packages/ui. Offered only where there is a positive verdict to withhold, or where it is
            already off. */}
        <OffMarketRow
          isOff={offMarket}
          canGoOffMarket={mood === 'love' || mood === 'maybe'}
          onToggle={(next) => void toggleOffMarket(next)}
          busy={offMarketBusy}
        />
      </div>
    </div>
  );
}

/** A note is the exception, not the rule — most places get a rating and nothing else. So an
 *  empty note is a button rather than an always-open textarea eating a third of the panel, and
 *  an existing note reads as text until you click it. */
/** Was focus taken by one of the rating buttons? Those save the note themselves. */
function isRatingButton(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('.rm-ratings') !== null;
}

function NoteEditor({
  note,
  author,
  setNote,
  save,
}: {
  note: string;
  /** Who last wrote this note — the project's, not yours. Null when there is no verdict yet. */
  author: string | null;
  setNote: (value: string) => void;
  save: (text: string) => void;
}) {
  const [editing, setEditing] = useState(false);

  if (editing) {
    return (
      <textarea
        className="rm-note"
        value={note}
        placeholder="Note…"
        rows={2}
        autoFocus
        onChange={(e) => setNote(e.target.value)}
        onBlur={(e) => {
          setEditing(false);
          // Blur fires before the click that caused it. Leaving the note to click "Exciting"
          // would fire a save at the OLD rating with the new note, racing the save the click is
          // about to fire at the new one — and whichever reply landed second won, so the verdict
          // could end up back on "Maybe" after you plainly clicked "Exciting". The rating button
          // saves the note itself, so there is nothing to do here.
          if (isRatingButton(e.relatedTarget)) return;
          save(e.target.value);
        }}
      />
    );
  }

  if (note.trim() === '') {
    return (
      <button className="rm-chip rm-chip-action rm-note-add" onClick={() => setEditing(true)}>
        ✎ Add note
      </button>
    );
  }

  return (
    <button className="rm-note-text" onClick={() => setEditing(true)} title="Click to edit">
      {author ? `${author}: ` : ''}
      {note}
    </button>
  );
}

/** Why there are no photo findings, in words. Four different reasons, and conflating them is how
 *  a listing looks unassessable when it is merely queued, or looks queued forever when the budget
 *  ran out a week ago. The blank this replaces read as "there is nothing to say about this flat". */
function AnalysisState({
  request,
  pending,
  photos,
  retry,
}: {
  request: AnalysisRequest | null;
  pending: boolean;
  photos: number;
  retry: () => void;
}) {
  if (request?.status === 'capped') return <CappedNotice capped={request} />;

  if (request?.status === 'failed') {
    return (
      <span className="rm-claim">
        <Hint className="rm-bad" text={`The analyse function refused: ${request.message}`}>
          {FLAG_ICON.yellow} photos not analysed
        </Hint>
        <button className="rm-retry" onClick={retry}>
          ↻
        </button>
      </span>
    );
  }

  if (pending) {
    return (
      <Hint
        className="rm-dim rm-working"
        text={`Reading ${photos} photos to work out room sizes, outdoor space and whether there's a bath.`}
      >
        reading photos…
      </Hint>
    );
  }

  // Asked for, claimed by somebody, and still not here after a minute of polling. Not an error —
  // but not silence either, because "no bathtub row" and "we never found out" look identical.
  return (
    <span className="rm-claim">
      <Hint
        className="rm-dim"
        text="The analysis was requested but hasn't come back yet. Reload in a minute, or ask again."
      >
        photos not analysed yet
      </Hint>
      <button className="rm-retry" onClick={retry}>
        ↻
      </button>
    </span>
  );
}

/** The two judgements from the photos, promoted into the header. They only appear when they say
 *  something — a room that is neither small nor big, and ordinary outdoor space, are not news. */
function RoomFact({ analysis }: { analysis: Analysis | null }) {
  const size = analysis?.biggestRoomSqft;
  if (!analysis || size === null || size === undefined) return null;

  const small = size < BIGGEST_ROOM_SMALL_SQFT;
  const big = size > BIGGEST_ROOM_BIG_SQFT;
  if (!small && !big) return null;

  const room = analysis.biggestRoomLabel ?? 'Biggest room';
  return (
    <span className="rm-claim">
      <Hint
        // Amber, not red. A main room slightly under target is a reservation you settle by standing
      // in it; red is reserved for the things that mean don't bother viewing at all — no bath,
      // nowhere to sit outside. See the severity table in facts.ts.
      className={small ? 'rm-flag-yellow' : 'rm-good'}
        text={`${room} — ${sqft(size)}. Small is under ${BIGGEST_ROOM_SMALL_SQFT} sq ft.`}
      >
        {small ? `${FLAG_ICON.yellow} ` : '⭐ '}
        {claimLabel(small ? 'rooms-small' : 'rooms-big', analysis.biggestRoomConfidence)}
      </Hint>
      {/* Outside the Hint, not inside it: the dotted hover underline would otherwise run under
          the rings and read as part of the drawing. */}
      <Confidence level={analysis.biggestRoomConfidence} />
    </span>
  );
}

function OutdoorFact({ analysis }: { analysis: Analysis | null }) {
  if (!analysis || analysis.hasOutdoorSpace === null) return null;

  const area = analysis.outdoorSqft;
  const tiny = analysis.hasOutdoorSpace && area !== null && area < OUTDOOR_MINIMUM_SQFT;
  const none = !analysis.hasOutdoorSpace;
  const detail = [
    analysis.outdoorKind ?? null,
    area !== null ? `${analysis.outdoorIsEstimate ? 'about ' : ''}${sqft(area)}` : null,
  ]
    .filter(Boolean)
    .join(', ');

  if (!none && !tiny) {
    return (
      <span className="rm-claim">
        <Hint
          text={`${detail || 'Outdoor space'}.${analysis.outdoorIsEstimate ? ' Size estimated from the photos.' : ''}`}
        >
          🌿 {detail || 'outdoor space'}
        </Hint>
        <Confidence level={analysis.outdoorConfidence} />
      </span>
    );
  }

  return (
    <span className="rm-claim">
      <Hint
        className="rm-bad"
        text={
          none
            ? 'No outdoor space in any photo.'
            : `Only ${detail} — under ${OUTDOOR_MINIMUM_SQFT} sq ft is too small to sit out in.`
        }
      >
        {none
          ? `${FLAG_ICON.red} ${claimLabel('outdoor-absent', analysis.outdoorConfidence)}`
          : `${FLAG_ICON.red} ${detail}`}
      </Hint>
      <Confidence level={analysis.outdoorConfidence} />
    </span>
  );
}

function Section({
  title,
  note,
  children,
}: {
  title: string;
  /** A caveat that belongs to every row under the heading rather than to any one of them. It sits
   *  *in* the heading: as a paragraph above the rows it was the biggest thing in the section and
   *  pushed the numbers down the panel, which is backwards for something you need once. */
  note?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="rm-section">
      <h4>
        {title}
        {note && <span className="rm-section-note">{note}</span>}
      </h4>
      {children}
    </section>
  );
}

/** One number, marked when the sources disagree. The mark is a dotted underline and a "*", and
 *  the explanation is the tooltip — see `explainReading`. */
function Fact({
  reading,
  format,
  children,
}: {
  reading: Reading;
  format: (n: number) => string;
  children: React.ReactNode;
}) {
  // Only mark it when the sources actually disagree. "2 bed — from the listing" is not worth an
  // underline, and marking everything is the same as marking nothing.
  if (reading.conflicts.length === 0) return <>{children}</>;
  return (
    <Hint text={explainReading(reading, format)} className="rm-approx">
      {children}*
    </Hint>
  );
}

/** Bed and bath counts. Rightmove's own figure leads — it is what the agent filled in and what
 *  the search filtered on — and the count the model read off the floorplan is the check on it.
 *  Any difference at all is a real disagreement here, so the tolerance is zero. */
function CountFact({
  icon,
  word,
  listed,
  seen,
}: {
  icon: string;
  word: string;
  listed: number | null;
  seen: number | null | undefined;
}) {
  const reading = resolveReading([
    { source: 'listing', value: listed },
    { source: 'floorplan and photos', value: seen },
  ]);
  if (!reading) return null;
  return (
    <Fact reading={reading} format={(n) => `${n} ${word}`}>
      {icon} {reading.value} {word}
    </Fact>
  );
}

/** A bath is a thing this search wants and a shower-only flat is a reason to skip a viewing, so its
 *  absence is stated in red rather than left as a row you have to go looking for. */
function BathtubFact({ analysis }: { analysis: Analysis | null }) {
  if (!analysis || analysis.hasBathtub === null) return null;
  if (analysis.hasBathtub) {
    return (
      <span className="rm-claim">
        <Hint text="Bathtub seen in the photos.">
          🛁 {claimLabel('bathtub-present', analysis.bathtubConfidence)}
        </Hint>
        <Confidence level={analysis.bathtubConfidence} />
      </span>
    );
  }
  return (
    <span className="rm-claim">
      <Hint
        className="rm-bad"
        text="No bathtub in any photo or on the floorplan."
      >
        {FLAG_ICON.red} {claimLabel('bathtub-absent', analysis.bathtubConfidence)}
      </Hint>
      <Confidence level={analysis.bathtubConfidence} />
    </span>
  );
}

function CopyablePostcode({ postcode }: { postcode: string | null }) {
  const [copied, setCopied] = useState(false);
  if (!postcode) return <span className="rm-chip rm-dim">No postcode</span>;

  return (
    <button
      className="rm-chip rm-chip-action"
      title="Copy postcode"
      onClick={() => {
        void navigator.clipboard.writeText(postcode).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        });
      }}
    >
      📍 {postcode} {copied ? '✓' : '⧉'}
    </button>
  );
}

/** Floorplan presence is a decision input in its own right — a listing with no plan is one you
 *  cannot judge on size — so absence is stated loudly rather than left as a missing button. */
/** The photos, over Rightmove's own page.
 *
 *  Rightmove's gallery is a full-page route change: you leave the listing, flick through, and come
 *  back to a page that has scrolled somewhere else. This is the same overlay the shortlist uses,
 *  so a set of photos looks and behaves the same whichever side you are looking from, and the
 *  panel stays where it was underneath. */
function PhotosChip({ listing, onOpen }: { listing: Listing; onOpen: () => void }) {
  const count = listing.imageUrls.length;
  const plan = listing.floorplans.length > 0;
  if (count === 0) return null;
  return (
    <Hint
      underline={false}
      text={
        plan
          ? 'Flick through without leaving the page. The floorplan is first.'
          : 'Flick through the photos without leaving the page.'
      }
    >
      <button className="rm-chip rm-chip-action" onClick={onOpen}>
        🖼 Photos <span className="rm-dim">{count}</span>
      </button>
    </Hint>
  );
}

function FloorplanChip({
  listing,
  analysis,
  pending,
}: {
  listing: Listing;
  analysis: Analysis | null;
  pending: boolean;
}) {
  // Three distinct states, and conflating them is how a place looks assessed when it isn't:
  // there is no plan, there is a plan we could not read, or there is a plan we read.
  const published = listing.floorplans[0];
  const unreadable = analysis?.hasFloorplan === true && analysis.floorplanLegible === false;

  // A readable published floorplan gets no chip at all any more: it is the first image in the
  // gallery beside it, so the button was a second way to open the same picture — in a new tab,
  // which is the worse of the two. What is left here is only ever a warning.
  if (published && !unreadable) return null;
  if (published) {
    return (
      <Hint text="Floorplan unreadable — everything below comes from the photos alone. Open the photos and check.">
        <span className="rm-chip rm-chip-warn">⚠️ Floorplan unreadable</span>
      </Hint>
    );
  }
  if (analysis?.hasFloorplan) {
    return (
      <Hint
        underline={false}
        text={
          unreadable
            ? 'Floorplan unreadable — nothing has been taken from it.'
            : 'No published floorplan, but there is one in the photo gallery.'
        }
      >
        <span className={unreadable ? 'rm-chip rm-chip-warn' : 'rm-chip'}>
          {unreadable ? '⚠️ Floorplan unreadable' : '📐 Floorplan in the photos'}
        </span>
      </Hint>
    );
  }
  if (pending) return <span className="rm-chip rm-dim rm-working">📐 checking…</span>;
  return (
    <Hint text="No floorplan anywhere in this listing.">
      <span className="rm-chip rm-chip-warn">⚠️ No floorplan</span>
    </Hint>
  );
}










