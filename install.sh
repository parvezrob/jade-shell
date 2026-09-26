#!/usr/bin/env bash
# Install Jade Shell on Fedora 44 or Ubuntu 26.04 (GNOME 50):
#
#   wget -qO- https://jadeshell.app/install | bash
#
# (curl -fsSL https://jadeshell.app/install | bash works the same; Ubuntu's
# desktop comes with wget only.) Checks the system, downloads the latest release
# package (resuming a download that was cut off), checks it against the
# release's SHA256SUMS, installs it with dnf or apt (asking for the password
# once), runs `jade setup` as you, then adds the optional parts (text and QR
# code reading). Every setting setup changes is recorded first, and
#
#   wget -qO- https://jadeshell.app/install | bash -s -- --uninstall
#
# puts your desktop back and removes Jade Shell (add --yes after --uninstall to
# skip the question, e.g. without a terminal).
#
# Run again, it sets up your desktop without downloading what is already
# installed; --reinstall installs the package again anyway. The package
# manager's output goes to ~/.local/state/jade-shell/install.log; --verbose
# shows it too. `bash install.sh path/to/jade-shell.rpm` installs a package you
# built. JADE_RELEASE=<url> downloads from there instead of the latest release
# (file:// too, with curl), with the same checksum check: for testing a build
# the way users install it (scripts/test-install-vm.sh).
set -euo pipefail

REPO=parvezrob/jade-shell
LATEST=https://github.com/$REPO/releases/latest/download
RELEASE=${JADE_RELEASE:-$LATEST}
ISSUES=github.com/$REPO/issues
UUID='jade-shell@parvezrob.github.io'
STATE=${XDG_STATE_HOME:-$HOME/.local/state}/jade-shell
DATA=${XDG_DATA_HOME:-$HOME/.local/share}/jade-shell
CACHE=${XDG_CACHE_HOME:-$HOME/.cache}/jade-shell
LOG=$STATE/install.log
TAGLINE="Omarchy's look and polish, on the GNOME you already run."

action=install package='' verbose='' assume_yes='' reinstall=''
for arg; do
    case $arg in
        --uninstall) action=uninstall ;;
        --yes) assume_yes=1 ;;
        --verbose) verbose=1 ;;
        --reinstall) reinstall=1 ;;
        *) package=$arg ;;
    esac
done

# ------------------------------------------------------------------ output

# On a terminal (without --verbose) each step is one line that redraws in
# place: a spinner, a download bar, then a check mark. Narrower than 80 columns
# a step's line could wrap and the redraws would garble it, and a "dumb"
# terminal can't redraw: plain lines then, as in a log. NO_COLOR turns colors off.
cols=80
if [[ -t 1 ]]; then
    size=$(stty size </dev/tty 2>/dev/null) || size=''
    if [[ ${size#* } =~ ^[0-9]+$ ]]; then cols=${size#* }; fi
fi
fancy=''
if [[ -t 1 && -z $verbose && ${TERM:-dumb} != dumb ]] && ((cols >= 80)); then fancy=1; fi
if [[ -t 1 && -z ${NO_COLOR:-} && ${TERM:-dumb} != dumb ]]; then
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
frames=(⠋ ⠙ ⠹ ⠸ ⠼ ⠴ ⠦ ⠧ ⠇ ⠏)  # whole characters, whatever the locale
step_name='' step_start=0 step_log_line=0 step_waited='' step_below=0 step_detail=''
dl_file='' dl_offset=0 fail_message='' run_pid='' installed_now=''

say() { printf '%s\n' "$*"; }
# Under the steps, every line indented with them and wrapped to the terminal
# (a line starting with four spaces is a command to copy: kept whole).
note() {
    local line row width=$((cols - ${#pad} - 1))
    while IFS= read -r line; do
        if [[ $line == '    '* || ${#line} -le $width ]]; then
            printf '%s%s\n' "$pad" "$line"
        else
            while IFS= read -r row; do printf '%s%s\n' "$pad" "${row% }"; done < <(fold -s -w "$width" <<<"$line")
        fi
    done <<<"$*"
}
log() { printf '%s\n' "$*" >>"$LOG"; }

# "a", "a and b", "a, b and c".
join() {
    local out='' i
    for ((i = 1; i <= $#; i++)); do
        if ((i == 1)); then out=${!i}; elif ((i == $#)); then out+=" and ${!i}"; else out+=", ${!i}"; fi
    done
    printf '%s' "$out"
}

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
    step_name=$1 step_start=$SECONDS step_waited='' step_below=0 step_detail=''
    step_log_line=$(wc -l <"$LOG")
    log "== [$(date '+%F %T')] $1"
    if [[ -n $fancy ]]; then
        draw_step "$accent●$plain"
    else
        printf '%s•%s %s ' "$accent" "$plain" "$1"
    fi
}
# $1: the mark (a check by default).
done_step() {
    local took='' mark=${1:-$accent✓$plain}
    if ((SECONDS - step_start > 2)); then took=$(elapsed); fi
    if [[ -n $fancy ]]; then
        draw_step "$mark" "${took:+$dim$took$plain}"
        if [[ -n $step_waited ]]; then  # the wait is over: say it in the past
            # Two lines become one; the next step takes the freed line.
            printf '\0337\033[2A\r      %s%s%s\033[K\n\033[2K\0338\033[1A' "$dim" \
                'It waited for the other software to finish first.' "$plain"
            step_below=0
            return 0
        fi
        if ((step_below == 0)); then printf '\n'; fi
    else
        printf '%s%s\n' "$mark" "${took:+ $dim$took$plain}"
    fi
}

# What the spinner shows after the name: the download so far, or the time and
# what the step is doing.
bar() {
    local s='' k
    for ((k = 0; k < $1; k++)); do s+=$2; done
    printf '%s' "$s"
}
mb() { printf '%d.%d' $(($1 / 1048576)) $(($1 * 10 / 1048576 % 10)); }
# The download's full size, from the headers curl or wget wrote (a resumed
# download's 206 answer counts only what is left).
dl_size() {
    local status='' length=0 line
    [[ -s $tmp/headers ]] || { echo 0; return 0; }
    while IFS= read -r line; do
        line=${line%$'\r'}
        line=${line#"${line%%[![:space:]]*}"}
        case ${line,,} in
            http/*) status=${line#* }; status=${status%% *}; length=0 ;;
            content-length:*) length=${line#*:}; length=${length//[[:space:]]/} ;;
        esac
    done <"$tmp/headers"
    [[ $length =~ ^[0-9]+$ ]] || length=0
    if [[ $status == 206 ]]; then echo $((dl_offset + length)); else echo "$length"; fi
}
progress() {
    if [[ -n $dl_file ]]; then
        local have total fill width=24
        total=$(dl_size)
        if ((total > 0)); then
            have=$(stat -c %s "$dl_file" 2>/dev/null) || have=0
            ((have <= total)) || have=$total
            fill=$((have * width / total))
            printf '%s%s%s%s%s  %s / %s MB' "$accent" "$(bar "$fill" ━)" "$dim" "$(bar $((width - fill)) ─)" \
                "$plain" "$(mb "$have")" "$(mb "$total")"
            return 0
        fi
    fi
    printf '%s%s%s%s' "$dim" "$(elapsed)" "${step_detail:+ · $step_detail}" "$plain"
}

# What setup is doing, for the line under its step: in its own words once
# it writes them (JADE_PROGRESS_FILE), else what can be seen from outside:
# the theme pictures so far, then the icons.
setup_detail() {
    local last='' count
    if [[ -s $tmp/setup.progress ]]; then
        last=$(tail -n 1 "$tmp/setup.progress")
        printf '%s' "${last:0:40}"
        return 0
    fi
    if compgen -G "$CACHE/.MacTahoe-icon-theme-*" >/dev/null; then
        printf 'Preparing the Mac-style icons'
        return 0
    fi
    count=$(compgen -G "$STATE/thumbs/*.png" | wc -l) || count=0
    if ((count > 0 && count < 22)); then printf 'Getting theme pictures %d of 22' "$count"; fi
}

# The lines the current step wrote to the log.
step_tail() { tail -n +"$((step_log_line + 2))" "$LOG" 2>/dev/null | grep -v '^\s*$' | tail -40 || true; }

# The other program holding the package manager's lock, in words, or nothing.
lock_holder() {
    local text=$1 name
    if [[ $text =~ held\ by\ process\ [0-9]+\ \(([^\)]+)\) ]]; then
        name=${BASH_REMATCH[1]}
        case $name in
            packagekitd | gnome-software) printf 'the Software app' ;;
            unattended-upgr*) printf 'automatic updates' ;;
            *) printf 'another window' ;;
        esac
    fi
}

# In plain words, what stopped a step, when it is something a desktop in daily
# use can have going on; else nothing.
hint_for() {
    local text=$1 host=''
    case $text in
        *'dpkg was interrupted'*)
            printf '%s\n    %s' 'An earlier install on this computer was interrupted. Finish it first with:' \
                'sudo dpkg --configure -a' ;;
        *'Unable to acquire the dpkg frontend lock'* | *'Could not get lock /var/lib/dpkg/'*)
            local who
            who=$(lock_holder "$text")
            printf 'Your computer was still busy installing other software%s after 20 minutes. Let it finish, or restart the computer, then run this again.' \
                "${who:+ ($who)}" ;;
        *'Unable to locate package'* | *'has no installation candidate'* | *'is not installable'* | *'none of the choices are installable'* | *'Unable to satisfy dependencies'*)
            printf '%s' "Some parts Jade Shell needs weren't found in Ubuntu's software lists. Open Software & Updates, make sure \"Community-maintained free and open-source software\" is ticked and \"Download from\" is \"Main server\", then run this again." ;;
        *'No match for argument'* | *'nothing provides'*)
            printf '%s' "Some parts Jade Shell needs weren't found in Fedora's software sources. Run this again in a few minutes; if it keeps happening, tell us at $ISSUES." ;;
        *'Unmet dependencies'* | *'held broken packages'*)
            printf '%s\n    %s' 'Some software on this computer was left half-installed before Jade Shell. Repair it first with:' \
                'sudo apt --fix-broken install' ;;
        *'No space left on device'*)
            printf '%s' 'Your disk is full. Free some space (empty the Trash, clear some downloads), then run this again.' ;;
        *'Failed to fetch'* | *'Temporary failure resolving'* | *'Unable to connect'*)
            if [[ $text =~ Failed\ to\ fetch\ [a-z]+://([^/ ]+) ]]; then host=${BASH_REMATCH[1]}; fi
            printf "Your computer's download server%s isn't answering. Try again later, or choose \"Main server\" in Software & Updates." \
                "${host:+ ($host)}" ;;
        *'Curl error'* | *'No more mirrors to try'* | *'Cannot download'*)
            printf '%s' "Fedora's download servers aren't answering right now. Check your internet connection, or try again in a few minutes." ;;
        *'Failed to obtain rpm transaction lock'*)
            printf '%s' 'Your computer is busy installing other software. Let it finish, then run this again.' ;;
    esac
}

# The log's own lines, only those a person can read: no commands, no mirror
# chatter, a Python error's last line only.
readable() {
    local text=$1 errors
    text=$(grep -v -E '^\$ |^(Hit|Get|Ign|Err):[0-9]|^Reading (package lists|state information|database)|^Building dependency tree|^\(Reading database|^WARNING: apt does not have|^Fetched |^Selecting previously|^Preparing to unpack|^Unpacking |^Setting up |^Processing triggers|^  File "|^    ' <<<"$text" || true)
    if [[ $text == *'Traceback (most recent call last)'* ]]; then
        tail -n 1 <<<"$text"
        return 0
    fi
    errors=$(grep -E '^(E:|W:|Error|error:|dpkg: error|Failed|Problem|curl: \([0-9]+\)|wget:)' <<<"$text" | tail -n 6 || true)
    if [[ -n $errors ]]; then printf '%s\n' "$errors"; else tail -n 6 <<<"$text"; fi
}

# Stop with what went wrong, in words, and what to do next.
fail() {
    local message=${1:-$fail_message} tail hint shown
    if [[ -n $fancy ]]; then
        draw_step "$red✗$plain"
        if ((step_below == 0)); then printf '\n'; fi
        printf '\n'
    else
        printf '%s✗%s\n\n' "$red" "$plain"
    fi
    log "== failed: ${step_name}${message:+: $message}"
    [[ -z $message ]] || note "$message"
    if [[ $step_name == 'Checking your system' ]]; then
        note 'Nothing was changed.'
        exit 1
    fi
    tail=$(step_tail)
    hint=$(hint_for "$tail")
    if [[ -n $hint ]]; then
        [[ -z $message ]] || say ''
        note "$hint"
        say ''
    elif [[ -z $message ]]; then
        shown=$(readable "$tail")
        if [[ -n $shown ]]; then
            note "${dim}What went wrong:${plain}"
            note "    ${shown//$'\n'/$'\n'    }"
        fi
        say ''
    else
        say ''
    fi
    note "${step_name} did not finish. The details are in ${LOG/#$HOME/\~}."
    if [[ -n $installed_now ]]; then
        note 'Jade Shell is installed. To finish setting up your desktop, run:'
        note '    jade setup'
    else
        note 'Running it again is safe.'
    fi
    if [[ -x /usr/bin/jade ]]; then
        note 'Still stuck? Run jade debug to send us a report.'
    else
        note "Still stuck? Tell us at $ISSUES and attach the log."
    fi
    exit 1
}

# On a desktop in use, the Software app (packagekitd) or automatic updates may
# be installing something, or another window may be waiting at apt's
# question. apt and dnf wait for them; the log names them.
other_software_running() {
    local last
    last=$(tail -n 6 "$LOG" 2>/dev/null) || return 1
    [[ $last == *'Could not get lock'* || $last == *'Waiting for a lock'* || $last == *'currently accessing it'* ]]
}
waiting_lines() {
    if [[ $(lock_holder "$(tail -n 6 "$LOG" 2>/dev/null)") == 'another window' ]]; then
        printf '%s\n%s' 'Another window is using the software installer.' 'Finish or close it; Jade Shell then carries on.'
    else
        printf '%s\n%s' 'Your computer is installing other software right now.' \
            'Jade Shell waits for it to finish, then carries on.'
    fi
}

# Run a command for the current step, in the background so that Ctrl-C stays
# with the installer (on_interrupt decides what stops): its output into the
# log (and on screen with --verbose). On a terminal a spinner and the time so
# far show it is working. Returns the command's status; run() stops on failure.
try() {
    local arg shown=()
    for arg; do  # a proxy's password stays out of the log
        if [[ $arg == *_proxy=* || $arg == *_PROXY=* ]]; then shown+=("${arg%%=*}=(set)"); else shown+=("$arg"); fi
    done
    log "\$ ${shown[*]}"
    # In the background sudo can't ask: it uses the password need_sudo asked
    # for (kept fresh by keep_sudo), and fails rather than waits without it.
    if [[ $1 == sudo ]]; then set -- sudo -n "${@:2}"; fi
    if [[ -n $verbose ]]; then
        ( "$@" 2>&1 | tee -a "$LOG"; exit "${PIPESTATUS[0]}" ) 9>&- &
    else
        "$@" >>"$LOG" 2>&1 9>&- &  # the installer's lock stays with the installer
    fi
    run_pid=$!
    local i=0 rc=0 lines
    if [[ -n $fancy ]]; then
        while kill -0 "$run_pid" 2>/dev/null; do
            if ((i % 10 == 0)); then
                # Once per step, in words anyone reads, on short lines of their
                # own under the step (a wrapped line would outlive the redraws).
                if [[ -z $step_waited ]] && other_software_running; then
                    step_waited=1 step_below=3
                    lines=$(waiting_lines)
                    printf '\n      %s\n      %s\n' "${lines%%$'\n'*}" "${lines#*$'\n'}"
                fi
                if [[ $step_name == 'Setting up your desktop' ]]; then step_detail=$(setup_detail); fi
            fi
            draw_step "$accent${frames[i % 10]}$plain" "$(progress)"
            i=$((i + 1))
            sleep 0.1
        done
    elif [[ -z $verbose ]]; then
        # Plain lines: the same words once, on lines of their own.
        while kill -0 "$run_pid" 2>/dev/null; do
            if [[ -z $step_waited ]] && other_software_running; then
                step_waited=1
                printf '\n%s\n' "$(waiting_lines)"
            fi
            sleep 1
        done
    fi
    wait "$run_pid" || rc=$?
    run_pid=''
    return "$rc"
}
run() { try "$@" || fail; }

# The password, asked once, before anything changes. $1: what for ("to
# install it"). A background loop keeps it fresh (Fedora's sudo forgets it
# after 5 minutes, and a slow download can take longer).
sudo_keeper=''
need_sudo() {
    if sudo -n true 2>/dev/null; then keep_sudo; return 0; fi
    if ! (exec </dev/tty) 2>/dev/null; then
        note "Jade Shell needs your password $1, and can only ask for it in a terminal. Open a terminal window and run this there. Nothing was changed."
        exit 1
    fi
    local lead="Jade Shell needs your password once, $1. Type the password you log in with, then press Enter."
    local -a prompt=()
    # sudo-rs (Ubuntu) shows a star per key and mangles a custom prompt;
    # classic sudo (Fedora) shows nothing while you type.
    if [[ $(sudo -V 2>/dev/null || true) != *sudo-rs* ]]; then
        lead+=' (Nothing shows while you type.)'
        prompt=(-p "${pad}Password: ")
    fi
    say ''
    note "$lead"
    # sudo reads the password from the terminal itself, and its own words
    # decide what went wrong: its retry prompts stay on screen, its refusals
    # give way to the sentences below.
    # shellcheck disable=SC2024
    if sudo "${prompt[@]}" -v </dev/tty 2> >(tee "$tmp/sudo.err" \
        | grep --line-buffered -v -E "afraid I can't do that|not in the sudoers|not allowed to|incorrect password attempt|maximum [0-9]+ incorrect|usual lecture|boils down to these|#[123]\\) |password you type will not be visible|^$" >&2); then
        say ''
        keep_sudo
        return 0
    fi
    sleep 0.2  # the error lines reach the file
    say ''
    if [[ -n ${desktop_done:-} ]]; then  # the rest is done: only the extras wait
        note "Your desktop is set up. Text and QR code reading weren't added (the password wasn't accepted); run this again to add them."
        exit 1
    fi
    local said
    said=$(cat "$tmp/sudo.err" 2>/dev/null) || said=''
    if [[ $said =~ afraid\ I\ can|not\ in\ the\ sudoers|not\ allowed\ to ]] \
        || { [[ ! $said =~ ncorrect|Authentication\ failed|Sorry,\ try\ again ]] && [[ ! " $(id -nG 2>/dev/null) " =~ \ (sudo|wheel|admin)\  ]]; }; then
        note "Installing needs an administrator account, and this one isn't. Ask the person who manages this computer to run this command once; then run it again in your account to set up your desktop."
    else
        note "The password wasn't accepted, so nothing was changed. Run this again to try once more."
    fi
    exit 1
}
keep_sudo() {
    [[ -z $sudo_keeper ]] || return 0
    local parent=$$
    # (without the installer's lock: a leftover sleep would hold it after the end)
    ( exec 9>&-; while sleep 50; do kill -0 "$parent" 2>/dev/null && sudo -n -v 2>/dev/null || exit 0; done ) &
    sudo_keeper=$!
}

# Setup and restore run in a session of their own: with no terminal they don't
# ask their own questions (the installer asks, in the same words), and their
# progress lines stay quiet under the spinner. Ctrl-C doesn't reach that
# session, so on_interrupt() stops it (the process id is kept for that).
detached() {
    local out=$1 rc=0
    shift
    setsid -w "$@" >"$out" 2>&1 &
    echo $! >"$tmp/detached.pid"
    wait $! || rc=$?
    rm -f "$tmp/detached.pid"
    cat "$out"
    return "$rc"
}
quiet_setup() {
    detached "$tmp/setup.out" env JADE_PROGRESS_FILE="$tmp/setup.progress" JADE_SUMMARY_FILE="$tmp/setup.json" \
        /usr/bin/jade setup
}

# Ctrl-C, or the window closed. A download stops at once (the next run
# continues it); a package manager at work finishes first, as stopping it
# halfway would leave the system's software half-installed; setup and restore
# stop (running them again is safe). Then say what state things are in.
on_interrupt() {
    trap '' INT TERM HUP
    local pid tries=0
    if [[ -n $fancy && -n $step_name ]]; then
        draw_step "$dim–$plain"
        if ((step_below == 0)); then printf '\n'; fi
    fi
    if [[ -s $tmp/detached.pid ]]; then
        pid=$(<"$tmp/detached.pid")
        kill -TERM -- "-$pid" 2>/dev/null || true
        while kill -0 "$pid" 2>/dev/null; do
            tries=$((tries + 1))
            if ((tries == 50)); then kill -KILL -- "-$pid" 2>/dev/null || true; fi
            sleep 0.1
        done
    fi
    if [[ -n $run_pid ]] && kill -0 "$run_pid" 2>/dev/null; then
        if [[ $step_name == Installing* || $step_name == Removing* || $step_name == Adding* ]]; then
            say ''
            note 'Finishing the part already started, one moment…'
            wait "$run_pid" 2>/dev/null || true
        else
            kill -TERM "$run_pid" 2>/dev/null || true
            wait "$run_pid" 2>/dev/null || true
        fi
    fi
    log "== [$(date '+%F %T')] stopped"
    say ''
    if [[ $action == uninstall ]]; then
        note 'Stopped. Run the same command again to finish removing Jade Shell.'
    elif [[ -n $installed_now ]]; then
        note 'Stopped. Jade Shell is installed; to finish setting up your desktop, run:'
        note '    jade setup'
    else
        note 'Stopped. Running it again is safe.'
    fi
    exit 130
}

# A yes/no question on the terminal (stdin is the script itself when piped
# from wget or curl). $1: the question; $2: the answer Enter gives (y or n).
# Ctrl-C answers no. Without a terminal: the default.
ask() {
    local answer='' default=$2 interrupted=''
    (exec </dev/tty) 2>/dev/null || { [[ $default == y ]]; return; }
    trap 'interrupted=1' INT
    printf '%s%s %s ' "$pad" "$1" "$([[ $default == y ]] && echo '[Y/n]' || echo '[y/N]')"
    read -r answer </dev/tty || answer=''
    trap on_interrupt INT
    if [[ -n $interrupted ]]; then say ''; return 1; fi
    answer=${answer,,}
    [[ ${answer:-$default} == y || $answer == yes ]]
}

# What a jade command said, under its step: dimmed, indented, wrapped to fit.
# The system's own warnings (GLib's "(process:N): …-WARNING") stay in the log.
show_lines() {
    local line row
    for line; do
        if [[ $line =~ ^\(.*:[0-9]+\):\ .*(WARNING|CRITICAL|Gtk-|GLib-) || $line =~ ^[[:space:]]*$ ]]; then continue; fi
        while IFS= read -r row; do printf '      %s%s%s\n' "$dim" "${row% }" "$plain"; done \
            < <(fold -s -w $((cols - 7)) <<<"$line")
    done
}

# The closing card. $1: its title (after a check mark); then rows: '' for a
# gap, 'label|value' for a dimmed label, anything else as it is.
card() {
    local title=$1 row w=$((${#1} + 3)) rule text lw=0 label
    shift
    for row; do  # the labels' column: the longest label and a gap
        label=${row%%|*}
        if [[ $row == *'|'* ]] && ((${#label} + 3 > lw)); then lw=$((${#label} + 3)); fi
    done
    if [[ -z $fancy ]]; then  # no box where lines may wrap
        printf '\n%s✓%s %s%s%s\n' "$accent" "$plain" "$bold" "$title" "$plain"
        for row; do
            if [[ $row == *'|'* ]]; then say "  ${row%%|*}: ${row#*|}"; elif [[ -n $row ]]; then say "  $row"; fi
        done
        say ''
        return 0
    fi
    for row; do
        if [[ $row == *'|'* ]]; then row="$(printf '%-*s' "$lw" "${row%%|*}")${row#*|}"; fi
        ((${#row} <= w)) || w=${#row}
    done
    rule=$(printf '%*s' $((w + 4)) '' | sed 's/ /─/g')
    printf '\n   %s╭%s╮%s\n' "$accent" "$rule" "$plain"
    printf '   %s│%s  %s✓%s  %s%s%s%*s  %s│%s\n' "$accent" "$plain" "$accent" "$plain" "$bold" "$title" "$plain" \
        $((w - ${#title} - 3)) '' "$accent" "$plain"
    for row in '' "$@"; do
        if [[ $row == *'|'* ]]; then
            text="$dim$(printf '%-*s' "$lw" "${row%%|*}")$plain${row#*|}"
            row="$(printf '%-*s' "$lw" "${row%%|*}")${row#*|}"
        else
            text=$row
        fi
        printf '   %s│%s  %s%*s  %s│%s\n' "$accent" "$plain" "$text" $((w - ${#row})) '' "$accent" "$plain"
    done
    printf '   %s╰%s╯%s\n\n' "$accent" "$rule" "$plain"
}

# GNOME's own log-out dialog confirms, and logs out by itself after a minute.
offer_logout() {
    in_gnome_session || return 0
    (exec </dev/tty) 2>/dev/null || return 0
    note 'Save your work first; GNOME logs out by itself after a minute.'
    if ask 'Log out now?' y; then
        gnome-session-quit --logout 2>/dev/null \
            || note "The log-out dialog didn't open; log out from the menu at the top right."
    fi
    say ''
}

# Setup's summary (JADE_SUMMARY_FILE) as shell variables, when it wrote one.
read_summary() {
    [[ -s $1 ]] || return 1
    python3 -I - "$1" <<'EOF' 2>>"$LOG"
import json, shlex, sys
d = json.load(open(sys.argv[1]))
text = lambda v: v if isinstance(v, str) else ''
words = lambda v: ' '.join(shlex.quote(x) for x in v or [] if isinstance(x, str))
print('login=%s welcome=%s restored=%s' % ('1' if d.get('login_needed') else '', '1' if d.get('welcome') else '',
                                           '1' if d.get('restored') else ''))
print('shortcut=%s' % shlex.quote(text(d.get('shortcut'))))
print('turned_off=(%s)' % words(d.get('turned_off')))
print('info=(%s)' % words(d.get('notes')))
print('partial=(%s)' % words(d.get('partial')))
EOF
}

# App names for the config files 0.9.0's setup lists ("~/.config/kitty/kitty.conf").
app_title() {
    local path=${1#\~/}
    path=${path#.config/}
    case ${path%%/*} in
        kitty) printf 'Kitty' ;; starship.toml | starship) printf 'Starship' ;; btop) printf 'btop' ;;
        Code | 'Code - OSS' | VSCodium | vscode*) printf 'VS Code' ;; nvim | neovim) printf 'Neovim' ;;
        alacritty) printf 'Alacritty' ;; ghostty) printf 'Ghostty' ;; tmux | .tmux.conf) printf 'tmux' ;;
        ptyxis) printf 'Ptyxis' ;; obsidian) printf 'Obsidian' ;; claude*) printf 'Claude Code' ;;
        font) printf 'The font' ;; gtk) printf 'GNOME apps' ;; shell) printf 'The top bar' ;; dock) printf 'The dock' ;;
        *) printf '%s' "${path%%/*}" ;;
    esac
}

# What setup said, as the lines under its step and the card. From its
# summary when it writes one; from 0.9.0's own lines otherwise, reworded here
# (they were written for a terminal of its own). Wording neither knows is
# shown as it is.
finish() {
    local line login='' welcome='' restored='' shortcut='' known='' pictures='' wallpaper='' word
    local -a info=() turned_off=() partial=() apps=() rows=() said=()
    if eval "$(read_summary "$tmp/setup.json" || echo false)"; then
        known=1
    else
        while IFS= read -r line; do
            case $line in
                'Change theme with '*) shortcut=${line#Change theme with }; shortcut=${shortcut%%. Undo*} ;;
                'Done. Log out and back in'*) known=1 login=1; if [[ $line == *Welcome* ]]; then welcome=1; fi ;;
                'Done.') known=1 ;;
                'Downloaded '*' theme previews.' | 'Your settings in them stay'*) ;;
                'No theme previews ('* | 'No preview for '*) pictures=1 ;;
                'Not themed: wallpaper ('*) wallpaper=1 ;;
                'Not themed: '*)
                    word=${line#Not themed: }
                    said+=("$(app_title "${word%% (*}" | sed 's/^./\u&/') couldn't be themed this time; everything else is done.") ;;
                'Turned off '*': Jade Shell does '*) line=${line#Turned off }; turned_off+=("${line%%:*}") ;;
                'Adding the theme to '*)
                    for word in $line; do
                        # shellcheck disable=SC2088  # the text setup printed, not a path to expand
                        if [[ $word == '~/'* ]]; then word=${word%[,.]}; apps+=("$(app_title "$word")"); fi
                    done ;;
                *' is now the monospace font of GNOME and your terminals'*)
                    said+=("Terminals and code now use the ${line%% is now*} font.") ;;
                '') ;;
                *) said+=("$line") ;;
            esac
        done <"$tmp/setup.out"
        if ((${#turned_off[@]})); then info+=("Turned off $(join "${turned_off[@]}"), since Jade Shell does the same job."); fi
        if ((${#apps[@]})); then
            info+=("Your $(join "${apps[@]}") settings now follow the theme too. Your own settings stay, and a copy of each was saved.")
        fi
        info+=("${said[@]}")
        if [[ -n $wallpaper ]]; then info+=("Kept your current wallpaper: the theme's own couldn't be downloaded right now."); fi
        if [[ -n $pictures ]]; then info+=("Some theme pictures couldn't be downloaded right now; the theme picker gets them later."); fi
    fi
    if [[ -z $known ]]; then
        mapfile -t info < <(grep -v '^$' "$tmp/setup.out" || true)
        show_lines "${info[@]}"
        return 0
    fi
    show_lines "${info[@]}"
    if [[ -n $login ]]; then
        rows+=('Log out and back in to start it.')
        if [[ -n $welcome ]]; then rows+=('A welcome window helps you pick a look.'); fi
        for word in "${turned_off[@]}"; do
            if [[ $word == 'Ubuntu Dock' || $word == 'Dash to Dock' ]]; then
                rows+=("Your dock comes back, as Jade Shell's, then.")
                break
            fi
        done
        rows+=('')
    fi
    if [[ -n $shortcut ]]; then rows+=("Change theme|$shortcut"); fi
    rows+=('Your old desktop|jade restore')
    finish_rows=("${rows[@]}") finish_login=$login
}

# ------------------------------------------------------------------ system

mkdir -p "$STATE"
if [[ -n $fancy ]]; then
    printf '\n   %s◆%s %sJade Shell%s\n' "$accent" "$plain" "$bold" "$plain"
    if [[ $action == install ]]; then printf '   %s%s%s\n' "$dim" "$TAGLINE" "$plain"; fi
    printf '\n'
else
    printf '\n%sJade Shell%s\n\n' "$bold" "$plain"
fi

if [[ $EUID -eq 0 ]]; then
    note "Please run this without sudo, as yourself. Jade Shell asks for your password when it needs it:"
    suffix=''
    if [[ $action == uninstall ]]; then suffix=' -s -- --uninstall'; fi
    note "    wget -qO- https://jadeshell.app/install | bash$suffix"
    exit 1
fi
# A terminal inside an app's sandbox or a container sees another system than
# the desktop's. (JADE_ALLOW_CONTAINER: the installer's own tests.)
if [[ -z ${JADE_ALLOW_CONTAINER:-} ]]; then
    if [[ -e /.flatpak-info ]]; then
        note "This terminal is inside an app's sandbox (like VS Code from Flathub). Open the Terminal app from your desktop and run this there."
        exit 1
    fi
    if [[ -e /run/.containerenv || -e /run/.toolboxenv || -n ${container:-} ]]; then
        note "This terminal is inside a container (Toolbx or Distrobox). Open a normal Terminal window, or type exit, and run this there."
        exit 1
    fi
fi

# One installer at a time: two would run two setups on the same record.
if command -v flock >/dev/null; then
    exec 9>>"$STATE/install.lock"
    if ! flock -n 9; then
        note 'Jade Shell is already being installed in another window. Let that one finish.'
        exit 1
    fi
fi

# shellcheck source=/dev/null
. /etc/os-release
case " $ID ${ID_LIKE:-} " in
    *' fedora '*) kind=rpm ;;
    *' ubuntu '*) kind=deb ;;
    *) note "Jade Shell works on Fedora 44 and Ubuntu 26.04. This computer runs ${PRETTY_NAME:-another system}. Nothing was changed."; exit 1 ;;
esac

# Downloads with whichever tool this computer has: curl, else wget (Ubuntu's
# desktop has only wget). Never a snap's curl: its sandbox can't write here.
fetcher=''
if [[ -x /usr/bin/curl ]]; then fetcher=/usr/bin/curl; elif [[ -x /usr/bin/wget ]]; then fetcher=/usr/bin/wget; fi

# $1 the URL, $2 the file. $3: "resume" continues a partial file and retries a
# dropped or stalled connection for a while; "quick" gives up soon (a check).
fetch() {
    local -a opts
    if [[ $fetcher == */curl ]]; then
        if [[ ${3:-} == quick ]]; then
            opts=(--retry 1 --connect-timeout 10 --max-time 30)
        else
            opts=(--retry 4 --retry-all-errors --retry-delay 2 --connect-timeout 20 --speed-limit 2048 --speed-time 45)
            if [[ ${3:-} == resume ]]; then opts+=(-C -); fi
        fi
        "$fetcher" -fsSL -S "${opts[@]}" -D "$tmp/headers" -o "$2" "$1"
    else
        if [[ ${3:-} == quick ]]; then
            opts=(--tries=2 --timeout=10)
        else
            opts=(--tries=5 --waitretry=2 --timeout=20 --read-timeout=45)
            if [[ ${3:-} == resume ]]; then opts+=(-c); fi
        fi
        # wget writes the headers (-S) where its errors go: both reach the log.
        local rc=0
        "$fetcher" -q -S "${opts[@]}" -O "$2" "$1" 2>"$tmp/headers" || rc=$?
        cat "$tmp/headers"
        return "$rc"
    fi
}

# The installed jade-shell's version-release, or nothing (rpm prints "package
# jade-shell is not installed" on stdout, so it asks first).
installed_version() {
    if [[ $kind == rpm ]]; then
        if rpm -q --quiet jade-shell 2>/dev/null; then rpm -q --qf '%{VERSION}-%{RELEASE}' jade-shell; fi
    elif [[ $(dpkg-query -W -f '${db:Status-Status}' jade-shell 2>/dev/null) == installed ]]; then
        dpkg-query -W -f '${Version}' jade-shell
    fi
}
# Installed at all, half-installed included (what removal must take away).
package_present() {
    if [[ $kind == rpm ]]; then
        rpm -q --quiet jade-shell 2>/dev/null
    else
        local status
        status=$(dpkg-query -W -f '${db:Status-Abbrev}' jade-shell 2>/dev/null) || return 1
        [[ -n $status && ${status:1:1} != [nc] ]]
    fi
}

package_version() {
    if [[ $kind == rpm ]]; then rpm -qp --qf '%{VERSION}-%{RELEASE}' "$1" 2>/dev/null; else dpkg-deb -f "$1" Version; fi
}

# Is $1 a newer version than $2?
newer() { [[ $1 != "$2" && $(printf '%s\n%s\n' "$1" "$2" | sort -V | tail -n 1) == "$1" ]]; }

# The package manager in plain English (so its messages can be matched) and
# with the person's proxy, which sudo would drop; needrestart (Ubuntu) would
# print its report for every install.
proxy_env=()
for name in http_proxy https_proxy ftp_proxy no_proxy HTTP_PROXY HTTPS_PROXY FTP_PROXY NO_PROXY; do
    if [[ -n ${!name:-} ]]; then proxy_env+=("$name=${!name}"); fi
done
PM=(sudo env LC_ALL=C.UTF-8 LANGUAGE= DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a NEEDRESTART_SUSPEND=1
    "${proxy_env[@]}")
# apt gives up at once when another program holds its lock (the Software app's
# packagekitd, automatic updates, apt waiting in another window): wait instead.
APT_WAIT=(-o DPkg::Lock::Timeout=1200)

# The optional parts install on their own, after the desktop is ready (see
# add_extras): the core install is small and quick.
# $1: the package file; $2: "reinstall" to install the same version again.
package_install() {
    local -a install
    if [[ $kind == rpm ]]; then
        # dnf refreshes its software lists when they are old; the ones this
        # computer has usually do (Jade Shell's needs change rarely): try those
        # first, then with fresh lists.
        install=("${PM[@]}" dnf -y --setopt=install_weak_deps=False)
        if [[ ${2:-} == reinstall ]]; then install+=(reinstall "$1"); else install+=(install "$1"); fi
        if try "${install[@]:0:${#install[@]}-2}" '--setopt=*.metadata_expire=never' "${install[@]: -2}"; then return 0; fi
        step_detail='getting the latest software lists'
        step_log_line=$(wc -l <"$LOG")
        run "${install[@]}"
        return 0
    fi
    # The same with apt: install with the lists this computer has; refresh
    # every source only when that is not enough (it can take minutes), and
    # finish an interrupted earlier install first when there is one.
    install=("${PM[@]}" apt-get "${APT_WAIT[@]}" install -y --no-install-recommends ${2:+--reinstall} "$1")
    local attempt tail
    for attempt in 1 2 3; do
        if try "${install[@]}"; then return 0; fi
        tail=$(step_tail)
        if [[ $attempt == 3 ]]; then fail; fi
        if [[ $tail == *'dpkg was interrupted'* && $step_detail != *'earlier install'* ]]; then
            step_detail='finishing an earlier install'
            run "${PM[@]}" dpkg --configure -a
        elif [[ $tail =~ Unable\ to\ locate|no\ installation\ candidate|404|Unable\ to\ fetch|not\ installable|Unable\ to\ satisfy|Unmet\ dependencies|Failed\ to\ fetch ]] \
            && [[ $step_detail != *'software lists'* ]]; then
            step_detail='getting the latest software lists'
            run apt_update
        else
            fail
        fi
        step_log_line=$(wc -l <"$LOG")
    done
}

# `apt-get update`'s own lock ignores the timeout: retried. A broken source of
# the person's own (a third-party repository) fails it too, so the install
# after it decides.
apt_update() {
    # Each attempt's own output decides; the log may lag behind (tee, --verbose).
    local tries=0 out
    until out=$(sudo -n "${PM[@]:1}" apt-get update 2>&1); do
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

# The package's recommended parts (text and QR code reading) that this
# computer doesn't have yet. $1: the package file, or "installed".
missing_extras() {
    local group alt name
    if [[ $kind == rpm ]]; then
        local -a query=(-qp --recommends "$1")
        [[ $1 != installed ]] || query=(-q --recommends jade-shell)
        while read -r name _; do
            [[ -z $name ]] || rpm -q --quiet --whatprovides "$name" 2>/dev/null || printf '%s\n' "$name"
        done < <(rpm "${query[@]}" 2>/dev/null)
        return 0
    fi
    local recommends
    if [[ $1 == installed ]]; then
        recommends=$(dpkg-query -W -f '${Recommends}' jade-shell 2>/dev/null) || return 0
    else
        recommends=$(dpkg-deb -f "$1" Recommends 2>/dev/null) || return 0
    fi
    IFS=',' read -ra groups <<<"$recommends"
    for group in "${groups[@]}"; do
        local first='' have=''
        IFS='|' read -ra alts <<<"$group"
        for alt in "${alts[@]}"; do
            name=${alt%%(*}
            name=${name//[[:space:]]/}
            [[ -n $name ]] || continue
            [[ -n $first ]] || first=$name
            if [[ $(dpkg-query -W -f '${db:Status-Status}' "$name" 2>/dev/null) == installed ]]; then have=1; fi
        done
        if [[ -n $first && -z $have ]]; then printf '%s\n' "$first"; fi
    done
}

# The optional parts, offered once, before anything is installed (so the
# rest runs without stopping to ask): only on a terminal, and only when one
# of them is missing. Without a terminal (a script) they are left out; a run
# again in a terminal offers them.
want_extras=''
offer_extras() {
    local name size='about 14 MB'
    local -a names=(tesseract-ocr zbar-tools python3-qrcode) missing=()
    if [[ $kind == rpm ]]; then names=(tesseract zbar python3-qrcode) size='about 6 MB'; fi
    for name in "${names[@]}"; do
        if [[ $kind == rpm ]]; then
            rpm -q --quiet "$name" 2>/dev/null || missing+=("$name")
        elif [[ $(dpkg-query -W -f '${db:Status-Status}' "$name" 2>/dev/null) != installed ]]; then
            missing+=("$name")
        fi
    done
    ((${#missing[@]})) || return 0
    (exec </dev/tty) 2>/dev/null || return 0
    say ''
    note "Optional: text and QR code reading lets you copy text from screenshots and share your Wi-Fi as a QR code ($size)."
    if ask 'Add it too?' y; then want_extras=1; fi
    say ''
}

# Text and QR code reading, after the desktop is ready: not worth failing
# the install over (Jade Shell works without them, and says what's missing
# when they're used). Those added are recorded, so removal takes them too.
add_extras() {
    local -a extras
    mapfile -t extras < <(missing_extras "$1")
    ((${#extras[@]})) || return 0
    step 'Adding text and QR code reading'
    local -a install
    if [[ $kind == rpm ]]; then
        install=("${PM[@]}" dnf -y --setopt=install_weak_deps=False install "${extras[@]}")
    else
        install=("${PM[@]}" apt-get "${APT_WAIT[@]}" install -y --no-install-recommends "${extras[@]}")
    fi
    if try "${install[@]}"; then
        printf '%s\n' "${extras[@]}" >>"$STATE/extras"
        done_step
    else
        done_step "$dim–$plain"
        show_lines "Text and QR code reading couldn't be added right now; everything else works. Running the install command again adds them."
    fi
}

# dnf also removes the dependencies nothing else needs. apt only suggests
# autoremove, which would take every leftover on the system: remove just the
# ones Jade Shell brought (sassc and its library, text and QR code reading),
# and only those nothing else needs. JetBrains Mono stays: the terminal
# running this still draws with it, and removing a font in use leaves that
# window blank.
package_remove() {
    local -a extras=() unneeded=()
    if [[ -s $STATE/extras ]]; then mapfile -t extras < <(sort -u "$STATE/extras"); fi
    if [[ $kind == rpm ]]; then
        if rpm -q --quiet jetbrains-mono-fonts 2>/dev/null; then run "${PM[@]}" dnf mark user -y jetbrains-mono-fonts; fi
        run "${PM[@]}" dnf remove -y jade-shell
        local name needed
        for name in "${extras[@]}"; do
            # (rpm fails when nothing requires it: its words decide)
            needed=$(rpm -q --whatrequires "$name" 2>&1) || true
            if rpm -q --quiet "$name" 2>/dev/null && [[ $needed == 'no package requires'* ]]; then unneeded+=("$name"); fi
        done
        if ((${#unneeded[@]})); then try "${PM[@]}" dnf remove -y "${unneeded[@]}" || true; fi
        return 0
    fi
    run "${PM[@]}" apt-get "${APT_WAIT[@]}" remove -y jade-shell
    # Added by name, the extras were marked as wanted: now only a dependency.
    if ((${#extras[@]})); then try "${PM[@]}" apt-mark auto "${extras[@]}" || true; fi
    mapfile -t unneeded < <(apt-get -s autoremove 2>/dev/null | awk '$1 == "Remv" { print $2 }' \
        | grep -E '^(sassc|libsass[0-9]|tesseract-ocr|libtesseract[0-9]|liblept[0-9]|libleptonica|zbar-tools|libzbar[0-9]|python3-qrcode|python3-zbar|libmagick|imagemagick-[0-9.]+-common)' || true)
    if ((${#unneeded[@]})); then run "${PM[@]}" apt-get "${APT_WAIT[@]}" remove -y "${unneeded[@]}"; fi
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
    printf '    rm -rf'
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
cleanup() {
    if [[ -n $sudo_keeper ]]; then kill "$sudo_keeper" 2>/dev/null || true; fi
    rm -rf "$tmp"
}
trap cleanup EXIT
trap on_interrupt INT TERM HUP
chmod 755 "$tmp"  # apt reads the package as its sandbox user, _apt

gnome=$(gnome-shell --version 2>/dev/null | grep -oE '[0-9]+' | head -n 1) || gnome=''
log "== [$(date '+%F %T')] install.sh $action ${package:+$package }(${PRETTY_NAME:-?}, GNOME ${gnome:-none}, installed: $(installed_version || true), release: $RELEASE)"

# ------------------------------------------------------------------ uninstall

if [[ $action == uninstall ]]; then
    step 'Checking your system'
    # The packaged jade, not an older copy in ~/.local/bin that PATH finds first.
    jade=/usr/bin/jade
    [[ -x $jade ]] || jade=$(command -v jade || true)
    kit=$DATA/restore-kit
    present=''
    if package_present; then present=1; fi
    changed=''
    if [[ -e $STATE/setup.json || -d $STATE/backups ]]; then changed=1; fi
    if [[ -z $present && -z $jade && -z $changed && ! -d $kit ]]; then
        done_step
        say ''
        note "Jade Shell isn't on this computer. Nothing to remove."
        if [[ -n $(user_copies) ]]; then
            note 'An older or development copy is still in your home folder. To remove it:'
            note "$(remove_hint)"
        fi
        exit 0
    fi
    if [[ -z $jade && ! -d $kit && -n $changed ]]; then
        fail "Jade Shell's look is still on this desktop, but the files that undo it are gone. Install Jade Shell again with the install command, then remove it with this one."
    fi
    if [[ -n $assume_yes && -n $present ]] && ! (exec </dev/tty) 2>/dev/null && ! sudo -n true 2>/dev/null; then
        # Without a terminal sudo can't ask, and a restored desktop with the
        # package still installed would be a half-done removal.
        fail "Removing Jade Shell needs your password, which can only be asked for in a terminal. Open a terminal window and run this there."
    fi
    if [[ -z $assume_yes ]] && ! (exec </dev/tty) 2>/dev/null; then
        fail 'There is no terminal to ask on. To remove Jade Shell without being asked, add --yes after --uninstall.'
    fi
    done_step
    if [[ -z $assume_yes ]]; then
        say ''
        if ! ask 'Remove Jade Shell and put your desktop back the way it was?' n; then
            note 'Nothing was changed.'
            exit 0
        fi
    fi
    if [[ -n $present ]]; then need_sudo 'to remove it'; else say ''; fi

    restored='' keep_record=''
    if [[ -n $jade || -d $kit ]] && [[ -n $changed || -d $kit ]]; then
        step 'Restoring your desktop'
        fail_message='Your desktop was not put back, so Jade Shell was not removed.'
        if [[ -n $jade ]]; then
            restore=("$jade" restore --yes)
        else
            # The package is gone already (removed with the Software app or
            # apt): the copy of its code setup keeps puts the desktop back.
            restore=(env PYTHONPATH="$kit" /usr/bin/python3 -P -m jade restore --yes)
        fi
        rc=0
        try detached "$tmp/restore.out" env JADE_SUMMARY_FILE="$tmp/restore.json" "${restore[@]}" || rc=$?
        info=() partial=()
        if eval "$(read_summary "$tmp/restore.json" || echo false)"; then :; else
            mapfile -t info < <(grep -v -e '^$' -e '^Restored the desktop you had' -e '^Nothing to restore' \
                -e '^Not everything could be put back' "$tmp/restore.out" || true)
            if grep -q '^Restored the desktop you had' "$tmp/restore.out"; then restored=1; fi
        fi
        if ((rc == 0)) && ((${#partial[@]})); then
            # Put back, except what it lists: its record and backups stay.
            done_step "$dim–$plain"
            show_lines "${info[@]}" "${partial[@]}"
            restored='' keep_record=1
        elif ((rc == 0)); then
            done_step
            show_lines "${info[@]}" "${partial[@]}"
        elif grep -q 'Not everything could be put back' "$tmp/restore.out" && (exec </dev/tty) 2>/dev/null; then
            done_step "$dim–$plain"
            show_lines "${info[@]}" "${partial[@]}"
            say ''
            if ! ask "Some things couldn't be put back (above). Remove Jade Shell anyway? What couldn't be put back stays as it is now." n; then
                note 'Jade Shell was not removed. Your desktop is partly back; fix what stopped it and run this again.'
                exit 0
            fi
            restored='' keep_record=1  # a later restore may still need the record
        else
            fail
        fi
        fail_message=''
    fi

    if package_present; then
        step 'Removing Jade Shell'
        package_remove
        done_step
    fi
    # Jade Shell's own files (downloaded wallpapers and previews, the kept
    # download, caches), as a removal by the Software app ends too; the log
    # stays for a report. Only after a full restore: the record is its undo.
    if [[ -z $keep_record ]] && [[ -n $restored || ( -z $changed && ! -d $kit ) ]]; then
        rm -rf "${DATA:?}" "${CACHE:?}"
        # Backups a restore left (one it could not read, set aside) hold
        # someone's own files: they stay, and are named.
        find "${STATE:?}" -mindepth 1 -maxdepth 1 ! -name install.log ! -name install.lock ! -name backups \
            -exec rm -rf {} + 2>/dev/null || true
        if [[ -d $STATE/backups ]] && ! rmdir "$STATE/backups" 2>/dev/null; then
            note "Some of your earlier settings files are kept in ${STATE/#$HOME/\~}/backups."
        fi
    fi
    if [[ -n $(user_copies) ]]; then
        note 'An older or development copy of Jade Shell is still in your home folder. To remove it:'
        note "$(remove_hint)"
    fi
    if [[ -n $restored ]]; then
        card 'Jade Shell is removed' 'Your desktop is back the way it was.' 'Log out and back in to finish.'
    else
        card 'Jade Shell is removed' 'Log out and back in to finish.'
    fi
    offer_logout
    exit 0
fi

# ------------------------------------------------------------------ install

step 'Checking your system'
if [[ $kind == rpm && -e /run/ostree-booted ]]; then
    fail "Jade Shell doesn't work on Fedora Silverblue and the other Atomic desktops yet."
fi
command -v gnome-shell >/dev/null || fail "Jade Shell works only with the GNOME desktop, and this computer doesn't have it."
if [[ -z $gnome ]]; then
    fail "Jade Shell needs the GNOME desktop of Ubuntu 26.04 or Fedora 44, and couldn't find which one this computer has."
elif ((gnome < 50)); then
    if [[ $ID == ubuntu || $ID == fedora ]]; then
        fail "Jade Shell needs Ubuntu 26.04 or Fedora 44. This computer runs $PRETTY_NAME, which is too old for it. Upgrade first, then run this again."
    fi
    fail "Jade Shell needs a newer GNOME desktop (the one in Ubuntu 26.04 and Fedora 44). $PRETTY_NAME doesn't have it yet."
elif ((gnome > 50)); then
    fail "This computer runs $PRETTY_NAME, which is newer than Jade Shell supports so far. Support for it is on the way."
fi
in_gnome_session || fail "Open a terminal on your GNOME desktop and run this there. Jade Shell sets up the desktop you're logged in to."

if [[ -n $(user_copies) ]]; then
    fail "An older or development copy of Jade Shell is in your home folder, and GNOME would keep using it instead. Remove it, then run this again:
$(remove_hint)"
fi
if [[ $kind == deb ]] && ! grep -rqsE '^(Components:.*\buniverse\b|deb .*\buniverse\b)' /etc/apt/sources.list /etc/apt/sources.list.d/; then
    fail "Jade Shell needs a few free programs from Ubuntu's community software, which is turned off on this computer. Open Software & Updates and tick \"Community-maintained free and open-source software\", or run this, then run the install again:
    sudo add-apt-repository universe"
fi
# Another program already called jade (openjade, a documentation tool).
owner=''
if [[ -e /usr/bin/jade ]]; then
    if [[ $kind == rpm ]]; then owner=$(rpm -qf --qf '%{NAME}\n' /usr/bin/jade 2>/dev/null | head -n 1) || owner=''
    else owner=$(dpkg -S /usr/bin/jade 2>/dev/null | cut -d: -f1) || owner=''; fi
fi
if [[ -n $owner && $owner != jade-shell && $owner != *'not owned'* ]]; then
    remove="sudo dnf remove $owner"
    [[ $kind == rpm ]] || remove="sudo apt remove $owner"
    fail "Another program on this computer, $owner, already uses the name \"jade\". Remove it with this command, then run this again:
    $remove"
fi
# The package and what it needs go to /usr; the icons, wallpapers and
# previews to your home folder.
usr_free=$(df -Pm /usr | awk 'NR == 2 { print $4 }')
home_free=$(df -Pm "$HOME" | awk 'NR == 2 { print $4 }')
if [[ $(stat -c %d /usr) == $(stat -c %d "$HOME") ]]; then
    need=500 free=$usr_free
else
    need=300 free=$home_free
    if ((usr_free < 200)); then need=200 free=$usr_free; fi
fi
if ((free < need)); then
    fail "There isn't enough free space: Jade Shell needs about $need MB and only $free MB is free. Empty the Trash or clear some downloads, then run this again."
fi

# The release: its version, then its checksums and package from that one
# release, so a release published mid-download can't mix. (JADE_RELEASE, a
# test build, is used as it is.)
release_version=''
if [[ -z $package ]]; then
    [[ -n $fetcher ]] || fail "Jade Shell needs a download tool, and this computer has neither wget nor curl. Install one with this command, then run this again:
    sudo $([[ $kind == rpm ]] && echo dnf || echo apt) install wget"
    step_detail='asking GitHub for the latest version'
    if try fetch "$RELEASE/VERSION" "$tmp/VERSION" quick; then
        release_version=$(tr -d '[:space:]' <"$tmp/VERSION")
        [[ $release_version =~ ^[0-9][0-9A-Za-z.+~-]*$ ]] || release_version=''
    fi
    if [[ -n $release_version && -z ${JADE_RELEASE:-} ]]; then
        RELEASE=https://github.com/$REPO/releases/download/v$release_version
    fi
    try fetch "$RELEASE/SHA256SUMS" "$tmp/SHA256SUMS" quick \
        || fail "Couldn't reach GitHub, where Jade Shell downloads from. Check your internet connection, then run this again."
    step_detail=''
fi

# What is installed decides the rest: nothing to download when this release
# (or a newer build) is already here and whole; a test build (JADE_RELEASE)
# and --reinstall always install.
installed=$(installed_version)
plan=install mode=''
if [[ -z $package && -z $reinstall && -z ${JADE_RELEASE:-} && -n $installed && -n $release_version ]] \
    && [[ -x /usr/bin/jade && -d /usr/share/gnome-shell/extensions/$UUID ]]; then
    if [[ ${installed%-*} == "$release_version" ]] || newer "${installed%-*}" "$release_version"; then plan=setup; fi
fi
done_step

if [[ $plan == setup ]]; then
    version=$installed
    if newer "${installed%-*}" "$release_version"; then
        step "A newer Jade Shell (${installed%-*}) is already on this computer"
    else
        step "Jade Shell ${installed%-*} is already on this computer"
    fi
    done_step
else
    offer_extras
    need_sudo 'to install it'

    if [[ -n $package ]]; then
        step 'Using your package'
        [[ -f $package && $package == *.$kind ]] || fail "That isn't a .$kind package: $package"
        cp -- "$package" "$tmp/jade-shell.$kind"
    else
        step 'Downloading Jade Shell'
        # Into a folder that outlives this run: a download that was cut off
        # continues where it stopped the next time.
        mkdir -p "$CACHE/download"
        part=$CACHE/download/jade-shell-${release_version:-latest}.$kind
        expected=$(awk -v f="jade-shell.$kind" '$2 == f || $2 == "*" f { print $1 }' "$tmp/SHA256SUMS")
        [[ -n $expected ]] || fail "The release doesn't list a .$kind package. Try again in a few minutes; if it keeps happening, tell us at $ISSUES."
        sum() { sha256sum "$1" 2>/dev/null | cut -d' ' -f1; }
        if [[ ! -s $part || $(sum "$part") != "$expected" ]]; then
            dl_offset=$(stat -c %s "$part" 2>/dev/null) || dl_offset=0
            dl_file=$part
            rm -f "$tmp/headers"
            fail_message="The download stopped: the internet connection dropped or GitHub didn't answer. Run the same command again; it continues where it stopped."
            if ! try fetch "$RELEASE/jade-shell.$kind" "$part" resume; then
                # A server that can't continue a partial file (curl then
                # stops; wget starts over by itself): once more from the start.
                # Anything else keeps what arrived, for the next run to continue.
                if [[ $(step_tail) =~ does\ not\ seem\ to\ support|curl:\ \(33\)|416 ]]; then
                    rm -f "$part" "$tmp/headers"
                    dl_offset=0
                    run fetch "$RELEASE/jade-shell.$kind" "$part" resume
                else
                    fail
                fi
            fi
            dl_file='' fail_message=''
            if [[ $(sum "$part") != "$expected" ]]; then
                rm -f "$part"
                fail "The download arrived damaged, so nothing was installed. Run this again; if it keeps happening, tell us at $ISSUES."
            fi
        fi
        cp -- "$part" "$tmp/jade-shell.$kind"
    fi
    chmod 644 "$tmp/jade-shell.$kind"
    version=$(package_version "$tmp/jade-shell.$kind")
    done_step

    installed=$(installed_version)
    if [[ -n $installed && $installed == "$version" ]]; then mode=reinstall; fi
    step "Installing Jade Shell ${version%-*}"
    package_install "$tmp/jade-shell.$kind" "$mode"
    installed_now=1
    if [[ -n ${part:-} ]]; then rm -f "$part"; fi  # installed: the kept download has done its job
    done_step
fi

step 'Setting up your desktop'
# Setup says when a log-out is needed (the Shell keeps running the extension
# code it loaded at login); the installer then offers it.
finish_rows=() finish_login=''
fail_message="Something unexpected stopped the setup. Nothing is lost: run jade setup to try again, or jade debug to tell us."
run quiet_setup
fail_message=''
done_step
finish

if [[ $plan == install ]]; then
    if [[ -n $want_extras ]]; then add_extras "$tmp/jade-shell.$kind"; fi
elif [[ -n $(missing_extras installed) ]] && (exec </dev/tty) 2>/dev/null; then
    # Declined, or not added last time: a run again offers them.
    say ''
    offer_extras
    if [[ -n $want_extras ]]; then
        desktop_done=1
        need_sudo 'to add text and QR code reading'
        add_extras installed
    fi
fi

if ((${#finish_rows[@]})); then
    if [[ $plan == setup ]]; then
        card "Jade Shell ${version%-*} is set up" "${finish_rows[@]}"
    else
        card "Jade Shell ${version%-*} is installed" "${finish_rows[@]}"
    fi
    if [[ -n $finish_login ]]; then offer_logout; fi
fi
log "== [$(date '+%F %T')] finished"
