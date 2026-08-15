'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Icon, type IconName } from '@house-hunt/ui';
import { authState, renameProject, setActiveProject } from '@house-hunt/core/db';
import type { AuthState, ProjectSummary, SessionUser } from '@house-hunt/core';
import { InlineName } from '@/components/InlineName';
import { Menu } from '@/components/Menu';
import { keys, useSignOut } from '@/lib/queries';
import type { View } from '@/lib/view';

/** The top of every screen, and the same top on every screen.
 *
 *  It used to be three headings stacked: an H1 with the hunt's name, a switcher a line below saying
 *  the same name again, and then the page's own subject. The tab row landed centred under the counts
 *  on two screens and pinned top-right on two others — width-driven reflow rather than intent, so
 *  the one control that is in the same place on every website moved as you used it.
 *
 *  One 44px row now. The hunt's name *is* the switcher and the rename — it is the control that
 *  decides what every other screen is showing, so it takes the position a title would have had
 *  rather than sitting beside one. Then the destinations, left-aligned on the page grid. Then the
 *  account, at the far right, holding the three things that are about this browser rather than about
 *  the hunt: who you are, getting the extension, and leaving.
 *
 *  The counts line went with the H1. "21 loved · 27 liked · 110 not yet rated" was inert text that
 *  looked exactly like the filter chips a few rows below it and could not be clicked; the chips on
 *  Places carry those numbers now, and clicking one does what it looks like it does. */

/** Where a badge is worth drawing, which is only where there is work waiting. A `0` beside every
 *  destination is four numbers that never change and one that matters. */
export interface Destination {
  view: View;
  label: string;
  icon: IconName;
  hint: string;
  badge?: number;
}

export function Shell({
  user,
  project,
  projects,
  destinations,
  view,
  setView,
  notify,
  children,
}: {
  user: SessionUser;
  project: ProjectSummary;
  projects: ProjectSummary[];
  destinations: Destination[];
  view: View;
  setView: (next: View) => void;
  notify: (message: string) => void;
  children: React.ReactNode;
}) {
  const client = useQueryClient();
  const signOut = useSignOut();

  const rename = useMutation({
    mutationFn: async (next: string) => await renameProject(project.id, next),
    onSuccess: async () => await client.invalidateQueries({ queryKey: keys.auth }),
    onError: (e: Error) => notify(`Not renamed — ${e.message}`),
  });

  /** Switching hunts throws away everything read under the old one.
   *
   *  `setQueryData` then `resetQueries`, never `clear()` — see the long note on `useSignOut`. Reset
   *  keeps the observers attached and hands them `undefined`, so the previous hunt's flats are
   *  blanked rather than left painted while a refetch lands. */
  const switchHunt = useMutation({
    mutationFn: async (projectId: string) => {
      await setActiveProject(projectId);
      return await authState();
    },
    onSuccess: (state) => {
      client.setQueryData<AuthState>(keys.auth, state);
      void client.resetQueries({ predicate: (query) => query.queryKey[0] !== keys.auth[0] });
    },
    onError: (e: Error) => notify(`Not switched — ${e.message}`),
  });

  return (
    <>
      <header className="shell" data-testid="shell">
        <HuntName
          project={project}
          projects={projects}
          busy={rename.isPending || switchHunt.isPending}
          onRename={(next) => rename.mutateAsync(next).catch(() => {})}
          onSwitch={(id) => switchHunt.mutate(id)}
        />

        <span className="shell-rule" aria-hidden="true" />

        {/* One row of destinations, left-aligned, identical on every screen. The mobile tab bar at
            the foot draws the same list — one array, so the two cannot come to hold different
            places to go. */}
        <nav className="shell-nav" aria-label="Sections">
          {destinations.map((d) => (
            <button
              key={d.view}
              type="button"
              className={view === d.view ? 'shell-tab shell-tab-on' : 'shell-tab'}
              aria-current={view === d.view ? 'page' : undefined}
              title={d.hint}
              data-testid={`nav-${d.view}`}
              onClick={() => setView(d.view)}
            >
              {d.label}
              {d.badge !== undefined && d.badge > 0 && <span className="shell-badge">{d.badge}</span>}
            </button>
          ))}
        </nav>

        <Menu
          className="shell-account"
          align="right"
          title={user.displayName}
          label={<span className="avatar">{initialsOf(user.displayName)}</span>}
        >
          {(close) => (
            <>
              <div className="menu-head">
                <strong>{user.displayName}</strong>
                {user.displayName !== user.email && <span className="dim">{user.email}</span>}
              </div>
              <button
                type="button"
                className="menu-item"
                data-testid="account-you"
                onClick={() => {
                  setView('settings');
                  close();
                }}
              >
                You
              </button>
              {/* Load-unpacked on a handful of laptops, so this is a real destination rather than a
                  link to a store — see `screens/Install.tsx`. Desktop only: there is no Chrome to
                  load it into on a phone, which is why the tab bar below does not carry it. */}
              <button
                type="button"
                className="menu-item shell-desktop-only"
                data-testid="account-install"
                onClick={() => {
                  setView('install');
                  close();
                }}
              >
                Install the extension
              </button>
              <button
                type="button"
                className="menu-item menu-item-quiet"
                disabled={signOut.isPending}
                data-testid="account-sign-out"
                onClick={() => signOut.mutate()}
              >
                {signOut.isPending ? 'Signing out…' : 'Sign out'}
              </button>
            </>
          )}
        </Menu>
      </header>

      {children}

      {/* The phone's navigation. Same destinations, minus the two that need a desktop: Admin is a
          table of money six columns wide, and the extension cannot be installed on a phone at all.
          A `<nav>` rather than a bar of links so it is one landmark to skip past. */}
      <nav className="tabbar" aria-label="Sections">
        {destinations
          .filter((d) => d.view !== 'admin')
          .map((d) => (
            <button
              key={d.view}
              type="button"
              className={view === d.view ? 'tabbar-tab tabbar-tab-on' : 'tabbar-tab'}
              aria-current={view === d.view ? 'page' : undefined}
              onClick={() => setView(d.view)}
            >
              <Icon name={d.icon} size={20} />
              {d.label}
              {d.badge !== undefined && d.badge > 0 && <span className="tabbar-badge">{d.badge}</span>}
            </button>
          ))}
      </nav>
    </>
  );
}

/** The hunt's name, doing three jobs: saying which hunt you are in, switching to another, and
 *  being renamed in place.
 *
 *  The chevron is only drawn when there is more than one hunt, because a picker with one option is a
 *  question with one answer — but the rename is always there, which is why this is a menu rather
 *  than the `<select>` it used to be. */
function HuntName({
  project,
  projects,
  busy,
  onRename,
  onSwitch,
}: {
  project: ProjectSummary;
  projects: ProjectSummary[];
  busy: boolean;
  onRename: (next: string) => void;
  onSwitch: (projectId: string) => void;
}) {
  if (projects.length < 2) {
    return (
      <h1 className="shell-hunt">
        <InlineName value={project.name} label="this house hunt" busy={busy} onSave={onRename} />
      </h1>
    );
  }

  return (
    <h1 className="shell-hunt">
      <Menu
        className="hunt-switch"
        title="Which house hunt"
        label={
          <>
            <span className="hunt-name">{project.name}</span>
            <Icon name="chevron" size={11} />
          </>
        }
      >
        {(close) => (
          <>
            {projects.map((p) => (
              <button
                key={p.id}
                type="button"
                className={p.id === project.id ? 'menu-item menu-item-on' : 'menu-item'}
                disabled={busy}
                onClick={() => {
                  if (p.id !== project.id) onSwitch(p.id);
                  close();
                }}
              >
                {p.name}
                {p.id === project.id && <Icon name="tick" size={13} />}
              </button>
            ))}
            <div className="menu-foot">
              <InlineName value={project.name} label="this house hunt" busy={busy} onSave={onRename} />
            </div>
          </>
        )}
      </Menu>
    </h1>
  );
}

/** One or two letters for the avatar. Words rather than characters, so a two-part name gives one
 *  letter from each and a one-word name gives its first — slicing the string would have given the
 *  first two letters of the first word for both, and an ampersand for anyone joined by one. */
function initialsOf(name: string): string {
  const letters = name
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .map((word) => word[0]!.toUpperCase());
  return letters.slice(0, 2).join('') || '?';
}
