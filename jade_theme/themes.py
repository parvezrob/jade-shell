"""Themes: Omarchy palettes plus the GNOME shades derived from them."""
import math
import pathlib
import re
import tomllib
import urllib.request
from dataclasses import dataclass

from . import palette as pal
from .store import config_home, data_home, state_home

ROOT = pathlib.Path(__file__).resolve().parent.parent
THEMES = ROOT / 'themes'
TEMPLATES = ROOT / 'templates'
OMARCHY_COMMIT = 'd3cfd53b997f8bdcf776b8db68bf0d735e7a065d'
WALLPAPER_URL = f'https://raw.githubusercontent.com/omacom/omarchy/{OMARCHY_COMMIT}/themes/{{theme}}/backgrounds/{{file}}'
NAMES = {'retro-82': 'Retro 82', 'last-horizon': 'Last Horizon', 'matte-black': 'Matte Black'}

# Shades GNOME needs that Omarchy has no key for. A user override file can pin
# any of them (or any palette key) to a hand-tuned value.
DERIVED = {
    'dock_background': lambda c: pal.mix(c['background'], c['foreground'], 0.10),
    'quick_toggle_hover': lambda c: pal.mix(c['selection'], c['foreground'], 0.12),
    'secondary_text': lambda c: pal.mix(c['foreground'], c['dark_foreground'], 0.35),
}


@dataclass
class Theme:
    id: str
    name: str
    colors: dict
    backgrounds: list
    wallpaper_folder: pathlib.Path | None = None  # the user's own copies, if any

    def wallpaper(self, index=0):
        if not self.backgrounds:
            return None
        name = self.backgrounds[index % len(self.backgrounds)]
        if self.wallpaper_folder and (self.wallpaper_folder / name).exists():
            return self.wallpaper_folder / name
        return data_home() / 'jade-shell/backgrounds' / self.id / name

    def fetch_wallpaper(self, index=0):
        path = self.wallpaper(index)
        if path and not path.exists():
            path.parent.mkdir(parents=True, exist_ok=True)
            url = WALLPAPER_URL.format(theme=self.id, file=path.name)
            tmp = path.with_suffix(path.suffix + '.part')
            with urllib.request.urlopen(url, timeout=60) as response, tmp.open('wb') as out:
                out.write(response.read())
            tmp.replace(path)
        return path


def thumbnail_path(theme_id):
    return state_home() / 'jade-shell/thumbs' / f'{theme_id}.png'


def make_thumbnail(theme, width=320, height=200):
    """A small center-cropped preview, so the picker never decodes 4K images."""
    import gi
    gi.require_version('GdkPixbuf', '2.0')
    from gi.repository import GdkPixbuf
    source = theme.fetch_wallpaper(0)
    info, w, h = GdkPixbuf.Pixbuf.get_file_info(str(source))
    scale = max(width / w, height / h)
    # Scale to at least the preview size on both axes (aspect kept by `scale`), then crop.
    image = GdkPixbuf.Pixbuf.new_from_file_at_scale(str(source), max(width, math.ceil(w * scale)), max(height, math.ceil(h * scale)), False)
    x = (image.get_width() - width) // 2
    y = (image.get_height() - height) // 2
    out = thumbnail_path(theme.id)
    out.parent.mkdir(parents=True, exist_ok=True)
    image.new_subpixbuf(x, y, width, height).savev(str(out), 'png', [], [])
    return out


def ids():
    return sorted(p.name for p in THEMES.iterdir() if (p / 'colors.toml').exists())


def user_overrides(theme_id):
    path = config_home() / 'jade-shell/themes' / f'{theme_id}.toml'
    return tomllib.loads(path.read_text()) if path.exists() else {}


def load(theme_id):
    folder = THEMES / theme_id
    if not (folder / 'colors.toml').exists():
        raise KeyError(theme_id)
    user = user_overrides(theme_id)
    colors = pal.load(folder / 'colors.toml', user.get('colors'))
    for key, derive in DERIVED.items():
        colors.setdefault(key, derive(colors))
    backgrounds = (folder / 'backgrounds.txt').read_text().split() if (folder / 'backgrounds.txt').exists() else []
    folder_override = pathlib.Path(user['wallpaper_folder']).expanduser() if user.get('wallpaper_folder') else None
    name = NAMES.get(theme_id) or theme_id.replace('-', ' ').title()
    return Theme(theme_id, name, colors, backgrounds, folder_override)


TOKEN = re.compile(r'\{\{\s*(\w+?)(_strip|_rgb)?\s*\}\}')


def render(template, colors):
    """Fill Omarchy-style `{{ key }}`, `{{ key_strip }}` and `{{ key_rgb }}` tokens."""
    def value(match):
        key, form = match.groups()
        color = colors[key]
        if form == '_strip':
            return color.lstrip('#')
        if form == '_rgb':
            return ','.join(str(v) for v in pal.rgb(color))
        return color
    return TOKEN.sub(value, template)


def template(name):
    return (TEMPLATES / name).read_text()
