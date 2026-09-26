"""Set up a desktop for Jade Shell, check it, and put the old one back.

`setup` records the value of every setting it changes before changing it
(state/jade-shell/setup.json), the same way each theme switch keeps a backup,
so `restore` can return the desktop to exactly how it was.
"""
import configparser
import contextlib
import datetime
import errno
import fcntl
import json
import os
import pathlib
import platform
import re
import shlex
import shutil
import subprocess
import sys
import time

import gi

gi.require_version('Gio', '2.0')
from gi.repository import Gio, GLib

from . import __version__, engine, hooks, icons, keys, migrations, network, reasons, restore_offer, shelltheme, themes
from .store import File, Setting, config_home, data_home, write_text
from .targets import font as font_target
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
# Extensions setup turns off, by UUID: their name, and why, as setup says it
# ("Turned off Vitals, since Jade Shell has its own system monitor").
# `jade restore` turns them back on.
REPLACED = {
    'openbar@neuromorph': ('Open Bar', 'Jade Shell styles the top bar and menus itself'),
    'transparent-top-bar@zhanghai.me': ('Transparent Top Bar', 'Jade Shell styles the top bar itself'),
    'dash-to-panel@jderose9.github.com': ('Dash to Panel', 'it would move the top bar into a taskbar'),
    'bottom-dash-panel@fthx': ('Bottom Dash Panel', 'Jade Shell has its own dock'),
    'user-theme@gnome-shell-extensions.gcampax.github.com': ('User Themes',
                                                             'Jade Shell brings its own look for the top bar and menus'),
    'simple-workspaces-bar@null-git': ('Simple Workspaces Bar', 'Jade Shell shows the workspaces in the top bar'),
    'panel-date-format@keiii.github.com': ('Panel Date Format', 'Jade Shell sets the clock format'),
    'app-grid-tuner@m-lab': ('App Grid Tuner', 'Jade Shell arranges the app grid'),
    'just-perfection-desktop@just-perfection': ('Just Perfection',
                                                'Jade Shell already hides Activities and starts on the desktop'),
    'blur-my-shell@aunetx': ('Blur my Shell', 'Jade Shell draws the overview background'),
    'monitor@astraext.github.io': ('Astra Monitor', 'Jade Shell has its own system monitor'),
    'Vitals@CoreCoding.com': ('Vitals', 'Jade Shell has its own system monitor'),
    'tophat@fflewddur.github.io': ('TopHat', 'Jade Shell has its own system monitor'),
    'system-monitor@gnome-shell-extensions.gcampax.github.com': ('System Monitor', 'Jade Shell has its own system monitor'),
    'notification-position@drugo.dev': ('Notification Banner Position', 'Jade Shell places the notifications'),
    'notification-banner-re-reloaded@chrhuang': ('Notification Banner Re-Reloaded', 'Jade Shell places the notifications'),
    'osaka-ai-usage@local': ('Jade AI Usage', 'it is now part of Jade Shell'),
}
# Docks Jade's own dock replaces while it is on (the show-dock setting).
DOCKS = {
    DASH_TO_DOCK: ('Dash to Dock', 'Jade Shell has its own dock'),
    UBUNTU_DOCK: ('Ubuntu Dock', 'Jade Shell has its own dock'),
    'dash2dock-lite@icedman.github.com': ('Dash2Dock Animated', 'Jade Shell has its own dock'),
}
# The parts of the desktop, as setup names what it themed (other apps by their titles).
DESKTOP_PARTS = {'shell': 'the top bar and menus', 'gtk': 'your apps', 'icons': 'icons', 'gnome': 'wallpaper',
                 'ptyxis': 'terminal (Ptyxis)'}
OLD_UNITS = ['osaka-ai-usage.timer']
# Flatpak apps see the host's gtk.css (the GNOME apps target) only when allowed to.
FLATPAK_PATHS = ['xdg-config/gtk-4.0:ro', 'xdg-config/gtk-3.0:ro']
# (The tests' sandbox points it elsewhere, so a Jade Shell package on the machine running them doesn't count.)
SYSTEM_EXTENSIONS = pathlib.Path(os.environ.get('JADE_SYSTEM_EXTENSIONS', '/usr/share/gnome-shell/extensions'))

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


HOME_FULL = 'Your home folder is full; free some space and run jade setup again.'


class Report:
    """What setup or restore tells the person as it goes: each note is
    printed, and kept for the summary the installer asks for."""

    def __init__(self):
        self.notes = []
        self.partial = []  # restore: what could not be put back
        # setup: for the installer's closing card
        self.login_needed = self.welcome = False
        self.shortcut = None
        self.turned_off = []

    def note(self, text):
        say(text)
        self.notes.append(text)

    def write(self, **fields):
        """The summary, as JSON, when the installer names a file for it in
        JADE_SUMMARY_FILE: it shows the notes its own way, and needs no parsing
        of what was printed."""
        path = os.environ.get('JADE_SUMMARY_FILE')
        if not path:
            return
        with contextlib.suppress(OSError):  # the installer falls back to what was printed
            pathlib.Path(path).write_text(json.dumps({**fields, 'notes': self.notes}, indent=2) + '\n')


def log_path():
    return engine.state_dir() / 'setup.log'


def log(text):
    """The details behind a plain sentence (error numbers and the like), for
    `jade debug` and whoever looks: people are shown only the sentence."""
    try:
        path = log_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        if path.exists() and path.stat().st_size > 200_000:  # the latest runs are enough
            path.write_text(path.read_text(errors='replace')[-100_000:])
        with path.open('a') as out:
            out.write(f'{datetime.datetime.now():%Y-%m-%d %H:%M:%S} {text}\n')
    except OSError:
        pass


def progress(text):
    """What setup is doing now, in a few words ('Applying Osaka Jade').

    On a terminal, one line that updates in place (None clears it). The
    installer runs setup without one: it names a file in JADE_PROGRESS_FILE,
    gets a line there for each step, and shows the last. Elsewhere (a log, a
    pipe) it stays quiet: the line after it says how it went.
    """
    steps = os.environ.get('JADE_PROGRESS_FILE')
    if text and steps:
        try:
            with open(steps, 'a') as out:
                out.write(text + '\n')
        except OSError:
            pass  # only the installer's display misses a step
    if sys.stdout.isatty():
        print(f'\r\033[K{text}…' if text else '\r\033[K', end='', flush=True)


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


def flatpak_overrides():
    return data_home() / 'flatpak/overrides/global'


def flatpak_filesystems():
    parser = configparser.ConfigParser(interpolation=None, strict=False)
    parser.optionxform = str
    try:
        parser.read(flatpak_overrides())
    except configparser.Error:
        return parser, None  # not ours to fix
    listed = parser.get('Context', 'filesystems', fallback='')
    return parser, [entry for entry in listed.split(';') if entry]


def grant_flatpak(manifest):
    """Let Flatpak apps read the theme's gtk.css, remembering what was added."""
    if not shutil.which('flatpak'):
        return
    _parser, listed = flatpak_filesystems()
    if listed is None:
        return
    have = {entry.split(':')[0] for entry in listed}
    added = [path for path in FLATPAK_PATHS if path.split(':')[0] not in have]
    if added and subprocess.run(['flatpak', 'override', '--user', *[f'--filesystem={p}' for p in added]],
                                capture_output=True).returncode == 0:
        manifest['flatpak_added'] = sorted(set(manifest.get('flatpak_added', [])) | set(added))


def revoke_flatpak(manifest):
    """Take out only what setup added; the rest of the overrides stay."""
    added = set(manifest.get('flatpak_added', []))
    parser, listed = flatpak_filesystems()
    if not added or not listed:
        return
    kept = [entry for entry in listed if entry not in added]
    if kept:
        parser.set('Context', 'filesystems', ';'.join(kept) + ';')
    else:
        parser.remove_option('Context', 'filesystems')
        if not parser.items('Context'):
            parser.remove_section('Context')
    if not parser.sections():
        flatpak_overrides().unlink(missing_ok=True)  # setup made it: nothing else was in it
        return
    with open(flatpak_overrides(), 'w') as f:
        parser.write(f, space_around_delimiters=False)


def usage_wanted():
    return any(collect.present(provider) for provider in collect.PROVIDERS)


def usage_shown(ctx):
    """The AI usage switch in the preferences; with it off, nothing runs in the background."""
    return not ctx.settings.has(JADE_SCHEMA, 'show-usage') or ctx.settings.get(JADE_SCHEMA).get_boolean('show-usage')


def dock_shown(ctx):
    """Jade's dock switch in the preferences (on unless turned off)."""
    return not ctx.settings.has(JADE_SCHEMA, 'show-dock') or ctx.settings.get(JADE_SCHEMA).get_boolean('show-dock')


def replaced(ctx):
    """Extensions setup turns off, by UUID: REPLACED, and the other docks while Jade's is on."""
    return {**REPLACED, **(DOCKS if dock_shown(ctx) else {})}


def running_extension(ctx, uuid):
    """Whether GNOME Shell loads `uuid` at login: enabled, or brought by the
    session (Ubuntu Dock comes with Ubuntu's), and not disabled."""
    shell = ctx.settings.get(SHELL)
    wanted = uuid in shell.get_strv('enabled-extensions') or (uuid == UBUNTU_DOCK and extension_installed(uuid))
    return wanted and uuid not in shell.get_strv('disabled-extensions')


# ------------------------------------------------------------------ setup

def planned_settings(ctx, keep=()):
    """What setup sets. Extensions in `keep` stay on even if Jade Shell replaces them."""
    settings = ctx.settings
    shell = settings.get(SHELL)
    out_of_the_way = replaced(ctx)
    enabled = [uuid for uuid in shell.get_strv('enabled-extensions') if uuid not in out_of_the_way or uuid in keep]
    disabled = [uuid for uuid in shell.get_strv('disabled-extensions') if uuid != UUID]
    enabled.append(UUID)
    if dock_shown(ctx):
        # Ubuntu Dock comes with Ubuntu's session, not from the enabled list:
        # only disabled-extensions keeps it off.
        disabled += [uuid for uuid in DOCKS if extension_installed(uuid) and uuid not in keep and uuid not in disabled]
    out = [
        Setting(SHELL, 'disable-user-extensions', False),
        Setting(SHELL, 'enabled-extensions', list(dict.fromkeys(enabled))),
        Setting(SHELL, 'disabled-extensions', disabled),
    ]
    if settings.has(DOCK_SCHEMA) and not dock_shown(ctx):
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


DEFAULT_FONT = 'JetBrains Mono'  # a dependency of the package, as Omarchy's font


def font_installed(family):
    try:
        return subprocess.run(['fc-list', '-q', family], timeout=20).returncode == 0
    except (OSError, subprocess.TimeoutExpired):
        return False


def welcomed():
    """Whether the Jade Shell app's Welcome page has been on screen here."""
    try:
        return 'window' in json.loads((engine.state_dir() / 'welcome.json').read_text()).get('shown', [])
    except (OSError, ValueError, AttributeError):
        return False


def unsupported(version):
    """Why this computer's GNOME can't run Jade Shell, naming the system as
    people know it rather than by its GNOME version."""
    try:
        system = platform.freedesktop_os_release()
    except OSError:
        system = {}
    name = system.get('PRETTY_NAME') or 'This computer'
    if version is None:
        return "Jade Shell works only with the GNOME desktop, and this computer doesn't have it."
    if version > max(shelltheme.available_versions()):
        return (f'{name} has a newer GNOME desktop than this Jade Shell knows. '
                'Run the install command again to get the latest Jade Shell.')
    if system.get('ID') in ('ubuntu', 'fedora'):
        return (f'Jade Shell needs Ubuntu 26.04 or Fedora 44. This computer runs {name}, which is too old for it. '
                'Upgrade first, then run this again.')
    return f"Jade Shell needs a newer GNOME desktop (the one in Ubuntu 26.04 and Fedora 44). {name} doesn't have it yet."


def turned_off(names_and_why):
    """One sentence for the extensions setup turned off."""
    if len(names_and_why) == 1:
        name, why = names_and_why[0]
        return f'Turned off {name}, since {why}. jade restore turns it back on.'
    whys = {why for _name, why in names_and_why}
    why = whys.pop() if len(whys) == 1 else 'Jade Shell does the same job'
    return f'Turned off {join([name for name, _why in names_and_why])}, since {why}. jade restore turns them back on.'


def themed_sentence(theme, ctx):
    """'Osaka Jade is on: the top bar and menus, your apps, icons, wallpaper and
    terminal (Ptyxis), plus btop and VS Code.'"""
    alone = engine.left_alone(ctx.settings)
    themed = [t for t in engine.selected(skip=alone) if t.name not in ctx.absent and t.name not in ctx.skipped]
    names = {t.name for t in themed}
    desktop = [part for name, part in DESKTOP_PARTS.items()
               if name in names and not (name == 'gnome' and ctx.wallpaper_error)]
    # The fonts have a line of their own, and the dock target colors Dash to
    # Dock, which is off while Jade Shell's own dock is on.
    left_out = {*DESKTOP_PARTS, 'font', *(['dock'] if dock_shown(ctx) else [])}
    others = [t.title for t in themed if t.name not in left_out]
    if desktop:
        return f'{theme.name} is on: {join(desktop)}' + (f', plus {join(others)}.' if others else '.')
    return f'{theme.name} is on for {join(others)}.' if others else f'{theme.name} is on.'


def part_name(name):
    """What setup calls a target: a part of the desktop, or the app's title."""
    return DESKTOP_PARTS.get(name) or engine.target_named(name).title


def setup(ctx, theme_id=None, after_update=False):
    """Set up this desktop, or finish an update (`after_update`: run by the
    extension at the first login with a new version, without a terminal)."""
    report = Report()
    try:
        status = set_up_desktop(ctx, report, theme_id, after_update)
    except OSError as error:
        if error.errno == errno.ENOSPC:
            report.notes.append(HOME_FULL)  # said by jade's main, which catches it
        raise
    finally:
        report.write(login_needed=report.login_needed, welcome=report.welcome, shortcut=report.shortcut,
                     turned_off=report.turned_off)
    if status == 0 and report.login_needed and not after_update:
        offer_logout()
    return status


def set_up_desktop(ctx, report, theme_id, after_update):
    version = shelltheme.installed_shell_version()
    if version not in shelltheme.available_versions():
        report.note(unsupported(version))
        return 1
    if not shelltheme.compiler_available():
        report.note('A part Jade Shell needs to draw its top bar (sassc) is missing. '
                    'Run the install command again to put it back.')
        return 1

    fresh = not manifest_path().exists()
    manifest = load_manifest()
    if fresh:
        migrations.mark_all()  # a first setup starts from how things are now
    elif not migrations.run_pending(ctx, report.note):
        return 1
    # An extension Jade Shell already replaced when setup last ran and that is
    # on again was turned back on by its owner: an update leaves it alone,
    # whether the extension finishes it at login or the installer is run
    # again. Only ones a new version learned about are turned off.
    updating = after_update or (not fresh and manifest.get('version') != __version__)
    # Docks left on until Jade Shell's own could start (see below) are not
    # the owner's choice: they go now.
    pending = set(manifest.pop('after_login', []))
    keep = (set(manifest.get('replaced', REPLACED)) if updating else set()) - pending
    out_of_the_way = replaced(ctx)
    running_before = {uuid for uuid in out_of_the_way if running_extension(ctx, uuid)}
    # Jade Shell's dock starts only once GNOME Shell loads the extension, at
    # the next login: turning the other dock off now would leave no dock at
    # all until then. It stays on (Jade's dock steps aside while it runs),
    # and the extension has it turned off when it starts (`after_login`).
    # Only a dock on screen now: one listed but not running (not installed,
    # or failing) is nothing to wait for.
    report.login_needed = needs_login(UUID)
    later = {uuid for uuid in DOCKS if uuid in running_before and uuid not in keep
             and extension_state(uuid) == 'active'} \
        if report.login_needed and not after_update and finishes_at_login() else set()
    if later:
        manifest['after_login'] = sorted(later)
    keep |= later
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
    ctx.settings.write(changes)
    off = [out_of_the_way[uuid] for uuid in sorted(running_before - keep)]
    if off:
        report.turned_off = [name for name, _why in off]
        report.note(turned_off(off))
    if later:
        docks = [DOCKS[uuid][0] for uuid in sorted(later)]
        report.note(f'{join(docks)} {"stays" if len(docks) == 1 else "stay"} until you log out; '
                    f"then Jade Shell's dock takes {'its' if len(docks) == 1 else 'their'} place.")

    grant_flatpak(manifest)
    write_text(manifest_path(), json.dumps(manifest, indent=2))

    if usage_wanted():
        # Read after the settings above are written: a first setup turns it on, and a
        # later one keeps a person's "off" (the key is set only once).
        problem = install_usage_timer(manifest, enable=usage_shown(ctx))
        write_text(manifest_path(), json.dumps(manifest, indent=2))
        if problem:
            log(f'AI usage collector: {problem}')
            report.note("AI usage in the top bar couldn't start updating in the background; setup tries again next time.")
    elif (config_home() / 'systemd/user/jade-usage.timer').exists():
        systemctl('disable', '--now', 'jade-usage.timer')  # neither Claude Code nor Codex is here any more

    # The Tahoe icons are Jade Shell's default look: built once (the first
    # setup, or the first with a version that has them) from the package's
    # copy. Off stays off. A build that failed is tried again at the next
    # setup; and if the desktop uses them but they are gone from disk, rebuilt.
    in_use = ctx.settings.has('org.gnome.desktop.interface', 'icon-theme') and \
        str(ctx.settings.get('org.gnome.desktop.interface').get_string('icon-theme')).startswith(icons.NAME)
    if not manifest.get('icons-offered') or (in_use and not icons.installed()):
        if 'icons' in engine.left_alone(ctx.settings):
            manifest['icons-offered'] = True
        else:
            try:
                icons.install(progress)
                progress(None)
                manifest['icons-offered'] = True
            except (icons.IconsUnavailable, OSError) as error:
                progress(None)
                log(f'Mac-style icons: {getattr(error, "detail", None) or reasons.detail(error)}')
                report.note(f"The Mac-style icons couldn't be set up "
                            f"({getattr(error, 'reason', None) or reasons.plain(error)}). Setup tries again next "
                            "time, or turn them on in Jade Shell's settings under Dock.")
        write_text(manifest_path(), json.dumps(manifest, indent=2))

    # The theme asked for, else the current one, else Osaka Jade, applied
    # everywhere: this also builds anything a new version of Jade Shell adds.
    state = engine.current()
    current = state.get('theme') if state.get('theme') in themes.ids() else None
    theme = themes.load(theme_id or current or 'osaka-jade')
    ctx.wallpaper_index = state.get('wallpaper') or 0
    # Before touching them, name the apps whose own configs people edit.
    home = pathlib.Path.home()
    edited = [target for target, change in engine.plan(theme, ctx, skip=['gnome', 'dock', 'shell'])
              if isinstance(change, File) and change.path.exists() and change.path.is_relative_to(home)
              and not change.path.is_relative_to(engine.state_dir())
              and not change.path.is_relative_to(icons.icons_home())]
    if edited:
        # By the app's title: "GNOME apps" for a gtk.css of one's own, not "apps".
        apps = join(list(dict.fromkeys(re.sub(r'^(the|your) ', '', t.title) for t in edited)))
        report.note(f'Your {apps} settings now follow the theme too. Your own settings stay, and a copy of each '
                    "was saved. To keep an app out of it, turn it off under Apps in Jade Shell's settings.")
    # JetBrains Mono (installed with the package) as the monospace font of
    # GNOME and the terminals, as in Omarchy: once, for someone who has not
    # chosen one. Done only when it took; otherwise tried at the next setup.
    offer_font = not manifest.get('font-offered')
    if offer_font:
        if font_target.chosen() is not None or 'font' in engine.left_alone(ctx.settings):
            manifest['font-offered'] = True  # a font of their own, or fonts left alone
            offer_font = False
        elif font_installed(DEFAULT_FONT):
            ctx.font = DEFAULT_FONT
    # Only this theme's wallpaper is downloaded now; the other themes'
    # previews come after (see make_previews).
    wallpaper = theme.wallpaper(ctx.wallpaper_index)
    if wallpaper and not wallpaper.exists() and 'gnome' not in engine.left_alone(ctx.settings):
        progress(f'Getting the {theme.name} wallpaper')
        engine.fetch_wallpaper(theme, ctx)
    progress(f'Applying {theme.name}')
    changes, _backup = engine.apply(theme, ctx)
    progress(None)
    make_previews(theme)
    if offer_font and ctx.font and font_target.chosen() == DEFAULT_FONT:
        manifest['font-offered'] = True
        report.note(f"Terminals and code now use the {DEFAULT_FONT} font (change it in Jade Shell's settings).")
    write_text(manifest_path(), json.dumps(manifest, indent=2))
    report.note(themed_sentence(theme, ctx))
    for name, reason in ctx.skipped.items():
        if name == 'wallpaper':
            problem = ctx.wallpaper_problem
            log(f'{theme.name} wallpaper: {getattr(problem, "detail", None) or ctx.wallpaper_error}')
            report.note("Kept your current wallpaper: the theme's wallpaper couldn't be downloaded right now "
                        f"({getattr(problem, 'reason', None) or 'no internet connection'}). "
                        'It downloads the next time you pick a theme.')
        else:
            report.note(f'Not themed: {part_name(name)} ({reason})')
    for failure in ctx.hook_failures:
        report.note(failure)

    commands = leftover_commands(*leftovers())
    if commands:
        # Never removed here: it may be someone's development copy.
        report.note('Your home folder still has files from an older or development copy of Jade Shell. '
                    'Remove them with:')
        for command in commands:
            report.note(f'    {command}')

    try:
        restore_offer.keep_kit()
    except OSError as error:  # only the offer after a removal is missing
        log(f'restore kit: {reasons.detail(error)}')
        report.note(f"Couldn't save the files that undo Jade Shell after it's removed ({reasons.plain(error)}). "
                    'Before removing Jade Shell, run: jade restore')
    # Which version this desktop is set up for: the extension compares it with
    # its own at login, and finishes an update when they differ.
    manifest.update(version=__version__, replaced=sorted(out_of_the_way))
    write_text(manifest_path(), json.dumps(manifest, indent=2))
    if after_update:
        for failure in hooks.run('post-update', __version__, theme=theme):
            report.note(failure)
        say(f'Jade Shell {__version__} is set up.')
        return 0
    report.shortcut = picker_shortcut(ctx)
    say(f'Change theme with {report.shortcut or "the palette icon in the top bar"}. Undo everything with: jade restore')
    if report.login_needed:
        report.welcome = not welcomed()
        say(f'Done. Log out and back in to start {"the new version" if updating else "Jade Shell"}.'
            + (' A welcome window then helps you pick your look.' if report.welcome else ''))
    else:
        say('Done.')
    return 0


def finishes_at_login():
    """Whether the installed extension finishes setup at login: packages
    stamp their version into it, and only then does it run `jade setup
    --after-login` (a checkout is left alone)."""
    for base in (data_home() / 'gnome-shell/extensions', SYSTEM_EXTENSIONS):  # GNOME prefers the home copy
        try:
            return bool(json.loads((base / UUID / 'metadata.json').read_text()).get('version-name'))
        except (OSError, ValueError, AttributeError):
            continue
    return False


def after_login(ctx):
    """Turn off the docks setup left on until Jade Shell's own dock could
    start: run by the extension when it starts, at the first login after
    setup. Recorded like setup's other changes, so restore turns them on again."""
    if not manifest_path().exists():
        return 0  # restored since
    manifest = load_manifest()
    later = set(manifest.pop('after_login', []))
    # Only these: anything else was left as it is on purpose.
    keep = set(replaced(ctx)) - later
    off = [DOCKS[uuid] for uuid in sorted(later) if uuid in replaced(ctx) and running_extension(ctx, uuid)]
    changes = [c for c in planned_settings(ctx, keep)
               if c.schema == SHELL and c.key in ('enabled-extensions', 'disabled-extensions')]
    record(ctx, manifest, changes)
    write_text(manifest_path(), json.dumps(manifest, indent=2))
    ctx.settings.write(changes)
    if off:
        say(turned_off(off))
    return 0


def make_previews(theme):
    """The theme pickers' pictures: the applied theme's from its wallpaper,
    here now, and the others' in the background.

    Making them all here downloaded every theme's full-size wallpaper (18 MB)
    before setup could finish, for minutes on a slow line. `jade theme thumbs`
    now fetches them after setup, and the picker runs it again for any still
    missing (offline, say) when it opens.
    """
    picture = theme.wallpaper(0) or theme.preview
    if not themes.thumbnail_path(theme.id).exists() and picture and picture.exists():
        with contextlib.suppress(Exception):  # a picture it can't read: the picker shows the theme's colors
            themes.make_thumbnail(theme)
    if all(themes.thumbnail_path(tid).exists() for tid in themes.ids()):
        return
    code = str(pathlib.Path(__file__).resolve().parent.parent)
    env = {name: value for name, value in os.environ.items()
           if name not in ('JADE_PROGRESS_FILE', 'JADE_SUMMARY_FILE')}  # the installer's, for setup alone
    env['PYTHONPATH'] = os.pathsep.join(filter(None, [code, os.environ.get('PYTHONPATH')]))
    # Its own session: it outlives setup, and the installer's Ctrl-C isn't
    # meant for it. If it can't start, the picker fetches them when it opens.
    # -P, as /usr/bin/jade has it: a jade/ folder where setup was started
    # from must not be the code that runs.
    with contextlib.suppress(OSError):
        subprocess.Popen([sys.executable, '-P', '-m', 'jade', 'theme', 'thumbs', '--after-setup'], env=env,
                         stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                         start_new_session=True)


def wait_for_installer(limit=20 * 60):
    """Wait while the installer that ran setup is still at work (install.sh
    holds install.lock until it ends): after setup it downloads more (the text
    and QR code reading extras), and on a slow line the previews' four
    downloads would take most of it. Never longer than `limit` seconds."""
    try:
        lock = open(engine.state_dir() / 'install.lock', 'rb')
    except OSError:
        return  # no installer ran here
    with lock:
        deadline = time.monotonic() + limit
        while time.monotonic() < deadline:
            try:
                fcntl.flock(lock, fcntl.LOCK_SH | fcntl.LOCK_NB)
                return
            except BlockingIOError:
                time.sleep(2)
            except OSError:
                return


def picker_shortcut(ctx):
    """The picker's shortcut as people write it ('Super+Ctrl+Shift+Space'), or
    None when it is turned off."""
    if not ctx.settings.has(JADE_SCHEMA, 'toggle-picker'):
        return 'Super+Ctrl+Shift+Space'
    accels = ctx.settings.get(JADE_SCHEMA).get_strv('toggle-picker')
    if not accels:
        return None
    names = {'super': 'Super', 'control': 'Ctrl', 'primary': 'Ctrl', 'ctrl': 'Ctrl', 'alt': 'Alt', 'shift': 'Shift'}
    mods = [names.get(m.lower(), m) for m in re.findall(r'<(\w+)>', accels[0])]
    key = re.sub(r'<\w+>', '', accels[0])
    order = ['Super', 'Ctrl', 'Alt', 'Shift']
    mods = sorted(dict.fromkeys(mods), key=lambda m: order.index(m) if m in order else len(order))
    return '+'.join([*mods, key.upper() if len(key) == 1 else key.capitalize()])


def offer_logout():
    """Ask on the terminal (stdin is the script itself when piped from curl),
    then open GNOME's own log-out dialog: it lists apps with unsaved work, and
    logs out by itself after a minute. Without a terminal or a GNOME session,
    the sentence is enough. Ctrl-C here means no, not a failed setup."""
    if 'GNOME' not in os.environ.get('XDG_CURRENT_DESKTOP', '').split(':'):
        return
    try:
        # A terminal can't be opened for both in text mode: it isn't seekable.
        with open('/dev/tty', 'w') as out, open('/dev/tty') as tty:
            out.write('Log out now to finish? Save your work first: GNOME logs out by itself after a minute. '
                      '(Press Enter for yes, or type n.) ')
            out.flush()
            try:
                answer = tty.readline().strip().lower()
            except KeyboardInterrupt:
                out.write('\n')
                return
    except OSError:  # no terminal: run from a script or a service
        return
    if answer in ('', 'y', 'yes'):
        try:
            subprocess.run(['gnome-session-quit', '--logout'], check=False)
        except OSError:
            say("Couldn't open the log-out window; log out from the menu at the right end of the top bar.")


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
        # Older versions turned Dash to Dock on.
        added = {UUID} | ({DASH_TO_DOCK} if DASH_TO_DOCK not in old else set())
        keep = [uuid for uuid in now if uuid not in added]
        back = [uuid for uuid in old if uuid in REPLACED or uuid in DOCKS]  # the ones setup turned off
    else:
        # disabled-extensions: setup took Jade Shell out of it (older versions
        # Dash to Dock too), and put the docks Jade's dock replaces in.
        keep = [uuid for uuid in now if uuid not in DOCKS or uuid in old]
        back = [uuid for uuid in old if uuid in (UUID, DASH_TO_DOCK)]
    wanted = set(keep) | set(back)
    # What was there before keeps its old place; anything newer goes at the end.
    result = list(dict.fromkeys([u for u in old if u in wanted] + [u for u in keep if u not in old]))
    return result, entry['old'] is None and result == list(default)


def app_of(path, owners):
    """Which app a config belongs to, as people call it ('VS Code'), from the
    target that wrote it; its path (from ~) when older backups don't say."""
    try:
        title = engine.target_named(owners[path]).title
    except (KeyError, StopIteration):
        home = str(pathlib.Path.home())
        return path.replace(home, '~', 1) if path.startswith(home + '/') else path
    return title[0].upper() + title[1:] if title.startswith(('the ', 'your ')) else title


def restore(ctx, assume_yes=False, report=None):
    """Put back the desktop from before Jade Shell. What was said goes into
    `report` too: its notes, and in `partial` what could not be put back."""
    report = report or Report()
    status = 1
    try:
        status = restore_desktop(ctx, assume_yes, report)
    finally:
        report.write(restored=status == 0, partial=report.partial)
    return status


def restore_desktop(ctx, assume_yes, report):
    manifest = load_manifest()
    history = engine.backups()
    if not history and not manifest['settings'] and not keys.applied() and not network.state_file().exists():
        report.note('Nothing to restore: Jade Shell has not changed this desktop.')
        return 0
    if not assume_yes:
        if not sys.stdin.isatty():
            say('Run jade restore --yes to do it without asking.')
            return 1
        n = len(history)
        undoes = (f"This undoes {n} theme change{'' if n == 1 else 's'} and Jade Shell's settings." if n
                  else "This undoes Jade Shell's settings.")
        try:
            answer = input(f'Put your desktop back the way it was before Jade Shell? {undoes} (y/N) ')
        except EOFError:
            answer = ''
        if answer.strip().lower() not in ('y', 'yes'):
            return 1
    kept, merged, skipped, stuck, owners = [], [], [], [], {}
    skipped += keys.revert(ctx) or []  # the Omarchy keymap: your shortcuts back first
    if network.state_file().exists():
        skipped += network.restore()  # DNS and Wi-Fi band as they were
    # Whatever could not be put back yet (a file that could not be written,
    # NetworkManager saying no): its records stay, and so do setup's record
    # and the restore kit, so running restore again (or the offer after a
    # removal) finishes the job.
    unfinished = network.state_file().exists()
    # A broken backup that could not be set aside stays where it is: go on past it.
    while (undone := engine.undo(ctx, ignore=stuck)) is not None:
        kept += undone['kept']
        merged += undone.get('merged', [])
        owners.update({entry['path']: entry.get('target') for entry in undone.get('files', []) if entry.get('target')})
        skipped += undone['skipped']
        if undone.get('stuck'):
            stuck.append(undone['stuck'])
        if undone.get('incomplete'):
            # Not past it: an older backup would take what this one could
            # not put back for an edit of yours, and let go of the original.
            unfinished = True
            break

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
    # Jade Shell's own settings go with its package: not worth a line when they're gone.
    skipped += [item for item in ctx.settings.restore_all(rest) if not item.startswith(JADE_SCHEMA)]
    units = config_home() / 'systemd/user'
    systemctl('disable', '--now', 'jade-usage.timer')
    for name in ('jade-usage.service', 'jade-usage.timer'):
        (units / name).unlink(missing_ok=True)
    shutil.rmtree(units / 'jade-usage.timer.d', ignore_errors=True)  # the refresh interval set in prefs
    systemctl('daemon-reload')
    for unit in manifest['disabled_units']:
        systemctl('enable', '--now', unit)
    revoke_flatpak(manifest)
    # The Mac-style icons are Jade Shell's own download: gone with the rest.
    kept = [path for path in kept if not pathlib.Path(path).is_relative_to(icons.icons_home())]
    icons.remove()
    # The first-run welcome and its notes: set up again later, they show again.
    (engine.state_dir() / 'welcome.json').unlink(missing_ok=True)
    if not unfinished:
        manifest_path().unlink(missing_ok=True)
        restore_offer.drop_kit()  # nothing left to offer after a removal
    for line in dict.fromkeys([f"{app_of(path, owners)}: took out Jade Shell's colors; your own changes stay."
                               for path in merged]
                              + [f'{app_of(path, owners)}: left your settings file as it is, because it changed since.'
                                 for path in kept]):
        report.note(line)
    # A setting whose app (or key) is gone since, as Dash to Dock can go with
    # Jade Shell's package: nothing to put back, and nothing to do about it.
    home = str(pathlib.Path.home())
    for item in skipped:
        if not item.endswith('(no longer installed)'):
            log(f'restore: {item}')
            line = f"Couldn't put back {item.replace(home + '/', '~/')}."
            say(line)
            report.partial.append(line)
    if unfinished:
        report.note("Some things couldn't be put back (listed above), so Jade Shell keeps what it needs to try again. "
                    'Fix what stopped them, then run jade restore again.')
        return 1
    say('Restored the desktop you had before Jade Shell. Log out and back in to finish.')
    return 0


# ------------------------------------------------------------------ doctor

def diagnose(ctx):
    """What `jade doctor` checks, as rows: {'ok': True/False, or None for a
    note, 'text', 'fix'}. The settings window shows the same rows."""
    rows = []

    def check(ok, text, fix=None):
        rows.append({'ok': bool(ok), 'text': text, 'fix': None if ok else fix})

    def note(text, active=True):
        rows.append({'ok': None, 'text': text, 'fix': None, 'active': active})

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
              '\n'.join([*([f'GNOME Shell says: {error}'] if error else []),
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
    out_of_the_way = replaced(ctx)
    later = load_manifest().get('after_login', [])  # turned off once Jade Shell's dock starts
    clashing = [uuid for uuid in out_of_the_way if running_extension(ctx, uuid) and uuid not in later]
    check(not clashing, 'No extensions doing the same job or taking over the top bar',
          f'Run: jade setup (turns off {", ".join(out_of_the_way[uuid][0] for uuid in clashing)})')
    paths, units = leftovers()
    check(not paths and not units, 'No older or development copies in your home folder',
          '\n'.join(['Remove them with:', *leftover_commands(paths, units)]))
    if dock_shown(ctx):
        note("Dock: Jade Shell's own")
    elif not ctx.settings.has(DOCK_SCHEMA):  # optional: the look is complete without it, just dockless
        note("No dock: Jade Shell's is turned off in its settings, and no other dock is installed.")

    current = engine.current().get('theme')
    check(bool(current), f'Theme: {current or "none applied"}', 'Run: jade setup')
    alone = engine.left_alone(ctx.settings)
    for target in engine.selected():
        reason = 'left alone: jade apps on ' + target.name if target.name in alone else target.available(ctx)
        note(target.label + ('' if reason is None else f' ({reason})'), active=reason is None)
    timer = systemctl('is-active', 'jade-usage.timer').stdout.strip()
    note(f'AI usage collector: {timer or "unknown"}')
    return rows


def doctor(ctx, as_json=False):
    rows = diagnose(ctx)
    problems = sum(row['ok'] is False for row in rows)
    if as_json:
        print(json.dumps({'version': __version__, 'problems': problems, 'rows': rows}))
        return 1 if problems else 0
    for row in rows:
        if row['ok'] is None:
            say(f'  {"·" if row["active"] else "-"} {row["text"]}')
            continue
        say(f'{"✓" if row["ok"] else "✗"} {row["text"]}')
        if row['fix']:
            say('\n'.join(f'    {line}' for line in row['fix'].splitlines()))
    say('All good.' if not problems else f'{problems} problem(s) found.')
    return 1 if problems else 0
