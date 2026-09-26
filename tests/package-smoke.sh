#!/usr/bin/env bash
# Inside a fresh Fedora or Ubuntu container: install the package with the
# system package manager, set up a desktop user's settings with it, restore,
# and remove it. Run by scripts/test-packages.sh (and CI).
set -euo pipefail
# shellcheck source=/dev/null
. /etc/os-release
step() { printf '\n=== %s\n' "$*"; }

step "install on $PRETTY_NAME"
case $ID in
    fedora) dnf install -y -q /pkg/jade-shell.rpm glib2 gsettings-desktop-schemas util-linux ;;
    ubuntu) export DEBIAN_FRONTEND=noninteractive
            apt-get update -qq && apt-get install -y -qq /pkg/jade-shell.deb libglib2.0-bin gsettings-desktop-schemas >/dev/null ;;
esac
jade --version
test -d /usr/share/jade-shell/jade/__pycache__  # byte-compiled by the postinstall script
# A jade.py in the current directory must not replace the installed jade.
(cd "$(mktemp -d)" && echo 'raise SystemExit("ran ./jade.py")' > jade.py && jade --version)
test -f /usr/share/gnome-shell/extensions/jade-shell@parvezrob.github.io/schemas/gschemas.compiled
gnome-shell --version

step 'setup as a desktop user (no session: keyfile settings, systemctl stubbed)'
useradd -m robin 2>/dev/null || true
mkdir -p /stub && printf '#!/bin/sh\necho "systemctl $*" >> /tmp/systemctl.log\n' > /stub/systemctl && chmod +x /stub/systemctl
as_user() { runuser -u robin -- env HOME=/home/robin GSETTINGS_BACKEND=keyfile PATH=/stub:/usr/bin:/bin "$@"; }
as_user gsettings set org.gnome.shell enabled-extensions "['openbar@neuromorph']"
# Wallpapers come from Omarchy's repository, and jade only downloads one that
# is missing: a tiny local image in each theme's first wallpaper's place keeps
# this test off the network. It is a PNG whatever the name says, as image
# loading goes by the content.
as_user python3 - <<'EOF'
import pathlib
import struct
import zlib


def chunk(kind, data):
    return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data))


width, height = 16, 10
rows = b''.join(b'\0' + b'\x1f\x6f\x5a' * width for _ in range(height))  # filter byte, then RGB pixels
png = (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 2, 0, 0, 0))
       + chunk(b'IDAT', zlib.compress(rows)) + chunk(b'IEND', b''))
for listing in pathlib.Path('/usr/share/jade-shell/themes').glob('*/backgrounds.txt'):
    names = listing.read_text().split()
    if names:
        path = pathlib.Path.home() / '.local/share/jade-shell/backgrounds' / listing.parent.name / names[0]
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(png)
EOF
# No download either for the Tahoe icons: the package's own copy, where it lies.
as_user env https_proxy=http://127.0.0.1:9 jade setup
as_user gsettings get org.gnome.shell enabled-extensions
test -f /home/robin/.local/share/icons/Jade-MacTahoe/.jade-source
test -f /home/robin/.local/share/icons/Jade-MacTahoe-dark/index.theme
test -z "$(find /home/robin/.local/share/icons /home/robin/.cache -maxdepth 2 -name '.MacTahoe-*' -print -quit)" \
    || { echo 'the icon build left files behind'; exit 1; }
as_user jade theme current | grep -qx osaka-jade
grep -q 'popup-menu-content.jade-frame' /home/robin/.local/state/jade-shell/gnome-shell.css
as_user gsettings get org.gnome.desktop.background picture-uri \
    | grep -q "file:///home/robin/.local/share/jade-shell/backgrounds/osaka-jade/"
# With every wallpaper local, every theme gets a preview.
for listing in /usr/share/jade-shell/themes/*/backgrounds.txt; do
    tid=$(basename "$(dirname "$listing")")
    test -f "/home/robin/.local/state/jade-shell/thumbs/$tid.png" || { echo "setup made no preview for $tid"; exit 1; }
done
as_user jade theme set tokyo-night | tail -1
as_user gsettings get org.gnome.desktop.background picture-uri \
    | grep -q "file:///home/robin/.local/share/jade-shell/backgrounds/tokyo-night/"
# Nothing was downloaded: every wallpaper is still one of the tiny local ones.
test -z "$(find /home/robin/.local/share/jade-shell/backgrounds -type f -size +1k -print -quit)" \
    || { echo 'jade downloaded a wallpaper'; exit 1; }
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
