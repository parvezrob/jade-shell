"""Mac-style app icons (MacTahoe), their folders in the theme's accent."""

from .. import icons
from ..store import File, Setting
from .base import Absent


class Icons:
    name = 'icons'
    title = 'the icons'
    label = "Mac-style icons (MacTahoe, folders in the theme's accent)"

    def available(self, ctx):
        return None if icons.installed() else Absent('the Mac-style icons are off; turn them on with: jade apps on icons')

    def changes(self, theme, ctx):
        folders = icons.folder_icons(theme.colors['accent'])
        out = [File(folder / 'places/scalable' / name, svg) for folder in icons.theme_dirs() for name, svg in folders.items()]
        return [*out, Setting('org.gnome.desktop.interface', 'icon-theme', icons.variant(theme.colors))]

    def reload(self, ctx):
        icons.update_cache(wait=False)
