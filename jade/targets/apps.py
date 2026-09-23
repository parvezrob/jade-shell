"""Apps themed through files: the Shell theme, terminals, launcher, editor."""
import json
import pathlib
import re
import subprocess
from typing import ClassVar

from .. import shelltheme, themes
from ..store import File, Setting, config_home, data_home, read_text, state_home
from .base import Absent

MARK_BEGIN = '# >>> jade-theme (generated; edits here are replaced)'
MARK_END = '# <<< jade-theme'
BLOCK = re.compile(re.escape(MARK_BEGIN) + r'.*?' + re.escape(MARK_END) + r'\n?', re.S)


def signal(process, sig):
    """Ask running instances to reload; quietly nothing when none run."""
    subprocess.run(['pkill', f'-{sig}', '-x', process], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def managed_block(text, block):
    """Replace (or append) our marked block, leaving the rest of the file alone."""
    wrapped = f'{MARK_BEGIN}\n{block.rstrip()}\n{MARK_END}\n'
    if BLOCK.search(text):
        return BLOCK.sub(lambda _m: wrapped, text)
    return text.rstrip('\n') + '\n\n' + wrapped


def revert_block(text, old):
    """`text` with our marked block as it was in `old`: its old contents, or gone
    (with the blank line managed_block put before it). None if the block is not there."""
    found = BLOCK.search(text)
    if found is None:
        return None
    before = BLOCK.search(old or '')
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
        colors = {'id': theme.id, 'name': theme.name, 'colors': theme.colors}
        return [
            File(base / 'gnome-shell.css', shelltheme.build(theme.colors, self.version)),
            File(base / 'colors.json', json.dumps(colors, indent=2, sort_keys=True) + '\n'),
        ]

    def reload(self, ctx):
        pass  # the Jade Shell extension watches these files


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
        included = managed_block(conf, 'include jade-theme.conf')
        return [
            File(folder / 'jade-theme.conf', themes.render(themes.template('kitty.conf.tpl'), theme.colors)),
            File(folder / 'kitty.conf', included),
        ]

    def revert(self, path, text, old):
        return revert_block(text, old) if path == config_home() / 'kitty/kitty.conf' else None

    def reload(self, ctx):
        signal('kitty', 'USR1')


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
    name = 'vscode'
    title = 'VS Code'
    label = 'VS Code color theme'
    ID = 'jade-shell.jade-themes'
    VERSION = '1.0.0'
    LABEL = 'Jade · '

    def settings_path(self):
        return config_home() / 'Code/User/settings.json'

    def registry_path(self):
        return pathlib.Path.home() / '.vscode/extensions/extensions.json'

    def available(self, ctx):
        return None if self.settings_path().exists() else Absent('VS Code is not set up')

    @staticmethod
    def label_for(theme):
        return f'{VSCode.LABEL}{theme.name}'

    def changes(self, theme, ctx):
        base = pathlib.Path.home() / '.vscode/extensions'
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

        registry = self.registry_path()
        try:
            entries = json.loads(read_text(registry) or '[]')
            if not isinstance(entries, list):
                raise ValueError('not a list')
        except ValueError:  # VS Code owns this file; never rewrite one we can't read
            entries = None
            ctx.skipped[self.name] = f'could not read {registry}; the themes may not show up in VS Code'
        if entries is not None and not any((e.get('identifier') or {}).get('id') == self.ID
                                           for e in entries if isinstance(e, dict)):
            entries.append({
                'identifier': {'id': self.ID}, 'version': self.VERSION,
                'location': {'$mid': 1, 'fsPath': str(folder), 'external': folder.as_uri(),
                             'path': str(folder), 'scheme': 'file'},
                'relativeLocation': folder.name,
            })
            out.append(File(registry, json.dumps(entries)))

        settings = read_text(self.settings_path())
        line = f'"workbench.colorTheme": "{self.label_for(theme)}"'
        if re.search(r'"workbench\.colorTheme"\s*:\s*"[^"]*"', settings):
            settings = re.sub(r'"workbench\.colorTheme"\s*:\s*"[^"]*"', lambda _m: line, settings, count=1)
        else:
            settings = settings.replace('{', '{\n    ' + line + ',', 1)
        out.append(File(self.settings_path(), settings))
        return out

    def revert(self, path, text, old):
        if path == self.registry_path():
            if old is not None and self.ID in old:
                return None  # it was registered before the switch
            entries = json.loads(text)
            if not isinstance(entries, list):
                return None
            return json.dumps([e for e in entries if not (isinstance(e, dict)
                                                          and (e.get('identifier') or {}).get('id') == self.ID)])
        if path != self.settings_path():
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
