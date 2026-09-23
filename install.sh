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
# puts your desktop back and removes the package.
# `bash install.sh path/to/jade-shell.rpm` installs a package you built.
set -euo pipefail

REPO=parvezrob/jade-shell
RELEASE=https://github.com/$REPO/releases/latest/download

say() { printf '\033[1;32m::\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m!!\033[0m %s\n' "$*" >&2; exit 1; }

[[ $EUID -ne 0 ]] || die 'Run this as your normal user; it asks for sudo when it needs it.'
command -v gnome-shell >/dev/null || die 'Jade Shell needs GNOME Shell.'
shell_version=$(gnome-shell --version | grep -oE '[0-9]+' | head -1)
[[ $shell_version == 50 ]] || die "Jade Shell supports GNOME 50; this is GNOME $shell_version."

. /etc/os-release
case " $ID ${ID_LIKE:-} " in
    *' fedora '*) kind=rpm ;;
    *' ubuntu '*) kind=deb ;;
    *) die "Jade Shell packages are for Fedora and Ubuntu; this is $PRETTY_NAME." ;;
esac

package_install() {
    if [[ $kind == rpm ]]; then sudo dnf install -y "$1"; else sudo apt-get install -y "$1"; fi
}

package_remove() {
    if [[ $kind == rpm ]]; then sudo dnf remove -y jade-shell; else sudo apt-get remove -y jade-shell; fi
}

if [[ ${1:-} == --uninstall ]]; then
    if command -v jade >/dev/null; then
        # Through the terminal, so `jade restore` can ask even when piped from curl.
        jade restore </dev/tty || die 'Restore cancelled; nothing was removed.'
    fi
    say 'Removing the package (sudo may ask for your password)…'
    package_remove
    say 'Jade Shell is removed. Log out and back in to finish.'
    exit 0
fi

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
if [[ -n ${1:-} ]]; then
    [[ -f $1 && $1 == *.$kind ]] || die "Expected a .$kind package, got: $1"
    package=$(realpath "$1")
else
    say 'Downloading the latest Jade Shell…'
    curl -fsSL -o "$tmp/jade-shell.$kind" "$RELEASE/jade-shell.$kind"
    curl -fsSL -o "$tmp/SHA256SUMS" "$RELEASE/SHA256SUMS"
    (cd "$tmp" && grep " jade-shell.$kind\$" SHA256SUMS | sha256sum --check --quiet) \
        || die 'The download does not match the release checksum; nothing was installed.'
    package=$tmp/jade-shell.$kind
fi

say 'Installing the package (sudo may ask for your password)…'
package_install "$package"

say 'Setting up your desktop…'
jade setup
