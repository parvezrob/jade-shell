"""An Omarchy-style keymap on GNOME's own shortcuts (`jade keys apply`).

Omarchy's keys where GNOME can do the same thing: Super+Space for the Jade
Menu, Super+1-9 for workspaces, Super+W to close, Super+Return for a
terminal, and so on. A shortcut GNOME (or you) had on one of those keys moves
out of the way, and every key changed is recorded first: `jade keys revert`
(and `jade restore`) put them all back exactly as they were.

The keys come from Omarchy's bindings (github.com/omacom/omarchy,
default/hypr/bindings); what GNOME can't do (tiling, groups, scratchpads)
has no key here.
"""

import json
import re
import shutil

from . import engine
from .store import Setting, write_text

JADE = 'org.gnome.shell.extensions.jade-shell'
WM = 'org.gnome.desktop.wm.keybindings'
SHELL = 'org.gnome.shell.keybindings'
MEDIA = 'org.gnome.settings-daemon.plugins.media-keys'
CUSTOM = f'{MEDIA}.custom-keybinding'
CUSTOM_BASE = '/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/'
# Where other shortcuts live, to move them off the keys the keymap takes.
SCANNED = (WM, SHELL, MEDIA, 'org.gnome.mutter.keybindings', 'org.gnome.mutter.wayland.keybindings', JADE)

# (schema, key, accelerators, what): the keymap's own keys, added to what the
# key already has, except where `only` says they replace it.
KEYMAP = [
    (JADE, 'toggle-menu', ['<Super>space'], 'Jade Menu', 'only'),
    (JADE, 'menu-system', ['<Super>Escape'], 'System menu', 'only'),
    (SHELL, 'toggle-application-view', ['<Super><Alt>space'], 'Apps', None),
    (WM, 'close', ['<Super>w', '<Super>q'], 'Close window', None),
    (WM, 'toggle-fullscreen', ['<Super>f'], 'Full screen', None),
    (WM, 'toggle-maximized', ['<Super><Alt>f'], 'Full width (maximize)', None),
    *[(WM, f'switch-to-workspace-{n}', [f'<Super>{n}'], f'Workspace {n}', None) for n in range(1, 10)],
    *[(WM, f'move-to-workspace-{n}', [f'<Super><Shift>{n}'], f'Move window to workspace {n}', None) for n in range(1, 10)],
    (WM, 'switch-to-workspace-right', ['<Super>Tab'], 'Next workspace', None),
    (WM, 'switch-to-workspace-left', ['<Super><Shift>Tab'], 'Previous workspace', None),
    (SHELL, 'show-screen-recording-ui', ['<Alt>Print'], 'Screen recording', None),
    (MEDIA, 'www', ['<Super><Shift>Return', '<Super><Shift>b'], 'Browser', None),
    (MEDIA, 'home', ['<Super><Shift>f'], 'File manager', None),
    (MEDIA, 'screensaver', ['<Super><Control>l'], 'Lock screen', None),
    (MEDIA, 'calculator', ['<Super><Control>q'], 'Calculator', None),
    # What loses its key gets another one.
    (SHELL, 'screenshot-window', ['<Shift><Alt>Print'], 'Screenshot of a window (was Alt+Print)', None),
    (WM, 'switch-input-source', ['<Shift><Super>space'], 'Next keyboard layout (was Super+Space)', None),
]
TERMINAL = ('Terminal', '<Super>Return')
TERMINALS = ('xdg-terminal-exec', 'ptyxis', 'kgx', 'gnome-terminal', 'kitty', 'ghostty', 'alacritty')


def state_file():
    return engine.state_dir() / 'keys.json'


def applied():
    return state_file().exists()


def norm(accel):
    """One key, however GNOME spells it: (modifiers, key)."""
    alias = {'ctrl': 'control', 'primary': 'control', 'mod1': 'alt', 'mod4': 'super'}
    mods = frozenset(alias.get(m.lower(), m.lower()) for m in re.findall(r'<([^>]+)>', accel))
    return mods, re.sub(r'<[^>]+>', '', accel).strip().lower()


def terminal_command():
    return next((name for name in TERMINALS if shutil.which(name)), None)


def custom_paths(ctx):
    return list(ctx.settings.get(MEDIA).get_strv('custom-keybindings')) if ctx.settings.has(MEDIA) else []


def plan(ctx):
    """The settings that make the keymap: the keymap's keys, and every other
    shortcut with one of those keys taken off it."""
    settings = ctx.settings
    wanted = {}  # (schema, key) -> accelerators
    owner = {}   # norm(accel) -> (schema, key)
    for schema, key, accels, _what, only in KEYMAP:
        if not settings.has(schema, key):
            continue
        current = [] if only else [a for a in settings.get(schema).get_strv(key) if a]  # GNOME's [''] means none
        wanted[schema, key] = list(dict.fromkeys([*accels, *current]))
        for accel in accels:
            owner[norm(accel)] = (schema, key)

    changes = []
    for schema in SCANNED:
        if not settings.has(schema):
            continue
        gsettings = settings.get(schema)
        for key in gsettings.props.settings_schema.list_keys():
            if gsettings.get_value(key).get_type_string() != 'as' or key == 'custom-keybindings':
                continue
            accels = wanted.get((schema, key), list(gsettings.get_strv(key)))
            kept = [a for a in accels if not a or owner.get(norm(a), (schema, key)) == (schema, key)]
            if kept != list(gsettings.get_strv(key)):
                changes.append(Setting(schema, key, kept))

    # Your own shortcuts on one of the keys: taken off (put back with revert).
    ours = CUSTOM_BASE + 'jade-terminal/'
    for path in custom_paths(ctx):
        if path == ours:
            continue
        binding = settings.get(CUSTOM, path).get_string('binding')
        if binding and (norm(binding) in owner or norm(binding) == norm(TERMINAL[1])):
            changes.append(Setting(CUSTOM, 'binding', '', path))

    # A terminal on Super+Return, as a custom shortcut of Jade Shell's own.
    command = terminal_command()
    if command and settings.has(MEDIA, 'custom-keybindings'):
        paths = custom_paths(ctx)
        if ours not in paths:
            changes.append(Setting(MEDIA, 'custom-keybindings', [*paths, ours]))
        changes += [Setting(CUSTOM, 'name', TERMINAL[0], ours), Setting(CUSTOM, 'command', command, ours),
                    Setting(CUSTOM, 'binding', TERMINAL[1], ours)]
    return changes


def load():
    try:
        return json.loads(state_file().read_text())
    except (OSError, ValueError):
        return {'settings': []}


def apply(ctx):
    """Set the keymap; returns the changes. Safe to run again: the values
    from before the first apply are the ones kept for revert."""
    changes = plan(ctx)
    state = load()
    known = {(e['schema'], e['path'], e['key']) for e in state['settings']}
    for change in changes:
        if (change.schema, change.path, change.key) not in known:
            state['settings'].append({'schema': change.schema, 'path': change.path, 'key': change.key,
                                      'old': ctx.settings.user_value(change)})
    write_text(state_file(), json.dumps(state, indent=2))
    ctx.settings.write(changes)
    return changes


def revert(ctx):
    """Put every key back as it was before `apply`; returns what was skipped."""
    state = load()
    if not state['settings']:
        state_file().unlink(missing_ok=True)
        return None
    skipped = ctx.settings.restore_all(list(reversed(state['settings'])))
    state_file().unlink(missing_ok=True)
    return skipped


def shown(accel):
    """<Super><Shift>Return -> Super+Shift+Return"""
    order = ['super', 'control', 'shift', 'alt']
    mods = sorted(norm(accel)[0], key=lambda m: order.index(m) if m in order else len(order))
    mods = [m.capitalize().replace('Control', 'Ctrl') for m in mods]
    key = re.sub(r'<[^>]+>', '', accel)
    return '+'.join([*mods, {'space': 'Space', 'Escape': 'Esc'}.get(key, key.upper() if len(key) == 1 else key)])


def rows(ctx):
    """[(keys, what)] the keymap sets on this desktop, for `jade keys`."""
    out = []
    for schema, key, accels, what, _only in KEYMAP:
        workspace = re.fullmatch(r'(switch|move)-to-workspace-(\d)', key)
        if (workspace and workspace[2] != '1') or not ctx.settings.has(schema, key):
            continue  # nine keys, one row
        if workspace:
            out.append((shown(accels[0]).replace('+1', '+1…9'),
                        'Go to workspace 1-9' if workspace[1] == 'switch' else 'Move the window to workspace 1-9'))
        else:
            out.append((' '.join(shown(a) for a in accels), what))
    if terminal_command():
        out.insert(1, (shown(TERMINAL[1]), TERMINAL[0]))
    return out
