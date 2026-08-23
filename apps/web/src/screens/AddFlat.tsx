'use client';

import { useEffect, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Icon, useOverlayKeys } from '@house-hunt/ui';
import { rightmoveListingId, type AddListingResult } from '@house-hunt/core';
import { addListingByUrl } from '@house-hunt/core/db';
import { keys } from '@/lib/queries';
import { useCanHoldExtension } from '@/lib/platform';

/** Add a flat by its address, for the half of the hunt that has no extension.
 *
 *  Everything else in this app arrives from a content script standing on the listing. A phone has no
 *  content script — Chrome for Android loads no extensions and iOS loads no Chrome extensions at
 *  all — so without this, the phone is a viewer of what somebody else added from a laptop, and
 *  "found a flat on the train" has nowhere to go.
 *
 *  Paste, or share. The paste is this field; the share is the same code reached from the app's share
 *  target, so the Rightmove app's own Share button lists this hunt and the flat lands here with
 *  nothing typed. Both end at `addListingByUrl`, which ends at `record_property` — the same row the
 *  extension writes, so a flat added from a phone is not a second-class one.
 *
 *  It says the id back before it does anything. That is the whole of the input validation a reader
 *  can act on: a search page, an agent's own site and a half-copied link are the three things people
 *  actually paste, and "that is not a listing address" the moment the paste lands beats the same
 *  sentence after a round trip.
 */
export function AddFlat({
  onClose,
  onAdded,
  initialUrl = '',
}: {
  onClose: () => void;
  /** The flat is in the hunt — open it. Called for one already here too: the reader asked for this
   *  flat, and "you already have it" with no way to look at it is a dead end.
   *
   *  Takes the address as well as the id because the caller shuts this dialog on it, and the
   *  "Added …" line below goes with it: without something naming the flat on the way out, a paste
   *  that worked and a paste that opened nothing look the same. */
  onAdded: (rightmoveId: string, displayAddress: string) => void;
  /** Pre-filled from the share target, so a shared link needs one press rather than a paste. */
  initialUrl?: string;
}) {
  const client = useQueryClient();
  const extensionPossible = useCanHoldExtension();
  const [url, setUrl] = useState(initialUrl);
  const [result, setResult] = useState<AddListingResult | null>(null);
  const field = useRef<HTMLInputElement>(null);

  useOverlayKeys({ Escape: onClose });
  useEffect(() => field.current?.focus(), []);

  const add = useMutation({
    mutationFn: (address: string) => addListingByUrl(address),
    onSuccess: async (outcome) => {
      setResult(outcome);
      if (outcome.status !== 'added') return;
      // The list, not the whole cache: what changed is which flats this hunt holds.
      await client.invalidateQueries({ queryKey: keys.shortlist });
      onAdded(outcome.rightmoveId, outcome.displayAddress);
    },
    // Never silently: a paste that went nowhere with the field still full looks like a slow network,
    // and the reader pastes it again.
    onError: (e: Error) => setResult({ status: 'failed', message: e.message }),
  });

  // Read here as well as on the server, and only ever to say no sooner — see `addListingByUrl`.
  const id = rightmoveListingId(url);
  const typed = url.trim().length > 0;

  return (
    <div className="sheet" data-testid="add-flat">
      <button type="button" className="sheet-behind" aria-label="Close" onClick={onClose} />
      <div className="panel panel-narrow" role="dialog" aria-modal="true" aria-label="Add a flat">
        <div className="panel-bar">
          <span className="panel-where">Add a flat</span>
          <button type="button" className="key" onClick={onClose} data-testid="add-flat-close">
            <Icon name="close" size={12} /> Close
          </button>
        </div>

        <div className="panel-body addflat">
          <p className="dim">
            Paste a Rightmove listing address. We read that one page, the same as the panel does on a
            laptop — the photographs, the floorplan and the postcode all come from it.
          </p>

          <div className="fields">
            <input
              ref={field}
              type="url"
              inputMode="url"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              placeholder="https://www.rightmove.co.uk/properties/…"
              value={url}
              data-testid="add-flat-url"
              onChange={(e) => {
                setUrl(e.target.value);
                setResult(null);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && id && !add.isPending) add.mutate(url);
              }}
            />
            <button
              type="button"
              className="primary"
              disabled={!id || add.isPending}
              data-testid="add-flat-go"
              onClick={() => add.mutate(url)}
            >
              {add.isPending ? 'Reading…' : 'Add it'}
            </button>
          </div>

          {/* Said before the button is pressed, not after. */}
          {typed && !id && (
            <p className="error" data-testid="add-flat-not-a-listing">
              That is not a Rightmove listing address. One looks like{' '}
              <code>rightmove.co.uk/properties/88023648</code> — a search page or an agent&apos;s own
              site will not do, because the flat&apos;s details are on the listing page itself.
            </p>
          )}
          {id && !add.isPending && !result && <p className="dim">Listing {id}.</p>}

          {result && <Outcome result={result} onOpen={onAdded} />}

          {extensionPossible && (
            // Not an upsell, and only where it is possible: somebody pasting one address at a time
            // on a laptop is doing by hand the thing the panel does by itself, and nothing else on
            // this screen would ever tell them so.
            <p className="dim addflat-aside">
              On this computer the extension can do this for you — open a listing on Rightmove and
              the panel records it as you look at it.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

/** Five answers, each said as itself. Four of them are not faults, and dressing them up as one
 *  ("could not add that flat") is how the two that mean something — a listing that is gone, and a
 *  page we could no longer decode — stop being read. */
function Outcome({
  result,
  onOpen,
}: {
  result: AddListingResult;
  onOpen: (rightmoveId: string, displayAddress: string) => void;
}) {
  switch (result.status) {
    case 'added':
      // Never drawn: the caller shuts this dialog on `onAdded` and opens the flat itself, which is
      // a better answer than a sentence about it. An arm rather than a `default`, so a sixth
      // outcome added to the union fails the typecheck here instead of silently saying nothing.
      return null;
    case 'already-here':
      return (
        <p className="notice notice-quiet" data-testid="add-flat-already">
          {result.displayAddress} is already in this hunt.{' '}
          <button className="key" onClick={() => onOpen(result.rightmoveId, result.displayAddress)}>
            Open it
          </button>
        </p>
      );
    case 'withdrawn':
      return (
        <p className="notice notice-warn" data-testid="add-flat-withdrawn">
          The agent has taken that listing down, so there is nothing left to read. Nothing was added.
        </p>
      );
    case 'rate-limited':
      return (
        <p className="notice notice-warn">
          That is {result.used} listings read in the last hour, which is the limit ({result.limit}).
          It clears within the hour.
        </p>
      );
    case 'not-a-listing':
      return <p className="error">That is not a Rightmove listing address.</p>;
    case 'failed':
      return (
        <p className="error" data-testid="add-flat-failed">
          {result.message}
        </p>
      );
  }
}
