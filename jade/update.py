"""Find out about a new Jade Shell release, and install it.

Each release carries a VERSION file next to its packages and SHA256SUMS, so
the check is one small download from the same place the installer uses (no
GitHub API and its rate limits). `jade update` downloads the package for this
system from that version's own release, checks it against SHA256SUMS and
installs it with dnf or apt: through sudo in a terminal, or pkexec (GNOME's
password dialog) without one, as when the top bar's "Update" runs it. What dnf
or apt print goes to update.log; the screen shows one plain line per step. The
running Shell keeps the old version until the next login, where the extension
finishes the update (see setup.py).
"""
import contextlib
import hashlib
import http.client
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

from . import __version__, engine
from .setup import offer_logout
from .store import write_text

REPO = 'parvezrob/jade-shell'
# JADE_RELEASE: another place with the same files (file:// works), as for install.sh.
RELEASE = os.environ.get('JADE_RELEASE') or f'https://github.com/{REPO}/releases/latest/download'
NOTES = f'https://github.com/{REPO}/releases'
ISSUES = f'github.com/{REPO}/issues'
VERSION_RE = re.compile(r'\d+(\.\d+)*')
# The extension follows these lines of `jade update` to show what it's doing.
INSTALLING = 'Installing Jade Shell'
WAITING = 'Waiting for other updates on this computer to finish…'
# What apt (with DPkg::Lock::Timeout) and dnf5 print while another program
# installs something; install-update runs them untranslated.
LOCK_WAIT = ('Waiting for cache lock', 'Waiting for a lock')


class UpdateError(Exception):
    """A sentence to show, not a traceback."""


# update.log, while `jade update` runs: its own lines and everything dnf or
# apt print, for "Show details" and `jade debug`.
_log = None


def say(text):
    print(text, flush=True)
    note(text)


def note(text):
    """A line for update.log only."""
    if _log:
        _log.write(text.rstrip('\n') + '\n')
        _log.flush()


def version_key(version):
    return tuple(int(part) for part in version.split('.'))


def request(url, headers=()):
    return urllib.request.Request(url, headers={'User-Agent': f'jade-shell/{__version__}', **dict(headers)})


def unreachable(error):
    note(f'({getattr(error, "reason", error)})')
    return UpdateError("Couldn't reach GitHub, where Jade Shell downloads from. "
                       'Check your internet connection, then try again.')


def fetch(name, timeout=20, base=None):
    try:
        with urllib.request.urlopen(request(f'{base or RELEASE}/{name}'), timeout=timeout) as response:
            return response.read()
    except (urllib.error.URLError, OSError, ValueError, http.client.HTTPException) as error:
        raise unreachable(error) from error


def pinned(version):
    """Where that version's files stay. The latest release can change between
    two downloads (one published meanwhile), which would check one release's
    package against another's SHA256SUMS; a mirror (JADE_RELEASE) has one."""
    if RELEASE.endswith('/releases/latest/download'):
        return f'{RELEASE.removesuffix("/latest/download")}/download/v{version}'
    return RELEASE


def latest():
    text = fetch('VERSION', timeout=10).decode(errors='replace').strip()
    if not VERSION_RE.fullmatch(text):
        note(f'VERSION: {text[:40]!r}')
        raise UpdateError("The Jade Shell release can't be read right now. Try again later.")
    return text


def cache_path():
    return engine.state_dir() / 'update.json'


def log_path():
    return engine.state_dir() / 'update.log'


def check():
    """The latest version, remembered with when it was asked (the extension
    reads it to ask at most once a day)."""
    version = latest()
    write_text(cache_path(), json.dumps({'checked': int(time.time()), 'latest': version}))
    return version


def installed_kind():
    """'rpm' or 'deb' when the package is installed, else None (a checkout)."""
    if shutil.which('rpm') and subprocess.run(['rpm', '-q', 'jade-shell'], capture_output=True).returncode == 0:
        return 'rpm'
    if shutil.which('dpkg-query'):
        status = subprocess.run(['dpkg-query', '-W', '-f', '${db:Status-Status}', 'jade-shell'],
                                capture_output=True, text=True).stdout
        if status == 'installed':
            return 'deb'
    return None


def download(url, path, progress=None, attempts=5):
    """Stream url into path, calling progress(done, total) as it comes. A
    dropped connection continues where it stopped (or starts over where the
    server can't), a few times, before giving up."""
    done = 0
    for attempt in range(attempts):
        if attempt:
            time.sleep(min(2 * attempt, 6))
        try:
            with urllib.request.urlopen(request(url, {'Range': f'bytes={done}-'} if done else {}),
                                        timeout=30) as response:
                if done and getattr(response, 'status', None) != 206:
                    done = 0  # the whole file again
                size = response.headers.get('Content-Length')
                total = done + int(size) if size and size.isdigit() else None
                with open(path, 'ab' if done else 'wb') as f:
                    while chunk := response.read(1 << 16):
                        f.write(chunk)
                        done += len(chunk)
                        if progress:
                            progress(done, total)
            if total is None or done >= total:
                return
            note(f'The download stopped at {done} of {total} bytes; continuing.')
        except urllib.error.HTTPError as error:
            if error.code < 500 and error.code not in (408, 429):  # not there: trying again won't help
                raise unreachable(error) from error
            note(f'{url}: {error}; trying again.')
        except (urllib.error.URLError, OSError, http.client.HTTPException) as error:
            if isinstance(error, urllib.error.URLError) and not done and attempt == attempts - 1:
                raise unreachable(error) from error
            note(f'{url}: {getattr(error, "reason", error) or type(error).__name__}; trying again.')
    raise UpdateError('The download kept stopping because the internet connection dropped. '
                      'Nothing was installed; try again when the connection is steady.')


def verified_download(kind, directory, version=None, progress=None):
    base = pinned(version) if version else RELEASE
    name = f'jade-shell.{kind}'
    sums = fetch('SHA256SUMS', base=base).decode(errors='replace')
    wanted = next((line.split()[0] for line in sums.splitlines() if line.split()[1:] == [name]), None)
    if not wanted:
        note(f'SHA256SUMS has no line for {name}.')
        raise UpdateError("The Jade Shell release can't be read right now. Try again later.")
    path = os.path.join(directory, name)
    download(f'{base}/{name}', path, progress)
    digest = hashlib.sha256()
    with open(path, 'rb') as f:
        while chunk := f.read(1 << 20):
            digest.update(chunk)
    if digest.hexdigest() != wanted:
        raise UpdateError('The download arrived damaged, so nothing was installed. Try again; '
                          f'if it keeps happening, let us know at {ISSUES}.')
    return path


# Installed by the package: installs a jade-shell package file as root. Through
# pkexec, GNOME's dialog says "Authentication is required to update Jade Shell".
HELPER = '/usr/libexec/jade-shell/install-update'


def install_command(path, elevate):
    return [elevate, HELPER, path]


def explain(kind, output, version):
    """Why dnf or apt failed, from what they printed (untranslated), in words
    for the person: the lock, a full disk, what's worth doing."""
    # apt 3 writes "Error:" instead of "E:" when it thinks it has a terminal.
    errors = [line for line in output.splitlines() if line.startswith(('E: ', 'Error: '))]
    if 'No space left on device' in output:
        return 'Your disk is full. Free some space, then try again.'
    if 'dpkg was interrupted' in output:
        return ('An earlier install on this computer was interrupted. Finish it first with: '
                'sudo dpkg --configure -a')
    # apt's last error when it gave up waiting for the lock (after 20 minutes):
    # "Unable to acquire the dpkg frontend lock" or "Unable to lock the
    # administration directory", both asking "is another process using it?"
    if errors and any(text in errors[-1] for text in ('Could not get lock', 'another process using it')):
        return 'Your computer is installing other updates. Try again when they finish.'
    if 'fix-broken' in output:
        return ('Some software on this computer is only partly installed. Finish it first with: '
                'sudo apt --fix-broken install')
    if any(text in output for text in ('not installable', 'Unable to locate', 'no installation candidate',
                                       'unmet dependencies', 'Unable to satisfy dependencies',
                                       'Failed to fetch', 'Unable to fetch', 'Failed to download',
                                       'Cannot download', 'nothing provides')):
        return ("Jade Shell's new version needs other software that couldn't be downloaded. "
                'Check your internet connection, then try again.')
    system = "Fedora's" if kind == 'rpm' else "Ubuntu's"
    return f"{system} software installer couldn't install Jade Shell {version}."


def run_helper(command, show):
    """Run install-update, its output into update.log, and say when it waits
    for other updates. Returns its exit status and output."""
    output = []
    waiting = False
    with subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT) as proc:
        for raw in proc.stdout:
            line = raw.decode(errors='replace')
            output.append(line)
            note(line)
            if not waiting and any(wait in line for wait in LOCK_WAIT):
                waiting = True
                show(WAITING)
    return proc.returncode, ''.join(output)


def authorize():
    """In a terminal, ask for the password before the install starts, so the
    question isn't lost among the status lines."""
    if subprocess.run(['sudo', '-n', 'true'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0:
        return True
    say('Installing the update needs your password. Type the password you log in with, then press Enter.')
    return subprocess.run(['sudo', '-v']).returncode == 0


class Status:
    """One line on a terminal that changes in place; elsewhere (the extension
    reading along, a pipe) one line per step."""

    def __init__(self):
        self.live = sys.stdout.isatty()
        self.text = None

    def show(self, text):
        note(text)
        if self.live:
            print(f'\r\033[K{text}', end='', flush=True)
        elif text != self.text:
            print(text, flush=True)
        self.text = text

    def percent(self, prefix):
        shown = [None]

        def progress(done, total):
            value = done * 100 // total if total else None
            if self.live and value is not None and value != shown[0]:
                shown[0] = value
                print(f'\r\033[K{prefix} {value}%', end='', flush=True)
        return progress

    def end(self):
        if self.live and self.text is not None:
            print(flush=True)
        self.text = None


def update(check_only=False, as_json=False):
    if check_only or as_json:
        return check_and_say(check_only, as_json)
    with logging():
        try:
            return install_latest()
        except KeyboardInterrupt:  # Ctrl-C: a line, not a traceback
            print(flush=True)
            say('Stopped.')
            return 130


@contextlib.contextmanager
def logging():
    """update.log for this run, begun afresh (without it, the update goes on)."""
    global _log
    path = log_path()
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(f'jade update, {time.strftime("%Y-%m-%d %H:%M")}, Jade Shell {__version__}\n', encoding='utf-8')
    except OSError:
        yield
        return
    with open(path, 'a', encoding='utf-8') as _log:
        try:
            yield
        finally:
            _log = None


def check_and_say(check_only, as_json):
    kind = installed_kind()
    try:
        newest = check()
    except UpdateError as error:
        if as_json:
            print(json.dumps({'current': __version__, 'error': str(error)}))
        else:
            say(str(error))
        return 1
    available = version_key(newest) > version_key(__version__)
    if as_json:
        print(json.dumps({'current': __version__, 'latest': newest, 'available': available, 'package': kind}))
        return 0
    if not available:
        say(f'Jade Shell {__version__} is the latest version.')
    else:
        say(f'Jade Shell {newest} is available (you have {__version__}). Update with: jade update')
    return 0


def install_latest():
    kind = installed_kind()
    try:
        newest = check()
    except UpdateError as error:
        say(str(error))
        return 1
    if version_key(newest) <= version_key(__version__):
        say(f'Jade Shell {__version__} is the latest version.')
        return 0
    if not kind or not os.access(HELPER, os.X_OK):
        say(f'Jade Shell {newest} is available, but this copy is not from a package: '
            'update the checkout and run scripts/dev-install.sh.')
        return 1

    terminal = sys.stdin.isatty()
    status = Status()
    with tempfile.TemporaryDirectory(prefix='jade-update-') as directory:
        downloading = f'Downloading Jade Shell {newest}…'
        status.show(downloading)
        try:
            path = verified_download(kind, directory, newest, status.percent(downloading))
        except UpdateError as error:
            status.end()
            say(str(error))
            return 1
        status.end()
        if terminal and not authorize():
            say("Nothing was changed: installing the update needs an administrator's password.")
            return 1
        status.show(f'{INSTALLING} {newest}…')
        returncode, output = run_helper(install_command(path, 'sudo' if terminal else 'pkexec'), status.show)
        status.end()
    note(f'install-update: exit {returncode}')
    if returncode in (126, 127) and not terminal:  # pkexec: dialog dismissed, or not allowed
        say('Not updated: the password window was closed.')
        return 2
    if returncode != 0:
        say(explain(kind, output, newest))
        if terminal:
            say(f'The details are in {str(log_path()).replace(os.path.expanduser("~"), "~", 1)}.')
        return 1
    say(f'Installed Jade Shell {newest}. Log out and back in to start the new version.')
    if terminal:
        offer_logout()
    return 0
