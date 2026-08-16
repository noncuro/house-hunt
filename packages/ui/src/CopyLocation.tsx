import { useState } from 'react';
import { Icon } from './Icon';
import './copylocation.css';

/** Where the flat is, in a form you can paste somewhere else.
 *
 *  Every view here answers "how far is it" and none of them answer "show me". That question gets
 *  asked in Google Maps, or in a message to whoever is coming to the viewing, and both want the
 *  location as text rather than as a pin on our map.
 *
 *  The postcode where there is one, because it is what a person recognises and what every travel
 *  time here is routed from. Coordinates only where there is not: Rightmove hides the postcode on
 *  some listings, and `lat,lon` is a location every map accepts even if nobody can read it. Five
 *  decimal places is about a metre, which is finer than the pin it came from.
 *
 *  Never both. Two things to copy is a choice to make about a thing that has one answer. */
export function CopyLocation({
  postcode,
  point,
}: {
  postcode: string | null;
  point: { lat: number; lon: number } | null;
}) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const value = postcode?.trim() || (point ? `${point.lat.toFixed(5)},${point.lon.toFixed(5)}` : null);
  if (!value) return <span className="rm-copy rm-dim">No location on this listing</span>;

  return (
    <button
      type="button"
      className="rm-copy"
      title={postcode ? 'Copy the postcode' : 'Copy the coordinates'}
      onClick={() => {
        // Said out loud when it does not work, and left saying it. The clipboard needs a focused
        // document and a secure context, and a panel injected into somebody else's page is exactly
        // where one of those goes missing. A button that silently does nothing is worse than one
        // that admits it, because what you paste afterwards is whatever was in the clipboard
        // before — the last thing copied, pasted into a message as if it were an address.
        //
        // All three ways it can go wrong say the same thing: no clipboard object at all (an
        // insecure context does not get one), a synchronous throw out of `writeText`, and the
        // rejected promise. The first two would otherwise be an exception nobody catches and a
        // button that appears to have done nothing.
        try {
          void navigator.clipboard.writeText(value).then(
            () => {
              setState('copied');
              setTimeout(() => setState('idle'), 1600);
            },
            () => setState('failed'),
          );
        } catch {
          setState('failed');
        }
      }}
    >
      <Icon name="pin" size={12} /> <span className="rm-copy-value">{value}</span>{' '}
      {state === 'failed' ? (
        <span className="rm-copy-failed">not copied — select it instead</span>
      ) : (
        <Icon name={state === 'copied' ? 'tick' : 'twin'} size={12} label={state === 'copied' ? 'Copied' : 'Copy'} />
      )}
    </button>
  );
}
