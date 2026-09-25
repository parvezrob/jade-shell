#!/usr/bin/env bash
# Install Jade Shell on Fedora or Ubuntu with GNOME 50:
#
#   curl -fsSL https://jadeshell.app/install | bash
#
# Checks the system, downloads the latest release package, checks it against
# the release's SHA256SUMS, installs it with dnf or apt (asking for sudo), then
# runs `jade setup` as you. Every setting setup changes is recorded first, and
#
#   curl -fsSL https://jadeshell.app/install | bash -s -- --uninstall
#
# puts your desktop back and removes the package (add --yes after --uninstall
# to skip the question, e.g. without a terminal).
#
# The package manager's output goes to ~/.local/state/jade-shell/install.log;
# --verbose shows it too. `bash install.sh path/to/jade-shell.rpm` installs a
# package you built. JADE_RELEASE=<url> downloads from there instead of the
# latest release (any URL curl reads, file:// too), with the same checksum
# check: for testing a build the way users install it (scripts/test-install-vm.sh).
set -euo pipefail

REPO=parvezrob/jade-shell
RELEASE=${JADE_RELEASE:-https://github.com/$REPO/releases/latest/download}
ISSUES=https://github.com/$REPO/issues
UUID='jade-shell@parvezrob.github.io'
LOG=${XDG_STATE_HOME:-$HOME/.local/state}/jade-shell/install.log

action=install package='' verbose='' assume_yes=''
for arg; do
    case $arg in
        --uninstall) action=uninstall ;;
        --yes) assume_yes=1 ;;
        --verbose) verbose=1 ;;
        *) package=$arg ;;
    esac
done

# ------------------------------------------------------------------ output

if [[ -t 1 ]]; then
    bold=$'\033[1m' dim=$'\033[2m' green=$'\033[32m' red=$'\033[31m' plain=$'\033[0m'
else
    bold='' dim='' green='' red='' plain=''
fi
step_count=0 step_total=0 step_name='' step_start=0 step_log_line=0

say() { printf '%s\n' "$*"; }
log() { printf '%s\n' "$*" >>"$LOG"; }

# A numbered step: its name now, a check mark (and its time) when done.
step() {
    step_count=$((step_count + 1)) step_name=$1 step_start=$SECONDS
    step_log_line=$(wc -l <"$LOG")
    log "== [$(date '+%F %T')] $1"
    printf '%s[%d/%d]%s %s ' "$dim" "$step_count" "$step_total" "$plain" "$1"
}
done_step() {
    local took=$((SECONDS - step_start))
    printf '%s✓%s' "$green" "$plain"
    if ((took >= 60)); then
        printf ' %s%dm %02ds%s' "$dim" $((took / 60)) $((took % 60)) "$plain"
    elif ((took > 2)); then
        printf ' %s%ds%s' "$dim" "$took" "$plain"
    fi
    printf '\n'
}

# Stop with what went wrong, what the log says, and what to do next.
fail() {
    printf '%s✗%s\n\n' "$red" "$plain"
    [[ -z ${1:-} ]] || say "$1"
    if [[ $step_name == 'Checking your system' ]]; then
        say 'Nothing was changed.'
        exit 1
    fi
    local tail
    tail=$(tail -n +"$((step_log_line + 2))" "$LOG" | grep -v '^\s*$' | tail -15 || true)
    if [[ -n $tail ]]; then
        say "${dim}Last lines of the log:${plain}"
        say "    ${tail//$'\n'/$'\n'    }"
        say ''
    fi
    say "${step_name} did not finish. The full log is in $LOG"
    say 'Running the installer again is safe: it picks up where this one stopped.'
    if command -v jade >/dev/null; then
        say "Still stuck? Run 'jade doctor', or open an issue with the log: $ISSUES"
    else
        say "Still stuck? Open an issue with the log: $ISSUES"
    fi
    exit 1
}

# Run a command for the current step: output into the log (and on screen with
# --verbose). On a terminal a spinner and the time so far show it is working (a
# slow mirror can take minutes). A failure shows the failure screen.
run() {
    log "\$ $*"
    if [[ -n $verbose ]]; then
        "$@" 2>&1 | tee -a "$LOG" || fail
    elif [[ -t 1 ]]; then
        # In the background sudo can't ask: it uses the password need_sudo
        # asked for, and fails rather than waits if that has run out.
        if [[ $1 == sudo ]]; then set -- sudo -n "${@:2}"; fi
        "$@" >>"$LOG" 2>&1 &
        local pid=$! frames='⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏' i=0 took
        while kill -0 "$pid" 2>/dev/null; do
            took=$((SECONDS - step_start))
            printf '\0337%s%s %s%s\0338' "$dim" "${frames:i++ % 10:1}" \
                "$( ((took >= 60)) && printf '%dm %02ds' $((took / 60)) $((took % 60)) || printf '%ds' "$took")" "$plain"
            sleep 0.1
        done
        printf '\033[K'
        wait "$pid" || fail
    else
        "$@" >>"$LOG" 2>&1 || fail
    fi
}

# sudo asks here, on its own line, before a step prints its name.
need_sudo() {
    sudo -n true 2>/dev/null && return
    if ! (exec </dev/tty) 2>/dev/null; then
        say "$1 needs administrator rights, and sudo can only ask for your password in a terminal."
        say 'Run this in a terminal window. Nothing was changed.'
        exit 1
    fi
    say "$1 needs administrator rights, so sudo asks for your password."
    sudo -v || { say 'No password given; nothing was changed.'; exit 1; }
}

# ------------------------------------------------------------------ system

mkdir -p "$(dirname "$LOG")"
log "== [$(date '+%F %T')] install.sh $action ${package:+$package }(release: $RELEASE)"

if [[ $EUID -eq 0 ]]; then
    say 'Run this as your normal user; it asks for sudo when it needs it.'
    exit 1
fi

# shellcheck source=/dev/null
. /etc/os-release
case " $ID ${ID_LIKE:-} " in
    *' fedora '*) kind=rpm ;;
    *' ubuntu '*) kind=deb ;;
    *) say "Jade Shell packages are for Fedora and Ubuntu; this is $PRETTY_NAME."; exit 1 ;;
esac

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
        if [[ ${2:-} == reinstall ]]; then run sudo dnf reinstall -y "$1"; else run sudo dnf install -y "$1"; fi
        return
    fi
    # A fresh or offline-installed system may have no package lists yet, and
    # the package pulls in sassc and fonts-jetbrains-mono. An unrelated broken
    # source or a busy apt lock fails this too, so only the install decides.
    # (The log is the user's; sudo only runs apt-get.)
    # shellcheck disable=SC2024
    sudo env DEBIAN_FRONTEND=noninteractive apt-get update >>"$LOG" 2>&1 \
        || log 'apt-get update reported problems; trying the install anyway.'
    # needrestart (Ubuntu) would print its report for every install.
    run sudo env DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a NEEDRESTART_SUSPEND=1 \
        apt-get install -y ${2:+--reinstall} "$1"
}

# dnf also removes the dependencies nothing else needs. apt only suggests
# autoremove, which would take every leftover on the system: remove just the
# ones Jade Shell pulled in (sassc, its library, the font) if they are unneeded.
package_remove() {
    if [[ $kind == rpm ]]; then
        run sudo dnf remove -y jade-shell
        return
    fi
    run sudo env DEBIAN_FRONTEND=noninteractive apt-get remove -y jade-shell
    local -a unneeded
    mapfile -t unneeded < <(apt-get -s autoremove 2>/dev/null \
        | awk '$1 == "Remv" && ($2 == "sassc" || $2 ~ /^libsass[0-9]/ || $2 == "fonts-jetbrains-mono") { print $2 }')
    if (( ${#unneeded[@]} )); then run sudo env DEBIAN_FRONTEND=noninteractive apt-get remove -y "${unneeded[@]}"; fi
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

# Setup changes settings through the running GNOME Shell and its session bus:
# the user must be logged in to GNOME (a terminal over SSH then works too).
in_gnome_session() {
    if command -v gdbus >/dev/null; then
        gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell \
            --method org.freedesktop.DBus.Peer.Ping >/dev/null 2>&1
    else
        [[ ${XDG_CURRENT_DESKTOP:-} == *GNOME* ]]
    fi
}

# ------------------------------------------------------------------ uninstall

tagline="Omarchy's look for the GNOME you already have"
printf '\n  %sJade Shell%s  %s·  %s%s\n\n' "$bold" "$plain" "$dim" "$tagline" "$plain"

if [[ $action == uninstall ]]; then
    step_total=3
    step 'Checking your system'
    # The packaged jade, not an older copy in ~/.local/bin that PATH finds first.
    jade=/usr/bin/jade
    [[ -x $jade ]] || jade=$(command -v jade || true)
    state=${XDG_STATE_HOME:-$HOME/.local/state}/jade-shell
    if [[ -z $jade && ( -e $state/setup.json || -d $state/backups ) ]]; then
        fail "Jade Shell changed this desktop, but its jade command is gone, so nothing can be put back. Install the package again, then run --uninstall."
    fi
    if [[ -n $assume_yes && -n $(installed_version) ]] && ! (exec </dev/tty) 2>/dev/null && ! sudo -n true 2>/dev/null; then
        # Without a terminal sudo cannot ask, and a restored desktop with the
        # package still installed would be a half-done uninstall.
        fail 'Removing the package needs sudo, which cannot ask for a password without a terminal. Run this in a terminal, or with passwordless sudo.'
    fi
    if [[ -n $jade && -z $assume_yes ]] && ! (exec </dev/tty) 2>/dev/null; then
        fail 'No terminal to ask on; run this again with --uninstall --yes to restore your desktop without asking.'
    fi
    done_step

    step 'Restoring your desktop'
    if [[ -n $jade ]]; then
        say ''
        if [[ -n $assume_yes ]]; then
            "$jade" restore --yes || fail 'The desktop was not restored, so nothing was removed.'
        else
            # Through the terminal, so `jade restore` can ask even when piped from curl.
            "$jade" restore </dev/tty || fail 'The desktop was not restored, so nothing was removed.'
        fi
    else
        done_step
    fi

    if [[ -n $(installed_version) ]]; then
        need_sudo 'Removing the package'
    fi
    step 'Removing the package'
    [[ -z $(installed_version) ]] || package_remove
    done_step
    if [[ -n $(user_copies) ]]; then
        say "An older or development copy of Jade Shell is still in your home folder. To remove it: $(remove_hint)"
    fi
    say ''
    # With a desktop restored, restore has already said to log out.
    if [[ -n $jade ]]; then say 'Jade Shell is removed.'; else say 'Jade Shell is removed. Log out and back in to finish.'; fi
    exit 0
fi

# ------------------------------------------------------------------ install

step_total=4
step 'Checking your system'
if [[ $kind == rpm && -e /run/ostree-booted ]]; then
    fail 'Fedora Atomic desktops (Silverblue, Kinoite) are not supported yet: dnf cannot change their read-only system, and layering the package with rpm-ostree needs a reboot before jade setup can run, which this installer does not handle.'
fi
command -v gnome-shell >/dev/null || fail 'Jade Shell needs the GNOME desktop, and GNOME Shell is not installed.'
shell_version=$(gnome-shell --version | grep -oE '[0-9]+' | head -1)
[[ $shell_version == 50 ]] || fail "Jade Shell supports GNOME 50; this is GNOME $shell_version."
in_gnome_session || fail "Log in to your GNOME desktop first, then run this in a terminal there. Setting up changes your desktop through GNOME Shell, which isn't running for $USER right now."

if [[ -n $(user_copies) ]]; then
    fail "An older or development copy of Jade Shell is in your home folder, and GNOME Shell would keep loading it instead of the package. Remove it, then run this again:
    $(remove_hint)"
fi
if [[ $kind == deb ]] && ! grep -rqsE '^(Components:.*\buniverse\b|deb .*\buniverse\b)' /etc/apt/sources.list /etc/apt/sources.list.d/; then
    fail "Jade Shell needs sassc and fonts-jetbrains-mono from Ubuntu's universe component, which is turned off. Turn it on with:
    sudo add-apt-repository universe"
fi
free_mb=$(df -Pm /usr | awk 'NR == 2 { print $4 }')
((free_mb >= 200)) || fail "Jade Shell and what it needs take about 50 MB, and the package manager needs room to work; only ${free_mb} MB is free on /usr."
if [[ -z $package ]] && ! curl -fsI --max-time 15 "$RELEASE/SHA256SUMS" >>"$LOG" 2>&1; then
    fail "Could not reach the Jade Shell release ($RELEASE). Check your internet connection, then run this again."
fi
done_step

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
chmod 755 "$tmp"  # apt reads the package as its sandbox user, _apt
if [[ -n $package ]]; then
    step 'Using your package'
    [[ -f $package && $package == *.$kind ]] || fail "Expected a .$kind package, got: $package"
    cp -- "$package" "$tmp/jade-shell.$kind"
else
    step 'Downloading Jade Shell'
    run curl -fsSL -o "$tmp/jade-shell.$kind" "$RELEASE/jade-shell.$kind"
    run curl -fsSL -o "$tmp/SHA256SUMS" "$RELEASE/SHA256SUMS"
    (cd "$tmp" && grep " jade-shell.$kind\$" SHA256SUMS | sha256sum --check --quiet) >>"$LOG" 2>&1 \
        || fail 'The download does not match the release checksum, so nothing was installed. Run this again; if it keeps happening, tell us.'
fi
chmod 644 "$tmp/jade-shell.$kind"
version=$(package_version "$tmp/jade-shell.$kind")
done_step

mode=''
installed=$(installed_version)
if [[ -n $installed && $installed == "$version" ]]; then
    mode=reinstall
fi

need_sudo 'Installing Jade Shell'
step "Installing Jade Shell ${version%-*}"
package_install "$tmp/jade-shell.$kind" "$mode"
done_step

step 'Setting up your desktop'
say ''
# Setup says when a log-out is needed (the Shell keeps running the extension
# code it loaded at login) and, on a terminal, offers to do it.
/usr/bin/jade setup || fail 'Setup stopped (see above).'
