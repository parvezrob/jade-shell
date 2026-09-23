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
left=$(awk -F: '$3 >= 1000 && $3 < 65534 { print $6 }' /etc/passwd | while read -r home; do
    if [ -f "$home/.local/state/jade-shell/setup.json" ]; then echo "$home"; fi
done)
if [ -n "$left" ]; then
    echo "Jade Shell's look stays on these desktops until it is restored: $(echo "$left" | tr '\n' ' ')"
    echo "At their next login, Jade Shell offers to restore each one."
    echo "Or reinstall Jade Shell and run 'jade restore' as that user."
fi
