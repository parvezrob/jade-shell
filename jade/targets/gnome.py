"""GNOME itself and the dock, which carry theme colors in GSettings."""

from .. import palette as pal
from ..store import Setting

# GNOME 47+ offers a fixed set of named accents; pick the nearest.
ACCENTS = {
    'blue': '#3584e4', 'teal': '#2190a4', 'green': '#3a944a', 'yellow': '#c88800',
    'orange': '#ed5b00', 'red': '#e62d42', 'pink': '#d56199', 'purple': '#9141ac', 'slate': '#6f8396',
}


def nearest_accent(color):
    target = pal.rgb(color)
    return min(ACCENTS, key=lambda name: sum((a - b) ** 2 for a, b in zip(pal.rgb(ACCENTS[name]), target, strict=True)))


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
        pass


class Dock:
    name = 'dock'
    label = 'Dock (Dash to Dock or Ubuntu Dock)'
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
