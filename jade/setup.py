"""Set up a desktop for Jade Shell, check it, and put the old one back.

`setup` records the value of every setting it changes before changing it
(state/jade-shell/setup.json), the same way each theme switch keeps a backup,
so `restore` can return the desktop to exactly how it was.
"""
import json
import os
import pathlib
import shutil
import subprocess
import sys

import gi

gi.require_version('Gio', '2.0')
from gi.repository import Gio, GLib

from . import engine, shelltheme, themes
from .store import Setting, config_home, data_home, write_text

UUID = 'jade-shell@parvezrob.github.io'
SHELL = 'org.gnome.shell'
DOCK_SCHEMA = 'org.gnome.shell.extensions.dash-to-dock'
DASH_TO_DOCK = 'dash-to-dock@micxgx.gmail.com'
UBUNTU_DOCK = 'ubuntu-dock@ubuntu.com'

# Extensions whose job Jade Shell now does. Running both would fight over the
# same part of the Shell (or just do the work twice).
REPLACED = {
    'openbar@neuromorph': 'top bar and menu styling',
    'user-theme@gnome-shell-extensions.gcampax.github.com': 'the Shell theme',
    'simple-workspaces-bar@null-git': 'workspace buttons',
    'panel-date-format@keiii.github.com': 'the clock format',
    'app-grid-tuner@m-lab': 'the app grid',
    'just-perfection-desktop@just-perfection': 'hiding Activities and starting on the desktop',
    'blur-my-shell@aunetx': 'the overview background',
    'monitor@astraext.github.io': 'the system monitor',
    'osaka-ai-usage@local': 'AI usage (Jade AI Usage is now part of Jade Shell)',
}
OLD_UNITS = ['osaka-ai-usage.timer']

# The dock as Jade Shell ships it: small, at the bottom, out of the way.
DOCK_LAYOUT = {
    'dock-position': 'BOTTOM',
    'dock-fixed': False,
    'autohide': True,
    'intellihide': True,
    'intellihide-mode': 'ALL_WINDOWS',
    'dash-max-icon-size': 24,
    'icon-size-fixed': True,
    'extend-height': False,
    'always-center-icons': True,
    'custom-background-color': True,
    'transparency-mode': 'FIXED',
    'background-opacity': 0.78,
    'apply-custom-theme': False,
    'running-indicator-style': 'DOT',
    'custom-theme-customize-running-dots': True,
    'show-trash': True,
    'show-mounts': False,
    'click-action': 'minimize-or-previews',
    'scroll-action': 'cycle-windows',
    'hide-tooltip': True,
}

USAGE_SERVICE = '''[Unit]
Description=Collect Claude and Codex usage for Jade Shell

[Service]
Type=oneshot
ExecStart={jade} usage collect
Environment=PATH=%h/.local/bin:/usr/local/bin:/usr/bin:/bin
TimeoutStartSec=150
UMask=0077
Nice=10
'''
USAGE_TIMER = '''[Unit]
Description=Refresh Jade Shell's AI usage every ten minutes

[Timer]
OnStartupSec=20
OnUnitActiveSec=10min
RandomizedDelaySec=15

[Install]
WantedBy=timers.target
'''


def manifest_path():
    return engine.state_dir() / 'setup.json'


def load_manifest():
    try:
        return json.loads(manifest_path().read_text())
    except (OSError, ValueError):
        return {'settings': [], 'disabled_units': []}


def say(text):
    print(text, flush=True)


def systemctl(*args):
    return subprocess.run(['systemctl', '--user', *args], capture_output=True, text=True)


def jade_command():
    found = os.environ.get('JADE_BIN') or shutil.which('jade')
    return str(pathlib.Path(found).resolve()) if found else None


def extension_installed(uuid):
    return any((base / uuid / 'metadata.json').exists()
               for base in (data_home() / 'gnome-shell/extensions', pathlib.Path('/usr/share/gnome-shell/extensions')))


def extension_state(uuid):
    """The running Shell's view: 'active', 'inactive', 'unknown' (needs a new login) or None (no Shell)."""
    try:
        bus = Gio.bus_get_sync(Gio.BusType.SESSION)
        info = bus.call_sync('org.gnome.Shell.Extensions', '/org/gnome/Shell/Extensions',
                             'org.gnome.Shell.Extensions', 'GetExtensionInfo', GLib.Variant('(s)', (uuid,)),
                             None, Gio.DBusCallFlags.NONE, 2000, None).unpack()[0]
    except GLib.Error:
        return None
    if not info:
        return 'unknown'
    return 'active' if info.get('state') == 1 else 'inactive'


def usage_wanted():
    home = pathlib.Path.home()
    return any(shutil.which(cli) for cli in ('claude', 'codex')) or (home / '.claude').exists() or (home / '.codex').exists()


# ------------------------------------------------------------------ setup

def planned_settings(ctx):
    settings = ctx.settings
    shell = settings.get(SHELL)
    enabled = [uuid for uuid in shell.get_strv('enabled-extensions') if uuid not in REPLACED]
    disabled = [uuid for uuid in shell.get_strv('disabled-extensions') if uuid not in (UUID, DASH_TO_DOCK)]
    enabled.append(UUID)
    # Ubuntu Dock is Dash to Dock under another name; never run both.
    if not extension_installed(UBUNTU_DOCK) and extension_installed(DASH_TO_DOCK):
        enabled.append(DASH_TO_DOCK)
    out = [
        Setting(SHELL, 'disable-user-extensions', False),
        Setting(SHELL, 'enabled-extensions', list(dict.fromkeys(enabled))),
        Setting(SHELL, 'disabled-extensions', disabled),
    ]
    if settings.has(DOCK_SCHEMA):
        out += [Setting(DOCK_SCHEMA, key, value) for key, value in DOCK_LAYOUT.items() if settings.has(DOCK_SCHEMA, key)]
    if settings.has('org.gnome.shell.extensions.jade-shell', 'show-usage'):
        out.append(Setting('org.gnome.shell.extensions.jade-shell', 'show-usage', usage_wanted()))
    return out


def record(ctx, manifest, changes):
    """Remember each key's value from before Jade Shell, the first time only."""
    known = {(e['schema'], e['path'], e['key']) for e in manifest['settings']}
    for change in changes:
        if (change.schema, change.path, change.key) not in known and ctx.settings.differs(change):
            manifest['settings'].append({'schema': change.schema, 'path': change.path, 'key': change.key,
                                         'old': ctx.settings.user_value(change)})


def install_usage_timer(manifest):
    jade = jade_command()
    if not jade:
        return 'jade is not on PATH'
    units = config_home() / 'systemd/user'
    write_text(units / 'jade-usage.service', USAGE_SERVICE.format(jade=jade))
    write_text(units / 'jade-usage.timer', USAGE_TIMER)
    for unit in OLD_UNITS:
        if systemctl('is-enabled', unit).stdout.strip() == 'enabled':
            systemctl('disable', '--now', unit)
            if unit not in manifest['disabled_units']:
                manifest['disabled_units'].append(unit)
    systemctl('daemon-reload')
    result = systemctl('enable', '--now', 'jade-usage.timer')
    systemctl('start', '--no-block', 'jade-usage.service')
    return None if result.returncode == 0 else result.stderr.strip()


def setup(ctx, theme_id='osaka-jade'):
    version = shelltheme.installed_shell_version()
    if version not in shelltheme.available_versions():
        supported = ', '.join(str(v) for v in shelltheme.available_versions())
        say(f'Jade Shell supports GNOME {supported}; this is GNOME {version or "(not found)"}.')
        return 1
    if not shelltheme.compiler_available():
        say('Jade Shell needs sassc to build the Shell theme. Install it with your package manager.')
        return 1

    manifest = load_manifest()
    changes = planned_settings(ctx)
    record(ctx, manifest, changes)
    write_text(manifest_path(), json.dumps(manifest, indent=2))
    enabled_before = set(ctx.settings.get(SHELL).get_strv('enabled-extensions'))
    ctx.settings.write(changes)
    for uuid in sorted(enabled_before & set(REPLACED)):
        say(f'Turned off {uuid}: Jade Shell now does {REPLACED[uuid]}.')

    problem = install_usage_timer(manifest)
    write_text(manifest_path(), json.dumps(manifest, indent=2))
    if problem:
        say(f'AI usage collector not started: {problem}')

    say('Preparing theme previews…')
    for tid in themes.ids():
        if not themes.thumbnail_path(tid).exists():
            try:
                themes.make_thumbnail(themes.load(tid))
            except Exception as error:  # a preview is not worth failing setup over
                say(f'  no preview for {tid}: {error}')

    # The current theme (or the starting one), applied everywhere: this also
    # builds anything a new version of Jade Shell adds, and changes nothing else.
    state = engine.current()
    theme = themes.load(state['theme'] if state.get('theme') in themes.ids() else theme_id)
    ctx.wallpaper_index = state.get('wallpaper') or 0
    changes, _backup = engine.apply(theme, ctx)
    say(f'{theme.name}: {len(changes)} change{"" if len(changes) == 1 else "s"} applied.')

    state = extension_state(UUID)
    if state in ('unknown', None) and os.environ.get('XDG_SESSION_TYPE') == 'wayland':
        say('Done. Log out and back in once to start Jade Shell.')
    else:
        say('Done.')
    say('Change theme with Super+Ctrl+Shift+Space. Undo everything with: jade restore')
    return 0


# ------------------------------------------------------------------ restore

def restore(ctx, assume_yes=False):
    manifest = load_manifest()
    history = engine.backups()
    if not history and not manifest['settings']:
        say('Nothing to restore: Jade Shell has not changed this desktop.')
        return 0
    if not assume_yes:
        if not sys.stdin.isatty():
            say('Run with --yes to restore without a prompt.')
            return 1
        answer = input(f'Undo {len(history)} theme switch(es) and Jade Shell setup? [y/N] ')
        if answer.strip().lower() not in ('y', 'yes'):
            return 1
    while engine.undo(ctx):
        pass
    for entry in reversed(manifest['settings']):
        ctx.settings.restore(entry['schema'], entry['path'], entry['key'], entry['old'])
    Gio.Settings.sync()
    units = config_home() / 'systemd/user'
    systemctl('disable', '--now', 'jade-usage.timer')
    for name in ('jade-usage.service', 'jade-usage.timer'):
        (units / name).unlink(missing_ok=True)
    systemctl('daemon-reload')
    for unit in manifest['disabled_units']:
        systemctl('enable', '--now', unit)
    manifest_path().unlink(missing_ok=True)
    say('Restored the desktop you had before Jade Shell. Log out and back in to finish.')
    return 0


# ------------------------------------------------------------------ doctor

def doctor(ctx):
    problems = 0

    def check(ok, text, fix=None):
        nonlocal problems
        say(f'{"✓" if ok else "✗"} {text}')
        if not ok:
            problems += 1
            if fix:
                say(f'    {fix}')

    version = shelltheme.installed_shell_version()
    check(version in shelltheme.available_versions(), f'GNOME Shell {version or "not found"}',
          f'Jade Shell supports GNOME {", ".join(map(str, shelltheme.available_versions()))}')
    check(shelltheme.compiler_available(), 'Shell theme compiler (sassc)', 'Install the sassc package')
    check(extension_installed(UUID), 'Jade Shell extension installed', 'Reinstall Jade Shell')
    enabled = ctx.settings.get(SHELL).get_strv('enabled-extensions')
    check(UUID in enabled and not ctx.settings.get(SHELL).get_boolean('disable-user-extensions'),
          'Jade Shell extension enabled', 'Run: jade setup')
    state = extension_state(UUID)
    if state is not None:
        check(state == 'active', f'Jade Shell running in GNOME Shell ({state})',
              'Log out and back in' if state == 'unknown' else 'Check: journalctl --user -b | grep -i jade')
    clashing = [uuid for uuid in enabled if uuid in REPLACED]
    check(not clashing, 'No extensions doing the same job', f'Run: jade setup (turns off {", ".join(clashing)})')
    check(ctx.settings.has(DOCK_SCHEMA), 'Dock (Dash to Dock or Ubuntu Dock)', 'Install Dash to Dock')

    current = engine.current().get('theme')
    check(bool(current), f'Theme: {current or "none applied"}', 'Run: jade setup')
    for target in engine.selected():
        reason = target.available(ctx)
        say(f'  {"·" if reason is None else "-"} {target.label}{"" if reason is None else f" (skipped: {reason})"}')

    timer = systemctl('is-active', 'jade-usage.timer').stdout.strip()
    say(f'  · AI usage collector: {timer or "unknown"}')
    say('All good.' if not problems else f'{problems} problem(s) found.')
    return 1 if problems else 0
