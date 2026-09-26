"""`jade debug`: the facts a bug report needs, without personal details.

Collects versions (Jade Shell, the extension GNOME Shell is running, GNOME,
the OS), the session and GPU, extensions, setup and theme state, `jade
doctor`, the ends of the install and update logs, and GNOME Shell's recent
messages about Jade Shell. The user name, real name, host name and home
folder are replaced before anything is shown or saved.
"""
import getpass
import os
import pathlib
import platform
import pwd
import re
import shutil
import socket
import subprocess
import sys
import urllib.parse
import webbrowser

from . import __version__, engine, setup
from .store import Settings, state_home

ISSUES = 'https://github.com/parvezrob/jade-shell/issues/new'
LOG_LINES = 40


def command(*argv, timeout=10):
    """A command's output, or a note that it could not run."""
    if not shutil.which(argv[0]):
        return f'({argv[0]} is not installed)'
    try:
        result = subprocess.run(argv, capture_output=True, text=True, timeout=timeout)
    except (OSError, subprocess.TimeoutExpired) as error:
        return f'({argv[0]} failed: {error})'
    return (result.stdout or result.stderr).strip()


def tail(path, lines=LOG_LINES):
    try:
        return '\n'.join(path.read_text(errors='replace').splitlines()[-lines:]) or '(empty)'
    except OSError:
        return '(none)'


def os_name():
    try:
        text = pathlib.Path('/etc/os-release').read_text()
    except OSError:
        return 'unknown'
    found = re.search(r'^PRETTY_NAME="?([^"\n]*)', text, re.M)
    return found.group(1) if found else 'unknown'


def gpus():
    out = command('lspci', '-nnk')
    if out.startswith('('):
        return out
    lines, keep = [], False
    for line in out.splitlines():
        if not line.startswith(('\t', ' ')):
            keep = bool(re.search(r'VGA|3D controller|Display controller', line))
            if keep:
                lines.append(line)
        elif keep and 'Kernel driver in use' in line:
            lines.append(line.strip())
    return '\n'.join(lines) or '(no display controller listed)'


def package_version():
    for argv in (['rpm', '-q', 'jade-shell'], ['dpkg-query', '-W', '-f', '${Version}', 'jade-shell']):
        if shutil.which(argv[0]):
            result = subprocess.run(argv, capture_output=True, text=True)
            if result.returncode == 0 and result.stdout.strip():
                return result.stdout.strip()
    return 'not installed from a package'


def shell_messages():
    """Recent GNOME Shell lines about Jade Shell, from the user's journal (and
    the system one, where the Shell logs on some systems and the user may read)."""
    found = []
    for argv in (['journalctl', '--user', '-b', '--no-pager', '-o', 'short-iso', '-n', '4000'],
                 ['journalctl', '-b', '--no-pager', '-o', 'short-iso', '-n', '4000', '_COMM=gnome-shell']):
        out = command(*argv, timeout=20)
        found += [line for line in out.splitlines() if re.search(r'jade', line, re.I)]
    return '\n'.join(list(dict.fromkeys(found))[-60:]) or '(nothing mentions Jade Shell)'


def jade_settings(ctx):
    schema = setup.JADE_SCHEMA
    if not ctx.settings.has(schema):
        return "(Jade Shell's settings are not installed)"
    settings = ctx.settings.get(schema)
    changed = [f'{key} = {settings.get_user_value(key).print_(False)}'
               for key in settings.props.settings_schema.list_keys() if settings.get_user_value(key) is not None]
    return '\n'.join(sorted(changed)) or '(all defaults)'


def state_summary(ctx):
    manifest = setup.load_manifest()
    current = engine.current()
    return '\n'.join([
        f'set up for: {manifest.get("version") or ("(older version)" if setup.manifest_path().exists() else "never")}',
        f'theme: {current.get("theme") or "none"} (wallpaper {current.get("wallpaper")})',
        f'switches in the undo history: {len(engine.backups())}',
        f'apps left alone: {", ".join(sorted(engine.left_alone(ctx.settings))) or "none"}',
        f'settings setup changed: {len(manifest.get("settings", []))}',
    ])


def doctor_text(ctx):
    lines = []
    for row in setup.diagnose(ctx):
        mark = ('·' if row.get('active', True) else '-') if row['ok'] is None else '✓' if row['ok'] else '✗'
        lines.append(f'{mark} {row["text"]}')
        if row['fix']:
            lines += [f'    {line}' for line in row['fix'].splitlines()]
    return '\n'.join(lines)


def report(ctx):
    shell = setup.SHELL
    info = setup.extension_info(setup.UUID) or {}
    enabled = ctx.settings.get(shell).get_strv('enabled-extensions')
    disabled = ctx.settings.get(shell).get_strv('disabled-extensions')
    sections = [
        ('Jade Shell', '\n'.join([
            f'jade: {__version__}',
            f'package: {package_version()}',
            f'extension GNOME Shell runs: {info.get("version-name") or "(none or a development copy)"}'
            f' ({setup.extension_state(setup.UUID) or "no Shell answered"})',
            *([f'extension error: {info["error"]}'] if info.get('error') else []),
        ])),
        ('System', '\n'.join([
            f'OS: {os_name()}',
            f'GNOME Shell: {command("gnome-shell", "--version")}',
            f'session: {os.environ.get("XDG_SESSION_TYPE", "unknown")} ({os.environ.get("XDG_CURRENT_DESKTOP", "?")})',
            f'kernel: {platform.release()}',
            f'python: {platform.python_version()}',
        ])),
        ('GPU', gpus()),
        ('Extensions', '\n'.join([
            f'user extensions {"off" if ctx.settings.get(shell).get_boolean("disable-user-extensions") else "on"}',
            f'enabled: {", ".join(enabled) or "none"}',
            f'disabled: {", ".join(disabled) or "none"}',
        ])),
        ('Setup and theme', state_summary(ctx)),
        ('Jade Shell settings changed from the defaults', jade_settings(ctx)),
        ('jade doctor', doctor_text(ctx)),
        ('install.log (end)', tail(state_home() / 'jade-shell/install.log')),
        ('setup.log (end)', tail(state_home() / 'jade-shell/setup.log')),
        ('update.log', tail(state_home() / 'jade-shell/update.log')),
        ('GNOME Shell messages about Jade Shell (this boot)', shell_messages()),
    ]
    text = '\n\n'.join(f'## {title}\n{body}' for title, body in sections)
    return anonymize(f'# Jade Shell debug report\n\n{text}\n')


def anonymize(text):
    """The home folder, user name, real name and host name, replaced."""
    home = str(pathlib.Path.home())
    user = getpass.getuser()
    try:
        real = pwd.getpwnam(user).pw_gecos.split(',')[0].strip()
    except KeyError:
        real = ''
    text = text.replace(home, '~')
    for secret, stand_in in ((real, '<name>'), (socket.gethostname(), '<host>'), (user, '<user>')):
        if len(secret) >= 3:
            text = re.sub(re.escape(secret), stand_in, text, flags=re.I)
    return text


def issue_url(text):
    """A new-issue link with the short sections in the body; the full report
    is too long for a URL (GitHub stops around 8 KB), so it asks for the file."""
    short = text.split('## jade doctor')[0].strip()
    body = ('**What happened?**\n\n\n**What did you expect?**\n\n\n'
            '**Details** (from `jade debug`; please also attach the saved jade-debug.txt)\n\n'
            f'```\n{short}\n```\n')
    return f'{ISSUES}?{urllib.parse.urlencode({"body": body})}'


def save(text, path=None):
    path = pathlib.Path(path) if path else pathlib.Path.home() / 'jade-debug.txt'
    path.write_text(text)
    return path


def debug(print_only=False, save_to=None, open_issue=False):
    ctx = engine.Context(Settings())
    text = report(ctx)
    if print_only or not (save_to or open_issue or sys.stdin.isatty()):
        print(text)
        return 0
    if save_to or open_issue:
        path = save(text, save_to)
        print(f'Saved to {str(path).replace(str(pathlib.Path.home()), "~", 1)}')
        if open_issue:
            webbrowser.open(issue_url(text))
            print('Opened a new GitHub issue with the details; attach the saved file to it.')
        return 0
    print(text)
    answer = input('Save it to ~/jade-debug.txt and open a GitHub issue with it? [y/N] ').strip().lower()
    if answer in ('y', 'yes'):
        return debug(open_issue=True)
    return 0


if __name__ == '__main__':
    sys.exit(debug(print_only=True))
