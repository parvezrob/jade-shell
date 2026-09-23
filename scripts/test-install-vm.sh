#!/usr/bin/env bash
# Install a build of this checkout in a test VM the way users install Jade
# Shell: install.sh piped into bash, downloading the packages and checking them
# against SHA256SUMS, only from a folder in the VM instead of a release.
#
#   scripts/test-install-vm.sh [options] <ssh-host>
#
#   --no-build    use dist/ as it is instead of running build-packages.sh
#   --relogin     afterwards restart the VM's display manager, so its auto-login
#                 starts a new session with the new extension, and run jade doctor
#   --uninstall   run the uninstaller instead (install.sh --uninstall --yes)
#
# The VM needs SSH as its desktop user (with sudo), a logged-in GNOME session
# and, for --relogin, auto-login. SSH options come from $JADE_VM_SSH, e.g.
# JADE_VM_SSH='-F ~/VMs/jade-ubuntu/ssh_config'.
set -euo pipefail
root=$(cd -- "$(dirname -- "$0")/.." && pwd)

build=1 relogin='' uninstall='' host=''
for arg; do
    case $arg in
        --no-build) build='' ;;
        --relogin) relogin=1 ;;
        --uninstall) uninstall=1 ;;
        -*) echo "Unknown option: $arg" >&2; exit 2 ;;
        *) host=$arg ;;
    esac
done
[[ -n $host ]] || { sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 2; }

# shellcheck disable=SC2206  # $JADE_VM_SSH is a list of options
ssh_opts=(${JADE_VM_SSH:-})
# The commands run in the VM's shell, so they are passed as they are.
# shellcheck disable=SC2029
vm() { ssh "${ssh_opts[@]}" "$host" "$@"; }

# Run a command in the VM as if from a terminal in its GNOME session: with the
# session's bus, runtime dir and display, read from its gnome-shell process.
in_session() {
    vm "set -e
        pid=\$(pgrep -u \"\$USER\" -x gnome-shell | head -1)
        [ -n \"\$pid\" ] || { echo 'No GNOME session is running in the VM' >&2; exit 1; }
        while IFS= read -r -d '' var; do
            case \$var in DBUS_SESSION_BUS_ADDRESS=*|XDG_*|WAYLAND_DISPLAY=*|DISPLAY=*|DESKTOP_SESSION=*) export \"\$var\" ;; esac
        done < /proc/\$pid/environ
        $1"
}

if [[ -n $uninstall ]]; then
    scp -q "${ssh_opts[@]}" "$root/install.sh" "$host:/tmp/jade-install.sh"
    in_session 'bash /tmp/jade-install.sh --uninstall --yes'
else
    [[ -z $build ]] || "$root/scripts/build-packages.sh" >/dev/null
    for file in jade-shell.rpm jade-shell.deb SHA256SUMS; do
        [[ -f $root/dist/$file ]] || { echo "dist/$file is missing; run without --no-build" >&2; exit 1; }
    done
    vm 'rm -rf /tmp/jade-release && mkdir -p /tmp/jade-release'
    scp -q "${ssh_opts[@]}" "$root"/dist/{jade-shell.rpm,jade-shell.deb,SHA256SUMS} "$root/install.sh" "$host:/tmp/jade-release/"
    # Piped, as from curl: install.sh gets no terminal on stdin.
    in_session 'JADE_RELEASE=file:///tmp/jade-release bash < /tmp/jade-release/install.sh'
fi

if [[ -n $relogin ]]; then
    echo ':: Restarting the VM session…'
    vm 'sudo systemctl restart display-manager'
    for _ in $(seq 1 45); do
        sleep 2
        # shellcheck disable=SC2016  # $USER is the VM's
        if vm 'pgrep -u "$USER" -x gnome-shell >/dev/null' 2>/dev/null; then
            sleep 8  # let the Shell load its extensions
            in_session 'jade doctor' || true
            exit 0
        fi
    done
    echo 'The VM session did not come back within 90 seconds' >&2
    exit 1
fi
