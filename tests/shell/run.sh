#!/usr/bin/env bash
# Screenshot Jade Shell's panels in a throwaway headless GNOME Shell:
#
#   tests/shell/run.sh [out-dir]          JADE_THEMES=osaka-jade,nord tests/shell/run.sh
#
# Or measure how fast its menus open and switch (JADE_ROUNDS=10, JADE_HZ=180):
#
#   JADE_MODE=timing tests/shell/run.sh   → "HARNESS TIMING …" lines, also in timing.txt
#   JADE_GLASS=frosted …                  → start with frosted glass
#
# Everything is private to a temporary HOME: XDG dirs, a keyfile GSettings
# backend, its own session bus and its own XDG_RUNTIME_DIR (GNOME keeps a crash
# marker there; one left in the real runtime dir makes the next login disable
# every extension). Needs sassc (or python libsass) like the package does.
set -euo pipefail
root=$(cd -- "$(dirname -- "$0")/../.." && pwd)
mode=${JADE_MODE:-shots}
default_out=$root/build/shell-shots
[[ $mode == timing ]] && default_out=$root/build/shell-timing
[[ $mode == dock ]] && default_out=$root/build/shell-dock
[[ $mode == looks ]] && default_out=$root/build/shell-looks
out=$(realpath -m "${1:-$default_out}")
work=$(mktemp -d)
runtime=$(mktemp -d /tmp/jade-rt.XXXX)  # short: a Wayland socket path must fit 108 bytes
chmod 700 "$runtime"
cleanup() {
    if [[ -n ${shell_pid:-} ]]; then
        kill -- -"$shell_pid" 2>/dev/null
        # Let it exit before its runtime dir goes, or it recreates bits of it.
        for _ in $(seq 1 50); do kill -0 -- -"$shell_pid" 2>/dev/null || break; sleep 0.1; done
    fi
    chmod -R u+w "$work" 2>/dev/null
    rm -rf "$work" "$runtime"
}
trap cleanup EXIT

home=$work/home
ext=$home/.local/share/gnome-shell/extensions
mkdir -p "$out" "$ext" "$home/.local/bin" "$home/.config/glib-2.0/settings" "$home/.local/state/jade-shell"
rm -f "$out"/*.png "$out/done" "$out/timing.txt"
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
if [[ -n ${JADE_ICONS:-} ]]; then  # built Mac-style icons (~/.local/share/icons after `jade apps on icons`)
    mkdir -p "$home/.local/share/icons"; cp -a "$JADE_ICONS"/Jade-MacTahoe* "$home/.local/share/icons/"
fi
[[ -d $home/.cache/jade-shell/usage/records ]] && chmod -R a-w "$home/.cache/jade-shell/usage/records"  # no refresh without sign-in
favorites="'org.mozilla.firefox.desktop', 'org.gnome.Nautilus.desktop', 'org.gnome.Ptyxis.desktop', 'org.gnome.Calendar.desktop', 'org.gnome.TextEditor.desktop', 'org.gnome.Loupe.desktop', 'org.gnome.Weather.desktop', 'org.gnome.Calculator.desktop', 'org.gnome.Software.desktop', 'org.gnome.Settings.desktop'"
printf "[org/gnome/shell]\nenabled-extensions=['jade-shell@parvezrob.github.io', 'jade-shell-harness@local']\ndisable-user-extensions=false\nwelcome-dialog-last-shown-version='999'\nfavorite-apps=[%s]\n" "$favorites" \
    > "$home/.config/glib-2.0/settings/keyfile"
# JADE_GLASS=frosted: start with frosted glass (e.g. to time it).
[[ -n ${JADE_GLASS:-} ]] && printf "\n[org/gnome/shell/extensions/jade-shell]\nglass='%s'\n" "$JADE_GLASS" >> "$home/.config/glib-2.0/settings/keyfile"

monitor=1400x900
timeout=600  # half seconds
[[ $mode == dock || $mode == looks ]] && monitor=1400x900@${JADE_HZ:-180}
if [[ $mode == timing ]]; then
    # The live display runs at 180 Hz; frame counts only mean something at its rate.
    monitor=1400x900@${JADE_HZ:-180}
    timeout=2400
    # The live Shell's resident size (read only), for the fork() cost at that size.
    live_kb=0
    for pid in $(pgrep -x -u "$(id -u)" gnome-shell); do
        [[ $(tr '\0' ' ' < "/proc/$pid/cmdline") == *--headless* ]] && continue
        live_kb=$(awk '/^VmRSS:/ {print $2}' "/proc/$pid/status")
    done
    export JADE_LIVE_MB=$((live_kb / 1024))
    echo "Load before: $(cut -d' ' -f1-3 /proc/loadavg), headless shells running: $(pgrep -a -x gnome-shell | grep -c -- --headless)"
fi

# The extension finds `jade` on PATH first: make that this checkout's, as
# ~/.local/bin/jade is on the live machine, not whatever the caller's PATH has
# (the developer's own ~/.local/bin copy may be an older version).
export PATH=$home/.local/bin:$PATH
export HOME=$home XDG_RUNTIME_DIR=$runtime XDG_DATA_HOME=$home/.local/share XDG_CONFIG_HOME=$home/.config \
    XDG_CACHE_HOME=$home/.cache XDG_STATE_HOME=$home/.local/state GSETTINGS_BACKEND=keyfile JADE_SHOTS=$out JADE_MODE=$mode
unset WAYLAND_DISPLAY DISPLAY DBUS_SESSION_BUS_ADDRESS
"$home/.local/bin/jade" theme set osaka-jade --only gnome,shell >/dev/null

setsid dbus-run-session -- gnome-shell --headless --no-x11 --virtual-monitor "$monitor" --wayland-display jade-test \
    > "$out/shell.log" 2>&1 &
shell_pid=$!
for _ in $(seq 1 "$timeout"); do [[ -e $out/done ]] && break; sleep 0.5; done
if [[ $mode == timing ]]; then
    grep -a 'HARNESS\|JS ERROR\|Jade Shell:' "$out/shell.log" | sed 's/^.*HARNESS /HARNESS /' | tee "$out/timing.txt" || true
    grep -a 'renderer for' "$out/shell.log" | sed 's/^.*Created/Renderer:/' || true
    echo "GLib criticals in the log: $(grep -ac 'CRITICAL' "$out/shell.log" || true)" \
        "(symlink-target: $(grep -ac 'g_file_info_get_symlink_target' "$out/shell.log" || true))"
    # A fork() costs by the size of the process: compare with the live Shell (read only).
    for pid in $(pgrep -x -u "$(id -u)" gnome-shell); do
        [[ $(tr '\0' ' ' < "/proc/$pid/cmdline") == *--headless* ]] && continue
        echo "Live gnome-shell $pid (read only): $(grep -E '^(VmRSS|VmPTE):' "/proc/$pid/status" | tr -s ' \t' ' ' | paste -sd,)," \
            "$(wc -l < "/proc/$pid/maps") mappings"
    done
    echo "Load after: $(cut -d' ' -f1-3 /proc/loadavg), headless shells running (this one included): $(pgrep -a -x gnome-shell | grep -c -- --headless)"
    echo "Timing in $out/timing.txt"
else
    grep -a 'HARNESS\|JS ERROR\|Jade Shell:' "$out/shell.log" || true
    echo "Disposed-object warnings: $(grep -ac 'already disposed' "$out/shell.log" || true)," \
        "JS warnings: $(grep -ac 'JS WARNING' "$out/shell.log" || true)," \
        "unhandled promise rejections: $(grep -ac 'Unhandled promise rejection' "$out/shell.log" || true)"
    echo "Screenshots in $out"
fi
