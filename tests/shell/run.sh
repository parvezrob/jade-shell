#!/usr/bin/env bash
# Screenshot Jade Shell's panels in a throwaway headless GNOME Shell:
#
#   tests/shell/run.sh [out-dir]          JADE_THEMES=osaka-jade,nord tests/shell/run.sh
#
# Everything is private to a temporary HOME: XDG dirs, a keyfile GSettings
# backend, its own session bus and its own XDG_RUNTIME_DIR (GNOME keeps a crash
# marker there; one left in the real runtime dir makes the next login disable
# every extension). Needs sassc (or python libsass) like the package does.
set -euo pipefail
root=$(cd -- "$(dirname -- "$0")/../.." && pwd)
out=$(realpath -m "${1:-$root/build/shell-shots}")
work=$(mktemp -d)
runtime=$(mktemp -d /tmp/jade-rt.XXXX)  # short: a Wayland socket path must fit 108 bytes
chmod 700 "$runtime"
cleanup() {
    [[ -n ${shell_pid:-} ]] && kill -- -"$shell_pid" 2>/dev/null
    chmod -R u+w "$work" 2>/dev/null
    rm -rf "$work" "$runtime"
}
trap cleanup EXIT

home=$work/home
ext=$home/.local/share/gnome-shell/extensions
mkdir -p "$out" "$ext" "$home/.local/bin" "$home/.config/glib-2.0/settings" "$home/.local/state/jade-shell"
rm -f "$out"/*.png "$out/done"
cp -a "$root/extension" "$ext/jade-shell@parvezrob.github.io"
glib-compile-schemas "$ext/jade-shell@parvezrob.github.io/schemas"
cp -a "$root/tests/shell/harness" "$ext/jade-shell-harness@local"
ln -s "$root/bin/jade" "$home/.local/bin/jade"
# Reuse this machine's previews, wallpapers and usage records when there are any.
for dir in .local/state/jade-shell/thumbs .local/share/jade-shell/backgrounds .cache/jade-shell/usage/records; do
    if [[ -d $HOME/$dir ]]; then mkdir -p "$(dirname "$home/$dir")"; cp -a "$HOME/$dir" "$home/$dir"; fi
done
if [[ -n ${JADE_RECORDS:-} ]]; then  # usage records to show, e.g. from an older install
    mkdir -p "$home/.cache/jade-shell/usage"; cp -a "$JADE_RECORDS" "$home/.cache/jade-shell/usage/records"
fi
[[ -d $home/.cache/jade-shell/usage/records ]] && chmod -R a-w "$home/.cache/jade-shell/usage/records"  # no refresh without sign-in
printf "[org/gnome/shell]\nenabled-extensions=['jade-shell@parvezrob.github.io', 'jade-shell-harness@local']\ndisable-user-extensions=false\nwelcome-dialog-last-shown-version='999'\n" \
    > "$home/.config/glib-2.0/settings/keyfile"

export HOME=$home XDG_RUNTIME_DIR=$runtime XDG_DATA_HOME=$home/.local/share XDG_CONFIG_HOME=$home/.config \
    XDG_CACHE_HOME=$home/.cache XDG_STATE_HOME=$home/.local/state GSETTINGS_BACKEND=keyfile JADE_SHOTS=$out
unset WAYLAND_DISPLAY DISPLAY DBUS_SESSION_BUS_ADDRESS
"$home/.local/bin/jade" theme set osaka-jade --only gnome,shell >/dev/null

setsid dbus-run-session -- gnome-shell --headless --no-x11 --virtual-monitor 1400x900 --wayland-display jade-test \
    > "$out/shell.log" 2>&1 &
shell_pid=$!
for _ in $(seq 1 600); do [[ -e $out/done ]] && break; sleep 0.5; done
grep -a 'HARNESS\|JS ERROR\|Jade Shell:' "$out/shell.log" || true
echo "Screenshots in $out"
