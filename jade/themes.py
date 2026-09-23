"""Themes: Omarchy palettes plus the GNOME shades derived from them."""
import math
import os
import pathlib
import re
import shutil
import time
import tomllib
import urllib.error
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
RETRY_DELAYS = (1, 2)  # seconds between download attempts


class WallpaperUnavailable(Exception):
    """A wallpaper that is not on disk could not be downloaded."""


def transient(error):
    # A server hiccup or a dropped connection may pass; a missing file will not.
    if isinstance(error, urllib.error.HTTPError):
        return error.code == 429 or error.code >= 500
    return True

# Shades GNOME needs that Omarchy has no key for. A user override file can pin
# any of them (or any palette key) to a hand-tuned value.
DERIVED = {
    'dock_background': lambda c: pal.mix(c['background'], c['foreground'], 0.10),
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
            # Its own partial file: the picker's preview download and a switch may fetch the same one.
            tmp = path.with_name(f'.{path.name}.{os.getpid()}.part')
            for attempt in range(len(RETRY_DELAYS) + 1):
                try:
                    with urllib.request.urlopen(url, timeout=20) as response, tmp.open('wb') as out:
                        shutil.copyfileobj(response, out)
                    tmp.replace(path)
                    break
                except OSError as error:  # URLError, HTTPError and timeouts are all OSErrors
                    tmp.unlink(missing_ok=True)
                    if attempt == len(RETRY_DELAYS) or not transient(error):
                        reason = getattr(error, 'reason', None) or error
                        raise WallpaperUnavailable(
                            f'could not download the {self.name} wallpaper ({reason})') from None
                    time.sleep(RETRY_DELAYS[attempt])
        return path


def thumbnail_path(theme_id):
    return state_home() / 'jade-shell/thumbs' / f'{theme_id}.png'


def make_thumbnail(theme, width=320, height=200):
    """A small center-cropped preview, so the picker never decodes 4K images."""
    import gi
    gi.require_version('GdkPixbuf', '2.0')
    from gi.repository import GdkPixbuf
    source = theme.fetch_wallpaper(0)
    _format, w, h = GdkPixbuf.Pixbuf.get_file_info(str(source))
    scale = max(width / w, height / h)
    # Scale to at least the preview size on both axes (aspect kept by `scale`), then crop.
    size = max(width, math.ceil(w * scale)), max(height, math.ceil(h * scale))
    image = GdkPixbuf.Pixbuf.new_from_file_at_scale(str(source), *size, False)
    x = (image.get_width() - width) // 2
    y = (image.get_height() - height) // 2
    out = thumbnail_path(theme.id)
    out.parent.mkdir(parents=True, exist_ok=True)
    tmp = out.with_name(f'.{out.name}.{os.getpid()}.part')
    image.new_subpixbuf(x, y, width, height).savev(str(tmp), 'png', [], [])
    tmp.replace(out)
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
