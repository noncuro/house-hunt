# Sweeping from a machine nobody is sitting at

`pnpm sweep` runs one full sweep — scan, fill in, re-check — by driving the button on the Triage
tab in a real Chrome with the real extension loaded. `tools/sweep-runner.ts` is the whole of it, and
its header says why an unattended sweep has to take this shape rather than being a server job.

The short version: `runFullSweep` is the website's own JavaScript, and the only thing permitted to
open a Rightmove page is the extension. Automating the *press* is the only part that was missing.

## What the mini PC needs

- **Chrome, via Playwright.** `pnpm install` then `pnpm exec playwright install chromium` — the
  runner uses Playwright's own Chromium, the same one the smoke harnesses use.
- **A display.** MV3 extensions and headless Chrome are not worth the fight, so the runner is
  headed. On a box with no monitor that means `xvfb-run` (`apt install xvfb`), which is a display
  like any other as far as Chrome is concerned.
- **The extension on disk**, installed by the same one-liner everybody else uses:

  ```bash
  curl -fsSL https://<your-site>/install.sh | bash -s -- https://<your-site>
  ```

  With no terminal to ask on — under a systemd unit, say — it installs to
  `~/.local/share/rightmove-house-hunt` without prompting, and records that path in
  `~/.config/rightmove-house-hunt/install.conf`. The runner reads that file, so the two cannot end
  up pointing at different copies.

The repo itself is needed only for `tools/` and `node_modules`; nothing is built on the mini PC and
the extension is never built there — the zip in `apps/web/public/` is the artefact, and `install.sh`
fetches it from the site.

## Signing in, once

```bash
export SWEEP_ORIGIN=https://<your-site>
pnpm sweep:sign-in
```

A browser window opens on the Triage tab. Sign in with the email your invite went to. The window
closes itself once the **sweep button appears**, which is the signal worth waiting for: that button
renders only when the *extension* reports `signed-in`, and the extension only learns that through
the bridge after the website session exists — so one condition proves both sessions, in the same
state the nightly run needs them.

This needs a screen. Over SSH, either `ssh -X` or start `x11vnc` against the Xvfb display and
connect to it once.

Everything lands in `~/.local/share/rightmove-house-hunt-profile`. Back that directory up and you
have backed up the sign-in; delete it and you are doing this step again.

## Running it nightly

```ini
# ~/.config/systemd/user/house-hunt-sweep.service
[Unit]
Description=House hunt — nightly sweep
After=network-online.target

[Service]
Type=oneshot
WorkingDirectory=%h/cc/house-hunt
Environment=SWEEP_ORIGIN=https://<your-site>
# Update before launch, never during. Chrome reads an unpacked extension off disk at startup, so
# a fresh launch *is* the reload that `install.sh` cannot do by itself — which is why this is an
# ExecStartPre and not a separate timer that could land mid-sweep.
ExecStartPre=/bin/bash -c 'curl -fsSL ${SWEEP_ORIGIN}/install.sh | bash -s -- ${SWEEP_ORIGIN}'
ExecStart=/usr/bin/xvfb-run -a --server-args="-screen 0 1400x1000x24" /usr/bin/env pnpm sweep
TimeoutStartSec=4h
```

```ini
# ~/.config/systemd/user/house-hunt-sweep.timer
[Unit]
Description=House hunt — nightly sweep

[Timer]
OnCalendar=*-*-* 03:20:00
Persistent=true
RandomizedDelaySec=30m

[Install]
WantedBy=timers.target
```

```bash
systemctl --user enable --now house-hunt-sweep.timer
loginctl enable-linger $USER          # so it runs with nobody logged in
journalctl --user -u house-hunt-sweep -f
```

`Persistent=true` catches up a run missed while the machine was off. `RandomizedDelaySec` keeps the
sweep off a round number, which is a courtesy to the site being read.

## Settings

| Variable | Default | What it is |
|---|---|---|
| `SWEEP_ORIGIN` | *(none — required)* | Your house hunt's address. Deliberately has no default: guessing one would sweep somebody else's deployment. |
| `SWEEP_EXTENSION` | the folder `install.sh` recorded | The unpacked extension Chrome loads. |
| `SWEEP_PROFILE` | `~/.local/share/rightmove-house-hunt-profile` | The Chrome profile holding both sessions. |
| `SWEEP_BUDGET_MINUTES` | `180` | When to abandon a run as hung. Not a schedule — see below. |
| `SWEEP_SIGN_IN_MINUTES` | `15` | How long `--sign-in` waits for a person. |

The pace between tabs is **not** set here. It is the opener's own setting, on the Triage tab, and it
is the same number whether a person or a timer pressed the button. That is deliberate: a runner with
its own faster pace would be a crawler wearing the button's clothes.

## When it goes wrong

The runner prints the extension version it loaded on every line-one, because "which build was that"
is the first question about any sweep that behaved oddly, and an unpacked copy carries no other
evidence of its age.

**"The sweep button is not on the page"** — it prints what the page says instead, which is one of
four sentences the screen already writes: no extension, extension signed out, extension broken, or
the page never got that far. Fix the one it names.

**"The sweep button is there but disabled"** — the hunt has nothing to sweep, and the button's own
small print says which: no Rightmove filters saved, or no place ticked "search around".

**"Still running after N minutes"** — usually timer throttling. The runner passes
`--disable-background-timer-throttling`, `--disable-backgrounding-occluded-windows` and
`--disable-renderer-backgrounding` for exactly this, because a throttled sweep does not fail, it
crawls — one tick a minute — and reads from the log like a slow night on Rightmove. If those flags
are in place and it still hangs, find out why before raising the budget.

Nothing is lost by a run that stops early, however it stops. Every page already opened was recorded,
and the rest is waiting for the next run — the same promise the button makes to a person who closes
the tab.

## What this is not

It sweeps **the active project of the signed-in account**, which is one hunt. Sweeping several would
mean an account that is a member of each (`active_project_id` is a column on `profile`, so switching
is per-user and the runs are serial), and a hunt holds six people, so a service account costs one of
those seats. None of that is built.
