'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { keys as shellKeys, useAuth, useProjectSettings, useSetProjectSettings } from '@/lib/queries';
import { Hint, Icon, TRANSIT_BASIS_NOTE, type IconName } from '@house-hunt/ui';
import '@/app/hunt.css';
import { attempt } from '@/lib/attempt';
import {
  addPlace as addPlaceRow,
  listHubSweeps,
  removePlace as removePlaceRow,
  resolveLocation,
  updatePlace,
} from '@house-hunt/core/db';
import {
  authState,
  createInvite,
  headcount as readHeadcount,
  leaveProject,
  listInvites,
  listMembers,
  resendInvite,
  revokeInvite,
  setActiveProject,
} from '@house-hunt/core/db';
import {
  AMENITIES,
  SWEEP_RADII,
  SWEEP_WINDOWS,
  criteriaFromUrl,
  describeCriteria,
  distanceMiles,
} from '@house-hunt/core';
import type {
  AmenityKey,
  AmenityWant,
  AuthState,
  Headcount,
  HuntPreferences,
  Invite,
  InviteResult,
  LocationResult,
  Place,
  PlacePatch,
  ProjectSummary,
  SweepCriteria,
} from '@house-hunt/core';

/** The house hunt you are in: who else is in it, who has been asked, and which one you are looking
 *  at when you are in more than one.
 *
 *  Everything here is a question about the *active* project, which is why the view starts from
 *  `auth:state` rather than from a project id handed in: the shell would otherwise have to hold
 *  the same answer and the two could disagree about which hunt you are reading. Signed-out and
 *  signed-in-with-no-project are both rendered here as their own states (design D13) rather than
 *  as an empty page — an empty project view reads as a project with nobody in it. */

/** Keyed per project rather than per view: switching hunts must not serve the last one's members
 *  out of the cache for the frame before the refetch lands. `shellKeys.auth` is the shell's own
 *  key, reused rather than restated — two spellings of "who is signed in" is two answers. */
const keys = {
  members: (projectId: string) => ['project-members', projectId] as const,
  headcount: (projectId: string) => ['project-headcount', projectId] as const,
  invites: (projectId: string) => ['project-invites', projectId] as const,
};

type Notify = (text: string, kind?: 'error' | 'info') => void;

export function Project({
  notify,
  places,
  setPlaces,
}: {
  notify: Notify;
  places: Place[];
  setPlaces: (update: (current: Place[]) => Place[]) => void;
}) {
  const auth = useAuth();

  if (auth.isPending) return <p className="working">Working…</p>;
  if (auth.isError) return <p className="error">{(auth.error as Error).message}</p>;
  if (auth.data.status === 'signed-out') {
    return <p className="dim">Not signed in — sign in to see the house hunt you are part of.</p>;
  }

  const { projects, activeProject } = auth.data;

  // Signed in with no active project is a real state, not a gap: it is where you are between an
  // invite being consumed and a hunt being chosen. Show the picker rather than a project view
  // with every field blank.
  if (!activeProject) return <ProjectPicker />;

  return (
    <div className="settings">
      <HuntSettings notify={notify} />
      {/* Where, straight after what: a search is filters plus somewhere to point them at, and the
          two were a page apart. This list sat under Settings beside the display name as though it
          were one person's own, while `place` has always been a project table. */}
      <Places places={places} setPlaces={setPlaces} notify={notify} />
      <SearchCriteria notify={notify} />
      <Members projectId={activeProject.id} />
      {/* Keyed on the project so switching hunts starts the invite form empty. Without it the
          sentence under the field — "they are already in this hunt" — would still be on screen,
          now describing a different hunt. */}
      <Invites key={activeProject.id} project={activeProject} notify={notify} />
      <YourProjects projects={projects} activeId={activeProject.id} />
    </div>
  );
}

/** What this hunt is looking for — a great-room bar and the must-have/nice-to-have amenities.
 *
 *  Shared by the whole hunt, like a verdict: anyone in the project can adjust it, and realtime keeps
 *  it in step across laptops. It changes how flats are *flagged* on the shortlist and compare table
 *  (a missing must-have goes red, a missing nice-to-have amber) and where the great-room mark sits —
 *  it never filters anything out. Every control saves on change; there is no Save button, because a
 *  preference you set and forgot to save is a preference that silently did nothing. */
/** Offered as the great-room bar when it is first switched on — a sensible "large reception room"
 *  size, and the same number `BIGGEST_ROOM_SMALL_SQFT` uses for the other end of the scale. The
 *  range is what a bar could sensibly be: below the small-room mark it stops meaning "great", and a
 *  four-figure single room is a typo. Enforced on save, not just as input attributes, which a typed
 *  value slips past. */
const DEFAULT_GREAT_ROOM_SQFT = 450;
const GREAT_ROOM_MIN_SQFT = 100;
const GREAT_ROOM_MAX_SQFT = 2000;

/** The whole-flat bar, same shape. Defaults to a comfortable one-bedroom and ranges from a studio
 *  to a house — wider than the room bar because it is measuring a different thing. */
const DEFAULT_MIN_SQFT = 600;

const MIN_SQFT_FLOOR = 150;
const MIN_SQFT_CEILING = 5000;

/** The one control this page speaks in: a label on the left, the answers on the right, the chosen
 *  one filled.
 *
 *  Every preference here is the same question — how much does this hunt care — and it was being
 *  asked in two different grammars in the same section: a checkbox with a number for the two size
 *  bars, a segmented group for the six amenities. Two grammars for one question reads as two kinds
 *  of setting, so somebody sets one and assumes the other works differently. The groups are
 *  right-aligned rather than left so the chosen segment lines up down the section and the shape of
 *  the answers is readable without reading any of them. */
function Segments<T>({
  label,
  choices,
  value,
  busy,
  onPick,
}: {
  label: string;
  choices: { value: T; label: string }[];
  value: T;
  busy: boolean;
  onPick: (value: T) => void;
}) {
  return (
    <div className="hunt-seg" role="group" aria-label={label}>
      {choices.map((choice) => (
        <button
          key={choice.label}
          type="button"
          className={choice.value === value ? 'hunt-seg-pick hunt-seg-on' : 'hunt-seg-pick'}
          aria-pressed={choice.value === value}
          disabled={busy}
          onClick={() => onPick(choice.value)}
        >
          {choice.label}
        </button>
      ))}
    </div>
  );
}

/** The first sentence, and the rest only if you ask for it.
 *
 *  Each section here opened with a paragraph about itself before showing a single control, and the
 *  paragraphs earn their place — they are what say that a preference flags rather than filters, and
 *  why a pasted URL beats a form. What they cannot do is stand between somebody and the thing they
 *  came to change, five lines at a time, on every visit. */
function Explainer({ lead, children }: { lead: ReactNode; children: ReactNode }) {
  return (
    <>
      <p className="hunt-lead">{lead}</p>
      <details className="hunt-more">
        <summary>
          How this works
          <Icon name="chevron" size={12} className="hunt-more-mark" />
        </summary>
        <div className="hunt-more-body">{children}</div>
      </details>
    </>
  );
}

/** A menu that reads as a sentence: "searching within 1 mi", "window from the last sweep".
 *
 *  A place's row carries two of these and they were bare selects, which put two grey boxes of
 *  browser furniture where the row is meant to say what this place is for. The chevron is drawn
 *  rather than the platform's own because a select showing its own arrow cannot be made to sit
 *  inside a pill. */
function Pill({
  label,
  title,
  value,
  faint,
  disabled,
  onPick,
  children,
}: {
  label: string;
  title: string;
  value: string;
  /** The off state — a place nobody is searching around says so quietly. */
  faint?: boolean;
  disabled?: boolean;
  onPick: (value: string) => void;
  children: ReactNode;
}) {
  return (
    <span className="hunt-pill-wrap">
      <select
        className={faint ? 'hunt-pill hunt-pill-off' : 'hunt-pill'}
        aria-label={label}
        title={title}
        value={value}
        disabled={disabled}
        onChange={(e) => onPick(e.target.value)}
      >
        {children}
      </select>
      <Icon name="chevron" size={12} className="hunt-pill-mark" />
    </span>
  );
}

/** A bar in square feet: off, or a number. Off is `null` rather than zero, because "no opinion" and
 *  "zero square feet" are different sentences and only one of them is ever meant.
 *
 *  Two segments, where the amenities below get three, and the asymmetry is honest rather than
 *  sloppy: `flagsFor` decides on its own what an unmet bar looks like. Being under `minSqft` is
 *  always red, and `greatRoomMinSqft` never flags an absence at all — it only moves the bar at
 *  which a room earns the good great-room mark, the small-room amber coming from a constant this
 *  page cannot set. Neither number carries a nice/must, and `HuntPreferences` has nowhere to store
 *  one. A third segment here would therefore claim a setting nothing reads: it would look saved and
 *  change no flag on any flat. So each bar names the severity that is actually in force, and the row
 *  still reads in the same language as the ones under it.
 *
 *  The number is typed into the parent's draft as you go and written once on blur — not one write
 *  per keystroke, which would also fight the disabled-while-saving guard. Clamping happens on blur
 *  too: `min`/`max` on the input do not stop a typed 1 or 30000 from reaching a write. */
function SqftBar({
  label,
  icon,
  onLabel,
  suffix,
  value,
  fallback,
  min,
  max,
  busy,
  onDraft,
  onCommit,
}: {
  label: string;
  icon: IconName;
  /** What setting this bar actually does to a flat that misses it — see the note above. */
  onLabel: string;
  suffix: string;
  value: number | null;
  fallback: number;
  min: number;
  max: number;
  busy: boolean;
  onDraft: (value: number) => void;
  onCommit: (value: number | null) => void;
}) {
  const on = value != null;
  return (
    <div className="hunt-row">
      <span className="hunt-row-label">
        <Icon name={icon} className="hunt-ico hunt-ico-warm" />
        <span>{label}</span>
        {on && (
          <span className="hunt-row-size">
            <input
              type="number"
              // Nothing labels this one but the row it sits in, and a row is not a <label>.
              aria-label={`${label} — ${suffix}`}
              min={min}
              max={max}
              disabled={busy}
              value={value ?? fallback}
              onChange={(e) => {
                const n = Number(e.target.value);
                if (Number.isFinite(n) && n > 0) onDraft(Math.round(n));
              }}
              onBlur={() => onCommit(Math.min(max, Math.max(min, value ?? fallback)))}
            />
            <span className="hunt-unit">{suffix}</span>
          </span>
        )}
      </span>
      <Segments
        label={label}
        value={on}
        busy={busy}
        choices={[
          { value: false, label: "Don't mind" },
          { value: true, label: onLabel },
        ]}
        onPick={(next) => onCommit(next ? fallback : null)}
      />
    </div>
  );
}

/** Shorter than the sentences they replace ("Must have", "Nice to have"), because three of these
 *  sit side by side in one group and the words that differ are the first ones. */
const WANT_CHOICES: { value: AmenityWant | null; label: string }[] = [
  { value: null, label: "Don't mind" },
  { value: 'nice', label: 'Nice' },
  { value: 'must', label: 'Must' },
];

/** The glyph and the hue each amenity wears, keyed off `AMENITIES` rather than restating it — the
 *  list, its names and its flag keys stay in core. The hue says what the icon is a picture of and
 *  never how much it matters; severity is the verdict's colour and belongs to the flags. */
const AMENITY_ICON: Record<AmenityKey, IconName> = {
  outdoor: 'outdoor',
  dishwasher: 'dishwasher',
  bathtub: 'bathtub',
  inUnitLaundry: 'laundry',
  brightLight: 'light',
  billsIncluded: 'bills',
};

const AMENITY_HUE: Record<AmenityKey, 'water' | 'green' | 'warm'> = {
  outdoor: 'green',
  dishwasher: 'water',
  bathtub: 'water',
  inUnitLaundry: 'water',
  brightLight: 'warm',
  billsIncluded: 'warm',
};

function HuntSettings({ notify }: { notify: Notify }) {
  const settings = useProjectSettings();
  const save = useSetProjectSettings();

  // A local draft is the source of truth for edits. Each control builds the next full-object write
  // from THIS, not from the server read, so two quick changes compose onto each other rather than
  // each rebuilding from a `settings.data` that has not refetched yet — which would drop the earlier
  // one. Re-seeded whenever a fresh read lands (another laptop, or our own write coming back).
  const [draft, setDraft] = useState<HuntPreferences | null>(settings.data ?? null);
  useEffect(() => {
    if (settings.data) setDraft(settings.data);
  }, [settings.data]);

  // Full-object writes go one at a time — the mutation stays disabled while one is in flight — so
  // two replacements cannot land out of order and restore a stale set. The local draft still updates
  // immediately, so the controls stay responsive; only the save waits its turn.
  const commit = (next: HuntPreferences) => {
    setDraft(next);
    save.mutate(next, {
      onError: (e) => notify(`Couldn't save that preference — ${(e as Error).message}`, 'error'),
    });
  };

  if (settings.isError) {
    return (
      <section className="setting">
        <h2 className="hunt-h">What you&rsquo;re looking for</h2>
        <p className="error">Could not read this hunt&rsquo;s preferences.</p>
      </section>
    );
  }
  // No editing until the first read lands — otherwise a partial object would replace whatever is
  // already stored.
  if (!draft) {
    return (
      <section className="setting">
        <h2 className="hunt-h">What you&rsquo;re looking for</h2>
        <p className="working">Working…</p>
      </section>
    );
  }

  const busy = save.isPending;
  const setAmenity = (key: AmenityKey, want: AmenityWant | null) => {
    const amenities = { ...(draft.amenities ?? {}) };
    // "Don't mind" removes the key rather than storing a third value — absent already means that,
    // and one representation of "no preference" cannot disagree with itself.
    if (want) amenities[key] = want;
    else delete amenities[key];
    commit({ ...draft, amenities });
  };

  return (
    <section className="setting">
      <h2 className="hunt-h">What you&rsquo;re looking for</h2>
      <Explainer lead="Shared by the whole hunt.">
        These change how flats are flagged on the shortlist and compare table — a must-have
        you&rsquo;re missing shows red, a nice-to-have amber — and set the bars for how big a flat
        and how big its main room have to be. Nothing here hides a flat; it only changes the
        emphasis. They reach the listing panel on Rightmove too.
      </Explainer>

      <div className="hunt-rows">
        {/* Two bars, one control. They are the same interaction down to the clamp-on-blur — an
            answer that turns a number on — and writing it twice is how the second one ends up
            without the clamp. What differs is only what missing the bar does to a flat, which is
            the word on the filled segment. */}
        <SqftBar
          label="Has a great room"
          icon="room"
          // Not "Must": missing this bar flags nothing. It moves where the good great-room mark
          // starts, and that is the whole of what setting it does.
          onLabel="Mark it"
          suffix="sq ft or bigger"
          value={draft.greatRoomMinSqft ?? null}
          fallback={DEFAULT_GREAT_ROOM_SQFT}
          min={GREAT_ROOM_MIN_SQFT}
          max={GREAT_ROOM_MAX_SQFT}
          busy={busy}
          onDraft={(v) => setDraft({ ...draft, greatRoomMinSqft: v })}
          onCommit={(v) => commit({ ...draft, greatRoomMinSqft: v })}
        />

        <SqftBar
          label="Big enough overall"
          icon="size"
          // Under this bar is red in `flagsFor`, with no amber reading available — which is exactly
          // what a must-have amenity does, so it wears the same word.
          onLabel="Must"
          suffix="sq ft or bigger"
          value={draft.minSqft ?? null}
          fallback={DEFAULT_MIN_SQFT}
          min={MIN_SQFT_FLOOR}
          max={MIN_SQFT_CEILING}
          busy={busy}
          onDraft={(v) => setDraft({ ...draft, minSqft: v })}
          onCommit={(v) => commit({ ...draft, minSqft: v })}
        />

        {/* From `AMENITIES` in core rather than a list of its own: this page, the flags and
            triage's filters all ask what a flat has, and three copies of the list is three chances
            to disagree about what "in-unit laundry" means. */}
        {AMENITIES.map(({ key, name }) => (
          <div className="hunt-row" key={key}>
            <span className="hunt-row-label">
              <Icon name={AMENITY_ICON[key]} className={`hunt-ico hunt-ico-${AMENITY_HUE[key]}`} />
              <span>{name}</span>
            </span>
            <Segments
              label={name}
              choices={WANT_CHOICES}
              value={draft.amenities?.[key] ?? null}
              busy={busy}
              onPick={(want) => setAmenity(key, want)}
            />
          </div>
        ))}
      </div>
    </section>
  );
}

/** What a signed-in user with no active project sees, and the same list the project view uses to
 *  switch. Exported because the shell mounts it directly on `isNoProject` (design D13), where
 *  there is no toast host — which is why nothing down this path reports through `notify`. */
export function ProjectPicker() {
  const auth = useAuth();

  if (auth.isPending) return <p className="working">Working…</p>;
  if (auth.isError) return <p className="error">{(auth.error as Error).message}</p>;
  if (auth.data.status === 'signed-out') {
    return <p className="dim">Not signed in — sign in to see the house hunt you are part of.</p>;
  }

  const { projects, activeProject } = auth.data;

  return (
    <div className="settings">
      <section className="setting">
        <h2 className="hunt-h">Which house hunt</h2>
        {projects.length === 0 ? (
          // Not an error and not a loading state: an account exists only because somebody invited
          // it, and consuming that invite is what produces the first project. Say which of those
          // has not happened rather than showing an empty list.
          <p className="dim">
            You are signed in but not in a house hunt yet. Whoever invited you can add you to
            theirs, and it appears here once they do.
          </p>
        ) : (
          <>
            <p className="dim">
              Everything the extension shows — the shortlist, the panels, the search badges — is
              about one hunt at a time. Pick the one you are working on.
            </p>
            <ProjectRows projects={projects} activeId={activeProject?.id ?? null} />
          </>
        )}
      </section>
    </div>
  );
}

function Members({ projectId }: { projectId: string }) {
  const members = useQuery({
    queryKey: keys.members(projectId),
    queryFn: () => listMembers(projectId),
  });

  return (
    <section className="setting">
      <h2 className="hunt-h">Who is in it</h2>
      {members.isPending && <p className="working">Working…</p>}
      {members.isError && <p className="error">{(members.error as Error).message}</p>}
      {(members.data ?? []).map((m) => (
        <div className="place" key={m.userId}>
          <span>
            {m.displayName}
            {m.isYou && <span className="dim"> (you)</span>}{' '}
            {/* Somebody who has never set a name is listed under their address, and the address
                then appeared twice on the row — the same fact, said twice, reads as two people. */}
            {m.displayName !== m.email && <span className="dim">{m.email}</span>}
          </span>
          <span className="dim">{m.role === 'owner' ? 'owner' : 'member'}</span>
        </div>
      ))}
      {members.data?.length === 0 && <p className="dim">Nobody yet.</p>}
    </section>
  );
}

/** Asking someone in, and the ceiling that asking runs into.
 *
 *  Six people per project, counting members *plus* pending invites — otherwise six outstanding
 *  invites all land and the hunt holds twelve. The count is read before the field is submitted
 *  (design D7) so a full project is something you can see rather than something you discover by
 *  typing an address in twice. */
function Invites({ project, notify }: { project: ProjectSummary; notify: Notify }) {
  const client = useQueryClient();
  const [email, setEmail] = useState('');
  const [result, setResult] = useState<InviteResult | null>(null);
  const [showSettled, setShowSettled] = useState(false);

  const headcount = useQuery({
    queryKey: keys.headcount(project.id),
    queryFn: () => readHeadcount(project.id),
  });

  const invites = useQuery({
    queryKey: keys.invites(project.id),
    queryFn: () => listInvites(project.id),
  });

  async function refresh() {
    await Promise.all([
      client.invalidateQueries({ queryKey: keys.headcount(project.id) }),
      client.invalidateQueries({ queryKey: keys.invites(project.id) }),
    ]);
  }

  const create = useMutation({
    mutationFn: async () => await createInvite(email.trim(), project.id),
    onSuccess: async (outcome) => {
      setResult(outcome);
      // Only a real invite clears the field. Every other outcome is about the address that is
      // still in it, and clearing it would leave the sentence underneath pointing at nothing.
      if (outcome.status === 'invited') setEmail('');
      await refresh();
    },
    onError: (e: Error) => notify(`Not invited — ${e.message}`),
  });

  const resend = useMutation({
    mutationFn: async (inviteId: string) => await resendInvite(inviteId),
    onSuccess: async (outcome) => {
      setResult(outcome);
      await refresh();
    },
    onError: (e: Error) => notify(`Not resent — ${e.message}`),
  });

  const revoke = useMutation({
    mutationFn: async (inviteId: string) => await revokeInvite(inviteId),
    onSuccess: async () => {
      notify('Invite revoked.', 'info');
      await refresh();
    },
    onError: (e: Error) => notify(`Not revoked — ${e.message}`),
  });

  const count = headcount.data ?? null;
  const full = count !== null && count.members + count.pending >= count.maxMembers;

  // "Outstanding" is the same thing the headcount means by pending, and it is `inviteIsLive` that
  // says so: `project_headcount` counts `status = 'pending' and expires_at > now()`, so an invite
  // that lapsed holds no place and belongs with the joined and the revoked. One clock reading for
  // the whole partition, so a row cannot fall between the two filters.
  const all = invites.data ?? [];
  const now = Date.now();
  const outstanding = all.filter((invite) => inviteIsLive(invite, now));
  const settled = all.filter((invite) => !inviteIsLive(invite, now));

  return (
    <section className="setting">
      <h2 className="hunt-h">Invite someone</h2>
      <p className="dim">
        {headcount.isPending && 'Counting who is in…'}
        {headcount.isError && 'Could not count who is in — the limit is still enforced when you invite.'}
        {count && <Ceiling count={count} />}
      </p>

      <div className="fields">
        <input
          value={email}
          type="email"
          placeholder="Email address"
          disabled={full}
          onChange={(e) => setEmail(e.target.value)}
        />
        <button
          className="primary"
          disabled={full || create.isPending || !email.trim()}
          onClick={() => create.mutate()}
        >
          Invite
        </button>
      </div>

      {result && <Outcome result={result} />}

      {invites.isPending && <p className="working">Working…</p>}
      {invites.isError && <p className="error">{(invites.error as Error).message}</p>}
      {/* Outstanding first and alone. Every invite ever sent stays in this list, and a project a
          few months old shows the two people still to arrive underneath a dozen who already did —
          the rows that need doing something about, buried in the rows that do not. */}
      {outstanding.map((invite) => (
        <div className="place" key={invite.id}>
          <span>
            {invite.email} <span className="dim">{inviteState(invite)}</span>
          </span>
          <span>
            {/* Resending is the answer to "they lost the code" — it revokes this invite and mints
                a fresh one, which is the only way to get a working code, since the old one is
                stored as a hash and cannot be read back. Offered only while the invite is live: a
                resent expired invite would hand over a code that redeems into nothing. */}
            {inviteIsLive(invite) && (
              <button
                className="key"
                disabled={resend.isPending}
                onClick={() => resend.mutate(invite.id)}
              >
                Resend
              </button>
            )}
            {invite.status === 'pending' && (
              <button
                className="remove"
                title="Revoke"
                disabled={revoke.isPending}
                onClick={() => revoke.mutate(invite.id)}
              >
                ×
              </button>
            )}
          </span>
        </div>
      ))}
      {invites.data?.length === 0 && <p className="dim">Nobody has been asked in yet.</p>}
      {settled.length > 0 && (
        <>
          <button className="key" onClick={() => setShowSettled(!showSettled)}>
            {showSettled
              ? 'Hide finished invites'
              : `Show ${settled.length} finished ${settled.length === 1 ? 'invite' : 'invites'}`}
          </button>
          {showSettled &&
            settled.map((invite) => (
              <div className="place" key={invite.id}>
                <span>
                  {invite.email} <span className="dim">{inviteState(invite)}</span>
                </span>
              </div>
            ))}
        </>
      )}
    </section>
  );
}

/** The headcount, said as the ceiling it is running into rather than as a bare number. */
function Ceiling({ count }: { count: Headcount }) {
  const taken = count.members + count.pending;
  const held = `${count.members} ${count.members === 1 ? 'person' : 'people'}${
    count.pending > 0 ? ` and ${count.pending} pending ${count.pending === 1 ? 'invite' : 'invites'}` : ''
  }`;

  if (taken >= count.maxMembers) {
    return (
      <>
        This hunt is at its limit of {count.maxMembers} people — {held}. A pending invite holds a
        place, so revoking one below makes room. An admin can raise the limit.
      </>
    );
  }
  return (
    <>
      {held}, of a limit of {count.maxMembers}. A pending invite counts toward it, so there
      {count.maxMembers - taken === 1 ? ' is 1 place' : ` are ${count.maxMembers - taken} places`}{' '}
      left.
    </>
  );
}

/** The code, said once, with what to do with it.
 *
 *  **This is the only time the code exists anywhere but the invitee's phone.** Only its hash is
 *  stored, deliberately — every member of a project can read that project's invite rows, and a
 *  plaintext column would put every outstanding code in front of all of them. So this panel is not
 *  a convenience: it is the handover. Losing it is not a disaster, because Resend mints a new one,
 *  and the copy says so rather than letting somebody discover it by scrolling back looking.
 *
 *  Nothing here emails anybody. The code goes by text, or is read out — which is the whole reason
 *  the alphabet has no O, I or L in it. */
function Invited({ result }: { result: Extract<InviteResult, { status: 'invited' }> }) {
  const [copied, setCopied] = useState(false);

  return (
    <div className="notice notice-good invite-code">
      <p>
        Invited <strong>{result.invite.email}</strong>.{' '}
        {result.userExisted
          ? 'They already have an account, so they can just sign in with their own password — the code below is only needed if they have forgotten it and want to start again.'
          : 'Send them this code. They enter it with their address and a password of their choosing.'}
      </p>
      <p className="invite-code-value">
        <code>{result.code}</code>
        <button
          className="key"
          onClick={() => {
            void navigator.clipboard.writeText(result.code).then(() => setCopied(true));
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </p>
      <p className="dim">
        This is the only time it is shown — it is not stored anywhere it can be read back. If it
        gets lost, <strong>Resend</strong> below makes a new one and retires this one. The invite
        expires {expiry(result.invite.expiresAt)}.
      </p>
    </div>
  );
}

/** Every answer `invite:create` and `invite:resend` can give, each said in its own words.
 *
 *  None of these is an error, and the four that are not "invited" all mean *do something
 *  different*, which a generic failure would hide — the person just types the same address in
 *  again (design D7). */
function Outcome({ result }: { result: InviteResult }) {
  switch (result.status) {
    case 'invited':
      return <Invited result={result} />;
    case 'at-capacity':
      return (
        <p className="error">
          Nobody was invited: <Ceiling count={result.headcount} />
        </p>
      );
    case 'already-a-member':
      return <p className="dim">They are already in this hunt — nothing to do.</p>;
    case 'already-invited':
      return (
        <p className="dim">
          They already have an invite waiting. Resend that one below rather than making a second.
        </p>
      );
    case 'refused':
      return <p className="error">Refused: {result.reason}</p>;
  }
}

function YourProjects({ projects, activeId }: { projects: ProjectSummary[]; activeId: string }) {
  return (
    <section className="setting">
      <h2 className="hunt-h">Your hunts</h2>
      <p className="dim">
        {projects.length === 1
          ? 'The one you are in. Leaving it takes its shortlist, verdicts and sweeps off this laptop — the hunt itself carries on without you.'
          : 'Only one is live at a time; switch between them at the top of the page. Switching changes the shortlist, the panels, the search badges and the sweep together.'}
      </p>
      <ProjectRows projects={projects} activeId={activeId} />
    </section>
  );
}

/** The list you switch and leave from, shared by the project view and the picker.
 *
 *  Failures are printed here rather than pushed as toasts: the picker is mounted by the shell in
 *  the no-project state, which has no toast host, and a switch that silently did nothing is the
 *  worst reading of this list. */
function ProjectRows({ projects, activeId }: { projects: ProjectSummary[]; activeId: string | null }) {
  const client = useQueryClient();
  const [leaving, setLeaving] = useState<string | null>(null);

  /** Changing which hunt is live throws away everything read under the old one.
   *
   *  A shortlist, a places list or a sweep left over from the hunt you switched away from is the
   *  failure the spec names outright: nothing from the previous project may remain on screen.
   *  Not `invalidateQueries()`: invalidation leaves the old rows painted until the refetch lands,
   *  and those rows are another project's flats. The reply carries the new state, so the shell does
   *  not have to ask again for it.
   *
   *  The order below is load-bearing, and getting it wrong is why this button did nothing at all.
   *  `client.clear()` removes every query from the cache *without notifying its observers*, so the
   *  mounted `useAuth` is left holding an orphaned query while the `setQueryData` after it builds a
   *  fresh one that nothing is watching. Zero notifications, so the shell never re-renders: the
   *  switch lands in the database and the screen keeps naming the hunt you just left. Sign-out runs
   *  the same two lines and survives only because it is called from the component that reads the
   *  auth query, so its own state change re-renders it and `useQuery` re-attaches on the way past.
   *  This is a leaf, and gets no such rescue.
   *
   *  So: write the auth state into the query that already exists, which does notify, and *reset*
   *  the rest rather than removing it. Reset keeps the observers attached and hands them
   *  `undefined` before their refetch lands, which is what the spec asks for — the previous hunt's
   *  flats are blanked rather than left painted. */
  function reload(next: AuthState) {
    client.setQueryData<AuthState>(shellKeys.auth, next);
    void client.resetQueries({ predicate: (query) => query.queryKey[0] !== shellKeys.auth[0] });
  }

  // Each of these re-reads the state itself rather than being handed one. The worker's handlers
  // did the same two steps and returned the result; a mutation that only wrote and let the shell
  // refetch would leave a frame in which the page still names the hunt you have just left.
  const setActive = useMutation({
    mutationFn: async (projectId: string) => {
      await setActiveProject(projectId);
      return await authState();
    },
    onSuccess: (state) => reload(state),
  });

  const leave = useMutation({
    mutationFn: async (projectId: string) => {
      await leaveProject(projectId);
      return await authState();
    },
    onSuccess: (state) => {
      setLeaving(null);
      reload(state);
    },
    onError: () => setLeaving(null),
  });

  return (
    <>
      {projects.map((p) => (
        <div className="place" key={p.id}>
          <span>
            {p.name} <span className="dim">{p.role}</span>
          </span>
          <span>
            {p.id === activeId ? (
              <span className="dim">active</span>
            ) : (
              <button
                className="key"
                disabled={setActive.isPending}
                onClick={() => setActive.mutate(p.id)}
              >
                Open
              </button>
            )}
            {/* Only the hunt you are in. Leaving one you are not looking at is a destructive act
                performed on something off screen — the shortlist and verdicts it drops are ones you
                cannot see to reconsider — and a row of Leave buttons makes the dangerous one no
                more prominent than the rest.
                Asked twice on purpose: there is no undo button that puts a membership back. */}
            {p.id === activeId &&
              (leaving === p.id ? (
                <button
                  className="danger"
                  disabled={leave.isPending}
                  onClick={() => leave.mutate(p.id)}
                >
                  {leave.isPending ? 'Leaving…' : 'Yes, leave this hunt'}
                </button>
              ) : (
                <button className="danger danger-quiet" onClick={() => setLeaving(p.id)}>
                  Leave
                </button>
              ))}
          </span>
        </div>
      ))}
      {setActive.isError && <p className="error">Not switched — {setActive.error.message}</p>}
      {leave.isError && <p className="error">Not left — {leave.error.message}</p>}
    </>
  );
}

/** What an invite is *now*, which is not always what its status column says.
 *
 *  Nothing ages a pending invite out: a row fourteen days past its `expires_at` still reads
 *  `pending` in the database. Showing that word would say the invite is waiting for someone when
 *  it confers nothing, so expiry is derived from the date here and at every other reading. */
function inviteIsLive(invite: Invite, now = Date.now()): boolean {
  return invite.status === 'pending' && !invite.expired && Date.parse(invite.expiresAt) > now;
}

function inviteState(invite: Invite): string {
  if (invite.status === 'accepted') return 'joined';
  if (invite.status === 'revoked') return 'revoked';
  return inviteIsLive(invite) ? `invited, expires ${expiry(invite.expiresAt)}` : 'expired, never used';
}

/** "in 12 days" rather than a date, because a date makes the reader do the arithmetic that decides
 *  whether resending is worth it. */
function expiry(iso: string): string {
  const days = Math.round((Date.parse(iso) - Date.now()) / 86_400_000);
  if (days <= 0) return 'today';
  return days === 1 ? 'tomorrow' : `in ${days} days`;
}

/** What a sweep actually searches for, set by pasting a Rightmove search.
 *
 *  This was six numbers compiled into `SWEEP_CRITERIA` — one to three bedrooms, four to six
 *  thousand a month, a mile of radius — which every hunt using this app shared whether they were
 *  looking in Hampstead or Hull. The reason it stayed that way is that the obvious alternative is
 *  worse: a form with a control per Rightmove filter is a dozen fields to build and to keep in step
 *  with a site nobody here controls, and it still cannot express the filter they add next month.
 *
 *  A pasted URL is better than a form on every count that matters here. The filters already exist,
 *  on Rightmove, with their own names and their own explanations; you can see the results before
 *  committing to them; and what comes back works for every filter the site has, including the ones
 *  this app has never heard of. What it costs is that the thing you paste is opaque — so nothing is
 *  saved without saying, in words, what it will search for and which parts of it were ignored.
 *
 *  See `criteriaFromUrl` for why the location and the time window are never taken from the paste. */
function SearchCriteria({ notify }: { notify: Notify }) {
  const settings = useProjectSettings();
  const save = useSetProjectSettings();
  const [pasted, setPasted] = useState('');
  const [rejected, setRejected] = useState(false);

  // Null, not a fallback. There is no sensible default price band for a hunt we know nothing about,
  // and the old constant meant every project swept one household's budget — see `RENTAL_SEARCH`.
  const current = settings.data?.search ?? null;

  const apply = (criteria: SweepCriteria | undefined) => {
    // The whole preferences object, like every other control here: a partial write would drop the
    // amenity wants somebody set thirty seconds ago.
    save.mutate(
      { ...(settings.data ?? {}), search: criteria },
      {
        onSuccess: () => {
          setPasted('');
          setRejected(false);
          notify(criteria ? 'Search filters saved.' : 'Search filters cleared — nothing to sweep until you set them again.', 'info');
        },
        onError: (e) => notify(`Couldn't save the filters — ${(e as Error).message}`, 'error'),
      },
    );
  };

  const read = criteriaFromUrl(pasted);

  return (
    <section className="hunt-search">
      <h3 className="hunt-h3">What we search for</h3>
      <Explainer lead="Set the filters you want on Rightmove — any of them, including ones this app has never heard of — then copy the address bar and paste it here.">
        Every place you search around is swept with these, so the area and the date range in what
        you paste are ignored: those are what a sweep works out for itself.
      </Explainer>

      <div className="hunt-search-paste">
        <input
          type="url"
          value={pasted}
          placeholder="https://www.rightmove.co.uk/property-to-rent/find.html?..."
          aria-label="Rightmove search URL"
          data-testid="criteria-url"
          onChange={(e) => {
            setPasted(e.target.value);
            setRejected(false);
          }}
        />
        <button
          className="primary"
          disabled={save.isPending || !pasted.trim()}
          data-testid="criteria-save"
          onClick={() => {
            if (!read) return setRejected(true);
            apply(read.criteria);
          }}
        >
          Use these filters
        </button>
      </div>

      {/* Refused rather than accepted-and-empty. An empty set of criteria is a valid search — every
          flat in the country — so taking a pasted tweet as one would quietly widen every sweep. */}
      {rejected && (
        <div className="error">
          That is not a Rightmove search. Go to Rightmove, set the filters, and copy the whole
          address — it should start{' '}
          <code>https://www.rightmove.co.uk/property-to-rent/find.html?</code>
        </div>
      )}

      {read && pasted.trim() !== '' && (
        <div className="dim">
          Ready to save. {read.ignored.length > 0 && (
            <>Ignoring {read.ignored.join(', ')} — the place, the radius, the date range and the sort
            order are the sweep&rsquo;s own.</>
          )}
        </div>
      )}

      <h4 className="hunt-label">Sweeping for</h4>
      {current === null ? (
        <p className="dim" data-testid="criteria-summary">
          Nothing yet — so there is nothing to sweep, and the places below have
          no links. That is deliberate: the alternative is a built-in price band, which every hunt
          using this app would search whether or not it was theirs, and a search that returns
          results always looks like it worked.
        </p>
      ) : (
        <>
          <ul className="hunt-search-summary" data-testid="criteria-summary">
            {describeCriteria(current).map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          <button className="key" disabled={save.isPending} onClick={() => apply(undefined)}>
            Clear these filters
          </button>
        </>
      )}
    </section>
  );
}


/** What one resolve attempt said. All four states are rendered: a silent failure here is a place
 *  that looks searchable and never appears in the sweep. */
function LocationNote({ result, place }: { result: LocationResult; place: Place }) {
  if (result.status === 'not-found') {
    return (
      <div className="error">
        Rightmove has no page at <code>{result.slug}</code>. Its own spelling is the one that works
        — try "{place.label} Station", or the area rather than the stop.
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
    result.centroid !== null && place.lat !== null && place.lon !== null
      ? distanceMiles({ lat: place.lat, lon: place.lon }, result.centroid)
      : null;
  return (
    <div className="dim">
      {result.displayName} ({result.locationIdentifier}), read out of {result.slug}.
      {apart === null
        ? ' No coordinate here to check it against — worth adding one before you trust the sweep.'
        : apart > 1
          ? ` Rightmove puts its centre ${apart.toFixed(1)} mi from where this place is — check which of the two is wrong before sweeping it.`
          : ` Rightmove's centre agrees to within ${apart.toFixed(1)} mi.`}
    </div>
  );
}

/** The places this hunt cares about, and what it does with each one.
 *
 *  One list, three jobs, and each row says which it can do. Every place with a postcode is timed by
 *  walking, bike and transit; every place with coordinates fixes a listing ("0.4 mi NE of Angel");
 *  and a place you tick "search around" becomes a sweep centre.
 *
 *  This was two sections on two pages — places here, neighbourhoods under the sweep — with their
 *  own add forms, their own lists, and the compass quietly merging them on every card. Angel had to
 *  be typed twice to be both searched and commuted from. The tables are one table now (see the
 *  `places_are_hubs` migration) and so is this.
 *
 *  Searching around a place needs Rightmove's own name for it, which is resolved by a person
 *  pressing a button and never in the background — the standing no-crawl rule's one sanctioned
 *  fetch: one request, for one place, by somebody looking at the screen. */
function Places({
  places,
  setPlaces,
  notify,
}: {
  places: Place[];
  setPlaces: (update: (current: Place[]) => Place[]) => void;
  notify: Notify;
}) {
  const [label, setLabel] = useState('');
  const [postcode, setPostcode] = useState('');
  const [busy, setBusy] = useState(false);
  /** Place id -> what its last resolve attempt said. Per place rather than one banner: two can be
   *  in different states at once and a shared line would attribute one's failure to the other. */
  const [located, setLocated] = useState<Record<string, LocationResult>>({});

  const replace = (next: Place) => setPlaces((current) => current.map((p) => (p.id === next.id ? next : p)));

  async function addPlace() {
    setBusy(true);
    const place = await attempt(() => addPlaceRow(label, postcode.toUpperCase()), notify);
    setBusy(false);
    if (!place) return;
    setPlaces((current) => [...current, place]);
    setLabel('');
    setPostcode('');
  }

  async function removePlace(place: Place) {
    // A place takes its sweep history with it — `hub_sweep` cascades. That is the whole record of
    // having worked this search to the end, so it is worth a stop.
    //
    // Asked of the sweeps rather than of the place's current radius: unticking "search around"
    // only clears the radius and leaves the history behind, so a place that reads as never-swept
    // can still have every page of a finished sweep hanging off it. Looked up at the click rather
    // than held in a query, because this is the only thing on this screen that wants it — and a
    // lookup that fails warns anyway, since the alternative is deleting the history in silence.
    const swept = await listHubSweeps()
      .then((sweeps) => sweeps.some((s) => s.placeId === place.id))
      .catch(() => true);
    const warning = swept
      ? `Remove ${place.label}? Its sweep history goes with it.`
      : `Remove ${place.label}?`;
    if (!confirm(warning)) return;
    const gone = await attempt(async () => {
      await removePlaceRow(place.id);
      return true;
    }, notify);
    if (!gone) return;
    setPlaces((current) => current.filter((p) => p.id !== place.id));
  }

  const patch = async (place: Place, change: PlacePatch) => {
    const saved = await attempt(() => updatePlace(place.id, change), notify);
    if (saved) replace(saved);
    return saved;
  };

  /** Ask Rightmove what it calls this place, once, because somebody pressed a button. */
  async function resolve(place: Place) {
    setBusy(true);
    const result = await attempt(() => resolveLocation(place.label), notify);
    setBusy(false);
    if (!result) return;
    setLocated({ ...located, [place.id]: result });
    if (result.status !== 'resolved') return;
    await patch(place, {
      locationIdentifier: result.locationIdentifier,
      displayLocationIdentifier: result.displayLocationIdentifier,
    });
  }

  /** Starting to sweep a place is one act with two halves: give it a radius, and — the first time —
   *  find out what Rightmove calls it. Doing the second automatically is the difference between one
   *  choice and a two-step setup where the first step appears to do nothing.
   *
   *  A radius and "search around this at all" were a tick and a menu; they are one menu now, whose
   *  off state is a sentence rather than an empty box. The tick's hidden 1-mile default goes with
   *  it: the radius is named at the moment it is chosen, which is what the default was standing in
   *  for. */
  async function setSweeping(place: Place, miles: number | null) {
    const saved = await patch(place, { sweepRadiusMiles: miles });
    if (saved && miles !== null && saved.locationIdentifier === null) await resolve(saved);
  }

  return (
    <section className="setting">
      <h2 className="hunt-h">Places</h2>
      <Explainer lead="The office, the in-laws, the neighbourhoods you are looking in.">
        Every one is timed by walking, bike and public transport, and fixes each listing on the
        compass — &ldquo;0.4 mi NE of Angel&rdquo;. Give one a radius and it also becomes somewhere
        the sweep goes looking. {TRANSIT_BASIS_NOTE}
      </Explainer>
      {places.length === 0 && (
        <p className="dim">Nothing yet — add the office, the in-laws, the areas you are searching.</p>
      )}
      {places.map((place) => (
        <div className="hunt-place" key={place.id}>
          <div className="hunt-place-head">
            <span className="hunt-place-name">{place.label}</span>
            <span className="hunt-place-where">
              {place.postcode ?? (place.lat === null ? 'no location' : 'no postcode — not timed')}
            </span>

            <Pill
              label={`Search around ${place.label}`}
              title="How far around this place Rightmove searches. The same steps its own radius control offers."
              faint={place.sweepRadiusMiles === null}
              disabled={busy}
              value={place.sweepRadiusMiles === null ? '' : String(place.sweepRadiusMiles)}
              onPick={(v) => void setSweeping(place, v === '' ? null : Number(v))}
            >
              <option value="">not searching around</option>
              {SWEEP_RADII.map((miles) => (
                <option key={miles} value={miles}>
                  searching within {miles} mi
                </option>
              ))}
            </Pill>

            {place.sweepRadiusMiles !== null && (
              <>
                <Pill
                  label={`How far back sweeps of ${place.label} look`}
                  title="A floor on how far back this sweep looks. It can only widen the window — a setting that narrowed it would drop listings and still report the page fully recorded."
                  value={place.maxDaysSinceAdded === null ? '' : String(place.maxDaysSinceAdded)}
                  onPick={(v) =>
                    void patch(place, { maxDaysSinceAdded: v === '' ? null : Number(v) })
                  }
                >
                  <option value="">window from the last sweep</option>
                  {SWEEP_WINDOWS.map((days) => (
                    <option key={days} value={days}>
                      at least {days} {days === 1 ? 'day' : 'days'}
                    </option>
                  ))}
                </Pill>
                {/* Whether this place can be swept at all, rather than the identifier that decides
                    it: `REGION^1486` is a string nobody but a debugger reads, and it was the widest
                    thing on the row. It is still the thing to check when a sweep brings back the
                    wrong neighbourhood, so it survives in the hint beside the name it resolved
                    from — one hover away rather than always on screen. */}
                <Hint
                  text={`Rightmove calls this ${place.displayLocationIdentifier ?? 'nothing yet'}${
                    place.locationIdentifier ? ` (${place.locationIdentifier})` : ''
                  }. It is what a sweep searches — if the results look like the wrong place, re-resolve it.`}
                >
                  <span className="hunt-place-state">
                    {place.locationIdentifier ? 'searchable' : 'not searchable yet'}
                  </span>
                </Hint>
                <button className="key" disabled={busy} onClick={() => void resolve(place)}>
                  {place.locationIdentifier ? 'Re-resolve' : 'Resolve'}
                </button>
              </>
            )}

            <button
              className="remove"
              title="Remove"
              aria-label={`Remove ${place.label}`}
              onClick={() => void removePlace(place)}
            >
              ×
            </button>
          </div>
          {located[place.id] && (
            <div className="hunt-place-note">
              <LocationNote result={located[place.id]!} place={place} />
            </div>
          )}
        </div>
      ))}
      <div className="fields hunt-place-add">
        <input value={label} placeholder="Label" onChange={(e) => setLabel(e.target.value)} />
        <input
          value={postcode}
          placeholder="Postcode or lat,lon"
          title="A UK postcode, or coordinates pasted from Google Maps (51.4708,-0.4523)"
          onChange={(e) => setPostcode(e.target.value)}
        />
        <button
          className="primary"
          disabled={busy || !label.trim() || !postcode.trim()}
          onClick={() => void addPlace()}
        >
          Add
        </button>
      </div>
    </section>
  );
}
