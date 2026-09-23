#!/usr/bin/env bash
# Remove Jade Shell. Themed settings stay as they are; run `jade-theme undo`
# first (repeatedly) to walk back to the look you had before.
set -euo pipefail
uuid=jade-shell@parvezrob.github.io
gnome-extensions disable "$uuid" 2>/dev/null || true
rm -rf "$HOME/.local/share/gnome-shell/extensions/$uuid" "$HOME/.local/lib/jade-shell"
rm -f "$HOME/.local/bin/jade-theme"
echo "Removed. Backups and generated styles remain in ${XDG_STATE_HOME:-$HOME/.local/state}/jade-shell."
