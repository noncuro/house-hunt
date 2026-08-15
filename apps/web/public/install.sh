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
# macOS and Linux. Windows is not supported and is not planned.

set -euo pipefail

# Where to fetch the zip from. The one-liner on the Install tab passes the site's own origin, so the
# same line works against production, a preview deployment and localhost. There is deliberately no
# default: guessing an origin would install from somewhere the reader did not ask for, and the copy
# they meant is one click away.
ORIGIN="${1:-${HOUSE_HUNT_ORIGIN:-}}"

CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/rightmove-house-hunt"
CONFIG="$CONFIG_DIR/install.conf"

case "$(uname -s)" in
  Darwin) DEFAULT_DIR="$HOME/Applications/rightmove-house-hunt" ;;
  Linux) DEFAULT_DIR="$HOME/.local/share/rightmove-house-hunt" ;;
  *) echo "This installer runs on macOS and Linux only. On Windows, download the zip from the Install tab and load it unpacked by hand." >&2; exit 1 ;;
esac

die() { echo "$*" >&2; exit 1; }

[ -n "$ORIGIN" ] || die "No site address given. Copy the one-liner from the Install tab of the house hunt — it carries the address this installs from."
ORIGIN="${ORIGIN%/}"

for tool in curl unzip; do
  command -v "$tool" >/dev/null 2>&1 || die "\`$tool\` is not installed, and this needs it."
done

# The saved location, so an update goes back to the folder Chrome is already loading rather than
# asking again and quietly leaving the old copy behind. `dir=` is the only key; anything else in the
# file is ignored.
saved=""
if [ -f "$CONFIG" ]; then
  saved="$(sed -n 's/^dir=//p' "$CONFIG" | tail -n 1)"
fi

announce=""
if [ -n "$saved" ]; then
  DIR="$saved"
  announce="Updating the copy at"
elif (: <> /dev/tty) 2>/dev/null; then
  # Read from the terminal, not stdin: piped into `bash`, stdin is the script itself. Whether there
  # is a terminal is tested by opening it in a subshell — `/dev/tty` exists and looks readable under
  # a service manager or a CI runner, and only opening it says so.
  printf 'Where should the extension live? [%s] ' "$DEFAULT_DIR" > /dev/tty
  IFS= read -r answer < /dev/tty || answer=""
  DIR="${answer:-$DEFAULT_DIR}"
else
  DIR="$DEFAULT_DIR"
  announce="No terminal to ask on, so installing to"
fi

# Said after expansion rather than before, so the line names the folder that is about to be written
# and not the `~/…` somebody typed a run ago.
case "$DIR" in
  "~") DIR="$HOME" ;;
  "~/"*) DIR="$HOME/${DIR#\~/}" ;;
esac
[ -n "$DIR" ] || die "No folder given."
[ -z "$announce" ] || echo "$announce $DIR"

# An existing folder is only ever replaced when it holds an extension. Somebody typing
# `~/Applications` when they meant `~/Applications/rightmove-house-hunt` would otherwise have the
# rest of it deleted, and the second run is the one where that is easiest to do.
first_install=1
if [ -e "$DIR" ]; then
  [ -d "$DIR" ] || die "$DIR exists and is not a folder."
  if [ -n "$(ls -A "$DIR" 2>/dev/null)" ]; then
    [ -f "$DIR/manifest.json" ] || die "$DIR is not empty and does not look like the extension (no manifest.json). Refusing to replace it — pick another folder."
    first_install=0
  fi
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "Downloading from $ORIGIN"
curl -fsSL "$ORIGIN/rightmove-house-hunt.zip" -o "$WORK/extension.zip" \
  || die "Could not download $ORIGIN/rightmove-house-hunt.zip"
unzip -q "$WORK/extension.zip" -d "$WORK/unpacked" || die "The download is not a readable zip."
[ -f "$WORK/unpacked/manifest.json" ] || die "The download has no manifest.json in it — that is not the extension."

# The version Chrome will show, read from the build itself rather than from anything this script or
# the page believes. `tr -d` first because the manifest ships minified but need not stay that way.
version="$(tr -d ' \n' < "$WORK/unpacked/manifest.json" | sed -n 's/.*[,{]"version":"\([^"]*\)".*/\1/p')"
[ -n "$version" ] || die "Could not read the version out of the downloaded manifest.json."

# Swap rather than unzip-over: a file dropped in a later build has to disappear from the folder
# Chrome reads, and unzipping on top would leave it there. The old copy is moved aside first and
# only deleted once the new one is in place, so a failure here leaves something loadable behind.
mkdir -p "$(dirname "$DIR")"
OLD=""
if [ "$first_install" -eq 0 ]; then
  OLD="$DIR.previous.$$"
  mv "$DIR" "$OLD"
fi
rm -rf "$DIR"
mv "$WORK/unpacked" "$DIR"
[ -z "$OLD" ] || rm -rf "$OLD"

mkdir -p "$CONFIG_DIR"
printf 'dir=%s\n' "$DIR" > "$CONFIG"

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
