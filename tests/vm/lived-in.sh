#!/usr/bin/env bash
# Make a fresh Fedora or Ubuntu desktop look used for a few months, to test
# how Jade Shell's installer, setup and restore treat someone's own setup.
# Run in the VM as the desktop user, from a terminal in the GNOME session
# (scripts/test-install-vm.sh's session environment works too); needs sudo.
#
# It adds: extensions setup should turn off (Dash to Panel, Blur my Shell,
# User Themes, all enabled), a customized dock, a different accent and
# wallpaper, a 12-hour clock, and kitty, Starship and btop with configs of
# their own. Log out and back in afterwards so the extensions load.
set -euo pipefail

# shellcheck source=/dev/null
. /etc/os-release
case " $ID ${ID_LIKE:-} " in
    *' fedora '*) sudo dnf install -y --skip-unavailable kitty starship btop curl unzip ;;  # starship is only in COPR
    *' ubuntu '*) sudo apt-get update -q && sudo apt-get install -y -q kitty starship btop curl unzip ;;
esac

shell=$(gnome-shell --version | grep -oE '[0-9]+' | head -1)
extensions=(dash-to-panel@jderose9.github.com blur-my-shell@aunetx user-theme@gnome-shell-extensions.gcampax.github.com)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
for uuid in "${extensions[@]}"; do
    url=$(curl -fsS "https://extensions.gnome.org/extension-info/?uuid=$uuid&shell_version=$shell" \
        | python3 -c 'import json, sys; print(json.load(sys.stdin)["download_url"])')
    curl -fsSL -o "$tmp/$uuid.zip" "https://extensions.gnome.org$url"
    gnome-extensions install --force "$tmp/$uuid.zip"
done
# Enabled in the settings, as the Extensions app would: the running Shell only
# sees new extensions after the next login.
python3 - "${extensions[@]}" <<'EOF'
import ast
import subprocess
import sys

key = ['org.gnome.shell', 'enabled-extensions']
enabled = ast.literal_eval(subprocess.check_output(['gsettings', 'get', *key], text=True).replace('@as ', ''))
enabled += [uuid for uuid in sys.argv[1:] if uuid not in enabled]
subprocess.check_call(['gsettings', 'set', *key, str(enabled)])
EOF

# The dock: Ubuntu Dock on Ubuntu, Dash to Dock when installed on Fedora.
dock=org.gnome.shell.extensions.dash-to-dock
if gsettings list-schemas | grep -qx "$dock"; then
    gsettings set "$dock" dock-position 'LEFT'
    gsettings set "$dock" dash-max-icon-size 40
    gsettings set "$dock" extend-height false
fi
gsettings set org.gnome.desktop.interface accent-color 'teal'
gsettings set org.gnome.desktop.interface clock-format '12h'
gsettings set org.gnome.desktop.interface color-scheme 'default'
# The largest picture: a real wallpaper, not one of the small pattern tiles.
wallpaper=$(find /usr/share/backgrounds -maxdepth 2 -type f \( -name '*.jpg' -o -name '*.png' -o -name '*.jxl' \) -printf '%s %p\n' \
    | sort -n | tail -1 | cut -d' ' -f2-)
if [[ -n $wallpaper ]]; then
    gsettings set org.gnome.desktop.background picture-uri "file://$wallpaper"
    gsettings set org.gnome.desktop.background picture-uri-dark "file://$wallpaper"
fi

mkdir -p ~/.config/kitty ~/.config/btop
cat > ~/.config/kitty/kitty.conf <<'EOF'
# My kitty setup
font_size 12.0
background #1b1d23
foreground #d8dee9
cursor_shape beam
enable_audio_bell no
EOF
cat > ~/.config/starship.toml <<'EOF'
# My prompt
add_newline = false

[character]
success_symbol = "[➜](bold green)"
error_symbol = "[➜](bold red)"

[directory]
truncation_length = 2
EOF
cat > ~/.config/btop/btop.conf <<'EOF'
color_theme = "Default"
update_ms = 1500
EOF
# shellcheck disable=SC2016  # written as it is into .bashrc
if command -v starship >/dev/null && ! grep -q 'starship init bash' ~/.bashrc; then
    echo 'eval "$(starship init bash)"' >> ~/.bashrc
fi

echo 'Lived-in setup done. Log out and back in so the extensions load.'
