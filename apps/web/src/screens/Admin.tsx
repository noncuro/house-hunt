'use client';

import { useMemo, useRef, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  MIN_PASSWORD_LENGTH,
  listingUrl,
  type AdminProject,
  type AdminUser,
  type Invite,
  type UsageRow,
} from '@house-hunt/core';
import {
  adminProjects,
  adminSetMaxMembers,
  adminSetPassword,
  adminSetProjectCap,
  adminSetUserCap,
  adminUsage,
  adminUsers,
  listInvites,
  revokeInvite,
} from '@house-hunt/core/db';
import { charge, Icon, money, SpendBar } from '@house-hunt/ui';

/** What everyone is spending, and the ceilings on it.
 *
 *  This view exists for one reason: every account is a claim on the owner's OpenAI key. Users,
 *  projects and invites are all here because they are the things that turn into spend — a user is
 *  a spender, a project is a shared budget, and a pending invite is a spender who has not arrived
 *  yet. So money is the spine of the whole view rather than a column at the far right of it: every
 *  row carries a budget bar, and both tables are ordered by what they cost this month, biggest
 *  first. The question "who is spending, and how close to their cap" is answered by the shape of
 *  the page before you read a single number.
 *
 *  **The tab that leads here is hidden from non-admins, and that is presentation, not the
 *  boundary.** RLS decides what these messages can return; if this view were shown to a member it
 *  would render their own rows and nothing else. Nothing here is written on the assumption that
 *  only an admin can see it.
 *
 *  The bar is drawn on the same argument as the confidence bars (`components/Confidence.tsx`): the
 *  track is always full width, so the mark has the same footprint at every level and a nearly
 *  empty budget reads as "a little of this much" rather than as a speck. Unlike confidence, colour
 *  here *is* the signal — a cap is a threshold with a right and a wrong side, which is exactly the
 *  case confidence was not. */
export function Admin() {
  const [tab, setTab] = useState<'users' | 'projects' | 'invites' | 'charges'>('users');
  /** Set by clicking a row's charge count; the charges tab opens filtered to it. Drilling in from
   *  the row that raised the question is the whole point of the drill-down. */
  const [focus, setFocus] = useState<Focus>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const months = useMemo(() => monthBounds(new Date()), []);

  const users = useQuery({ queryKey: ['admin', 'users'], queryFn: adminUsers });
  const projects = useQuery({ queryKey: ['admin', 'projects'], queryFn: adminProjects });
  const invites = useQuery({ queryKey: ['admin', 'invites'], queryFn: () => listInvites() });

  // One usage read covers both jobs: the per-row "and last month" figures, and the charge list.
  // Asking for a month more than the tables strictly need costs one query and saves a second.
  const usage = useQuery({
    queryKey: ['admin', 'usage', months.since],
    queryFn: () => adminUsage({ since: months.since }),
  });

  const lastMonth = useMemo(() => bucketPreviousMonth(usage.data ?? [], months), [usage.data, months]);

  /** What Charges is worth opening for, in the same place the other three tabs say how many rows
   *  they hold. A count of charges would be the wrong figure — nobody is rationing rows — so the
   *  tab carries the month's total across every user, which is the number a cap is set against.
   *  Summed from the stored `cost_usd` of the rows this month, the way every other figure here is:
   *  a total recomputed from tokens and a price would disagree with the caps the database
   *  enforces. */
  const spentThisMonth = useMemo(
    () =>
      (usage.data ?? []).reduce(
        (sum, row) => (Date.parse(row.occurredAt) >= months.currentStart ? sum + row.costUsd : sum),
        0,
      ),
    [usage.data, months],
  );

  function drill(next: Focus) {
    setFocus(next);
    setTab('charges');
  }

  return (
    <section className="admin">
      <div className="admin-tabs">
        {(
          [
            ['users', 'Users', users.data ? String(users.data.length) : null],
            ['projects', 'Projects', projects.data ? String(projects.data.length) : null],
            ['invites', 'Invites', invites.data ? String(invites.data.length) : null],
            ['charges', 'Charges', usage.data ? charge(spentThisMonth) : null],
          ] as const
        ).map(([key, label, count]) => (
          <button
            key={key}
            className={tab === key ? 'admin-pill admin-pill-on' : 'admin-pill'}
            aria-pressed={tab === key}
            onClick={() => setTab(key)}
          >
            {label}
            {/* Absent while the query is in flight rather than a zero, which would be a figure
                somebody could act on. */}
            {count !== null && <span className="admin-pill-count">{count}</span>}
          </button>
        ))}
        <span className="admin-note" title="The same boundary the cap is enforced on">
          this calendar month, Europe/London
        </span>
      </div>

      {/* A failed write is stated here rather than swallowed: a cap that silently did not change
          is a budget nobody is enforcing, and the table would go on showing the old number either
          way. */}
      {notice && <p className="error admin-notice">{notice}</p>}

      {tab === 'users' && (
        <Users
          query={users}
          lastMonth={lastMonth}
          onDrill={drill}
          onNotice={setNotice}
        />
      )}
      {tab === 'projects' && (
        <Projects query={projects} lastMonth={lastMonth} onDrill={drill} onNotice={setNotice} />
      )}
      {tab === 'invites' && <Invites query={invites} onNotice={setNotice} />}
      {tab === 'charges' && (
        <Charges
          query={usage}
          months={months}
          focus={focus}
          setFocus={setFocus}
          users={users.data ?? []}
          projects={projects.data ?? []}
        />
      )}
    </section>
  );
}

// ------------------------------------------------------------------------------------------------
// The month, in Europe/London.
//
// `month_start_london()` in the migration is what the cap is actually counted against, so a view
// that bucketed on the browser's own midnight would disagree with the enforced budget for an hour
// at each end of the month in summer — a table that is wrong about money and looks right. Both
// boundaries are derived the same way the database derives its one.
// ------------------------------------------------------------------------------------------------

interface Months {
  /** 00:00 London on the 1st of this month, as an epoch millisecond.
   *
   *  A millisecond and not a string: Postgres hands back `2026-08-09T10:00:00+00:00` and
   *  `toISOString()` produces `2026-08-01T00:00:00.000Z`, so comparing the two as text sorts on
   *  the punctuation of the offset rather than on the instant. Every comparison here goes through
   *  `Date.parse`. */
  currentStart: number;
  /** ...and the month before, which is how far back `admin:usage` is asked to go. */
  previousStart: number;
  /** The same instant as `previousStart`, for the message that wants a timestamp. */
  since: string;
}

const LONDON = 'Europe/London';

function monthBounds(now: Date): Months {
  const parts = londonParts(now);
  const previous = londonMonthStart(parts.year, parts.month - 1);
  return {
    currentStart: londonMonthStart(parts.year, parts.month).getTime(),
    previousStart: previous.getTime(),
    since: previous.toISOString(),
  };
}

/** The wall-clock fields London is showing at an instant. */
function londonParts(at: Date) {
  const fields = new Intl.DateTimeFormat('en-GB', {
    timeZone: LONDON,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(at);
  const read = (type: Intl.DateTimeFormatPartTypes) => Number(fields.find((f) => f.type === type)?.value);
  // `hour` comes back as 24 rather than 0 at midnight under hour12: false in some engines.
  const hour = read('hour') % 24;
  return { year: read('year'), month: read('month'), day: read('day'), hour, minute: read('minute'), second: read('second') };
}

/** The instant at which London's clock reads 00:00 on the 1st of a given month. `month` is 1-based
 *  and may be 0 or 13 — Date.UTC normalises the year for us. */
function londonMonthStart(year: number, month: number): Date {
  const wanted = Date.UTC(year, month - 1, 1, 0, 0, 0);
  // Guess that London is at UTC, then correct by however far off that guess turns out to be. One
  // correction is exact here: London's offset changes at 01:00/02:00 on a Sunday in March and
  // October, never at midnight on the 1st, so the corrected instant is always in the same offset
  // as the instant used to measure it.
  const guess = new Date(wanted);
  return new Date(wanted - offsetMs(guess));
}

/** How far ahead of UTC London is at an instant, in ms. */
function offsetMs(at: Date): number {
  const p = londonParts(at);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - at.getTime();
}

/** Last month's spend, per project and per user. The month-to-date figures come from the server
 *  (`spentThisMonthUsd`); only the previous month has to be added up here, and it is added up from
 *  the stored `cost_usd` of each row — never recomputed from tokens and a price. */
function bucketPreviousMonth(rows: UsageRow[], months: Months) {
  const byProject = new Map<string, number>();
  const byUser = new Map<string, number>();
  for (const row of rows) {
    const at = Date.parse(row.occurredAt);
    if (!Number.isFinite(at) || at >= months.currentStart || at < months.previousStart) continue;
    if (row.projectId) byProject.set(row.projectId, (byProject.get(row.projectId) ?? 0) + row.costUsd);
    if (row.userId) byUser.set(row.userId, (byUser.get(row.userId) ?? 0) + row.costUsd);
  }
  return { byProject, byUser };
}

// ------------------------------------------------------------------------------------------------
// Money, drawn.
// ------------------------------------------------------------------------------------------------

/** Every figure here goes through the renderers in `packages/ui/src/Spend.tsx` — `money()` for a
 *  cap, `charge()` for a single charge, `SpendBar` for one against the other. A limit on someone
 *  else's money phrased two ways in two views is exactly the drift the one-fact-one-renderer rule
 *  exists to stop, and the bar moved into that file when its fill turned out to be invisible: the
 *  colour it was drawn in lived in `admin.css`, where nothing shared could reach it. */

// ------------------------------------------------------------------------------------------------
// Caps. The admin RPCs are the only writable path — RLS gates rows and not columns, so there is no
// policy under which a member could update their own project and leave the cap alone (design D15).
// ------------------------------------------------------------------------------------------------

/** A number you can change in place. Reads as text until you click it, because these are read far
 *  more often than they are changed and a page of input boxes reads as a form to fill in. */
function Editable({
  value,
  render,
  unit,
  min,
  step,
  onSave,
  saving,
}: {
  value: number;
  render: (value: number) => string;
  unit: string;
  min: number;
  step: number;
  onSave: (next: number) => void;
  saving: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(String(value));
  // Enter commits and then takes the focus off the input, so both handlers fire for one edit.
  // Without this the same cap is written twice — harmless in the database and not harmless on
  // screen, where the second write races the refetch of the first.
  const sent = useRef(false);

  if (saving) return <span className="dim working">saving…</span>;

  if (!editing) {
    return (
      <button
        className="admin-cap"
        title={`Change this ${unit}`}
        onClick={() => {
          setDraft(String(value));
          sent.current = false;
          setEditing(true);
        }}
      >
        {render(value)}
      </button>
    );
  }

  const commit = () => {
    if (sent.current) return;
    sent.current = true;
    const next = Number(draft);
    // A blank or a typo must not travel: the RPC would either refuse or, worse, take a NaN as a
    // zero and silently switch the budget off.
    if (!Number.isFinite(next) || next < min) {
      setEditing(false);
      return;
    }
    setEditing(false);
    if (next !== value) onSave(next);
  };

  return (
    <span className="admin-edit">
      <input
        type="number"
        min={min}
        step={step}
        value={draft}
        autoFocus
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
          if (e.key === 'Escape') {
            sent.current = true;
            setEditing(false);
          }
        }}
        onBlur={commit}
      />
    </span>
  );
}

/** Wraps a cap mutation so a refusal is printed rather than lost, and so the tables refetch the
 *  figure the database now holds rather than the one we hoped it would. */
function useAdminWrite(onNotice: (message: string | null) => void) {
  const client = useQueryClient();
  return {
    settle(what: string) {
      return {
        onSuccess: () => {
          onNotice(null);
          void client.invalidateQueries({ queryKey: ['admin'] });
        },
        onError: (error: Error) => onNotice(`${what} — ${error.message}`),
      };
    },
  };
}

// ------------------------------------------------------------------------------------------------
// Users.
// ------------------------------------------------------------------------------------------------

type Focus = { kind: 'user'; id: string; label: string } | { kind: 'project'; id: string; label: string } | null;

interface Bucketed {
  byProject: Map<string, number>;
  byUser: Map<string, number>;
}

interface Loadable<T> {
  data: T | undefined;
  isPending: boolean;
  isError: boolean;
  error: unknown;
}

/** Loading and failure, said out loud, and returning null when there is neither — a plain function
 *  rather than a component so a caller can ask "is there something to say instead of the table".
 *  A table that renders nothing while its query is failing is indistinguishable from a system with
 *  no users in it. */
function loadState(query: Loadable<unknown>, what: string): ReactNode | null {
  if (query.isPending) return <p className="dim working">Reading {what}…</p>;
  if (query.isError) {
    return (
      <p className="error">
        Could not read {what} — {(query.error as Error).message}
      </p>
    );
  }
  return null;
}

function Users({
  query,
  lastMonth,
  onDrill,
  onNotice,
}: {
  query: Loadable<AdminUser[]>;
  lastMonth: Bucketed;
  onDrill: (focus: Focus) => void;
  onNotice: (message: string | null) => void;
}) {
  const write = useAdminWrite(onNotice);
  const setCap = useMutation({
    mutationFn: ({ userId, capUsd }: { userId: string; capUsd: number }) =>
      adminSetUserCap(userId, capUsd),
    ...write.settle('Cap not changed'),
  });
  const setPassword = useMutation({
    mutationFn: ({ userId, password }: { userId: string; password: string }) =>
      adminSetPassword(userId, password),
    ...write.settle('Password not changed'),
  });

  const pending = loadState(query, 'users');
  if (pending) return pending;
  const users = [...(query.data ?? [])].sort(bySpend);
  if (users.length === 0) return <p className="dim">Nobody has an account yet.</p>;

  return (
    <div className="admin-scroll">
      <table className="admin-table">
        <thead>
          <tr>
            <th>Who</th>
            <th>This month</th>
            <th className="num">Last month</th>
            <th className="num">Cap</th>
            <th>Projects</th>
            <th>Joined</th>
            <th>Last seen</th>
            <th>Password</th>
          </tr>
        </thead>
        <tbody>
          {users.map((user) => (
            <tr key={user.id}>
              <td>
                <span className="admin-who">
                  <b>{user.displayName || user.email}</b>
                  {user.displayName && user.displayName !== user.email && (
                    <span className="dim admin-email">{user.email}</span>
                  )}
                  {user.isAdmin && <span className="admin-badge" title="Sees everything, and can change a cap">admin</span>}
                </span>
              </td>
              <td className="budget-cell">
                <button
                  className="admin-drill"
                  title="The individual charges behind this"
                  onClick={() => onDrill({ kind: 'user', id: user.id, label: user.displayName || user.email })}
                >
                  <SpendBar spent={user.spentThisMonthUsd} cap={user.monthlyCapUsd} label={user.email} />
                </button>
              </td>
              <td className="num dim">{charge(lastMonth.byUser.get(user.id) ?? 0)}</td>
              <td className="num">
                <Editable
                  value={user.monthlyCapUsd}
                  render={money}
                  unit="cap"
                  min={0}
                  step={5}
                  saving={setCap.isPending && setCap.variables?.userId === user.id}
                  onSave={(capUsd) => setCap.mutate({ userId: user.id, capUsd })}
                />
              </td>
              <td>
                {user.projects.length === 0 ? (
                  <span className="dim">none</span>
                ) : (
                  user.projects.map((p) => p.name).join(', ')
                )}
              </td>
              <td className="dim">{ago(user.createdAt)}</td>
              <td className="dim">{user.lastSeenAt ? ago(user.lastSeenAt) : 'never'}</td>
              <td>
                <SetPassword
                  who={user.email}
                  saving={setPassword.isPending && setPassword.variables?.userId === user.id}
                  onSave={(password) => setPassword.mutate({ userId: user.id, password })}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Setting somebody's password for them, which is the whole of password recovery here.
 *
 *  There is no "forgot my password" link and there is not going to be one: a reset link is an
 *  email, and email is the dependency this design removed — the built-in Supabase sender gives
 *  about two messages an hour, which is what broke the old code-by-email sign-in in the first
 *  place. So recovery is a person: the admin sets a password and tells the user what it is, down
 *  the same phone line the invite code went down.
 *
 *  Typed in the clear on purpose. The admin is about to read this out or text it, so hiding it
 *  behind dots would only mean typing it twice and hoping. It is never logged and never put in a
 *  URL; the Edge Function logs the user id it changed and nothing else.
 *
 *  Confirmation is the field itself: an empty box does nothing, and the button stays dead until
 *  what is in it is long enough to be accepted — which is the same rule the function enforces, so
 *  nobody learns about the minimum from a refusal.
 */
function SetPassword({
  who,
  saving,
  onSave,
}: {
  who: string;
  saving: boolean;
  onSave: (password: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');

  if (saving) return <span className="dim working">saving…</span>;

  if (!open) {
    return (
      <button className="key" title={`Set a new password for ${who}`} onClick={() => setOpen(true)}>
        Set
      </button>
    );
  }

  const commit = () => {
    if (draft.length < MIN_PASSWORD_LENGTH) return;
    onSave(draft);
    // Cleared before the write settles, so the value does not sit in a mounted input waiting for
    // somebody to walk past the screen.
    setDraft('');
    setOpen(false);
  };

  return (
    <span className="admin-edit">
      <input
        type="text"
        value={draft}
        autoFocus
        spellCheck={false}
        placeholder={`${MIN_PASSWORD_LENGTH}+ characters`}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
          if (e.key === 'Escape') {
            setDraft('');
            setOpen(false);
          }
        }}
      />
      <button className="key" disabled={draft.length < MIN_PASSWORD_LENGTH} onClick={commit}>
        Save
      </button>
    </span>
  );
}

// ------------------------------------------------------------------------------------------------
// Projects.
// ------------------------------------------------------------------------------------------------

function Projects({
  query,
  lastMonth,
  onDrill,
  onNotice,
}: {
  query: Loadable<AdminProject[]>;
  lastMonth: Bucketed;
  onDrill: (focus: Focus) => void;
  onNotice: (message: string | null) => void;
}) {
  const write = useAdminWrite(onNotice);
  const setCap = useMutation({
    mutationFn: ({ projectId, capUsd }: { projectId: string; capUsd: number }) =>
      adminSetProjectCap(projectId, capUsd),
    ...write.settle('Cap not changed'),
  });
  const setMax = useMutation({
    mutationFn: ({ projectId, maxMembers }: { projectId: string; maxMembers: number }) =>
      adminSetMaxMembers(projectId, maxMembers),
    ...write.settle('Member limit not changed'),
  });

  const pending = loadState(query, 'projects');
  if (pending) return pending;
  const projects = [...(query.data ?? [])].sort(bySpend);
  if (projects.length === 0) return <p className="dim">No projects yet.</p>;

  return (
    <div className="admin-scroll">
      <table className="admin-table">
        <thead>
          <tr>
            <th>Project</th>
            <th>This month</th>
            <th className="num">Last month</th>
            <th className="num">Cap</th>
            <th className="num">Members</th>
            <th className="num">Places</th>
            <th>Created</th>
          </tr>
        </thead>
        <tbody>
          {projects.map((project) => (
            <tr key={project.id}>
              <td>
                <b>{project.name}</b>
              </td>
              <td className="budget-cell">
                <button
                  className="admin-drill"
                  title="The individual charges behind this"
                  onClick={() => onDrill({ kind: 'project', id: project.id, label: project.name })}
                >
                  <SpendBar spent={project.spentThisMonthUsd} cap={project.monthlyCapUsd} label={project.name} />
                </button>
              </td>
              <td className="num dim">{charge(lastMonth.byProject.get(project.id) ?? 0)}</td>
              <td className="num">
                <Editable
                  value={project.monthlyCapUsd}
                  render={money}
                  unit="cap"
                  min={0}
                  step={5}
                  saving={setCap.isPending && setCap.variables?.projectId === project.id}
                  onSave={(capUsd) => setCap.mutate({ projectId: project.id, capUsd })}
                />
              </td>
              {/* Members against the ceiling in one cell, because the ceiling is the only reason
                  the member count is interesting: it is what stops a project being turned into a
                  mailing list one invite at a time (design D7). */}
              <td className="num">
                <span className={project.memberCount >= project.maxMembers ? 'budget-word budget-over' : undefined}>
                  {project.memberCount}
                </span>
                <span className="dim"> / </span>
                <Editable
                  value={project.maxMembers}
                  render={(n) => String(n)}
                  unit="member limit"
                  min={1}
                  step={1}
                  saving={setMax.isPending && setMax.variables?.projectId === project.id}
                  onSave={(maxMembers) => setMax.mutate({ projectId: project.id, maxMembers })}
                />
              </td>
              <td className="num">{project.propertyCount}</td>
              <td className="dim">{ago(project.createdAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Biggest spender first, in both tables. The order is the answer to the question this view exists
 *  to answer, so it is not a sort you have to ask for. Ties go alphabetical rather than to whatever
 *  order the database happened to return, which would otherwise reshuffle a page of $0 rows on
 *  every refetch. */
type Named = { spentThisMonthUsd: number; name?: string; displayName?: string; email?: string };

function bySpend<T extends Named>(a: T, b: T): number {
  return b.spentThisMonthUsd - a.spentThisMonthUsd || nameOf(a).localeCompare(nameOf(b));
}

function nameOf(row: Named): string {
  return row.name ?? row.displayName ?? row.email ?? '';
}

// ------------------------------------------------------------------------------------------------
// Invites.
// ------------------------------------------------------------------------------------------------

/** The four states an invite can be in, and the one that is not stored.
 *
 *  Nothing ages an invite out: a pending row keeps `status: 'pending'` for ever, so an invite two
 *  months past its date still says it is waiting to be accepted unless the date is read. The
 *  contract derives `expired` when it builds the row, and this derives it again from `expires_at`
 *  at render time — the two agree on load, and only this one stays right on a tab left open across
 *  the expiry, which is exactly the tab someone is watching an invite on. */
function inviteState(invite: Invite, now: number): 'pending' | 'expired' | 'accepted' | 'revoked' {
  if (invite.status !== 'pending') return invite.status;
  return invite.expired || Date.parse(invite.expiresAt) <= now ? 'expired' : 'pending';
}

const INVITE_WORD: Record<'pending' | 'expired' | 'accepted' | 'revoked', string> = {
  pending: 'waiting',
  expired: 'expired',
  accepted: 'accepted',
  revoked: 'revoked',
};

function Invites({ query, onNotice }: { query: Loadable<Invite[]>; onNotice: (message: string | null) => void }) {
  const write = useAdminWrite(onNotice);
  const revoke = useMutation({
    mutationFn: ({ inviteId }: { inviteId: string }) => revokeInvite(inviteId),
    ...write.settle('Invite not revoked'),
  });

  const now = Date.now();
  const pending = loadState(query, 'invites');
  if (pending) return pending;
  const invites = [...(query.data ?? [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  if (invites.length === 0) return <p className="dim">Nobody has been invited.</p>;

  const waiting = invites.filter((i) => inviteState(i, now) === 'pending').length;

  return (
    <>
      <p className="dim admin-lede">
        {waiting === 0
          ? 'Nothing outstanding — every invite has been used, revoked or has run out.'
          : `${waiting} ${waiting === 1 ? 'invite is' : 'invites are'} still open. Each one is a member the project has already made room for, and a cap it will start spending against.`}
      </p>
      <div className="admin-scroll">
        <table className="admin-table">
          <thead>
            <tr>
              <th>Address</th>
              <th>To</th>
              <th>State</th>
              <th>Sent</th>
              <th>Runs out</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {invites.map((invite) => {
              const state = inviteState(invite, now);
              return (
                <tr key={invite.id} className={state === 'pending' ? undefined : 'admin-spent'}>
                  <td>{invite.email}</td>
                  <td>
                    {/* A platform invite makes a project rather than joining one, which is a
                        materially different thing to hand out and should not read as a blank. */}
                    {invite.projectName ?? <span className="dim">a new project of their own</span>}
                  </td>
                  <td>
                    <span className={`admin-chip admin-chip-${state}`}>{INVITE_WORD[state]}</span>
                  </td>
                  <td className="dim">{ago(invite.createdAt)}</td>
                  <td className={state === 'pending' ? 'dim' : 'dim admin-struck'}>{ago(invite.expiresAt)}</td>
                  <td>
                    {state === 'pending' && (
                      <button
                        className="key"
                        disabled={revoke.isPending && revoke.variables?.inviteId === invite.id}
                        onClick={() => revoke.mutate({ inviteId: invite.id })}
                      >
                        Revoke
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

// ------------------------------------------------------------------------------------------------
// The charges themselves.
// ------------------------------------------------------------------------------------------------

function Charges({
  query,
  months,
  focus,
  setFocus,
  users,
  projects,
}: {
  query: Loadable<UsageRow[]>;
  months: Months;
  focus: Focus;
  setFocus: (next: Focus) => void;
  users: AdminUser[];
  projects: AdminProject[];
}) {
  const [when, setWhen] = useState<'this' | 'last' | 'both'>('this');
  const [kind, setKind] = useState<string | null>(null);
  const [limit, setLimit] = useState(PAGE);

  const userName = new Map(users.map((u) => [u.id, u.displayName || u.email]));
  const projectName = new Map(projects.map((p) => [p.id, p.name]));

  const waiting = loadState(query, 'charges');
  if (waiting) return waiting;

  const rows = (query.data ?? [])
    .filter((row) => {
      if (focus?.kind === 'user' && row.userId !== focus.id) return false;
      if (focus?.kind === 'project' && row.projectId !== focus.id) return false;
      if (kind !== null && row.kind !== kind) return false;
      const at = Date.parse(row.occurredAt);
      if (when === 'this') return at >= months.currentStart;
      if (when === 'last') return at < months.currentStart;
      return true;
    })
    .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));

  const total = rows.reduce((sum, row) => sum + row.costUsd, 0);
  // Offered only when there is a choice to make. One kind of charge is the usual state, and a
  // filter with a single button in it is a control that cannot change anything.
  const kinds = [...new Set((query.data ?? []).map((row) => row.kind))].sort();
  const shown = rows.slice(0, limit);

  return (
    <>
      <div className="admin-tabs admin-filters">
        {(
          [
            ['this', 'This month'],
            ['last', 'Last month'],
            ['both', 'Both'],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            className={when === key ? 'admin-pill admin-pill-on' : 'admin-pill'}
            aria-pressed={when === key}
            onClick={() => setWhen(key)}
          >
            {label}
          </button>
        ))}
        {kinds.length > 1 &&
          kinds.map((name) => (
            <button
              key={name}
              className={kind === name ? 'admin-pill admin-pill-on' : 'admin-pill'}
              aria-pressed={kind === name}
              onClick={() => setKind(kind === name ? null : name)}
            >
              {name}
            </button>
          ))}
        {focus && (
          <button
            className="admin-pill admin-pill-on"
            onClick={() => setFocus(null)}
            title="Show every charge again"
          >
            {focus.kind === 'user' ? 'by' : 'in'} {focus.label}
            <Icon name="close" size={11} />
          </button>
        )}
        <span className="admin-note">
          {rows.length === 0
            ? 'nothing here'
            : `${rows.length} ${rows.length === 1 ? 'charge' : 'charges'}, ${charge(total)}`}
        </span>
      </div>

      {rows.length === 0 ? (
        <p className="dim">
          No charges in this window. Nothing else in the extension costs money — travel times,
          verdicts and sweeps are all free — so a quiet month here is not a quiet month.
        </p>
      ) : (
        <div className="admin-scroll">
          <table className="admin-table">
            <thead>
              <tr>
                <th>When</th>
                <th>Who</th>
                <th>Project</th>
                <th>For</th>
                <th>Model</th>
                <th>Tokens</th>
                <th className="num">Cost</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((row) => (
                <tr key={row.id}>
                  {/* A hundred charges in an afternoon all read "today", which is no order at all
                      when the question is which run cost that. The clock time says it; the hover
                      carries the date for a row the relative wording rounds. */}
                  <td className="dim" title={new Date(row.occurredAt).toLocaleString()}>
                    {ago(row.occurredAt)} {clock(row.occurredAt)}
                  </td>
                  <td>{named(row.userId, userName)}</td>
                  <td>{named(row.projectId, projectName)}</td>
                  <td>
                    {row.rightmoveId ? (
                      <a
                        href={listingUrl(row.rightmoveId)}
                        target="_blank"
                        rel="noopener"
                      >
                        {row.kind === 'analysis' ? `#${row.rightmoveId}` : `${row.kind} #${row.rightmoveId}`}
                      </a>
                    ) : (
                      <span className="dim">{row.kind}</span>
                    )}
                  </td>
                  <td className="dim">{row.model}</td>
                  {/* The three token counts are the whole explanation of the cost beside them, and
                      cached input is the one worth seeing: it is priced an order of magnitude
                      below full input, so a row with a lot of it is cheap for a reason. */}
                  <td className="dim admin-tokens">
                    {thousands(row.inputTokens)} in
                    {row.cachedInputTokens > 0 && ` · ${thousands(row.cachedInputTokens)} cached`}
                    {' · '}
                    {thousands(row.outputTokens)} out
                  </td>
                  {/* The stored figure to the cent, and the stored figure exactly on the hover.
                      Nothing here re-derives a cost from tokens and a price: a repricing must not
                      change what last month cost. */}
                  <td className="num" title={`$${row.costUsd.toFixed(6)} exactly`}>
                    {charge(row.costUsd)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* A month of a project in use is several hundred rows, and all of them at once is a page you
          scroll past rather than read. The total above counts every row, not the ones on screen —
          a figure that grew as you pressed this would be worse than no figure. */}
      {rows.length > shown.length && (
        <button className="key" onClick={() => setLimit(limit + PAGE)}>
          Show {Math.min(PAGE, rows.length - shown.length)} more of {rows.length}
        </button>
      )}
    </>
  );
}

/** How many charges a page of them is. */
const PAGE = 100;

/** The time of day, in the reader's own timezone — the part `ago` throws away. */
function clock(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  return at.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

/** Who or which project a charge belongs to, and the two different ways that can be missing.
 *
 *  A null reference means the row was deleted: `api_usage` nulls it rather than cascading,
 *  deliberately, because deleting a project must not erase the record of money spent. An id that
 *  is simply not in the list is something else — a list still loading, or a row RLS did not return
 *  — and calling that "deleted" would invent a fact. Both are absences and they are not the same
 *  absence. */
function named(id: string | null, names: Map<string, string>): ReactNode {
  if (id === null) {
    return (
      <span className="dim" title="Deleted since this was charged — the spend is kept either way">
        deleted
      </span>
    );
  }
  const name = names.get(id);
  if (name) return name;
  return (
    <span className="dim" title={`id ${id}`}>
      not listed
    </span>
  );
}

function thousands(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** An ISO timestamp as how long ago it was.
 *
 *  `relativeUpdate` in `lib/facts.ts` does this for Rightmove's own prose ("Reduced on
 *  31/07/2026"); this takes a timestamp, which is a different input and the only kind this view
 *  has. If a third caller appears, the wording belongs in one place rather than two. */
function ago(iso: string, now = new Date()): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return iso;
  const days = Math.floor((now.getTime() - then) / DAY_MS);
  if (days < 0) {
    // In the future: an invite's expiry, read before it runs out.
    const ahead = Math.ceil((then - now.getTime()) / DAY_MS);
    return ahead <= 1 ? 'tomorrow' : `in ${ahead} days`;
  }
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 14) return `${days} days ago`;
  if (days < 60) return `${Math.round(days / 7)} weeks ago`;
  const monthsAgo = Math.round(days / 30);
  return `${monthsAgo} month${monthsAgo === 1 ? '' : 's'} ago`;
}
