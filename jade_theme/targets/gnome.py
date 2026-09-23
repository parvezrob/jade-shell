"""GNOME itself and the Shell extensions that carry theme colors in GSettings."""
import json
import re
import time

from .. import palette as pal
from ..store import Setting

# GNOME 47+ offers a fixed set of named accents; pick the nearest.
ACCENTS = {
    'blue': '#3584e4', 'teal': '#2190a4', 'green': '#3a944a', 'yellow': '#c88800',
    'orange': '#ed5b00', 'red': '#e62d42', 'pink': '#d56199', 'purple': '#9141ac', 'slate': '#6f8396',
}


def nearest_accent(color):
    target = pal.rgb(color)
    return min(ACCENTS, key=lambda name: sum((a - b) ** 2 for a, b in zip(pal.rgb(ACCENTS[name]), target)))


def floats(color):
    return [repr(v / 255) for v in pal.rgb(color)]


def rgba(color, alpha=1.0):
    r, g, b = pal.rgb(color)
    return f'rgba({r},{g},{b},{alpha:.1f})' if alpha == 1.0 else f'rgba({r},{g},{b},{alpha})'


class Gnome:
    name = 'gnome'
    label = 'GNOME accent, dark style and wallpaper'

    def available(self, ctx):
        return None

    def changes(self, theme, ctx):
        c = theme.colors
        out = [
            Setting('org.gnome.desktop.interface', 'color-scheme', 'prefer-dark'),
            Setting('org.gnome.desktop.interface', 'accent-color', nearest_accent(c['accent'])),
        ]
        wallpaper = theme.wallpaper(ctx.wallpaper_index)
        if wallpaper:
            uri = wallpaper.as_uri()
            out += [
                Setting('org.gnome.desktop.background', 'picture-uri', uri),
                Setting('org.gnome.desktop.background', 'picture-uri-dark', uri),
                Setting('org.gnome.desktop.background', 'picture-options', 'zoom'),
                Setting('org.gnome.desktop.screensaver', 'picture-uri', uri),
                Setting('org.gnome.desktop.screensaver', 'picture-options', 'zoom'),
            ]
        return out

    def reload(self, ctx):
        # OpenBar reacts to its selection color by picking a GNOME accent of its
        # own; once it has, put ours back.
        if ctx.theme:
            time.sleep(1)
            ctx.settings.write([c for c in self.changes(ctx.theme, ctx) if c.key == 'accent-color'])


class OpenBar:
    name = 'openbar'
    label = 'OpenBar top bar and menus'
    schema = 'org.gnome.shell.extensions.openbar'
    MAP = {
        'bgcolor': 'background', 'boxcolor': 'background', 'iscolor': 'background',
        'mbgcolor': 'background', 'fgcolor': 'foreground', 'mfgcolor': 'foreground',
        'hcolor': 'accent', 'mhcolor': 'accent', 'accent-color': 'accent',
        'mbcolor': 'muted', 'mscolor': 'selection', 'smbgcolor': 'lighter_background',
        'dbgcolor': 'dock_background',
    }

    def available(self, ctx):
        return None if ctx.settings.has(self.schema) else 'OpenBar is not installed'

    def changes(self, theme, ctx):
        out = []
        # OpenBar keeps dark- and light- copies and copies them over the plain
        # keys when the color scheme flips, so all three must agree.
        for key, color in self.MAP.items():
            for prefix in ('', 'dark-', 'light-'):
                out.append(Setting(self.schema, prefix + key, floats(theme.colors[color])))
        out.append(Setting(self.schema, 'bgcolor-wmax', floats(theme.colors['background'])))
        return out

    def reload(self, ctx):
        ctx.settings.flip(self.schema, 'trigger-reload')


class Dock:
    name = 'dock'
    label = 'Dash to Dock'
    schema = 'org.gnome.shell.extensions.dash-to-dock'

    def available(self, ctx):
        return None if ctx.settings.has(self.schema) else 'Dash to Dock is not installed'

    def changes(self, theme, ctx):
        c = theme.colors
        return [
            Setting(self.schema, 'background-color', c['dock_background'].lower()),
            Setting(self.schema, 'custom-theme-running-dots-color', c['light_foreground'].lower()),
            Setting(self.schema, 'custom-theme-running-dots-border-color', c['light_foreground'].lower()),
        ]

    def reload(self, ctx):
        pass


class AppGrid:
    name = 'appgrid'
    label = 'App Grid Tuner hover tiles'
    schema = 'org.gnome.shell.extensions.app-grid-tuner'

    def available(self, ctx):
        return None if ctx.settings.has(self.schema, 'app-hover-tile-background-color') else 'App Grid Tuner is not installed'

    def changes(self, theme, ctx):
        accent = theme.colors['accent'].lower()
        return [
            Setting(self.schema, 'app-hover-tile-background-color', accent),
            Setting(self.schema, 'app-hover-tile-border-color', accent),
        ]

    def reload(self, ctx):
        if ctx.settings.has(self.schema, 'reload-signal'):
            ctx.settings.flip(self.schema, 'reload-signal')


class Astra:
    name = 'astra'
    label = 'Astra Monitor readouts'
    schema = 'org.gnome.shell.extensions.astra-monitor'

    def available(self, ctx):
        return None if ctx.settings.has(self.schema, 'profiles') else 'Astra Monitor is not installed'

    @staticmethod
    def color_for(key, c):
        if key.endswith('icon-alert-color'):
            return rgba(c['bright_red'])
        if key.endswith('icon-color'):
            return rgba(c['foreground'])
        if key.startswith('gpu-header-activity') or key in ('memory-menu-swap-color', 'storage-menu-device-color'):
            return rgba(c['accent'])
        if key.endswith('color2'):
            if key.startswith('memory-'):
                return rgba(c['dark_foreground'], 0.35)
            if key.startswith('processor-'):
                return rgba(c['foreground'])
            return rgba(c['bright_red'])
        if key.endswith('color1'):
            return rgba(c['dark_foreground'])
        return None

    def changes(self, theme, ctx):
        settings = ctx.settings.get(self.schema)
        keys = [k for k in settings.props.settings_schema.list_keys() if re.search(r'color\d?$', k)]
        out = []
        wanted = {}
        for key in sorted(keys):
            value = self.color_for(key, theme.colors)
            if value and settings.get_string(key):
                wanted[key] = value
                out.append(Setting(self.schema, key, value))
        # Astra mirrors every key inside its profiles JSON and re-applies it on
        # sync, so the profile copy must match or the old colors come back.
        profiles = json.loads(settings.get_string('profiles') or '{}')
        changed = False
        for profile in profiles.values():
            for key, value in wanted.items():
                if key in profile and profile[key] != value:
                    profile[key] = value
                    changed = True
        if changed:
            out.append(Setting(self.schema, 'profiles', json.dumps(profiles)))
        return out

    def reload(self, ctx):
        pass
