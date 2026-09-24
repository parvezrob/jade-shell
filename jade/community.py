"""Community themes: `jade theme install <git-url>`, `update` and `remove`.

Omarchy's community themes share its colors.toml, so they work here too
(see omarchy.org/themes). Jade takes only what a theme looks like: its
colors, its wallpapers and its preview. Nothing else from it is kept, and
nothing from it ever runs; themes can carry scripts and app configs, and
those stay behind.

Older themes without a colors.toml get their colors from their Alacritty
theme, the terminal palette every Omarchy theme had.
"""

import json
import os
import pathlib
import re
import shutil
import subprocess
import tarfile
import tempfile
import time
import tomllib
import urllib.request

from . import palette as pal
from .store import config_home

IMAGES = {'.png', '.jpg', '.jpeg', '.webp'}
MAX_IMAGE = 64 << 20   # bytes: one wallpaper
MAX_TOTAL = 400 << 20  # bytes: a whole theme
NAME = re.compile(r'[a-z0-9_][a-z0-9._+-]*')
GITHUB = re.compile(r'(?:https://github\.com/|git@github\.com:)([\w.-]+)/([\w.-]+?)(?:\.git)?/?')


class ThemeError(Exception):
    """A sentence for the person: why a theme could not be installed."""


def home():
    return config_home() / 'jade-shell/themes'


def folder(theme_id):
    return home() / theme_id


def natural(name):
    """A sort key that puts 2 before 10."""
    return [int(t) if t.isdigit() else t.lower() for t in re.split(r'(\d+)', name)]


def installed():
    base = home()
    return sorted((p.name for p in base.iterdir() if (p / 'colors.toml').exists() and (p / 'source.json').exists()),
                  key=natural) if base.is_dir() else []


def source(theme_id):
    try:
        return json.loads((folder(theme_id) / 'source.json').read_text())
    except (OSError, ValueError):
        return {}


def check_url(url):
    """Git URLs only: never an option (-…) or a transport helper (ext::…)."""
    if url.startswith('-') or '::' in url or any(c.isspace() for c in url):
        raise ThemeError(f'{url} is not a git URL')
    if not re.match(r'(https?|ssh|git|file)://|[\w.-]+@[\w.-]+:', url):
        raise ThemeError(f'{url} is not a git URL (https://… or git@host:owner/repo.git)')


def theme_id(url):
    """omarchy-tokyo-night-theme.git -> tokyo-night, as Omarchy names it."""
    path = url.rstrip('/')
    if '://' not in path and ':' in path and '/' not in path.split(':', 1)[0]:
        path = path.split(':', 1)[1]  # git@host:owner/repo
    name = path.rsplit('/', 1)[-1]
    name = re.sub(r'\.git$', '', name)
    name = re.sub(r'-theme$', '', re.sub(r'^omarchy-', '', name)).lower()
    if not NAME.fullmatch(name):
        raise ThemeError(f'{url} does not give a usable theme name; pick one with --name')
    return name


# ---------------------------------------------------------------- fetching

def fetch(url, into):
    """The theme's files, in `into`: from GitHub's archive when it is on
    GitHub (no git needed), else a shallow clone."""
    github = GITHUB.fullmatch(url)
    if github:
        owner, repo = github.groups()
        archive = f'https://codeload.github.com/{owner}/{repo}/tar.gz/HEAD'
        try:
            with urllib.request.urlopen(archive, timeout=60) as response, \
                    tempfile.TemporaryFile() as tmp:
                shutil.copyfileobj(response, tmp)
                tmp.seek(0)
                unpack(tmp, into)
        except OSError as error:
            raise ThemeError(f'could not download {url} ({getattr(error, "reason", None) or error})') from None
        return
    if not shutil.which('git'):
        raise ThemeError('installing a theme from outside GitHub needs git')
    result = subprocess.run(['git', 'clone', '--quiet', '--depth', '1', '--', url, str(into)],
                            capture_output=True, text=True, timeout=300,
                            env={**os.environ, 'GIT_TERMINAL_PROMPT': '0'})
    if result.returncode:
        reason = result.stderr.strip().splitlines()[-1] if result.stderr.strip() else 'git failed'
        raise ThemeError(f'could not fetch {url}: {reason}')


def unpack(fileobj, into):
    """From GitHub's archive only what a theme looks like, within the limits."""
    total = 0
    with tarfile.open(fileobj=fileobj, mode='r:gz') as tar:
        for member in tar:
            parts = member.name.split('/', 1)
            if len(parts) < 2 or not member.isfile() or not wanted(parts[1]):
                continue
            total += member.size
            if member.size > MAX_IMAGE or total > MAX_TOTAL:
                raise ThemeError('the theme is larger than Jade Shell takes (64 MB a picture, 400 MB in all)')
            member.name = parts[1]
            tar.extract(member, into, filter='data')


def wanted(path):
    """The files Jade keeps: colors, wallpapers and the preview."""
    p = pathlib.PurePosixPath(path)
    if path in ('colors.toml', 'alacritty.toml', 'light.mode'):
        return True
    if p.suffix.lower() not in IMAGES:
        return False
    return (len(p.parts) == 2 and p.parts[0] == 'backgrounds') or (len(p.parts) == 1 and p.stem == 'preview')


# ---------------------------------------------------------------- colors

def colors_from_alacritty(text):
    """An Omarchy colors.toml from an Alacritty theme (older themes)."""
    data = tomllib.loads(text).get('colors', {})
    primary, normal, bright = data.get('primary', {}), data.get('normal', {}), data.get('bright', {})
    if not primary.get('background') or not primary.get('foreground'):
        raise ThemeError('the theme has no colors Jade Shell can read')
    out = {'background': primary['background'], 'foreground': primary['foreground']}
    for name in ('red', 'green', 'yellow', 'blue', 'magenta', 'cyan'):
        out[name] = normal.get(name) or primary['foreground']  # a partial theme still reads
        if bright.get(name):
            out[f'bright_{name}'] = bright[name]
    if bright.get('black'):
        out['muted'] = bright['black']
    if bright.get('white'):
        out['bright_foreground'] = bright['white']
    if data.get('selection', {}).get('background'):
        out['selection'] = data['selection']['background']
    return ''.join(f'{key} = "{value.replace("0x", "#")}"\n' for key, value in out.items())


def build(raw, target, url):
    """The theme folder Jade reads, from what was fetched."""
    for path in (raw / 'colors.toml', raw / 'alacritty.toml', raw / 'backgrounds', raw / 'light.mode'):
        if path.is_symlink():  # a link could point at one of your own files: never followed
            raise ThemeError(f'the theme\'s {path.name} is a link, which Jade Shell does not follow')
    colors = raw / 'colors.toml'
    if colors.exists():
        text = colors.read_text()
    elif (raw / 'alacritty.toml').exists():
        text = colors_from_alacritty((raw / 'alacritty.toml').read_text())
    else:
        raise ThemeError('the theme has no colors.toml (nor an Alacritty theme to take colors from)')
    try:
        palette = pal.resolve(tomllib.loads(text))
        pal.rgb(palette['background']), pal.rgb(palette['foreground'])
    except (tomllib.TOMLDecodeError, KeyError, TypeError, ValueError):
        raise ThemeError('the theme\'s colors.toml is not one Jade Shell can read') from None
    if (raw / 'light.mode').exists() and 'mode' not in tomllib.loads(text):
        text = 'mode = "light"\n' + text  # Omarchy's older way of saying light
    target.mkdir(parents=True)
    (target / 'colors.toml').write_text(text)
    walls = raw / 'backgrounds'
    if walls.is_dir():
        (target / 'backgrounds').mkdir()
        for image in sorted(walls.iterdir()):
            if image.is_file() and not image.is_symlink() and image.suffix.lower() in IMAGES \
                    and image.stat().st_size <= MAX_IMAGE:
                shutil.copyfile(image, target / 'backgrounds' / image.name)
    for image in sorted(raw.glob('preview.*')):
        if image.suffix.lower() in IMAGES and image.is_file() and not image.is_symlink():
            shutil.copyfile(image, target / f'preview{image.suffix.lower()}')
            break
    (target / 'source.json').write_text(json.dumps({'url': url, 'fetched': int(time.time())}, indent=2) + '\n')


# ---------------------------------------------------------------- commands

def install(url, name=None, reserved=()):
    """Fetch and set up a theme; returns its id. Installing one that is
    installed already fetches it again."""
    check_url(url)
    tid = name or theme_id(url)
    if not NAME.fullmatch(tid):
        raise ThemeError(f'{tid} is not a usable theme name (lowercase letters, digits, . _ + -)')
    if tid in reserved:
        raise ThemeError(f'Jade Shell already has a theme called {tid}; install this one under another name with --name')
    home().mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=home(), prefix='.fetch-') as tmp:
        raw, target = pathlib.Path(tmp) / 'raw', pathlib.Path(tmp) / 'theme'
        fetch(url, raw)
        build(raw, target, url)
        old = folder(tid)
        if old.exists():
            gone = pathlib.Path(tmp) / 'old'
            old.rename(gone)
        target.rename(old)
    return tid


def update(theme_id_):
    url = source(theme_id_).get('url')
    if not url:
        raise ThemeError(f'{theme_id_} is not a community theme')
    return install(url, name=theme_id_)


def remove(theme_id_):
    if theme_id_ not in installed():
        raise ThemeError(f'{theme_id_} is not a community theme')
    shutil.rmtree(folder(theme_id_))
