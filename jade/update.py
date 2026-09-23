"""Find out about a new Jade Shell release, and install it.

Each release carries a VERSION file next to its packages and SHA256SUMS, so
the check is one small download from the same place the installer uses (no
GitHub API and its rate limits). `jade update` downloads the package for this
system, checks it against SHA256SUMS and installs it with dnf or apt: through
sudo in a terminal, or pkexec (GNOME's password dialog) without one, as when
the top bar's "Update" runs it. The running Shell keeps the old version until
the next login, where the extension finishes the update (see setup.py).
"""
import hashlib
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
VERSION_RE = re.compile(r'\d+(\.\d+)*')


class UpdateError(Exception):
    """A sentence to show, not a traceback."""


def say(text):
    print(text, flush=True)


def version_key(version):
    return tuple(int(part) for part in version.split('.'))


def fetch(name, timeout=20):
    request = urllib.request.Request(f'{RELEASE}/{name}', headers={'User-Agent': f'jade-shell/{__version__}'})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.read()
    except (urllib.error.URLError, OSError, ValueError) as error:
        reason = getattr(error, 'reason', error)
        raise UpdateError(f'Could not reach the Jade Shell releases ({reason}).') from error


def latest():
    text = fetch('VERSION', timeout=10).decode(errors='replace').strip()
    if not VERSION_RE.fullmatch(text):
        raise UpdateError(f'The release has no usable version ({text[:40]!r}).')
    return text


def cache_path():
    return engine.state_dir() / 'update.json'


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


def verified_download(kind, directory):
    name = f'jade-shell.{kind}'
    sums = fetch('SHA256SUMS').decode(errors='replace')
    wanted = next((line.split()[0] for line in sums.splitlines() if line.split()[1:] == [name]), None)
    if not wanted:
        raise UpdateError(f'The release has no checksum for {name}.')
    data = fetch(name, timeout=120)
    if hashlib.sha256(data).hexdigest() != wanted:
        raise UpdateError(f'The downloaded {name} does not match the release checksum; nothing was installed.')
    path = os.path.join(directory, name)
    with open(path, 'wb') as f:
        f.write(data)
    return path


# Installed by the package: installs a jade-shell package file as root. Through
# pkexec, GNOME's dialog says "Authentication is required to update Jade Shell".
HELPER = '/usr/libexec/jade-shell/install-update'


def install_command(path, elevate):
    return [elevate, HELPER, path]


def update(check_only=False, as_json=False):
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
        return 0
    if check_only:
        say(f'Jade Shell {newest} is available (you have {__version__}). Update with: jade update')
        return 0
    if not kind or not os.access(HELPER, os.X_OK):
        say(f'Jade Shell {newest} is available, but this copy is not from a package: '
            'update the checkout and run scripts/dev-install.sh.')
        return 1

    terminal = sys.stdin.isatty()
    say(f'Updating Jade Shell {__version__} → {newest}…')
    with tempfile.TemporaryDirectory(prefix='jade-update-') as directory:
        try:
            path = verified_download(kind, directory)
        except UpdateError as error:
            say(str(error))
            return 1
        # Its output in order with ours, in a terminal or the extension's update.log.
        result = subprocess.run(install_command(path, 'sudo' if terminal else 'pkexec'), stderr=subprocess.STDOUT)
    if result.returncode in (126, 127) and not terminal:  # pkexec: dialog dismissed, or not allowed
        say('Not updated: the password dialog was closed.')
        return 2
    if result.returncode != 0:
        say(f'The package manager could not install Jade Shell {newest} (exit {result.returncode}).')
        return 1
    say(f'Installed Jade Shell {newest}. Log out and back in to finish; Jade Shell does the rest at login.')
    if terminal:
        offer_logout()
    return 0
