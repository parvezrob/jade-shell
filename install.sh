#!/usr/bin/env bash
# Install Jade Shell on Fedora or Ubuntu with GNOME 50:
#
#   curl -fsSL https://raw.githubusercontent.com/parvezrob/jade-shell/main/install.sh | bash
#
# Downloads the latest release package, checks it against the release's
# SHA256SUMS, installs it with dnf or apt (asking for sudo), then runs
# `jade setup` as you. Every setting setup changes is recorded first, and
#
#   curl -fsSL https://raw.githubusercontent.com/parvezrob/jade-shell/main/install.sh | bash -s -- --uninstall
#
# puts your desktop back and removes the package (add --yes after --uninstall
# to skip the question, e.g. without a terminal).
# `bash install.sh path/to/jade-shell.rpm` installs a package you built.
# JADE_RELEASE=<url> downloads from there instead of the latest release (any
# URL curl reads, file:// too), with the same checksum check: for testing a
# build the way users install it (scripts/test-install-vm.sh).
set -euo pipefail

REPO=parvezrob/jade-shell
RELEASE=${JADE_RELEASE:-https://github.com/$REPO/releases/latest/download}
UUID='jade-shell@parvezrob.github.io'

say() { printf '\033[1;32m::\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m!!\033[0m %s\n' "$*" >&2; exit 1; }

[[ $EUID -ne 0 ]] || die 'Run this as your normal user; it asks for sudo when it needs it.'

# shellcheck source=/dev/null
. /etc/os-release
case " $ID ${ID_LIKE:-} " in
    *' fedora '*) kind=rpm ;;
    *' ubuntu '*) kind=deb ;;
    *) die "Jade Shell packages are for Fedora and Ubuntu; this is $PRETTY_NAME." ;;
esac
if [[ $kind == rpm && -e /run/ostree-booted ]]; then
    die 'Fedora Atomic desktops (Silverblue, Kinoite) are not supported yet: dnf cannot change their read-only system, and layering the package with rpm-ostree needs a reboot before jade setup can run, which this installer does not handle.'
fi

# The installed jade-shell's version-release, or nothing.
installed_version() {
    if [[ $kind == rpm ]]; then
        rpm -q --qf '%{VERSION}-%{RELEASE}' jade-shell 2>/dev/null || true
    elif [[ $(dpkg-query -W -f '${db:Status-Status}' jade-shell 2>/dev/null) == installed ]]; then
        dpkg-query -W -f '${Version}' jade-shell
    fi
}

package_version() {
    if [[ $kind == rpm ]]; then rpm -qp --qf '%{VERSION}-%{RELEASE}' "$1" 2>/dev/null; else dpkg-deb -f "$1" Version; fi
}

# $1: the package file; $2: "reinstall" when the same version is installed
# (a package rebuilt from a checkout keeps its version).
package_install() {
    if [[ $kind == rpm ]]; then
        if [[ ${2:-} == reinstall ]]; then sudo dnf reinstall -y "$1"; else sudo dnf install -y "$1"; fi
    else
        # A fresh or offline-installed system may have no package lists yet, and
        # the package pulls in sassc and fonts-jetbrains-mono. An unrelated broken
        # source or a busy apt lock fails this too, so only the install decides.
        sudo apt-get update || say 'apt-get update reported problems (see above); trying the install anyway.'
        sudo apt-get install -y ${2:+--reinstall} "$1" \
            || die "apt could not install Jade Shell or its dependencies (see above). sassc and fonts-jetbrains-mono come from Ubuntu's universe component."
    fi
}

# dnf also removes the dependencies nothing else needs. apt only suggests
# autoremove, which would take every leftover on the system: remove just the
# ones Jade Shell pulled in (sassc, its library, the font) if they are unneeded.
package_remove() {
    [[ -n $(installed_version) ]] || return 0
    if [[ $kind == rpm ]]; then
        sudo dnf remove -y jade-shell
        return
    fi
    sudo apt-get remove -y jade-shell
    local -a unneeded
    mapfile -t unneeded < <(apt-get -s autoremove 2>/dev/null \
        | awk '$1 == "Remv" && ($2 == "sassc" || $2 ~ /^libsass[0-9]/ || $2 == "fonts-jetbrains-mono") { print $2 }')
    if (( ${#unneeded[@]} )); then sudo apt-get remove -y "${unneeded[@]}"; fi
}

# Copies in your home folder, from the installer before the packages or from
# scripts/dev-install.sh. GNOME Shell loads a user extension before the
# package's, and ~/.local/bin comes first on PATH.
user_copies() {
    local path
    for path in "$HOME/.local/share/gnome-shell/extensions/$UUID" "$HOME/.local/share/jade-shell/lib" \
                "$HOME/.local/lib/jade-shell" "$HOME/.local/lib/osaka-ai-usage" "$HOME/.local/bin/jade-theme"; do
        if [[ -e $path || -L $path ]]; then printf '%s\n' "$path"; fi
    done
    if [[ -L $HOME/.local/bin/jade && $(readlink -f "$HOME/.local/bin/jade") == */jade-shell/lib/bin/jade ]]; then
        printf '%s\n' "$HOME/.local/bin/jade"
    fi
}

remove_hint() {
    local -a copies
    mapfile -t copies < <(user_copies)
    printf 'rm -rf'
    printf ' %q' "${copies[@]}"
    printf '\n'
}

if [[ ${1:-} == --uninstall ]]; then
    # The packaged jade, not an older copy in ~/.local/bin that PATH finds first.
    jade=/usr/bin/jade
    [[ -x $jade ]] || jade=$(command -v jade || true)
    state=${XDG_STATE_HOME:-$HOME/.local/state}/jade-shell
    if [[ -z $jade && ( -e $state/setup.json || -d $state/backups ) ]]; then
        die "Jade Shell changed this desktop, but its jade command is gone, so nothing can be put back. Install the package again, then run --uninstall."
    fi
    if [[ -n $jade ]]; then
        if [[ ${2:-} == --yes ]]; then
            # Without a terminal sudo cannot ask, and a restored desktop with the
            # package still installed would be a half-done uninstall.
            if [[ -n $(installed_version) ]] && ! (exec </dev/tty) 2>/dev/null && ! sudo -n true 2>/dev/null; then
                die 'Removing the package needs sudo, which cannot ask for a password without a terminal. Run this in a terminal, or with passwordless sudo.'
            fi
            "$jade" restore --yes || die 'Desktop not restored; nothing was removed.'
        elif (exec </dev/tty) 2>/dev/null; then
            # Through the terminal, so `jade restore` can ask even when piped from curl.
            "$jade" restore </dev/tty || die 'Desktop not restored; nothing was removed.'
        else
            die 'No terminal to ask on; run this again with --uninstall --yes to restore your desktop without asking.'
        fi
    fi
    say 'Removing the package (sudo may ask for your password)…'
    package_remove
    if [[ -n $(user_copies) ]]; then
        say "An older or development copy of Jade Shell is still in your home folder. To remove it: $(remove_hint)"
    fi
    say 'Jade Shell is removed. Log out and back in to finish.'
    exit 0
fi

# Only installing needs GNOME 50; removing works on any version.
command -v gnome-shell >/dev/null || die 'Jade Shell needs GNOME Shell.'
shell_version=$(gnome-shell --version | grep -oE '[0-9]+' | head -1)
[[ $shell_version == 50 ]] || die "Jade Shell supports GNOME 50; this is GNOME $shell_version."

if [[ -n $(user_copies) ]]; then
    die "An older or development copy of Jade Shell is in your home folder, and GNOME Shell would keep loading it instead of the package. Remove it, then run this again:
    $(remove_hint)"
fi

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
chmod 755 "$tmp"  # apt reads the package as its sandbox user, _apt
if [[ -n ${1:-} ]]; then
    [[ -f $1 && $1 == *.$kind ]] || die "Expected a .$kind package, got: $1"
    cp -- "$1" "$tmp/jade-shell.$kind"
else
    say 'Downloading the latest Jade Shell…'
    curl -fsSL -o "$tmp/jade-shell.$kind" "$RELEASE/jade-shell.$kind"
    curl -fsSL -o "$tmp/SHA256SUMS" "$RELEASE/SHA256SUMS"
    (cd "$tmp" && grep " jade-shell.$kind\$" SHA256SUMS | sha256sum --check --quiet) \
        || die 'The download does not match the release checksum; nothing was installed.'
fi
chmod 644 "$tmp/jade-shell.$kind"

upgrade='' mode=''
installed=$(installed_version)
if [[ -n $installed ]]; then
    upgrade=1
    [[ $installed != "$(package_version "$tmp/jade-shell.$kind")" ]] || mode=reinstall
fi

say 'Installing the package (sudo may ask for your password)…'
package_install "$tmp/jade-shell.$kind" "$mode"

say 'Setting up your desktop…'
/usr/bin/jade setup
if [[ -n $upgrade ]]; then
    # The Shell keeps running the extension code it loaded at login.
    say 'Jade Shell was upgraded. Log out and back in to load the new version of the extension.'
fi
