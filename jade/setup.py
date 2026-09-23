"""Set up a desktop for Jade Shell, check it, and put the old one back.

`setup` records the value of every setting it changes before changing it
(state/jade-shell/setup.json), the same way each theme switch keeps a backup,
so `restore` can return the desktop to exactly how it was.
"""
import json
import os
import pathlib
import shlex
import shutil
import subprocess
import sys

import gi

gi.require_version('Gio', '2.0')
from gi.repository import Gio, GLib

from . import __version__, engine, migrations, shelltheme, themes
from .store import Setting, config_home, data_home, write_text
from .usage import collect

UUID = 'jade-shell@parvezrob.github.io'
SHELL = 'org.gnome.shell'
DOCK_SCHEMA = 'org.gnome.shell.extensions.dash-to-dock'
DASH_TO_DOCK = 'dash-to-dock@micxgx.gmail.com'
UBUNTU_DOCK = 'ubuntu-dock@ubuntu.com'
JADE_SCHEMA = 'org.gnome.shell.extensions.jade-shell'
# Opinionated defaults the user may change later: setup sets each key only once.
PREFERENCE_SCHEMAS = (DOCK_SCHEMA, JADE_SCHEMA)

# Extensions whose job Jade Shell now does. Running both would fight over the
# same part of the Shell (or just do the work twice).
# Extensions setup turns off, by UUID: their name, and the job Jade Shell does
# instead (or the top bar they would take over). `jade restore` turns them back on.
REPLACED = {
    'openbar@neuromorph': ('Open Bar', 'top bar and menu styling'),
    'transparent-top-bar@zhanghai.me': ('Transparent Top Bar', 'top bar styling'),
    'dash-to-panel@jderose9.github.com': ('Dash to Panel', 'the top bar and the dock (it moves the top bar into a taskbar)'),
    'bottom-dash-panel@fthx': ('Bottom Dash Panel', 'the dock'),
    'user-theme@gnome-shell-extensions.gcampax.github.com': ('User Themes', 'the Shell theme'),
    'simple-workspaces-bar@null-git': ('Simple Workspaces Bar', 'workspace buttons'),
    'panel-date-format@keiii.github.com': ('Panel Date Format', 'the clock format'),
    'app-grid-tuner@m-lab': ('App Grid Tuner', 'the app grid'),
    'just-perfection-desktop@just-perfection': ('Just Perfection', 'hiding Activities and starting on the desktop'),
    'blur-my-shell@aunetx': ('Blur my Shell', 'the overview background'),
    'monitor@astraext.github.io': ('Astra Monitor', 'the system monitor'),
    'Vitals@CoreCoding.com': ('Vitals', 'the system monitor'),
    'tophat@fflewddur.github.io': ('TopHat', 'the system monitor'),
    'system-monitor@gnome-shell-extensions.gcampax.github.com': ('System Monitor', 'the system monitor'),
    'notification-position@drugo.dev': ('Notification Banner Position', 'where notifications pop up'),
    'notification-banner-re-reloaded@chrhuang': ('Notification Banner Re-Reloaded', 'where notifications pop up'),
    'osaka-ai-usage@local': ('Jade AI Usage', 'AI usage (Jade AI Usage is now part of Jade Shell)'),
}
OLD_UNITS = ['osaka-ai-usage.timer']
SYSTEM_EXTENSIONS = pathlib.Path('/usr/share/gnome-shell/extensions')

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
# Removed with dnf or apt before `jade restore`: skip quietly instead of failing every run.
ConditionFileIsExecutable={jade}

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


def progress(text):
    """One line that updates in place on a terminal; None clears it. Elsewhere
    (a log, a pipe) it stays quiet: the line after it says how it went."""
    if not sys.stdout.isatty():
        return
    print(f'\r\033[K{text}' if text else '\r\033[K', end='', flush=True)


def join(names):
    """'a', 'a and b', 'a, b and c'."""
    if len(names) < 2:
        return ''.join(names) or 'nothing'
    return f'{", ".join(names[:-1])} and {names[-1]}'


def systemctl(*args):
    return subprocess.run(['systemctl', '--user', *args], capture_output=True, text=True)


def jade_command():
    found = os.environ.get('JADE_BIN') or shutil.which('jade')
    return str(pathlib.Path(found).resolve()) if found else None


def extension_installed(uuid):
    return any((base / uuid / 'metadata.json').exists()
               for base in (data_home() / 'gnome-shell/extensions', SYSTEM_EXTENSIONS))


def leftovers():
    """Copies in the home folder that get in the package's way, and old versions' files.

    Returns (paths to remove, units to disable). Only ever reported: they may
    be someone's development checkout, so nothing here deletes them.
    """
    home, extensions = pathlib.Path.home(), data_home() / 'gnome-shell/extensions'
    paths = []
    # GNOME Shell loads a user extension before the package's, and ~/.local/bin
    # comes first on PATH: a dev or pre-package copy would keep running instead.
    if (extensions / UUID).exists() and (SYSTEM_EXTENSIONS / UUID).exists():
        paths.append(extensions / UUID)
        lib = data_home() / 'jade-shell/lib'
        if lib.exists():
            paths.append(lib)
        link = home / '.local/bin/jade'
        if link.is_symlink() and link.resolve().is_relative_to(lib):
            paths.append(link)
    # From before Jade Shell and Jade AI Usage merged.
    old = [home / '.local/lib/jade-shell', home / '.local/lib/osaka-ai-usage', home / '.local/bin/jade-theme',
           extensions / 'osaka-ai-usage@local']
    paths += [path for path in old if path.exists() or path.is_symlink()]
    units = [unit for unit in OLD_UNITS if systemctl('is-enabled', unit).stdout.strip() == 'enabled']
    return paths, units


def leftover_commands(paths, units):
    commands = []
    if paths:
        commands.append('rm -rf ' + ' '.join(shlex.quote(str(path)) for path in paths))
    if units:
        commands.append('systemctl --user disable --now ' + ' '.join(units))
    return commands


def extension_info(uuid):
    """What the running Shell loaded for this extension: {} when it has not
    seen it (a new login needed), None when no Shell answers."""
    try:
        bus = Gio.bus_get_sync(Gio.BusType.SESSION)
        info = bus.call_sync('org.gnome.Shell.Extensions', '/org/gnome/Shell/Extensions',
                             'org.gnome.Shell.Extensions', 'GetExtensionInfo', GLib.Variant('(s)', (uuid,)),
                             None, Gio.DBusCallFlags.NONE, 2000, None).unpack()[0]
    except GLib.Error:
        return None
    return info


# GNOME Shell's ExtensionState values (js/misc/extensionUtils.js).
STATES = {1: 'active', 2: 'inactive', 3: 'error', 4: 'out of date'}


def extension_state(uuid):
    """The running Shell's view: 'active', 'inactive', 'error', 'out of date',
    'unknown' (needs a new login) or None (no Shell)."""
    info = extension_info(uuid)
    if info is None:
        return None
    if not info:
        return 'unknown'
    return STATES.get(info.get('state'), 'inactive')


def needs_login(uuid):
    """Whether the running Shell has yet to load this copy of the extension.

    The Shell loads an extension's code once per login: a new one is unknown
    to it, and one updated underneath it keeps running (or fails with) the
    old code. Only packages stamp a version to compare.
    """
    info = extension_info(uuid)
    if info is None:
        return False
    running = info.get('version-name')
    return not info or info.get('state') != 1 or bool(running and running != __version__)


def usage_wanted():
    return any(collect.present(provider) for provider in collect.PROVIDERS)


def usage_shown(ctx):
    """The AI usage switch in the preferences; with it off, nothing runs in the background."""
    return not ctx.settings.has(JADE_SCHEMA, 'show-usage') or ctx.settings.get(JADE_SCHEMA).get_boolean('show-usage')


# ------------------------------------------------------------------ setup

def planned_settings(ctx, keep=()):
    """What setup sets. Extensions in `keep` stay on even if Jade Shell replaces them."""
    settings = ctx.settings
    shell = settings.get(SHELL)
    enabled = [uuid for uuid in shell.get_strv('enabled-extensions') if uuid not in REPLACED or uuid in keep]
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
    if settings.has(JADE_SCHEMA, 'show-usage'):
        out.append(Setting(JADE_SCHEMA, 'show-usage', usage_wanted()))
    return out


def record(ctx, manifest, changes):
    """Remember each key's value from before Jade Shell, the first time only."""
    known = {(e['schema'], e['path'], e['key']) for e in manifest['settings']}
    for change in changes:
        if (change.schema, change.path, change.key) not in known and ctx.settings.differs(change):
            manifest['settings'].append({'schema': change.schema, 'path': change.path, 'key': change.key,
                                         'old': ctx.settings.user_value(change)})


def install_usage_timer(manifest, enable=True):
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
    if not enable:
        # Turned off in the preferences: the units stay for the switch to turn back on.
        systemctl('disable', '--now', 'jade-usage.timer')
        return None
    result = systemctl('enable', '--now', 'jade-usage.timer')
    systemctl('start', '--no-block', 'jade-usage.service')
    return None if result.returncode == 0 else result.stderr.strip()


def sticks(change):
    """Whether setup's value is set once and then left to the person. AI usage
    turned off only because neither Claude Code nor Codex was here is not a
    choice anyone made: it turns on at the first setup after one appears."""
    return not (change.key == 'show-usage' and change.value is False)


def setup(ctx, theme_id=None, after_update=False):
    """Set up this desktop, or finish an update (`after_update`: run by the
    extension at the first login with a new version, without a terminal)."""
    version = shelltheme.installed_shell_version()
    if version not in shelltheme.available_versions():
        supported = ', '.join(str(v) for v in shelltheme.available_versions())
        say(f'Jade Shell supports GNOME {supported}; this is GNOME {version or "(not found)"}.')
        return 1
    if not shelltheme.compiler_available():
        say('Jade Shell needs sassc to build the Shell theme. Install it with your package manager.')
        return 1

    fresh = not manifest_path().exists()
    manifest = load_manifest()
    if fresh:
        migrations.mark_all()  # a first setup starts from how things are now
    elif not migrations.run_pending(ctx, say):
        return 1
    # An extension Jade Shell already replaced when setup last ran and that is
    # on again was turned back on by its owner: an update leaves it alone. Only
    # ones a new version learned about are turned off.
    keep = set(manifest.get('replaced', REPLACED)) if after_update else ()
    planned = planned_settings(ctx, keep)
    if 'defaulted' not in manifest:
        # Set up by an older version, which has already applied these once.
        manifest['defaulted'] = ([[c.schema, c.path, c.key] for c in planned if c.schema in PREFERENCE_SCHEMAS and sticks(c)]
                                 if manifest_path().exists() else [])
    done = {tuple(key) for key in manifest['defaulted']}
    changes = [c for c in planned if c.schema not in PREFERENCE_SCHEMAS or (c.schema, c.path, c.key) not in done]
    record(ctx, manifest, changes)
    manifest['defaulted'] += [[c.schema, c.path, c.key] for c in changes if c.schema in PREFERENCE_SCHEMAS and sticks(c)]
    write_text(manifest_path(), json.dumps(manifest, indent=2))
    enabled_before = set(ctx.settings.get(SHELL).get_strv('enabled-extensions'))
    ctx.settings.write(changes)
    for uuid in sorted(enabled_before & set(REPLACED) - set(keep)):
        name, job = REPLACED[uuid]
        say(f'Turned off {name}: Jade Shell does {job}.')

    if usage_wanted():
        # Read after the settings above are written: a first setup turns it on, and a
        # later one keeps a person's "off" (the key is set only once).
        problem = install_usage_timer(manifest, enable=usage_shown(ctx))
        write_text(manifest_path(), json.dumps(manifest, indent=2))
        if problem:
            say(f'AI usage collector not started: {problem}')
    elif (config_home() / 'systemd/user/jade-usage.timer').exists():
        systemctl('disable', '--now', 'jade-usage.timer')  # neither Claude Code nor Codex is here any more

    missing = [tid for tid in themes.ids() if not themes.thumbnail_path(tid).exists()]
    for done, tid in enumerate(missing):
        progress(f'Downloading theme previews {done + 1}/{len(missing)}…')
        try:
            themes.make_thumbnail(themes.load(tid))
        except themes.WallpaperUnavailable as error:  # offline: the rest would fail the same way
            progress(None)
            say(f'No theme previews ({error}); the picker shows colors until you run: jade theme thumbs')
            break
        except Exception as error:  # a preview is not worth failing setup over; the picker shows colors
            progress(None)
            say(f'No preview for {tid}: {str(error).splitlines()[0]}')
    else:
        if missing:
            progress(None)
            say(f'Downloaded {len(missing)} theme previews.')

    # The theme asked for, else the current one, else Osaka Jade, applied
    # everywhere: this also builds anything a new version of Jade Shell adds.
    state = engine.current()
    current = state.get('theme') if state.get('theme') in themes.ids() else None
    theme = themes.load(theme_id or current or 'osaka-jade')
    ctx.wallpaper_index = state.get('wallpaper') or 0
    changes, _backup = engine.apply(theme, ctx)
    themed = [t.title for t in engine.selected() if t.name not in ctx.absent and t.name not in ctx.skipped]
    say(f'{theme.name} applied to {join(themed)}.')
    for name, reason in ctx.skipped.items():
        say(f'Not themed: {name} ({reason})')

    commands = leftover_commands(*leftovers())
    if commands:
        # Never removed here: it may be someone's development copy.
        say('Your home folder still has files from an older or development copy of Jade Shell. '
            'Remove them with:')
        for command in commands:
            say(f'    {command}')

    # Which version this desktop is set up for: the extension compares it with
    # its own at login, and finishes an update when they differ.
    manifest.update(version=__version__, replaced=sorted(REPLACED))
    write_text(manifest_path(), json.dumps(manifest, indent=2))
    if after_update:
        say(f'Jade Shell {__version__} is set up.')
        return 0
    say('Change theme with Super+Ctrl+Shift+Space. Undo everything with: jade restore')
    if needs_login(UUID):
        say('Done. Log out and back in once to start this version of Jade Shell.')
        offer_logout()
    else:
        say('Done.')
    return 0


def offer_logout():
    """Ask on the terminal (stdin is the script itself when piped from curl),
    then open GNOME's own log-out dialog: it confirms, and warns about apps with
    unsaved work. Without a terminal or a GNOME session, the sentence is enough."""
    if 'GNOME' not in os.environ.get('XDG_CURRENT_DESKTOP', '').split(':'):
        return
    try:
        # A terminal can't be opened for both in text mode: it isn't seekable.
        with open('/dev/tty', 'w') as out, open('/dev/tty') as tty:
            out.write('Log out now? GNOME asks you to confirm first. [Y/n] ')
            out.flush()
            answer = tty.readline().strip().lower()
    except OSError:  # no terminal: run from a script or a service
        return
    if answer in ('', 'y', 'yes'):
        try:
            subprocess.run(['gnome-session-quit', '--logout'], check=False)
        except OSError:
            say('Could not open the log-out dialog; log out from the top bar\'s menu.')


# ------------------------------------------------------------------ restore

def merged_extensions(ctx, entry):
    """An extension list with only setup's own change undone.

    Extensions enabled or disabled since setup stay as the user left them.
    Returns the list, and whether it is just the default again.
    """
    shell = ctx.settings.get(SHELL)
    key = entry['key']
    default = shell.get_default_value(key).unpack()
    old = default if entry['old'] is None else GLib.Variant.parse(None, entry['old'], None, None).unpack()
    now = shell.get_strv(key)
    if key == 'enabled-extensions':
        added = {UUID} | ({DASH_TO_DOCK} if DASH_TO_DOCK not in old else set())
        keep = [uuid for uuid in now if uuid not in added]
        back = [uuid for uuid in old if uuid in REPLACED]  # the ones setup turned off
    else:  # disabled-extensions: setup took Jade Shell and Dash to Dock out of it
        keep = now
        back = [uuid for uuid in old if uuid in (UUID, DASH_TO_DOCK)]
    wanted = set(keep) | set(back)
    # What was there before keeps its old place; anything newer goes at the end.
    result = list(dict.fromkeys([u for u in old if u in wanted] + [u for u in keep if u not in old]))
    return result, entry['old'] is None and result == list(default)


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
    kept, merged, skipped, stuck = [], [], [], []
    # A broken backup that could not be set aside stays where it is: go on past it.
    while (undone := engine.undo(ctx, ignore=stuck)) is not None:
        kept += undone['kept']
        merged += undone.get('merged', [])
        skipped += undone['skipped']
        if undone.get('stuck'):
            stuck.append(undone['stuck'])

    rest = []
    for entry in reversed(manifest['settings']):
        if entry['schema'] == SHELL and entry['key'] in ('enabled-extensions', 'disabled-extensions'):
            value, is_default = merged_extensions(ctx, entry)
            shell = ctx.settings.get(SHELL)
            if is_default:
                shell.reset(entry['key'])
            else:
                shell.set_strv(entry['key'], value)
        else:
            rest.append(entry)
    skipped += ctx.settings.restore_all(rest)  # also flushes the extension lists
    units = config_home() / 'systemd/user'
    systemctl('disable', '--now', 'jade-usage.timer')
    for name in ('jade-usage.service', 'jade-usage.timer'):
        (units / name).unlink(missing_ok=True)
    shutil.rmtree(units / 'jade-usage.timer.d', ignore_errors=True)  # the refresh interval set in prefs
    systemctl('daemon-reload')
    for unit in manifest['disabled_units']:
        systemctl('enable', '--now', unit)
    manifest_path().unlink(missing_ok=True)
    for path in dict.fromkeys(merged):
        say(f'Took Jade Shell\'s part out of {path}; your edits since stay.')
    for path in dict.fromkeys(kept):
        say(f'Kept {path}: it changed after Jade Shell wrote it, so it was left as it is.')
    for item in skipped:
        say(f'Skipped {item}')
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
        error = (extension_info(UUID) or {}).get('error')
        check(state == 'active', f'Jade Shell running in GNOME Shell ({state})',
              '\n    '.join([*([f'GNOME Shell says: {error}'] if error else []),
                             'Log out and back in (GNOME Shell loads extensions at login).',
                             'If it stays like this, check: journalctl --user -b | grep -i jade']))
    # Packages stamp their version into the extension; the Shell keeps running
    # the code it loaded at login until the next one.
    running = (extension_info(UUID) or {}).get('version-name')
    if running:
        check(running == __version__, f'GNOME Shell runs this version of the extension ({running})',
              f'The Shell still runs {running}; log out and back in to load {__version__}')
    set_for = load_manifest().get('version')
    if set_for:  # set up by a version that stamps it
        check(set_for == __version__, f'Set up for this version of Jade Shell ({set_for})',
              'Run: jade setup (the extension also does it at your next login)')
    clashing = [uuid for uuid in enabled if uuid in REPLACED]
    check(not clashing, 'No extensions doing the same job or taking over the top bar',
          f'Run: jade setup (turns off {", ".join(REPLACED[uuid][0] for uuid in clashing)})')
    paths, units = leftovers()
    check(not paths and not units, 'No older or development copies in your home folder',
          '\n    '.join(['Remove them with:', *leftover_commands(paths, units)]))
    if not ctx.settings.has(DOCK_SCHEMA):  # optional: the look is complete without it, just dockless
        say('· No dock installed (optional). For the full look, install Dash to Dock.')

    current = engine.current().get('theme')
    check(bool(current), f'Theme: {current or "none applied"}', 'Run: jade setup')
    for target in engine.selected():
        reason = target.available(ctx)
        say(f'  {"·" if reason is None else "-"} {target.label}{"" if reason is None else f" ({reason})"}')

    timer = systemctl('is-active', 'jade-usage.timer').stdout.strip()
    say(f'  · AI usage collector: {timer or "unknown"}')
    say('All good.' if not problems else f'{problems} problem(s) found.')
    return 1 if problems else 0
