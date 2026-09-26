#!/bin/sh
# rpm passes 0 on removal and 1 on upgrade, when this runs after the new
# package's postinstall has compiled; deb passes remove, upgrade, deconfigure
# or failed-upgrade. Only a real removal cleans up.
case "$1" in
    0|remove) ;;
    *) exit 0 ;;
esac
find /usr/share/jade-shell -name __pycache__ -type d -prune -exec rm -rf {} + 2>/dev/null || true
# install.sh --uninstall restores the desktop first, and `jade restore` removes
# setup.json. A removal straight through dnf, apt or Software cannot, so say it
# only when some user's desktop is still set up by Jade Shell.
left=$(awk -F: '$3 >= 1000 && $3 < 65534 { print $1 ":" $6 }' /etc/passwd | while IFS=: read -r user home; do
    if [ -f "$home/.local/state/jade-shell/setup.json" ]; then echo "$user"; fi
done)
if [ -n "$left" ]; then
    names=$(echo "$left" | awk 'NR > 1 { printf "%s%s", (NR > 2 ? ", " : ""), last }
        { last = $0 } END { printf "%s%s", (NR > 1 ? " and " : ""), last }')
    echo "Jade Shell's look stays on for $names for now. At their next login, a notification offers to put the old desktop back."
fi
