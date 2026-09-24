"""Build a GNOME Shell stylesheet from the current palette.

GNOME's own theme sources (shell-theme/gnome-<version>) derive every surface
from a handful of base colors. Pointing those at the Omarchy palette and
compiling recolors the whole Shell the way GNOME designed it: the top bar,
menus, quick settings, calendar, notifications, dialogs and OSDs. Jade's own
rules (shell-theme/jade.scss) are compiled after it and can use its variables
and mixins.
"""
import hashlib
import json
import os
import pathlib
import re
import shutil
import subprocess
import tempfile

from . import palette as pal

ROOT = pathlib.Path(__file__).resolve().parent.parent / 'shell-theme'

# GNOME variable → what it becomes. `$jade-<key>` is any palette key.
BASE_COLORS = {
    '_default-colors.scss': {
        '_base_color_dark': '$jade-background',
        '_base_color_light': '$jade-foreground',
        'accent_color': '$jade-accent',
        'destructive_bg_color': '$jade-red',
        'success_bg_color': '$jade-green',
        'warning_bg_color': '$jade-yellow',
        'error_bg_color': '$jade-red',
    },
    '_colors.scss': {
        'base_color': '$jade-dark_background',
        'bg_color': '$jade-background',
        'fg_color': '$jade-foreground',
        'osd_fg_color': '$jade-foreground',
        'osd_bg_color': '$jade-background',
        'system_base_color': '$jade-darker_background',
        'system_fg_color': '$jade-foreground',
        'panel_bg_color': '$jade-background',
        'panel_fg_color': '$jade-foreground',
    },
}


class BuildError(Exception):
    pass


def version_dir(shell_version):
    folder = ROOT / f'gnome-{shell_version}'
    if not folder.is_dir():
        raise BuildError(f'no theme sources for GNOME {shell_version}')
    return folder


def luminance(color):
    channels = [v / 255 for v in pal.rgb(color)]
    linear = [c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4 for c in channels]
    return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2]


def contrast(a, b):
    """WCAG contrast ratio of two colors."""
    high, low = sorted((luminance(a), luminance(b)), reverse=True)
    return (high + 0.05) / (low + 0.05)


def accent_foreground(colors):
    """Text on an accent fill: whichever end of the palette reads better, or,
    on a mid-tone accent neither end reads on (Rosé Pine's teal), near-white
    or near-black."""
    accent = colors['accent']
    best = max((colors['darker_background'], colors['bright_foreground']), key=lambda c: contrast(accent, c))
    if contrast(accent, best) >= 2.5:
        return best
    return max(('#fafafa', '#141414'), key=lambda c: contrast(accent, c))


def point_at_palette(text, variables, name):
    """Replace each `$var: …;` definition; every one must be found exactly once."""
    for variable, value in variables.items():
        pattern = re.compile(rf'^\${re.escape(variable)}:[^;]*;', re.M)
        text, count = pattern.subn(f'${variable}: {value};'.replace('\\', r'\\'), text)
        if count != 1:
            raise BuildError(f'{name}: expected one ${variable}, found {count}')
    return text


def palette_scss(colors):
    lines = [f'$jade-{key}: {value};' for key, value in sorted(colors.items()) if str(value).startswith('#')]
    lines.append(f'$jade-accent_fg: {accent_foreground(colors)};')
    return '\n'.join(lines) + '\n'


# A light theme builds GNOME's light variant, whose shades run the other way:
# its "dark" end is the text and its "light" end the background. Its base
# (entries, cards) is a touch lighter than the background, as in GNOME's own.
LIGHT_COLORS = {
    '_default-colors.scss': {'_base_color_dark': '$jade-foreground', '_base_color_light': '$jade-background'},
    '_colors.scss': {'base_color': 'mix(#ffffff, $jade-background, 45%)'},
}


def base_colors(colors):
    if colors.get('mode') != 'light':
        return BASE_COLORS
    return {name: {**variables, **LIGHT_COLORS.get(name, {})} for name, variables in BASE_COLORS.items()}


def sources(colors, shell_version, into):
    """Write the patched sources into `into` and return the entry file."""
    base = version_dir(shell_version)
    shutil.copytree(base / 'gnome-shell-sass', into / 'gnome-shell-sass')
    for name, variables in base_colors(colors).items():
        path = into / 'gnome-shell-sass' / name
        path.write_text(point_at_palette(path.read_text(), variables, name))
    # The Shell's runtime accent is one of GNOME's nine named colors; the
    # theme's exact accent replaces it everywhere.
    for path in (into / 'gnome-shell-sass').rglob('*.scss'):
        text = path.read_text()
        if '-st-accent' in text:
            text = text.replace('-st-accent-fg-color', '$jade-accent_fg').replace('-st-accent-color', '$jade-accent')
            path.write_text(text)
    (into / '_jade-palette.scss').write_text(palette_scss(colors))
    shutil.copy(ROOT / 'jade.scss', into / '_jade.scss')
    entry = into / 'jade-shell.scss'
    entry.write_text(
        '// Generated by Jade Shell from the current theme; do not edit.\n'
        '@import "jade-palette";\n'
        + (base / f'gnome-shell-{"light" if colors.get("mode") == "light" else "dark"}.scss').read_text()
        + '\n@import "jade";\n')
    return entry


def python_sass():
    try:
        import sass
    except ImportError:
        return None
    return sass


def compiler_available():
    return bool(python_sass() or shutil.which('sassc'))


def compile_scss(entry):
    sass = python_sass()
    if sass:
        try:
            return sass.compile(filename=str(entry), output_style='expanded')
        except sass.CompileError as error:
            raise BuildError(str(error)) from error
    if not shutil.which('sassc'):
        raise BuildError('sassc is not installed')
    result = subprocess.run(['sassc', '-t', 'expanded', str(entry)], capture_output=True, text=True)
    if result.returncode:
        raise BuildError(result.stderr.strip())
    return result.stdout


def cache_dir():
    return pathlib.Path(os.environ.get('XDG_CACHE_HOME') or pathlib.Path.home() / '.cache') / 'jade-shell'


CACHED_BUILDS = 48


def build(colors, shell_version):
    """The compiled stylesheet, from the cache when this palette was built
    before with the same sources (switching back to a theme skips sassc)."""
    sources_stamp = [(str(p), p.stat().st_mtime_ns, p.stat().st_size)
                     for p in sorted([ROOT / 'jade.scss', *version_dir(shell_version).rglob('*')]) if p.is_file()]
    # The code that turns a palette into SCSS counts too (this module and
    # the palette's), whatever an upgrade did to the files' times.
    generator = hashlib.sha256(pathlib.Path(__file__).read_bytes() + pathlib.Path(pal.__file__).read_bytes()).hexdigest()
    key = hashlib.sha256(json.dumps([palette_scss(colors), colors.get('mode'), shell_version, sources_stamp, generator])
                         .encode()).hexdigest()[:32]
    folder = cache_dir() / 'shell-css'
    cached = folder / f'{key}.css'
    try:
        css = cached.read_text()
        os.utime(cached)  # recently used: pruned last
        return css
    except OSError:
        pass
    with tempfile.TemporaryDirectory(prefix='jade-shell-theme.') as tmp:
        css = compile_scss(sources(colors, shell_version, pathlib.Path(tmp)))
    try:
        folder.mkdir(parents=True, exist_ok=True)
        partial = folder / f'.{key}.{os.getpid()}'
        partial.write_text(css)
        os.replace(partial, cached)
        for old in sorted(folder.glob('*.css'), key=lambda f: f.stat().st_mtime, reverse=True)[CACHED_BUILDS:]:
            old.unlink(missing_ok=True)
    except OSError:
        pass  # a cache that can't be written only costs the next switch a compile
    return css


def installed_shell_version():
    """GNOME Shell's major version, remembered while the gnome-shell binary
    stays the same (starting it just to ask takes a noticeable moment)."""
    binary = shutil.which('gnome-shell')
    if not binary:
        return None
    info = os.stat(binary)
    stamp = [binary, info.st_mtime_ns, info.st_size]
    memo = cache_dir() / 'shell-version.json'
    try:
        saved = json.loads(memo.read_text())
        if saved.get('stamp') == stamp:
            return saved['version']
    except (OSError, ValueError, KeyError, AttributeError):
        pass
    try:
        out = subprocess.run([binary, '--version'], capture_output=True, text=True).stdout
    except OSError:
        return None
    match = re.search(r'(\d+)\.', out)
    version = int(match.group(1)) if match else None
    if version:
        try:
            memo.parent.mkdir(parents=True, exist_ok=True)
            memo.write_text(json.dumps({'stamp': stamp, 'version': version}))
        except OSError:
            pass
    return version


def available_versions():
    return sorted(int(p.name.split('-')[1]) for p in ROOT.glob('gnome-*') if p.is_dir())
