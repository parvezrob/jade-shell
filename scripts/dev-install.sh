#!/usr/bin/env bash
# Install this checkout for the current user, for development: `jade` in
# ~/.local/bin and the extension in ~/.local/share/gnome-shell/extensions
# (which takes precedence over a package's copy). Then run `jade setup`.
# Needs the same dependencies as the package, sassc above all.
set -euo pipefail
[[ $EUID -ne 0 ]] || { echo 'Run without sudo' >&2; exit 1; }
root=$(cd -- "$(dirname -- "$0")/.." && pwd)
uuid=jade-shell@parvezrob.github.io
lib_dir="$HOME/.local/share/jade-shell/lib"
extension_dir="$HOME/.local/share/gnome-shell/extensions/$uuid"

rm -rf "$lib_dir" "$extension_dir"
mkdir -p "$lib_dir" "$extension_dir" "$HOME/.local/bin"
cp -a "$root"/{bin,jade,themes,templates,shell-theme} "$lib_dir/"
find "$lib_dir" -name __pycache__ -prune -exec rm -rf {} +
ln -sfn "$lib_dir/bin/jade" "$HOME/.local/bin/jade"
cp -a "$root/extension/." "$extension_dir/"
glib-compile-schemas --strict "$extension_dir/schemas"

# Leftovers of the versions before Jade Shell and Jade AI Usage merged.
rm -rf "$HOME/.local/lib/jade-shell" "$HOME/.local/lib/osaka-ai-usage"
rm -f "$HOME/.local/bin/jade-theme"

echo "Installed $("$HOME/.local/bin/jade" --version) for $USER. Next: jade setup"
