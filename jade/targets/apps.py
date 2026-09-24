"""Apps themed through files: the Shell theme, terminals, launcher, editor."""
import contextlib
import json
import os
import pathlib
import re
import shutil
import subprocess
from typing import ClassVar

from .. import palette as pal
from .. import shelltheme, themes
from ..store import File, Setting, config_home, data_home, read_text, state_home
from . import font
from .base import Absent

MARK_BEGIN = '# >>> jade-theme (generated; edits here are replaced)'
MARK_END = '# <<< jade-theme'
# The same markers as comments of a CSS file (GTK's gtk.css).
CSS_MARKS = ('/* >>> jade-theme (generated; edits here are replaced) */', '/* <<< jade-theme */')


def block_pattern(marks):
    return re.compile(re.escape(marks[0]) + r'.*?' + re.escape(marks[1]) + r'\n?', re.S)


BLOCK = block_pattern((MARK_BEGIN, MARK_END))


def signal(process, sig):
    """Ask running instances to reload; quietly nothing when none run."""
    subprocess.run(['pkill', f'-{sig}', '-x', process], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def managed_block(text, block, marks=(MARK_BEGIN, MARK_END)):
    """Replace (or append) our marked block, leaving the rest of the file alone."""
    pattern = block_pattern(marks)
    wrapped = f'{marks[0]}\n{block.rstrip()}\n{marks[1]}\n'
    if pattern.search(text):
        return pattern.sub(lambda _m: wrapped, text)
    return text.rstrip('\n') + '\n\n' + wrapped if text.strip() else wrapped


def revert_block(text, old, marks=(MARK_BEGIN, MARK_END)):
    """`text` with our marked block as it was in `old`: its old contents, or gone
    (with the blank line managed_block put before it). None if the block is not there."""
    pattern = block_pattern(marks)
    found = pattern.search(text)
    if found is None:
        return None
    before = pattern.search(old or '')
    if before:
        return text[:found.start()] + before.group(0) + text[found.end():]
    head = text[:found.start()].rstrip('\n')
    return (head + '\n' if head else '') + text[found.end():]


def revert_line(text, old, key, ours):
    """Put back the first `key = ...` line as it was in `old` (or take it out if
    `old` had none), when the line is still the one we wrote. None otherwise."""
    pattern = rf'^{key}\s*=.*$'
    now = re.search(pattern, text, re.M)
    if now is None or not re.fullmatch(rf'{key}\s*=\s*"{ours}"\s*', now.group(0)):
        return None
    before = re.search(pattern, old or '', re.M)
    if before:
        return text[:now.start()] + before.group(0) + text[now.end():]
    return text[:now.start()] + text[now.end():].removeprefix('\n')


class Shell:
    name = 'shell'
    title = 'the Shell'
    label = 'GNOME Shell theme and Jade Shell extension'

    def available(self, ctx):
        version = shelltheme.installed_shell_version()
        if version not in shelltheme.available_versions():
            return f'no Shell theme for GNOME {version}' if version else Absent('GNOME Shell is not installed')
        self.version = version
        return None

    def changes(self, theme, ctx):
        base = state_home() / 'jade-shell'
        # Also read by the settings window, to dress itself in the theme.
        colors = {'id': theme.id, 'name': theme.name, 'colors': theme.colors,
                  'accent_fg': shelltheme.accent_foreground(theme.colors)}
        return [
            File(base / 'gnome-shell.css', shelltheme.build(theme.colors, self.version)),
            File(base / 'colors.json', json.dumps(colors, indent=2, sort_keys=True) + '\n'),
        ]

    def reload(self, ctx):
        pass  # the Jade Shell extension watches these files


class Gtk:
    """GNOME's own apps (Files, Settings, Text Editor…) in the theme's colors:
    libadwaita's named colors in the user's gtk.css, which GTK 4 apps and GTK 3
    apps with adw-gtk3 read at start. Both the CSS variables of libadwaita
    1.6+ and the older @define-color names, plus GTK 3 Adwaita's own names."""
    name = 'gtk'
    title = 'GNOME apps'
    label = 'GNOME apps (GTK 4, and GTK 3 with adw-gtk3)'

    def paths(self):
        return [config_home() / 'gtk-4.0/gtk.css', config_home() / 'gtk-3.0/gtk.css']

    def available(self, ctx):
        return None

    @staticmethod
    def named_colors(theme):
        c = theme.colors
        light = c.get('mode') == 'light'
        fg, bg = c['foreground'], c['background']
        raised = pal.mix(bg, fg, 0.05)  # headerbars and popovers: a step toward the text
        view = pal.mix(bg, '#ffffff', 0.5) if light else c['dark_background']
        return {
            'accent_color': c['accent'], 'accent_bg_color': c['accent'],
            'accent_fg_color': shelltheme.accent_foreground(c),
            'destructive_color': c['red'], 'destructive_bg_color': c['red'], 'destructive_fg_color': bg,
            'success_color': c['green'], 'warning_color': c['yellow'], 'error_color': c['red'],
            'window_bg_color': bg, 'window_fg_color': fg,
            'view_bg_color': view, 'view_fg_color': fg,
            'headerbar_bg_color': raised, 'headerbar_fg_color': fg, 'headerbar_backdrop_color': bg,
            'sidebar_bg_color': c['dark_background'], 'sidebar_fg_color': fg,
            'sidebar_backdrop_color': c['dark_background'],
            'secondary_sidebar_bg_color': c['dark_background'], 'secondary_sidebar_fg_color': fg,
            'card_bg_color': pal.mix(bg, fg, 0.04), 'card_fg_color': fg,
            'thumbnail_bg_color': pal.mix(bg, fg, 0.04), 'thumbnail_fg_color': fg,
            'dialog_bg_color': raised, 'dialog_fg_color': fg,
            'popover_bg_color': raised, 'popover_fg_color': fg,
        }

    def css(self, theme, gtk3=False):
        named = self.named_colors(theme)
        lines = [f'/* {theme.name}, from Jade Shell. Apps read this when they start. */']
        lines += [f'@define-color {key} {value};' for key, value in named.items()]
        if gtk3:  # stock Adwaita for GTK 3 names a few of them its own way
            lines += [f'@define-color {old} {named[new]};' for old, new in (
                ('theme_bg_color', 'window_bg_color'), ('theme_fg_color', 'window_fg_color'),
                ('theme_base_color', 'view_bg_color'), ('theme_text_color', 'view_fg_color'),
                ('theme_selected_bg_color', 'accent_bg_color'), ('theme_selected_fg_color', 'accent_fg_color'))]
        else:
            variables = ' '.join(f'--{key.removesuffix("_color").replace("_", "-")}-color: {value};'
                                 for key, value in named.items())
            lines.append(f':root {{ {variables} }}')
        return '\n'.join(lines)

    def changes(self, theme, ctx):
        return [File(path, managed_block(read_text(path) or '', self.css(theme, gtk3=path.parent.name == 'gtk-3.0'),
                                         CSS_MARKS))
                for path in self.paths()]

    def revert(self, path, text, old):
        return revert_block(text, old, CSS_MARKS) if path in self.paths() else None

    def reload(self, ctx):
        pass  # apps read gtk.css when they start


class Ptyxis:
    name = 'ptyxis'
    title = 'Ptyxis'
    label = 'Ptyxis terminal palette'
    schema = 'org.gnome.Ptyxis'

    def available(self, ctx):
        return None if ctx.settings.has(self.schema) else Absent('Ptyxis is not installed')

    def changes(self, theme, ctx):
        c = theme.colors
        lines = [
            '[Palette]', f'Name={theme.name}', 'UseSystemAccent=false',
            f"Foreground={c['foreground']}", f"Background={c['background']}",
            f"CursorBackground={c['foreground']}", f"CursorForeground={c['background']}",
            f"TitlebarBackground={c['dark_background']}", f"TitlebarForeground={c['foreground']}",
            f"Color0={c['dark_background']}",
        ] + [f'Color{i}={c[f"color{i}"]}' for i in range(1, 16)]
        out = [File(data_home() / 'org.gnome.Ptyxis/palettes' / f'{theme.id}.palette', '\n'.join(lines) + '\n')]
        for uuid in ctx.settings.get(self.schema).get_strv('profile-uuids'):
            out.append(Setting('org.gnome.Ptyxis.Profile', 'palette', theme.id, f'/org/gnome/Ptyxis/Profiles/{uuid}/'))
        return out

    def reload(self, ctx):
        pass  # Ptyxis watches its palettes folder and profile settings


def jsonc(text):
    """Vicinae writes its config as JSON with // comment lines."""
    return json.loads(re.sub(r'^\s*//.*$', '', text, flags=re.M))


def set_theme_names(text, name):
    """Change only the theme names, keeping Vicinae's own formatting and comments."""
    data = jsonc(text)
    theme = data.get('theme')
    if not isinstance(theme, dict) or not all(isinstance(theme.get(v), dict) for v in ('dark', 'light')):
        # Vicinae keeps only the user's overrides here, so a fresh config has no
        # theme entry (or just one of the two). It rewrites this file itself, so
        # writing it out again is fine; its leading comment lines are kept.
        theme = theme if isinstance(theme, dict) else {}
        for variant in ('dark', 'light'):
            entry = theme.get(variant) if isinstance(theme.get(variant), dict) else {}
            theme[variant] = dict(entry, name=name)
        data['theme'] = theme
        head = ''.join(line + '\n' for line in text.splitlines() if line.lstrip().startswith('//'))
        return head + ('\n' if head else '') + json.dumps(data, indent=2) + '\n'
    start = text.index('"theme"')
    depth, end = 0, None
    for i in range(text.index('{', start), len(text)):
        depth += {'{': 1, '}': -1}.get(text[i], 0)
        if depth == 0:
            end = i
            break
    block = re.sub(r'("name"\s*:\s*")[^"]*"', lambda m: f'{m.group(1)}{name}"', text[start:end])
    return text[:start] + block + text[end:]


def restore_theme_names(text, old):
    """Vicinae's theme names back to the ones in `old`; everything else as in `text`."""
    data, before = jsonc(text), jsonc(old)
    theme = data.get('theme')
    if not isinstance(theme, dict):
        return None
    old_theme = before.get('theme') if isinstance(before.get('theme'), dict) else {}
    old_names = {v: old_theme[v].get('name') if isinstance(old_theme.get(v), dict) else None
                 for v in ('dark', 'light')}
    for variant in ('dark', 'light'):
        entry = theme.get(variant)
        if not isinstance(entry, dict) or not str(entry.get('name', '')).startswith('omarchy-'):
            return None  # a theme picked in Vicinae since: that choice stays, and so does the file
    if old_names['dark'] and old_names['dark'] == old_names['light']:
        return set_theme_names(text, old_names['dark'])  # keeps the file's own formatting
    # Different names, or none before (Vicinae kept only overrides): write it out
    # again, as set_theme_names does for a fresh config.
    for variant, name in old_names.items():
        if name:
            theme[variant]['name'] = name
        else:
            del theme[variant]['name']
            if not theme[variant]:
                del theme[variant]
    if not theme:
        del data['theme']
    head = ''.join(line + '\n' for line in text.splitlines() if line.lstrip().startswith('//'))
    return head + ('\n' if head else '') + json.dumps(data, indent=2) + '\n'


class Vicinae:
    name = 'vicinae'
    title = 'Vicinae'
    label = 'Vicinae launcher'

    def config_path(self):
        # The user service may pin a config file; fall back to the default one.
        unit = subprocess.run(['systemctl', '--user', 'cat', 'vicinae.service'],
                              capture_output=True, text=True).stdout
        pinned = re.findall(r'--config\s+(\S+)', unit)
        return pathlib.Path(pinned[-1]) if pinned else config_home() / 'vicinae/settings.json'

    def available(self, ctx):
        return None if (data_home() / 'vicinae').exists() else Absent('Vicinae is not installed')

    def changes(self, theme, ctx):
        c = theme.colors
        theme_id = f'omarchy-{theme.id}'
        toml = '\n'.join([
            '[meta]', 'version = 1', f'name = "{theme.name} (Omarchy)"',
            'description = "Generated by Jade Shell from the Omarchy palette"',
            'variant = "dark"', 'inherits = "vicinae-dark"', '',
            '[colors.core]', f'background = "{c["background"]}"', f'foreground = "{c["foreground"]}"',
            f'secondary_background = "{c["dark_background"]}"', f'border = "{c["selection"]}"',
            f'accent = "{c["accent"]}"', f'accent_foreground = "{c["bright_foreground"]}"', '',
            '[colors.list.item.selection]', f'background = "{c["selection"]}"',
            f'secondary_background = "{c["lighter_background"]}"', '',
            '[colors.accents]',
        ] + [f'{name} = "{c[key]}"' for name, key in [
            ('blue', 'blue'), ('green', 'green'), ('magenta', 'magenta'), ('orange', 'orange'),
            ('purple', 'bright_magenta'), ('red', 'red'), ('yellow', 'bright_yellow'), ('cyan', 'cyan')]])
        out = [File(data_home() / 'vicinae/themes' / f'{theme_id}.toml', toml + '\n')]
        config = self.config_path()
        text = read_text(config)
        if text is not None:
            try:
                themes_now = jsonc(text).get('theme') or {}
                names = [(themes_now.get(v) or {}).get('name') for v in ('dark', 'light')]
                if names != [theme_id, theme_id]:
                    out.append(File(config, set_theme_names(text, theme_id)))
            except (ValueError, AttributeError):  # not JSON we can read: leave the user's file alone
                ctx.skipped[self.name] = f'could not read {config}; select the theme in Vicinae'
        return out

    def revert(self, path, text, old):
        return restore_theme_names(text, old) if old is not None and path == self.config_path() else None

    def reload(self, ctx):
        text = read_text(self.config_path())
        name = jsonc(text).get('theme', {}).get('dark', {}).get('name') if text else None
        if name:
            subprocess.run(['vicinae', 'theme', 'set', name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


class Kitty:
    name = 'kitty'
    title = 'Kitty'
    label = 'Kitty terminal'

    def available(self, ctx):
        return None if (config_home() / 'kitty/kitty.conf').exists() else Absent('Kitty is not configured')

    def changes(self, theme, ctx):
        folder = config_home() / 'kitty'
        conf = read_text(folder / 'kitty.conf')
        # Included last, so it overrides the inline colors without deleting them.
        included = managed_block(conf, 'include jade-theme.conf' + ('\ninclude jade-font.conf' if font.chosen(ctx) else ''))
        return [
            File(folder / 'jade-theme.conf', themes.render(themes.template('kitty.conf.tpl'), theme.colors)),
            File(folder / 'kitty.conf', included),
        ]

    def revert(self, path, text, old):
        return revert_block(text, old) if path == config_home() / 'kitty/kitty.conf' else None

    def reload(self, ctx):
        signal('kitty', 'USR1')


class Ghostty:
    name = 'ghostty'
    title = 'Ghostty'
    label = 'Ghostty terminal'

    def config(self):
        # Ghostty 1.3 prefers config.ghostty; older ones read config.
        folder = config_home() / 'ghostty'
        return next((path for path in (folder / 'config.ghostty', folder / 'config') if path.exists()), None)

    def available(self, ctx):
        return None if self.config() else Absent('Ghostty is not configured')

    def changes(self, theme, ctx):
        config = self.config()
        # Loaded last, so it overrides the colors set above it without deleting them.
        included = managed_block(read_text(config), 'config-file = jade-theme.conf' +
                                 ('\nconfig-file = jade-font.conf' if font.chosen(ctx) else ''))
        return [
            File(config.parent / 'jade-theme.conf', themes.render(themes.template('ghostty.conf.tpl'), theme.colors)),
            File(config, included),
        ]

    def revert(self, path, text, old):
        return revert_block(text, old) if path == self.config() else None

    def reload(self, ctx):
        signal('ghostty', 'USR2')  # Ghostty 1.2+ reloads its config


class Tmux:
    """tmux: our colors file, sourced at the end of the user's config, and
    applied to every running tmux server right away."""
    name = 'tmux'
    title = 'tmux'
    label = 'tmux status bar and borders'

    def config(self):
        # tmux 3.1+ reads ~/.config/tmux/tmux.conf; older ones only ~/.tmux.conf.
        home = pathlib.Path.home()
        return next((path for path in (home / '.tmux.conf', config_home() / 'tmux/tmux.conf') if path.exists()), None)

    def theme_file(self):
        return config_home() / 'tmux/jade-theme.conf'

    def available(self, ctx):
        return None if self.config() else Absent('tmux is not configured')

    def changes(self, theme, ctx):
        home = pathlib.Path.home()
        theme_file = self.theme_file()
        shown = f'~/{theme_file.relative_to(home)}' if theme_file.is_relative_to(home) else str(theme_file)
        return [
            File(theme_file, themes.render(themes.template('tmux.conf.tpl'), theme.colors)),
            File(self.config(), managed_block(read_text(self.config()), f'source-file -q {shown}')),
        ]

    def revert(self, path, text, old):
        return revert_block(text, old) if path == self.config() else None

    def reload(self, ctx):
        """Every running server (one per socket) takes the colors, or, with
        them undone, its config again."""
        if not shutil.which('tmux'):
            return
        folder = pathlib.Path(os.environ.get('TMUX_TMPDIR') or '/tmp') / f'tmux-{os.getuid()}'
        config = self.config()
        ours = self.theme_file().exists() and config and MARK_BEGIN in read_text(config)
        for socket in folder.glob('*') if folder.is_dir() else ():
            command = ['source-file', str(self.theme_file())] if ours else \
                [arg for option in TMUX_STYLES for arg in ('set', '-gu', option, ';')] + ['source-file', str(config)]
            subprocess.run(['tmux', '-S', str(socket), *command], stdout=subprocess.DEVNULL,
                           stderr=subprocess.DEVNULL, timeout=5)


# What tmux.conf.tpl sets, to unset again on undo.
TMUX_STYLES = ['status-style', 'window-status-style', 'window-status-current-style', 'window-status-activity-style',
               'window-status-bell-style', 'pane-border-style', 'pane-active-border-style', 'message-style',
               'message-command-style', 'mode-style', 'copy-mode-match-style', 'copy-mode-current-match-style',
               'popup-border-style', 'menu-style', 'menu-selected-style', 'menu-border-style', 'clock-mode-colour']


class Neovim:
    """A `jade` colorscheme drawn from the palette (no plugin): chosen with
    `:colorscheme jade`, rewritten at each switch, and re-applied in every
    running Neovim that uses it."""
    name = 'neovim'
    title = 'Neovim'
    label = 'Neovim colorscheme (:colorscheme jade)'

    def colors_file(self):
        return config_home() / 'nvim/colors/jade.lua'

    def available(self, ctx):
        found = shutil.which('nvim') or (config_home() / 'nvim').exists()
        return None if found else Absent('Neovim is not installed')

    def changes(self, theme, ctx):
        values = {**theme.colors, 'name': theme.name}
        return [File(self.colors_file(), themes.render(themes.template('neovim.lua.tpl'), values))]

    def reload(self, ctx):
        """Each Neovim listens on $XDG_RUNTIME_DIR/nvim.<pid>.0 (0.9 and later)."""
        if not shutil.which('nvim'):
            return
        runtime = pathlib.Path(os.environ.get('XDG_RUNTIME_DIR') or f'/run/user/{os.getuid()}')
        expr = 'execute(\'if get(g:, "colors_name", "") ==# "jade" | colorscheme jade | endif\')'
        for socket in runtime.glob('nvim.*'):
            with contextlib.suppress(subprocess.TimeoutExpired):
                subprocess.run(['nvim', '--server', str(socket), '--remote-expr', expr], stdout=subprocess.DEVNULL,
                               stderr=subprocess.DEVNULL, timeout=3)


class Obsidian:
    """A Jade Shell theme in each vault Obsidian knows (as Omarchy writes its
    own), chosen only in vaults still on Obsidian's default theme."""
    name = 'obsidian'
    title = 'Obsidian'
    label = 'Obsidian vaults'
    THEME = 'Jade Shell'
    MANIFEST: ClassVar[dict] = {'name': 'Jade Shell', 'version': '1.0.0', 'minAppVersion': '0.16.0',
                'description': 'Follows the Jade Shell theme of the desktop.', 'author': 'Jade Shell'}

    def registries(self):
        home = pathlib.Path.home()
        return [config_home() / 'obsidian/obsidian.json',
                home / '.var/app/md.obsidian.Obsidian/config/obsidian/obsidian.json',
                home / 'snap/obsidian/current/.config/obsidian/obsidian.json']

    def vaults(self):
        found = []
        for registry in self.registries():
            try:
                vaults = json.loads(registry.read_text()).get('vaults', {})
            except (OSError, ValueError):
                continue
            for vault in vaults.values():
                folder = pathlib.Path(vault.get('path', '')) / '.obsidian'
                if vault.get('path') and folder.is_dir() and folder not in found:
                    found.append(folder)
        return found

    def available(self, ctx):
        return None if self.vaults() else Absent('Obsidian has no vaults')

    def changes(self, theme, ctx):
        css = themes.render(themes.template('obsidian.css.tpl'), theme.colors)
        out = []
        for folder in self.vaults():
            themed = folder / 'themes' / self.THEME
            out += [File(themed / 'theme.css', css),
                    File(themed / 'manifest.json', json.dumps(self.MANIFEST, indent=2) + '\n')]
            appearance = folder / 'appearance.json'
            try:
                settings = json.loads(read_text(appearance) or '{}')
            except ValueError:
                continue  # a file we can't read is left alone
            if not settings.get('cssTheme'):  # the default theme: nobody chose another
                out.append(File(appearance, json.dumps({**settings, 'cssTheme': self.THEME}, indent=2) + '\n'))
        return out

    def revert(self, path, text, old):
        """Obsidian rewrites appearance.json as settings change: give back only its theme."""
        if path.name != 'appearance.json':
            return None
        settings = json.loads(text)
        before = json.loads(old).get('cssTheme') if old else None
        if before:
            settings['cssTheme'] = before
        else:
            settings.pop('cssTheme', None)
        return json.dumps(settings, indent=2) + '\n'

    def reload(self, ctx):
        pass  # Obsidian reloads a theme's CSS when it changes


class Alacritty:
    """Alacritty reloads its config and imports by itself. Colors set in
    alacritty.toml itself still win over an import, as Alacritty intends."""
    name = 'alacritty'
    title = 'Alacritty'
    label = 'Alacritty terminal'
    IMPORT = '"~/.config/alacritty/jade-theme.toml"'

    def config(self):
        return config_home() / 'alacritty/alacritty.toml'

    def available(self, ctx):
        return None if self.config().exists() else Absent('Alacritty is not configured')

    def changes(self, theme, ctx):
        text = read_text(self.config())
        imports = re.search(r'^(\s*(?:general\.)?import\s*=\s*\[)', text, re.M)
        if self.IMPORT in text:
            pass
        elif imports:  # the person's own import list: ours goes first, so theirs win
            text = text[:imports.end()] + self.IMPORT + ', ' + text[imports.end():]
        elif table := re.search(r'^\[general\][ \t]*(?:#.*)?\n?', text, re.M):
            # A [general] table of their own: the import goes inside it (a
            # dotted general.import at the top would define the table twice).
            text = text[:table.end()] + managed_block('', f'import = [{self.IMPORT}]') + text[table.end():]
        else:
            # Top-level keys must come before any table: at the very top.
            text = managed_block('', f'general.import = [{self.IMPORT}]') + ('\n' + text if text.strip() else '')
        themed = themes.render(themes.template('alacritty.toml.tpl'), theme.colors)
        family = font.chosen(ctx)
        if family:  # `jade font set`
            themed += '\n' + font.font_text('alacritty', family)
        return [File(self.config().parent / 'jade-theme.toml', themed), File(self.config(), text)]

    def revert(self, path, text, old):
        if path != self.config():
            return None
        reverted = revert_block(text, old)
        if reverted is not None:
            return reverted.lstrip('\n') if not BLOCK.search(old or '') else reverted
        if self.IMPORT + ', ' in text and self.IMPORT not in (old or ''):
            return text.replace(self.IMPORT + ', ', '', 1)
        return None

    def reload(self, ctx):
        pass  # Alacritty watches its config and its imports


class ClaudeCode:
    """A `jade` theme for Claude Code in ~/.claude/themes, which Claude Code
    reloads live. Choosing it stays the person's call (/theme → jade)."""
    name = 'claude'
    title = 'Claude Code'
    label = 'Claude Code (choose it with /theme)'

    def folder(self):
        return pathlib.Path(os.environ.get('CLAUDE_CONFIG_DIR') or pathlib.Path.home() / '.claude')

    def available(self, ctx):
        return None if self.folder().is_dir() else Absent('Claude Code is not set up')

    def changes(self, theme, ctx):
        return [File(self.folder() / 'themes/jade.json', themes.render(themes.template('claude.json.tpl'), theme.colors))]

    def reload(self, ctx):
        pass  # Claude Code watches its themes folder


class Starship:
    name = 'starship'
    title = 'Starship'
    label = 'Starship prompt'
    # The prompt refers to Catppuccin color names; give each a theme color.
    NAMES: ClassVar[dict] = {
        'rosewater': 'bright_foreground', 'mauve': 'magenta', 'red': 'red', 'peach': 'orange',
        'yellow': 'yellow', 'green': 'green', 'teal': 'cyan', 'sapphire': 'accent', 'blue': 'blue',
        'overlay1': 'dark_foreground', 'overlay0': 'muted',
    }

    def available(self, ctx):
        return None if (config_home() / 'starship.toml').exists() else Absent('Starship is not configured')

    def changes(self, theme, ctx):
        path = config_home() / 'starship.toml'
        text = read_text(path)
        text = re.sub(r'^palette\s*=.*$', 'palette = "jade"', text, count=1, flags=re.M)
        if not re.search(r'^palette\s*=', text, re.M):
            text = 'palette = "jade"\n' + text
        block = '[palettes.jade]\n' + '\n'.join(f'{k} = "{theme.colors[v]}"' for k, v in self.NAMES.items())
        return [File(path, managed_block(text, block))]

    def revert(self, path, text, old):
        if path != config_home() / 'starship.toml':
            return None
        text = revert_block(text, old)
        if text is None:
            return None
        # A palette line changed since stays: it is the person's choice now.
        reverted = revert_line(text, old, 'palette', 'jade')
        return text if reverted is None else reverted

    def reload(self, ctx):
        pass  # read on every prompt


class Btop:
    name = 'btop'
    title = 'btop'
    label = 'btop'

    def available(self, ctx):
        return None if (config_home() / 'btop/btop.conf').exists() else Absent('btop is not configured')

    def changes(self, theme, ctx):
        folder = config_home() / 'btop'
        conf = re.sub(r'^color_theme\s*=.*$', 'color_theme = "jade"', read_text(folder / 'btop.conf'), count=1, flags=re.M)
        return [
            File(folder / 'themes/jade.theme', themes.render(themes.template('btop.theme.tpl'), theme.colors)),
            File(folder / 'btop.conf', conf),
        ]

    def revert(self, path, text, old):
        # btop writes its config back on exit, so this is the usual case, not a rare one.
        return revert_line(text, old, 'color_theme', 'jade') if path == config_home() / 'btop/btop.conf' else None

    def reload(self, ctx):
        signal('btop', 'USR2')


class VSCode:
    """VS Code and its siblings: Insiders, VSCodium, Code - OSS, and the
    Flatpak builds of VS Code and VSCodium. Every one that is set up gets the
    extension that provides the themes, and has its theme switched."""
    name = 'vscode'
    title = 'VS Code'
    label = 'VS Code color theme (and VSCodium, Code - OSS, Flatpak)'
    ID = 'jade-shell.jade-themes'
    VERSION = '1.0.0'
    LABEL = 'Jade · '

    @staticmethod
    def variants():
        """(settings.json, extension folders it may read), for each kind.
        Flatpak VSCodium reads one folder or the other depending on how it
        was started, so both get the extension."""
        home, config = pathlib.Path.home(), config_home()
        flatpak = home / '.var/app'
        return [
            (config / 'Code/User/settings.json', [home / '.vscode/extensions']),
            (config / 'Code - Insiders/User/settings.json', [home / '.vscode-insiders/extensions']),
            (config / 'VSCodium/User/settings.json', [home / '.vscode-oss/extensions']),
            (config / 'Code - OSS/User/settings.json', [home / '.vscode-oss/extensions']),
            (flatpak / 'com.visualstudio.code/config/Code/User/settings.json',
             [flatpak / 'com.visualstudio.code/data/vscode/extensions', home / '.vscode/extensions']),
            (flatpak / 'com.vscodium.codium/config/VSCodium/User/settings.json',
             [flatpak / 'com.vscodium.codium/data/codium/extensions', home / '.vscode-oss/extensions']),
        ]

    def installs(self):
        """The variants set up here: (settings.json, extension folders to fill)."""
        return [(settings, [d for d in folders if d.exists()] or folders[:1])
                for settings, folders in self.variants() if settings.exists()]

    def settings_path(self):
        return self.variants()[0][0]

    def registry_path(self):
        return self.variants()[0][1][0] / 'extensions.json'

    def available(self, ctx):
        return None if self.installs() else Absent('VS Code is not set up')

    @staticmethod
    def label_for(theme):
        return f'{VSCode.LABEL}{theme.name}'

    def extension(self, theme, base):
        """The files of the extension providing every theme, in `base`."""
        folder = base / f'{self.ID}-{self.VERSION}'
        template = themes.template('vscode-theme.json.tpl')
        # One extension contributes every theme, so switching is a settings change.
        contributed, out = [], []
        for theme_id in themes.ids():
            t = theme if theme_id == theme.id else themes.load(theme_id)
            data = json.loads(themes.render(template, t.colors))
            data['name'] = self.label_for(t)
            out.append(File(folder / 'themes' / f'{t.id}.json', json.dumps(data, indent=2) + '\n'))
            ui = 'vs' if t.colors.get('mode') == 'light' else 'vs-dark'
            contributed.append({'label': self.label_for(t), 'uiTheme': ui, 'path': f'./themes/{t.id}.json'})
        package = {
            'name': 'jade-themes', 'displayName': 'Jade Shell themes', 'publisher': 'jade-shell',
            'version': self.VERSION, 'engines': {'vscode': '^1.60.0'},
            'categories': ['Themes'], 'contributes': {'themes': contributed},
        }
        out.append(File(folder / 'package.json', json.dumps(package, indent=2) + '\n'))
        return folder, out

    def register(self, ctx, base, folder):
        """VS Code lists installed extensions in extensions.json; add ours once."""
        registry = base / 'extensions.json'
        try:
            entries = json.loads(read_text(registry) or '[]')
            if not isinstance(entries, list):
                raise ValueError('not a list')
        except ValueError:  # VS Code owns this file; never rewrite one we can't read
            ctx.skipped[self.name] = f'could not read {registry}; the themes may not show up there'
            return []
        if any((e.get('identifier') or {}).get('id') == self.ID for e in entries if isinstance(e, dict)):
            return []
        entries.append({
            'identifier': {'id': self.ID}, 'version': self.VERSION,
            'location': {'$mid': 1, 'fsPath': str(folder), 'external': folder.as_uri(),
                         'path': str(folder), 'scheme': 'file'},
            'relativeLocation': folder.name,
        })
        return [File(registry, json.dumps(entries))]

    def changes(self, theme, ctx):
        out, done = [], set()
        for settings_path, bases in self.installs():
            for base in bases:
                if base in done:  # VSCodium and Code - OSS share a folder
                    continue
                done.add(base)
                folder, files = self.extension(theme, base)
                out += files + self.register(ctx, base, folder)
            settings = read_text(settings_path)
            line = f'"workbench.colorTheme": "{self.label_for(theme)}"'
            if re.search(r'"workbench\.colorTheme"\s*:\s*"[^"]*"', settings):
                settings = re.sub(r'"workbench\.colorTheme"\s*:\s*"[^"]*"', lambda _m, line=line: line, settings, count=1)
            else:
                settings = settings.replace('{', '{\n    ' + line + ',', 1)
            out.append(File(settings_path, settings))
        return out

    def revert(self, path, text, old):
        if path in {folder / 'extensions.json' for _s, folders in self.variants() for folder in folders}:
            if old is not None and self.ID in old:
                return None  # it was registered before the switch
            entries = json.loads(text)
            if not isinstance(entries, list):
                return None
            return json.dumps([e for e in entries if not (isinstance(e, dict)
                                                          and (e.get('identifier') or {}).get('id') == self.ID)])
        if path not in {settings for settings, _f in self.variants()}:
            return None
        ours = r'"workbench\.colorTheme"\s*:\s*"' + re.escape(self.LABEL) + r'[^"]*"'
        if not re.search(ours, text):
            return None  # a theme picked in VS Code since stays
        before = re.search(r'"workbench\.colorTheme"\s*:\s*"[^"]*"', old or '')
        if before:
            return re.sub(ours, lambda _m: before.group(0), text, count=1)
        # The line changes() added after the opening brace (or, moved, with its comma).
        for pattern in (r'\n?[ \t]*' + ours + r'\s*,', r',\s*' + ours, r'\s*' + ours + r'\s*'):
            found = re.search(pattern, text)
            if found:
                return text[:found.start()] + text[found.end():]
        return None

    def reload(self, ctx):
        pass  # VS Code watches settings.json
