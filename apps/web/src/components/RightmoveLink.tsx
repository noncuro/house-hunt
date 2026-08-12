'use client';

/** The way back out to the original listing, worded in one place.
 *
 *  Clicking a flat used to mean leaving: the address was the Rightmove link in the compare table,
 *  in the triage table and on every card, so the most obvious click on the pile you are working
 *  through took you off the site and away from the verdict you were about to give. The address now
 *  opens what this app knows about the place and Rightmove is this, explicit and secondary — the
 *  listing's own photos, its agent and its "book a viewing" are still a click away, they are just
 *  no longer what "open" means.
 *
 *  The click is stopped from travelling upward because in triage the row underneath it is a tick
 *  box, and following a link and rating the flat you were reading are not the same intention. */
export function RightmoveLink({ url }: { url: string }) {
  return (
    <a
      className="rightmove-link"
      href={url}
      target="_blank"
      rel="noopener"
      onClick={(event) => event.stopPropagation()}
    >
      Open on Rightmove ↗
    </a>
  );
}
