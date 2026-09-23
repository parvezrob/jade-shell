#!/bin/sh
# rpm passes 0 on removal and 1 on upgrade, when this runs after the new
# package's postinstall has compiled; deb passes remove, upgrade, deconfigure
# or failed-upgrade. Only a real removal cleans up.
case "$1" in
    0|remove) ;;
    *) exit 0 ;;
esac
find /usr/share/jade-shell -name __pycache__ -type d -prune -exec rm -rf {} + 2>/dev/null || true
# install.sh --uninstall has already restored the desktop by now; this is for
# a removal straight through dnf, apt or Software, which cannot reach it.
echo "If you removed Jade Shell without 'install.sh --uninstall': its settings stay"
echo "in each user's home folder. To put a desktop back, reinstall and run 'jade restore'."
