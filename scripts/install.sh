#!/usr/bin/env bash
# Install jade-theme and the Jade Shell extension for the current user.
set -euo pipefail
[[ $(id -u) != 0 ]] || { echo 'Run without sudo'; exit 1; }
[[ $(gnome-shell --version) == 'GNOME Shell 50.'* ]] || { echo 'Jade Shell is tested on GNOME 50 only'; exit 1; }
source_dir=$(cd -- "$(dirname -- "$0")/.." && pwd)
uuid=jade-shell@parvezrob.github.io
lib_dir="$HOME/.local/lib/jade-shell"
extension_dir="$HOME/.local/share/gnome-shell/extensions/$uuid"

rm -rf "$lib_dir" "$extension_dir"
mkdir -p "$lib_dir" "$extension_dir" "$HOME/.local/bin"
cp -a "$source_dir"/{jade_theme,themes,templates,bin} "$lib_dir/"
find "$lib_dir" -name __pycache__ -prune -exec rm -rf {} +
ln -sfn "$lib_dir/bin/jade-theme" "$HOME/.local/bin/jade-theme"
cp -a "$source_dir/extension/." "$extension_dir/"
glib-compile-schemas --strict "$extension_dir/schemas"

echo 'Downloading theme previews…'
"$HOME/.local/bin/jade-theme" thumbs >/dev/null

if ! gnome-extensions enable "$uuid" 2>/dev/null; then
 python3 - "$uuid" <<'PY'
import sys
from gi.repository import Gio
s = Gio.Settings.new('org.gnome.shell'); v = s.get_strv('enabled-extensions')
if sys.argv[1] not in v:
    s.set_strv('enabled-extensions', v + [sys.argv[1]]); Gio.Settings.sync()
PY
 echo 'Log out and back in to load the Jade Shell extension.'
fi
echo 'Preview a theme with: jade-theme plan osaka-jade   Apply with: jade-theme set osaka-jade'
