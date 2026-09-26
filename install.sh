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

# On a terminal (without --verbose) each step is one line that redraws in
# place: a spinner, a download bar, then a check mark. NO_COLOR turns colors off.
fancy=''
if [[ -t 1 && -z $verbose ]]; then fancy=1; fi
if [[ -t 1 && -z ${NO_COLOR:-} ]]; then
    bold=$'\033[1m' dim=$'\033[2m' red=$'\033[31m' plain=$'\033[0m'
    if [[ ${COLORTERM:-} == truecolor || ${COLORTERM:-} == 24bit ]]; then
        accent=$'\033[38;2;121;185;154m'  # the site's jade
    else
        accent=$'\033[38;5;115m'
    fi
else
    bold='' dim='' red='' plain='' accent=''
fi
pad=${fancy:+   }
step_count=0 step_total=0 step_name='' step_start=0 step_log_line=0 step_waited='' step_below=0
dl_file='' dl_total=0 fail_message=''

say() { printf '%s\n' "$*"; }
# Under the steps on a terminal, every line indented with them.
note() {
    local line
    while IFS= read -r line; do printf '%s%s\n' "$pad" "$line"; done <<<"$*"
}
log() { printf '%s\n' "$*" >>"$LOG"; }

elapsed() {
    local t=$((SECONDS - step_start))
    if ((t >= 60)); then printf '%dm %02ds' $((t / 60)) $((t % 60)); else printf '%ds' "$t"; fi
}

# The step's line, drawn again: over itself, or from below when lines were
# printed under it (step_below counts them, the cursor's line included).
draw_step() {
    local line="   $1  $step_name${2:+  $2}"
    if ((step_below)); then
        printf '\0337\033[%dA\r%s\033[K\0338' "$step_below" "$line"
    else
        printf '\r%s\033[K' "$line"
    fi
}

step() {
    step_count=$((step_count + 1)) step_name=$1 step_start=$SECONDS
    step_waited='' step_below=0
    step_log_line=$(wc -l <"$LOG")
    log "== [$(date '+%F %T')] $1"
    if [[ -n $fancy ]]; then
        draw_step "$accent●$plain"
    else
        printf '%s[%d/%d]%s %s ' "$dim" "$step_count" "$step_total" "$plain" "$1"
    fi
}
done_step() {
    local took=''
    if ((SECONDS - step_start > 2)); then took=$(elapsed); fi
    if [[ -n $fancy ]]; then
        draw_step "$accent✓$plain" "${took:+$dim$took$plain}"
        if [[ -n $step_waited ]]; then  # the wait is over: say it in the past
            # Two lines become one; the next step takes the freed line.
            printf '\0337\033[2A\r      %s%s%s\033[K\n\033[2K\0338\033[1A' "$dim" \
                'It waited for your other updates to finish first.' "$plain"
            step_below=0
            return
        fi
        ((step_below)) || printf '\n'
    else
        printf '%s✓%s%s\n' "$accent" "$plain" "${took:+ $dim$took$plain}"
    fi
}

# What the spinner shows after the name: the download so far, or the time.
bar() {
    local s='' k
    for ((k = 0; k < $1; k++)); do s+=$2; done
    printf '%s' "$s"
}
mb() { printf '%d.%d' $(($1 / 1048576)) $(($1 * 10 / 1048576 % 10)); }
progress() {
    if ((dl_total > 0)); then
        local have fill width=24
        have=$(stat -c %s "$dl_file" 2>/dev/null) || have=0
        ((have <= dl_total)) || have=$dl_total
        fill=$((have * width / dl_total))
        printf '%s%s%s%s%s  %s / %s MB' "$accent" "$(bar "$fill" ━)" "$dim" "$(bar $((width - fill)) ─)" "$plain" \
            "$(mb "$have")" "$(mb "$dl_total")"
    else
        printf '%s%s%s' "$dim" "$(elapsed)" "$plain"
    fi
}

# Stop with what went wrong, what the log says, and what to do next.
fail() {
    if [[ -n $fancy ]]; then
        draw_step "$red✗$plain"
        ((step_below)) || printf '\n'
        printf '\n'
    else
        printf '%s✗%s\n\n' "$red" "$plain"
    fi
    local message=${1:-$fail_message}
    [[ -z $message ]] || note "$message"
    if [[ $step_name == 'Checking your system' ]]; then
        note 'Nothing was changed.'
        exit 1
    fi
    local tail hint=''
    tail=$(tail -n +"$((step_log_line + 2))" "$LOG" | grep -v '^\s*$' | tail -15 || true)
    # What a desktop in daily use can already have going on, in plain words;
    # anything else shows the end of the log.
    case $tail in
        *'dpkg was interrupted'*)
            hint="An earlier install on this computer was interrupted. Finish it first with:
    sudo dpkg --configure -a" ;;
        *'Unmet dependencies'* | *'held broken packages'* | *'fix-broken'*)
            hint="Some packages on this computer were left half-installed before Jade Shell. Repair them first with:
    sudo apt --fix-broken install" ;;
        *'E: Could not get lock /var/lib/dpkg/'*)  # apt gave up waiting (dnf waits for as long as it takes)
            hint='Your computer was still installing other updates after 20 minutes. Let them finish (or restart the computer), then run this again.' ;;
    esac
    if [[ -n $hint ]]; then
        note "$hint"
        say ''
    elif [[ -n $tail ]]; then
        note "${dim}Last lines of the log:${plain}"
        note "    ${tail//$'\n'/$'\n'    }"
        say ''
    fi
    note "${step_name} did not finish. The full log is in ${LOG/#$HOME/\~}"
    note 'Running the installer again is safe: it picks up where this one stopped.'
    if command -v jade >/dev/null; then
        note "Still stuck? Run 'jade doctor', or open an issue with the log: $ISSUES"
    else
        note "Still stuck? Open an issue with the log: $ISSUES"
    fi
    exit 1
}

# On a desktop in use, the Software app (packagekitd) or automatic updates may
# be installing something. apt and dnf wait for them; the log names them.
other_updates_running() {
    local last
    last=$(tail -n 6 "$LOG" 2>/dev/null) || return 1
    [[ $last == *'Could not get lock'* || $last == *'Waiting for a lock'* || $last == *'currently accessing it'* ]]
}

# Run a command for the current step: output into the log (and on screen with
# --verbose). On a terminal a spinner and the time so far show it is working (a
# slow mirror can take minutes). A failure shows the failure screen.
run() {
    log "\$ $*"
    if [[ -n $verbose ]]; then
        "$@" 2>&1 | tee -a "$LOG" || fail
    elif [[ -n $fancy ]]; then
        # In the background sudo can't ask: it uses the password need_sudo
        # asked for, and fails rather than waits if that has run out.
        if [[ $1 == sudo ]]; then set -- sudo -n "${@:2}"; fi
        "$@" >>"$LOG" 2>&1 &
        local pid=$! frames='⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏' i=0
        while kill -0 "$pid" 2>/dev/null; do
            # Once per step, in words anyone reads, on short lines of their
            # own under the step (a wrapped line would outlive the redraws).
            if [[ -z $step_waited ]] && ((i % 10 == 0)) && other_updates_running; then
                step_waited=1 step_below=3
                printf '\n      %s\n      %s\n' 'Your computer is installing other updates right now.' \
                    'Jade Shell waits for them to finish, then carries on.'
            fi
            draw_step "$accent${frames:i++ % 10:1}$plain" "$(progress)"
            sleep 0.1
        done
        wait "$pid" || fail
    else
        "$@" >>"$LOG" 2>&1 || fail
    fi
}

# sudo asks here, on its own line, before a step prints its name.
need_sudo() {
    sudo -n true 2>/dev/null && return
    if ! (exec </dev/tty) 2>/dev/null; then
        note "$1 needs administrator rights, and sudo can only ask for your password in a terminal."
        note 'Run this in a terminal window. Nothing was changed.'
        exit 1
    fi
    note "$1 needs your password (administrator rights)."
    sudo -v || { note 'No password given; nothing was changed.'; exit 1; }
}

# Setup in a session of its own: with no terminal it doesn't ask to log out,
# and its progress lines stay quiet under the spinner. finish() then shows
# what it said, and the card.
quiet_setup() {
    local rc=0
    setsid -w /usr/bin/jade setup >"$tmp/setup.out" 2>&1 || rc=$?
    cat "$tmp/setup.out"
    return "$rc"
}

# The restore, the same way, once the installer has asked.
quiet_restore() {
    local rc=0
    setsid -w "$jade" restore --yes >"$tmp/restore.out" 2>&1 || rc=$?
    cat "$tmp/restore.out"
    return "$rc"
}

# What a jade command said, under its step: dimmed, indented, wrapped to fit.
show_lines() {
    local line row cols
    cols=$(stty size </dev/tty 2>/dev/null | cut -d' ' -f2) || true
    for line; do
        while IFS= read -r row; do printf '      %s%s%s\n' "$dim" "$row" "$plain"; done \
            < <(fold -s -w $((${cols:-80} - 7)) <<<"$line")
    done
}

# The closing card. $1: its title (after a check mark); then rows: '' for a
# gap, 'label|value' for a dimmed label, anything else as it is.
card() {
    local title=$1 row w=$((${#1} + 3)) rule text
    shift
    for row; do
        [[ $row == *'|'* ]] && row="$(printf '%-15s' "${row%%|*}")${row#*|}"
        ((${#row} <= w)) || w=${#row}
    done
    rule=$(printf '%*s' $((w + 4)) '' | sed 's/ /─/g')
    printf '\n   %s╭%s╮%s\n' "$accent" "$rule" "$plain"
    printf '   %s│%s  %s✓%s  %s%s%s%*s  %s│%s\n' "$accent" "$plain" "$accent" "$plain" "$bold" "$title" "$plain" \
        $((w - ${#title} - 3)) '' "$accent" "$plain"
    for row in '' "$@"; do
        if [[ $row == *'|'* ]]; then
            text="$dim$(printf '%-15s' "${row%%|*}")$plain${row#*|}"
            row="$(printf '%-15s' "${row%%|*}")${row#*|}"
        else
            text=$row
        fi
        printf '   %s│%s  %s%*s  %s│%s\n' "$accent" "$plain" "$text" $((w - ${#row})) '' "$accent" "$plain"
    done
    printf '   %s╰%s╯%s\n\n' "$accent" "$rule" "$plain"
}

# As setup asks when it has the terminal: GNOME's own dialog then confirms.
offer_logout() {
    in_gnome_session && (exec </dev/tty) 2>/dev/null || return 0
    local answer=''
    printf '   Log out now? GNOME asks you to confirm first. [Y/n] '
    read -r answer </dev/tty || true
    say ''
    if [[ ${answer,,} == '' || ${answer,,} == y || ${answer,,} == yes ]]; then
        gnome-session-quit --logout 2>/dev/null || note "Could not open the log-out dialog; log out from the top bar's menu."
    fi
}

# Setup's closing lines become the card; the others stay, under the step.
# Wording setup doesn't end with (a later version) is shown as it is.
finish() {
    local line shortcut='' login='' welcome='' known=''
    local -a info=() rows=()
    while IFS= read -r line; do
        case $line in
            'Change theme with '*) shortcut=${line#Change theme with }; shortcut=${shortcut%%. Undo*} ;;
            'Done. Log out and back in'*) known=1 login=1; [[ $line != *Welcome* ]] || welcome=1 ;;
            'Done.') known=1 ;;
            '') ;;
            *) info+=("$line") ;;
        esac
    done <"$tmp/setup.out"
    if [[ -z $known ]]; then
        cat "$tmp/setup.out"
        return
    fi
    show_lines "${info[@]}"
    if [[ -n $login ]]; then
        rows+=('Log out and back in to start it.')
        [[ -z $welcome ]] || rows+=('A welcome window helps you pick a look.')
        rows+=('')
    fi
    [[ -z $shortcut ]] || rows+=("Change theme|$shortcut")
    rows+=('Undo it all|jade restore')
    card "Jade Shell ${version%-*} is installed" "${rows[@]}"
    [[ -z $login ]] || offer_logout
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
    # Old or missing package lists would fail sassc and fonts-jetbrains-mono,
    # which the package pulls in. An unrelated broken source fails this too,
    # so only the install decides.
    run apt_update
    # needrestart (Ubuntu) would print its report for every install.
    run sudo env DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a NEEDRESTART_SUSPEND=1 \
        apt-get "${APT_WAIT[@]}" install -y ${2:+--reinstall} "$1"
}

# apt gives up at once when another program holds its lock (GNOME Software's
# packagekitd, unattended-upgrades): wait for it instead. The lists lock of
# `apt-get update` ignores the timeout, so that one is retried.
APT_WAIT=(-o DPkg::Lock::Timeout=1200)
apt_update() {
    # Each attempt's own output decides; the log may lag behind (tee, --verbose).
    local tries=0 out
    until out=$(sudo -n env DEBIAN_FRONTEND=noninteractive apt-get update 2>&1); do
        printf '%s\n' "$out"
        if [[ $out == *'Could not get lock'* ]] && ((tries++ < 60)); then
            sleep 5
            continue
        fi
        echo 'apt-get update reported problems; trying the install anyway.'
        return 0
    done
    printf '%s\n' "$out"
}

# dnf also removes the dependencies nothing else needs. apt only suggests
# autoremove, which would take every leftover on the system: remove just the
# ones Jade Shell pulled in (sassc and its library) if they are unneeded.
# JetBrains Mono stays: the terminal running this still draws with it, and
# removing a font in use leaves that window blank.
package_remove() {
    if [[ $kind == rpm ]]; then
        if rpm -q jetbrains-mono-fonts >/dev/null 2>&1; then run sudo dnf mark user -y jetbrains-mono-fonts; fi
        run sudo dnf remove -y jade-shell
        return
    fi
    run sudo env DEBIAN_FRONTEND=noninteractive apt-get "${APT_WAIT[@]}" remove -y jade-shell
    local -a unneeded
    mapfile -t unneeded < <(apt-get -s autoremove 2>/dev/null \
        | awk '$1 == "Remv" && ($2 == "sassc" || $2 ~ /^libsass[0-9]/) { print $2 }')
    if (( ${#unneeded[@]} )); then run sudo env DEBIAN_FRONTEND=noninteractive apt-get "${APT_WAIT[@]}" remove -y "${unneeded[@]}"; fi
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

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
chmod 755 "$tmp"  # apt reads the package as its sandbox user, _apt

# ------------------------------------------------------------------ uninstall

tagline="Omarchy's look for the GNOME you already have"
if [[ -n $fancy ]]; then
    printf '\n   %s◆%s %sJade Shell%s\n   %s%s%s\n\n' "$accent" "$plain" "$bold" "$plain" "$dim" "$tagline" "$plain"
else
    printf '\n  %sJade Shell%s  %s·  %s%s\n\n' "$bold" "$plain" "$dim" "$tagline" "$plain"
fi

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
    # On a terminal the question is the installer's, in plain words; the
    # restore then runs under a spinner like the other steps.
    if [[ -n $fancy && -n $jade && -z $assume_yes ]]; then
        answer=''
        printf '\n   Put your desktop back as it was before Jade Shell, and remove it? [y/N] '
        read -r answer </dev/tty || true
        if [[ ${answer,,} != y && ${answer,,} != yes ]]; then
            note 'Nothing was changed.'
            exit 0
        fi
        say ''
    fi

    step 'Restoring your desktop'
    restored=''
    if [[ -n $jade && -n $fancy ]]; then
        fail_message='The desktop was not restored, so nothing was removed.'
        run quiet_restore
        fail_message=''
        done_step
        mapfile -t said < <(grep -v -e '^$' -e '^Restored the desktop you had' "$tmp/restore.out")
        show_lines "${said[@]}"
        grep -q '^Restored the desktop you had' "$tmp/restore.out" && restored=1
    elif [[ -n $jade ]]; then
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
        note "An older or development copy of Jade Shell is still in your home folder. To remove it: $(remove_hint)"
    fi
    if [[ -n $fancy ]]; then
        if [[ -n $restored ]]; then
            card 'Jade Shell is removed' 'Your desktop is back as it was.' 'Log out and back in to finish.'
        else
            card 'Jade Shell is removed' 'Log out and back in to finish.'
        fi
        offer_logout
    else
        say ''
        # With a desktop restored, restore has already said to log out.
        if [[ -n $jade ]]; then say 'Jade Shell is removed.'; else say 'Jade Shell is removed. Log out and back in to finish.'; fi
    fi
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
if [[ -z $package ]] && ! curl -fsI -o /dev/null --max-time 15 "$RELEASE/SHA256SUMS" 2>>"$LOG"; then
    fail "Could not reach the Jade Shell release ($RELEASE). Check your internet connection, then run this again."
fi
done_step

if [[ -n $package ]]; then
    step 'Using your package'
    [[ -f $package && $package == *.$kind ]] || fail "Expected a .$kind package, got: $package"
    cp -- "$package" "$tmp/jade-shell.$kind"
else
    step 'Downloading Jade Shell'
    # Its size first, for the download bar (none if the server doesn't say).
    dl_total=$(curl -fsIL --max-time 15 "$RELEASE/jade-shell.$kind" 2>>"$LOG" \
        | awk 'tolower($1) == "content-length:" { n = $2 + 0 } END { print n + 0 }') || dl_total=0
    [[ $dl_total =~ ^[0-9]+$ ]] || dl_total=0
    dl_file=$tmp/jade-shell.$kind
    run curl -fsSL -o "$tmp/jade-shell.$kind" "$RELEASE/jade-shell.$kind"
    dl_total=0
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
# Setup says when a log-out is needed (the Shell keeps running the extension
# code it loaded at login) and, on a terminal, offers to do it.
if [[ -n $fancy ]]; then
    run quiet_setup
    done_step
    finish
else
    say ''
    /usr/bin/jade setup || fail 'Setup stopped (see above).'
fi
