#!/usr/bin/env bash
#
# Installs and updates the House hunt Chrome extension from the command line.
#
# Served as a static asset from the website (`/install.sh`) and run through the one-liner the
# Install tab hands out, so this file is both the source and the thing people execute — there is no
# copy step to forget, which is the failure the committed zip beside it already had once.
#
# It does the two steps of the manual instructions that are easy to get wrong: unzipping to a folder
# that will not move, and replacing the *contents* of that same folder on an update rather than
# leaving a second copy somewhere new. Chrome is still the one that loads it: an unpacked extension
# is read off disk by the browser, and nothing on this side can make Chrome re-read it, so the
# script ends by saying where to click and which version should appear once you have.
#
# Everything below lives in `main`, called on the last line. `curl … | bash` hands bash the bytes as
# they arrive and bash runs each command as it completes one, so a connection dropped halfway
# through would otherwise execute the first half of an installer — and the first half is the half
# that moves somebody's extension aside. A truncated copy of this file defines a function and a
# handful of helpers, calls none of them, and exits 0 having touched nothing.
#
# macOS and Linux. Windows is not supported and is not planned.

set -euo pipefail

die() { echo "$*" >&2; exit 1; }

# The three the traps read. Global rather than `local` to `main`, because an EXIT trap fires after
# `main` has returned and its locals are gone — under `set -u` the sweep would then die on an
# unbound variable instead of removing the staging folder.
DIR=""
STAGE=""
OLD=""

# What is left behind if this stops early. Before the destination is renamed away there is nothing
# to undo and this only sweeps the staging folder; between that rename and the new copy landing,
# putting the old one back is the whole job.
cleanup() {
  if [ -n "$OLD" ] && [ -d "$OLD" ] && [ ! -e "$DIR" ]; then
    mv "$OLD" "$DIR" && echo "Put the previous copy back at $DIR" >&2
  fi
  [ -z "$STAGE" ] || rm -rf "$STAGE"
}

# One field out of a Chrome manifest, without assuming a JSON parser is installed. Newlines go
# first because the manifest ships minified but need not stay that way; the spaces the pattern
# tolerates are the ones a formatter would add. Every manifest read here — ours and whatever is
# already sitting in the destination — goes through this, so a mismatch means the two files really
# differ rather than that one of them was formatted.
manifest_field() {
  tr -d '\n\r\t' < "$1" | sed -n "s/.*[,{][ ]*\"$2\"[ ]*:[ ]*\"\([^\"]*\)\".*/\1/p"
}

main() {
  # Where to fetch the zip from. The one-liner on the Install tab passes the site's own origin, so
  # the same line works against production, a preview deployment and localhost. There is
  # deliberately no default: guessing an origin would install from somewhere the reader did not ask
  # for, and the copy they meant is one click away.
  local ORIGIN="${1:-${HOUSE_HUNT_ORIGIN:-}}"

  local CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/rightmove-house-hunt"
  local CONFIG="$CONFIG_DIR/install.conf"

  # Written into every folder this script creates, so a later run can tell a folder it made from a
  # folder that merely happens to contain a manifest.json. The manifest check below is the one that
  # matters for a hand-unzipped copy; this one covers the folder whose contents got emptied out.
  local MARKER=".rightmove-house-hunt-install"

  local DEFAULT_DIR
  case "$(uname -s)" in
    Darwin) DEFAULT_DIR="$HOME/Applications/rightmove-house-hunt" ;;
    Linux) DEFAULT_DIR="$HOME/.local/share/rightmove-house-hunt" ;;
    *) die "This installer runs on macOS and Linux only. On Windows, download the zip from the Install tab and load it unpacked by hand." ;;
  esac

  [ -n "$ORIGIN" ] || die "No site address given. Copy the one-liner from the Install tab of the house hunt — it carries the address this installs from."
  ORIGIN="${ORIGIN%/}"
  # An origin and nothing else: a scheme, a host or a bracketed IPv6 literal, an optional port. Two
  # things want this narrow. curl reads a leading `-` as an option, so an argument that is not a URL
  # can turn a download into a flag; and the address is interpolated into shell words below, where
  # the brackets of an IPv6 origin are a glob that a matching pathname in the caller's working
  # directory would rewrite. Refusing anything that is not an origin settles both.
  [[ "$ORIGIN" =~ ^https?://([A-Za-z0-9._-]+|\[[0-9A-Fa-f:.]+\])(:[0-9]+)?$ ]] \
    || die "\"$ORIGIN\" is not a site address. It has to be an origin — http:// or https://, a host, an optional port — and the Install tab's one-liner already carries the right one."

  local tool
  for tool in curl unzip; do
    command -v "$tool" >/dev/null 2>&1 || die "\`$tool\` is not installed, and this needs it."
  done

  # The saved location, so an update goes back to the folder Chrome is already loading rather than
  # asking again and quietly leaving the old copy behind. `dir=` is the only key; anything else in
  # the file is ignored.
  local saved=""
  [ ! -L "$CONFIG" ] || die "$CONFIG is a symlink. This file records where your extension lives and is read and rewritten on every run — refusing to follow it."
  if [ -f "$CONFIG" ]; then
    saved="$(sed -n 's/^dir=//p' "$CONFIG" | tail -n 1)"
  fi

  local announce=""
  if [ -n "$saved" ]; then
    DIR="$saved"
    announce="Updating the copy at"
  elif (: <> /dev/tty) 2>/dev/null; then
    # Read from the terminal, not stdin: piped into `bash`, stdin is the script itself. Whether
    # there is a terminal is tested by opening it in a subshell — `/dev/tty` exists and looks
    # readable under a service manager or a CI runner, and only opening it says so.
    local answer
    printf 'Where should the extension live? [%s] ' "$DEFAULT_DIR" > /dev/tty
    IFS= read -r answer < /dev/tty || answer=""
    DIR="${answer:-$DEFAULT_DIR}"
  else
    DIR="$DEFAULT_DIR"
    announce="No terminal to ask on, so installing to"
  fi

  # Both branches above land here, which is the point: the prompt and the saved file are two ways
  # of naming the same folder and there must be one spelling of it downstream.
  #
  # shellcheck disable=SC2088  # the tilde is a literal being matched, not one meant to expand:
  # what arrives here is text somebody typed at a prompt, where the shell never saw it.
  case "$DIR" in
    "~") DIR="$HOME" ;;
    "~/"*) DIR="$HOME/${DIR#\~/}" ;;
  esac
  # A trailing slash is what a shell's own tab-completion offers, so it is typed constantly, and
  # kept verbatim it strands the install: `mv src dst/` requires dst to exist, so the rename that
  # puts the new copy in place fails *after* the old one has been moved aside, and the rollback
  # fails for exactly the same reason — leaving the only real copy under a random hidden
  # `.previous.*` name. The config is never reached, so the next run aims at the missing path and
  # fails identically. Normalised here, once, before anything has been read or written, and it is
  # this form that is stored. `${DIR%/}` in a loop rather than once because `dir//` is a path too;
  # `/` itself normalises to nothing and is refused on the next line, which is the right answer.
  while [ "$DIR" != "${DIR%/}" ]; do DIR="${DIR%/}"; done
  [ -n "$DIR" ] || die "No folder given."
  # Said after expansion rather than before, so the line names the folder that is about to be
  # written and not the `~/…` somebody typed a run ago.
  [ -z "$announce" ] || echo "$announce $DIR"

  local PARENT
  PARENT="$(dirname "$DIR")"
  mkdir -p "$PARENT" || die "Could not create $PARENT."

  # Staged beside the destination rather than in /tmp. `mktemp -d` lands on whatever filesystem the
  # system reserves for temporary files, which on Linux is routinely not the one $HOME is on, and
  # then the final `mv` is not a rename but a copy followed by a delete — interruptible, and
  # interrupted at the wrong moment it leaves a half-written extension where the old one used to
  # be. A sibling directory is on the destination's filesystem by construction, so the move that
  # puts the new copy in place is a single atomic rename.
  STAGE="$(mktemp -d "$PARENT/.rightmove-house-hunt.XXXXXX")" \
    || die "Could not create a staging folder next to $DIR."
  # Cleanup hangs off EXIT alone, and the signals only ask for an exit. A trap on INT returns to
  # the command after the one it interrupted, so cleaning up there would undo the swap and then
  # carry on doing it — restoring the old copy and immediately moving the new one *inside* it.
  trap cleanup EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM

  echo "Downloading from $ORIGIN"
  curl -fsSL "$ORIGIN/rightmove-house-hunt.zip" -o "$STAGE/extension.zip" \
    || die "Could not download $ORIGIN/rightmove-house-hunt.zip"
  # Every entry checked against the CRC the archive carries for it, before anything is unpacked.
  # This is the exact form of the question that used to be asked by guesswork — is what arrived
  # whole — and it is not one a truncated download, a cut connection or a proxy's error page can
  # answer wrongly.
  unzip -tq "$STAGE/extension.zip" >/dev/null 2>&1 \
    || die "The download did not survive the trip — the archive's own checksums do not match. Nothing has been changed; try again."
  unzip -q "$STAGE/extension.zip" -d "$STAGE/unpacked" || die "The download is not a readable zip."
  local NEW="$STAGE/unpacked"
  [ -f "$NEW/manifest.json" ] || die "The download has no manifest.json in it — that is not the extension."

  # A floor, and deliberately only a floor: an archive holding a manifest and nothing else passes
  # everything above — the CRC of one file is fine — and installing it replaces a working copy with
  # a folder Chrome refuses to load, reported as a success.
  #
  # What is no longer here is the check this used to carry: read the paths out of the manifest and
  # require each to be in the archive. Doing that correctly needs a JSON parser, and this script can
  # count on `curl` and `unzip` and nothing else. Every shell approximation of one has both false
  # negatives and false positives on manifests Chrome accepts — a `short_name` of `House.hunt` is
  # hunted for as a file, a path written `content-scripts\/panel.js` is legal JSON and is looked up
  # with the backslash still in it, a filename with a space is skipped in silence — and a false
  # positive here refuses a good install on somebody's laptop. So the exhaustive version lives in
  # `smoke:web`, which has a real parser, knows which fields hold paths, and refuses to guess at a
  # manifest shaped in a way it does not recognise. It runs against this same archive on every CI
  # run: the committed zip and the served zip are one file, so it covers what people download, and
  # it covers it before they download it.
  [ "$(find "$NEW" -type f | wc -l)" -gt 1 ] \
    || die "The download holds a manifest.json and nothing else — that is not a complete extension. Nothing has been changed; if it keeps happening the copy on $ORIGIN is broken."

  # The version Chrome will show, read from the build itself rather than from anything this script
  # or the page believes.
  local version name key
  version="$(manifest_field "$NEW/manifest.json" version)"
  [ -n "$version" ] || die "Could not read the version out of the downloaded manifest.json."
  name="$(manifest_field "$NEW/manifest.json" name)"
  key="$(manifest_field "$NEW/manifest.json" key)"

  # An existing folder is only ever replaced when it holds *this* extension. Somebody typing
  # `~/Applications` when they meant `~/Applications/rightmove-house-hunt` would otherwise have the
  # rest of it deleted, and the second run is the one where that is easiest to do. Testing for a
  # manifest.json alone was not enough for that: any other unpacked extension has one, and so does
  # any web project that happens to keep one, and this deletes what it replaces. The name and the
  # pinned `key` come from the copy being installed rather than from a constant here, so the two
  # answers cannot drift apart. A function because the question is asked twice — here, and again
  # immediately before the folder is renamed away.
  #
  # The manifest is what authorises the deletion, and the marker file is not a second way of
  # granting it. A marker is evidence that a folder was ours once: it is a file, so it copies, and
  # it survives the folder being emptied and put to another use. Letting it short-circuit the
  # identity check made any directory containing one deletable, which is the same hole as trusting
  # a bare manifest.json, arrived at from the other side. So it answers only the case it exists
  # for — a folder this script wrote whose manifest a failed run or a bad build has taken away —
  # and even then only if every last thing in the folder is something the build being installed
  # would itself have put there. One stray file of somebody's own and this is not that folder.
  # The whole tree, not the first level of it. Matching top-level names only was a hole of the
  # same shape as the one above: a folder holding `icon/private.txt` passes a check that asks
  # whether the build has an `icon`, and the folder is then deleted with that file in it.
  holds_only_build_files() {
    local entry
    while IFS= read -r entry; do
      entry="${entry#./}"
      if [ "$entry" != "$MARKER" ] && [ ! -e "$NEW/$entry" ]; then return 1; fi
    done < <(cd "$1" && find . -mindepth 1)
  }
  is_ours() {
    [ -d "$1" ] || return 1
    [ ! -L "$1" ] || return 1
    if [ -f "$1/manifest.json" ] && [ -n "$(manifest_field "$1/manifest.json" name)" ]; then
      [ "$(manifest_field "$1/manifest.json" name)" = "$name" ] || return 1
      [ "$(manifest_field "$1/manifest.json" key)" = "$key" ]
      return
    fi
    [ -e "$1/$MARKER" ] || return 1
    holds_only_build_files "$1"
  }

  local first_install=1
  if [ -e "$DIR" ]; then
    [ ! -L "$DIR" ] || die "$DIR is a symlink. Point this at a real folder — the install replaces the folder, and following a link would replace something else."
    [ -d "$DIR" ] || die "$DIR exists and is not a folder."
    if [ -n "$(ls -A "$DIR" 2>/dev/null)" ]; then
      if ! is_ours "$DIR"; then
        if [ -f "$DIR/manifest.json" ]; then
          die "$DIR holds a manifest.json for something else, not House hunt. Refusing to replace it — pick another folder."
        fi
        if [ -e "$DIR/$MARKER" ]; then
          die "$DIR carries this installer's marker but also holds files that are not part of the extension, and no manifest.json to identify it by. Refusing to replace it — pick another folder."
        fi
        die "$DIR is not empty and does not look like the extension (no manifest.json). Refusing to replace it — pick another folder."
      fi
      first_install=0
    fi
  fi

  printf 'Installed by %s/install.sh — version %s\n' "$ORIGIN" "$version" > "$NEW/$MARKER"

  # Swap rather than unzip-over: a file dropped in a later build has to disappear from the folder
  # Chrome reads, and unzipping on top would leave it there. The old copy is moved aside first and
  # only deleted once the new one is in place, so a failure here leaves something loadable behind.
  if [ "$first_install" -eq 0 ]; then
    # Everything the destination was checked for happened before a download that takes as long as
    # the network takes, which is long enough for the folder to have become something else. Asked
    # again here, a step before it is renamed away.
    is_ours "$DIR" \
      || die "$DIR changed while the download was running and no longer looks like House hunt. Nothing has been touched — run this again."

    # `mv "$DIR" "$OLD"` puts the extension *inside* $OLD if that name is already a directory, and
    # the `rm -rf "$OLD"` at the end would then delete whatever else was in there. `mktemp -d`
    # creates the name or fails, which is the only way to be sure it was not already taken; it is
    # removed a line later so the rename has somewhere to land.
    OLD="$(mktemp -d "$PARENT/.rightmove-house-hunt.previous.XXXXXX")" \
      || die "Could not reserve a name to move the old copy to."
    rmdir "$OLD"
    # From here `cleanup` has a rollback to do. Between the `rmdir` and this `mv` the name exists
    # but nothing is at it, and `cleanup` tests for that rather than for $OLD alone.
    mv "$DIR" "$OLD" || die "Could not move the existing copy at $DIR out of the way."
  elif [ -e "$DIR" ]; then
    # Empty, or this would have been an update. `rmdir` rather than `rm -rf`: it refuses anything
    # with contents, so a destination that gained a file between the check and here stops the run
    # instead of being deleted by a wildcard.
    rmdir "$DIR" || die "$DIR is no longer empty. Nothing has been touched — run this again."
  fi

  mv "$NEW" "$DIR" || die "Could not put the new copy in place at $DIR."
  # The only path that ever deletes recursively, and the folder it deletes is one this script
  # created exclusively and renamed the destination onto two lines ago.
  if [ -n "$OLD" ]; then
    rm -rf "$OLD"
    OLD=""
  fi

  mkdir -p "$CONFIG_DIR"
  # Through a temporary file and a rename, because `>` follows a symlink and would write this
  # wherever one pointed. A rename replaces the link itself.
  printf 'dir=%s\n' "$DIR" > "$CONFIG.tmp.$$"
  mv -f "$CONFIG.tmp.$$" "$CONFIG"

  echo
  echo "House hunt v$version is now in $DIR"
  echo
  echo "Chrome has to be told to re-read it — nothing here can do that for you:"
  echo
  if [ "$first_install" -eq 1 ]; then
    echo "  1. Open chrome://extensions"
    echo "  2. Turn on Developer mode, top right"
    echo "  3. Click 'Load unpacked' and pick:"
    echo "       $DIR"
    echo "  4. Check the card says House hunt $version"
    echo "  5. Click the extension's icon, sign in on the website, then open any Rightmove listing"
  else
    echo "  1. Open chrome://extensions"
    echo "  2. Click Reload on the House hunt card"
    echo "  3. Check the card now says $version — if it still shows the old number, the reload did not take"
    echo "  4. Reload any Rightmove tab you had open"
  fi
  echo
  echo "Leave the folder where it is; Chrome loads it from there every time it starts."
}

main "$@"
