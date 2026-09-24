"""The monospace font, chosen with `jade font set`: GNOME's monospace
setting, Ptyxis when it uses a font of its own, and Kitty, Ghostty and
Alacritty through a small jade-font file each, which their theme block
includes. The choice is kept with the switch history, so undo puts the
previous fonts back, and theme switches keep it."""
import json
import re
import subprocess

from ..store import File, Setting, config_home, read_text, state_home
from .base import Absent

INTERFACE = 'org.gnome.desktop.interface'
PTYXIS = 'org.gnome.Ptyxis'
# Terminals whose theme block includes a jade-font file (Alacritty's font
# goes in its jade-theme.toml).
TERMINALS = ('kitty', 'ghostty')


def choice_path():
    return state_home() / 'jade-shell/font.json'


def chosen(ctx=None):
    """The chosen family: the one being set now, else the saved one."""
    if ctx is not None and getattr(ctx, 'font', None):
        return ctx.font
    try:
        return json.loads(read_text(choice_path()) or '{}').get('family')
    except ValueError:
        return None


def with_size(value, family, default=11):
    """'JetBrains Mono 11' → '<family> 11': the size people chose stays."""
    found = re.search(r'\s(\d+(?:\.\d+)?)$', value or '')
    return f'{family} {found.group(1) if found else default}'


def font_file(terminal):
    return config_home() / terminal / 'jade-font.conf'


def font_text(terminal, family):
    if terminal == 'kitty':
        return f'font_family {family}\n'
    if terminal == 'ghostty':
        # Empty first: Ghostty adds each font-family as a fallback otherwise.
        return f'font-family = ""\nfont-family = "{family}"\n'
    return f'[font.normal]\nfamily = "{family}"\n'


class Font:
    name = 'font'
    title = 'the fonts'
    label = 'Monospace font (GNOME, Ptyxis, Kitty, Ghostty, Alacritty)'

    def available(self, ctx):
        return None if chosen(ctx) else Absent('no font chosen (jade font set)')

    def changes(self, theme, ctx):
        family = chosen(ctx)
        out = [File(choice_path(), json.dumps({'family': family}) + '\n')]
        interface = ctx.settings.get(INTERFACE)
        out.append(Setting(INTERFACE, 'monospace-font-name', with_size(interface.get_string('monospace-font-name'), family)))
        if ctx.settings.has(PTYXIS, 'font-name'):
            ptyxis = ctx.settings.get(PTYXIS)
            if not ptyxis.get_boolean('use-system-font'):  # else GNOME's monospace setting is Ptyxis's
                out.append(Setting(PTYXIS, 'font-name', with_size(ptyxis.get_string('font-name'), family)))
        for terminal in TERMINALS:
            if (config_home() / terminal).is_dir():
                out.append(File(font_file(terminal), font_text(terminal, family)))
        return out

    def reload(self, ctx):
        for process, sig in (('kitty', 'USR1'), ('ghostty', 'USR2')):
            subprocess.run(['pkill', f'-{sig}', '-x', process], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
