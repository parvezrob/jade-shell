#!/usr/bin/env bash
# Inside a fresh Fedora or Ubuntu container: install the package with the
# system package manager, set up a desktop user's settings with it, restore,
# and remove it. Run by scripts/test-packages.sh (and CI).
set -euo pipefail
. /etc/os-release
step() { printf '\n=== %s\n' "$*"; }

step "install on $PRETTY_NAME"
case $ID in
    fedora) dnf install -y -q /pkg/jade-shell.rpm glib2 gsettings-desktop-schemas util-linux ;;
    ubuntu) export DEBIAN_FRONTEND=noninteractive
            apt-get update -qq && apt-get install -y -qq /pkg/jade-shell.deb libglib2.0-bin gsettings-desktop-schemas >/dev/null ;;
esac
jade --version
test -f /usr/share/gnome-shell/extensions/jade-shell@parvezrob.github.io/schemas/gschemas.compiled
gnome-shell --version

step 'setup as a desktop user (no session: keyfile settings, systemctl stubbed)'
useradd -m robin 2>/dev/null || true
mkdir -p /stub && printf '#!/bin/sh\necho "systemctl $*" >> /tmp/systemctl.log\n' > /stub/systemctl && chmod +x /stub/systemctl
as_user() { runuser -u robin -- env HOME=/home/robin GSETTINGS_BACKEND=keyfile PATH=/stub:/usr/bin:/bin "$@"; }
as_user gsettings set org.gnome.shell enabled-extensions "['openbar@neuromorph']"
as_user jade setup
as_user gsettings get org.gnome.shell enabled-extensions
as_user jade theme current | grep -qx osaka-jade
grep -q 'popup-menu-content.jade-frame' /home/robin/.local/state/jade-shell/gnome-shell.css
test "$(ls /home/robin/.local/state/jade-shell/thumbs | wc -l)" -ge 17
as_user jade theme set tokyo-night | tail -1
as_user jade doctor || true

step 'restore'
as_user jade restore --yes
as_user gsettings get org.gnome.shell enabled-extensions | grep -q "openbar@neuromorph"
as_user jade theme current | grep -qx none

step 'remove'
case $ID in
    fedora) dnf remove -y -q jade-shell ;;
    ubuntu) apt-get remove -y -qq jade-shell >/dev/null ;;
esac
test ! -e /usr/bin/jade && test ! -e /usr/share/jade-shell
echo 'PASS'
