"""Mac-style app icons: MacTahoe, with its folders in the theme's accent.

Jade Shell's default look (`jade apps off icons`, or the switch in the
settings, puts GNOME's back). MacTahoe (vinceliuice/MacTahoe-icon-theme,
GPL-3.0) comes with the package, at a pinned release checked against its
SHA-256: only the parts of its release archive that the build reads
(PARTS), repacked when the package is built (a checkout without it
downloads the whole archive). Setup builds it into ~/.local/share/icons as
Jade-MacTahoe (for light themes) and Jade-MacTahoe-dark (light symbolic
icons, for dark ones). The build follows the theme's own install.sh (which
leaves stray cursor-only folders behind when a color is chosen, so it is
not run). Every theme switch then repaints the 18 folder icons in the
theme's exact accent: MacTahoe's blue folders are one flat color, with
their shading and glyphs in black and white on top.

The package's copy is about 3 MB; built, about 180 MB per person. Its
Finder and App Store icons are never installed: Jade draws its own Files
and Software.
"""
import contextlib
import errno
import hashlib
import http.client
import os
import pathlib
import re
import shutil
import subprocess
import tarfile
import urllib.error
import urllib.request

from . import reasons
from .store import data_home

try:  # the package's trimmed copy, whose checksum is written when the package is built
    from ._icons_sha import SHA256 as BUNDLED_SHA256
except ImportError:  # a checkout
    BUNDLED_SHA256 = None

TAG = '2026-09-10'
# The release as published: what a checkout downloads, and what the package's
# copy is made from.
URL = f'https://github.com/vinceliuice/MacTahoe-icon-theme/archive/refs/tags/{TAG}.tar.gz'
SHA256 = '6330369e9e10a28cfc8da598ebf63a7204be705403519963ff84e1cb84719d35'
NAME = 'Jade-MacTahoe'
FOLDER_BLUE = '#006efd'  # the one color of colors/color-blue's folders
SECTIONS = ['actions', 'animations', 'apps', 'categories', 'devices', 'emotes', 'emblems', 'mimes', 'places',
            'preferences']
STATUS_SIZES = ['16', '22', '24', '32', 'symbolic']
# What build() reads from the release, under its top folder, less its PNGs and
# JPGs: all the package ships of it (scripts/build-packages.sh).
PARTS = ('COPYING', 'AUTHORS', 'src/index.theme', *(f'src/{section}' for section in SECTIONS),
         *(f'src/status/{size}' for size in STATUS_SIZES), 'links', 'colors/color-blue')
# Free space the build needs at its peak: the unpacked parts and both themes,
# in small files that take more room on disk than their size.
SPACE = 300 << 20
FULL = 'your home folder is full'
# What a build leaves while it runs, named with its process: .<source>.<pid>
# and, when it downloads, .<source>.<pid>.tar.gz.
PARTIAL = re.compile(r'\.MacTahoe-icon-theme-.+\.(\d+)(\.tar\.gz)?')


class IconsUnavailable(Exception):
    """Its text is for people, `reason` the why of it in a few words;
    `detail`, the error behind it, is for the log."""

    def __init__(self, text, reason=None, detail=None):
        super().__init__(text)
        self.reason = reason or text  # a short text is its own reason
        self.detail = detail


def cache_home():
    return pathlib.Path(os.environ.get('XDG_CACHE_HOME') or pathlib.Path.home() / '.cache')


def icons_home():
    return data_home() / 'icons'


def theme_dirs():
    return [icons_home() / NAME, icons_home() / f'{NAME}-dark']


def installed():
    """Built from the pinned release (a new one is built again)."""
    stamp = icons_home() / NAME / '.jade-source'
    return all((d / 'index.theme').exists() for d in theme_dirs()) and stamp.exists() and stamp.read_text().strip() == TAG


def variant(colors):
    return NAME if colors.get('mode') == 'light' else f'{NAME}-dark'


def source_dir():
    """Where Jade Shell 0.9.0 unpacked the release, and kept it after a build
    that failed."""
    return cache_home() / 'jade-shell' / f'MacTahoe-icon-theme-{TAG}'


def bundled():
    """The package's copy of the release, beside the code (a checkout has none)."""
    return pathlib.Path(__file__).resolve().parent.parent / 'icons' / f'MacTahoe-jade-{TAG}.tar.xz'


def wanted(name):
    """Whether build() reads this member of the release archive."""
    path = name.partition('/')[2]
    return not path.endswith(('.png', '.jpg')) and any(path == part or path.startswith(f'{part}/') for part in PARTS)


def sha256(stream, out=None):
    digest = hashlib.sha256()
    while chunk := stream.read(1 << 20):
        digest.update(chunk)
        if out:
            out.write(chunk)
    return digest.hexdigest()


def release(work):
    """The pinned release's archive: the package's copy where it lies (checked,
    not copied), else downloaded beside `work` (a checkout, or a package copy
    that is damaged)."""
    try:
        with bundled().open('rb') as source:
            if BUNDLED_SHA256 and sha256(source) == BUNDLED_SHA256:
                return bundled()
    except OSError:
        pass
    archive = work.with_name(f'{work.name}.tar.gz')
    with urllib.request.urlopen(URL, timeout=30) as response, archive.open('wb') as out:
        if sha256(response, out) != SHA256:
            raise IconsUnavailable('the download was damaged')
    return archive


def only_wanted(member, _dest):
    """tarfile's filter: the archive is the pinned release, checked against its
    SHA-256, so the `data` filter's checks of where every path and link leads
    (half the time unpacking takes) add nothing. This keeps the rest of what
    it does, so the files come out the same."""
    if not wanted(member.name) or member.name.startswith('/') or '..' in member.name.split('/'):
        return None
    mode = None
    if member.isreg():
        mode = member.mode & 0o755 | 0o600
        if not mode & 0o100:
            mode &= ~0o111
    elif not (member.isdir() or member.issym()):
        return None
    return member.replace(mode=mode, linkname=os.path.normpath(member.linkname) if member.issym() else member.linkname,
                          uid=None, gid=None, uname=None, gname=None, deep=False)


def unpack(archive, work):
    """The parts of the release build() reads, unpacked into `work`: its top folder."""
    with tarfile.open(archive) as tar:
        tar.extractall(work, filter=only_wanted)
    return next(work.iterdir())


def alive(pid):
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:  # someone else's
        pass
    return True


def remove_orphans():
    """What a build that was stopped (Ctrl-C, a closed window) left behind.
    Never fails: restore runs this, and a leftover must not stop it."""
    for folder in (icons_home(), cache_home() / 'jade-shell'):  # 0.9.0 unpacked into the cache
        with contextlib.suppress(OSError):
            for path in list(folder.glob('.MacTahoe-icon-theme-*')):
                match = PARTIAL.fullmatch(path.name)
                with contextlib.suppress(OSError, OverflowError):  # a number too big for a pid
                    if match and not alive(int(match.group(1))):
                        if path.is_dir() and not path.is_symlink():
                            shutil.rmtree(path, ignore_errors=True)
                        else:
                            path.unlink(missing_ok=True)


def reason(error):
    """An error while building, in plain words."""
    if error.errno in (errno.ENOSPC, errno.EDQUOT):
        return FULL
    if isinstance(error, (urllib.error.HTTPError, ConnectionError)):  # a server error, or cut off midway
        return "the download didn't work"
    if isinstance(error, (urllib.error.URLError, TimeoutError)):
        return 'no internet connection right now'
    return (error.strerror or str(error)).lower()


def merge(src, dst):
    """cp -r src/. dst: files and symlinks replace what is there."""
    for root, dirs, files in os.walk(src):
        rel = pathlib.Path(root).relative_to(src)
        (dst / rel).mkdir(parents=True, exist_ok=True)
        for name in dirs + files:
            source, target = pathlib.Path(root) / name, dst / rel / name
            if source.is_symlink():
                if target.is_symlink() or target.is_file():
                    target.unlink()
                elif target.is_dir():
                    shutil.rmtree(target)
                target.symlink_to(os.readlink(source))
                if name in dirs:
                    dirs.remove(name)
            elif name in files:
                if target.is_symlink():
                    target.unlink()
                shutil.copyfile(source, target)


def recolor(files, old, new):
    for path in files:
        if path.is_file() and not path.is_symlink():
            text = path.read_text(errors='replace')
            if old in text:
                path.write_text(text.replace(old, new))


def svgs(folder, sizes):
    return [path for size in sizes for path in (folder / size).glob('*.svg')]


def build(src):
    """Jade-MacTahoe and Jade-MacTahoe-dark from the unpacked release (on the
    same disk), which this uses up: the dark variant's own files are copied
    first, then the light one's are moved into place, not copied again."""
    home = icons_home()
    base, dark = home / NAME, home / f'{NAME}-dark'
    for folder in (base, dark):
        shutil.rmtree(folder, ignore_errors=True)
        folder.mkdir(parents=True)
        for name in ('COPYING', 'AUTHORS'):
            shutil.copyfile(src / name, folder / name)
        (folder / 'index.theme').write_text((src / 'src/index.theme').read_text().replace('MacTahoe', folder.name))
    # The outline of MacTahoe's app tiles, for Jade's Software icon.
    plate = re.search(r'<path fill="url\(#d\)" d="([^"]+)"', (src / 'src/apps/scalable/softwarecenter.svg').read_text())

    # The dark variant: its own light symbolic and small icons, the rest shared.
    parts = {'actions': None, 'apps': ['16', '22', '32', 'symbolic'], 'categories': ['22', 'symbolic'],
             'emblems': ['symbolic'], 'mimes': ['symbolic'], 'devices': ['16', '22', '24', '32', 'symbolic'],
             'places': ['16', '22', '24', 'scalable', 'symbolic'], 'status': ['symbolic']}
    for section, sizes in parts.items():
        if sizes is None:
            merge(src / 'src' / section, dark / section)
        else:
            for size in sizes:
                merge(src / 'src' / section / size, dark / section / size)
    # MacTahoe's dark variant swaps in a dark trash can; a Mac keeps the light
    # one in dark mode too, and so does Jade's dock.
    for name in ('user-trash-dark.svg', 'user-trash-full-dark.svg'):
        (dark / 'places/scalable' / name).unlink(missing_ok=True)
    recolor(svgs(dark, [f'{s}/{n}' for s in ('actions', 'devices', 'places') for n in ('16', '22', '24')])
            + svgs(dark, ['apps/16', 'apps/22', 'apps/32', 'categories/22', 'actions/32', 'devices/32'])
            + svgs(dark, [f'{s}/symbolic' for s in ('actions', 'apps', 'categories', 'emblems', 'devices', 'mimes',
                                                   'places', 'status')]),
            '#363636', '#dedede')
    for section, sizes in (('actions', ['16', '22', '24', '32', 'symbolic']),
                           ('devices', ['16', '22', '24', '32', 'symbolic']),
                           ('places', ['16', '22', '24', 'scalable', 'symbolic']),
                           ('apps', ['16', '22', '32', 'symbolic']), ('categories', ['22', 'symbolic']),
                           ('mimes', ['symbolic']), ('status', ['symbolic'])):
        for size in sizes:
            if (src / 'links' / section / size).exists():
                merge(src / 'links' / section / size, dark / section / size)
    for section in ('animations', 'emotes', 'preferences'):
        (dark / section).symlink_to(f'../{NAME}/{section}')
    for section, size in (('categories', '32'), ('emblems', '16'), ('emblems', '22'), ('emblems', '24'),
                          ('mimes', '16'), ('mimes', '22'), ('mimes', 'scalable'), ('apps', 'scalable'),
                          ('devices', 'scalable'), ('status', '16'), ('status', '22'), ('status', '24'),
                          ('status', '32')):
        (dark / section).mkdir(exist_ok=True)
        (dark / section / size).symlink_to(f'../../{NAME}/{section}/{size}')

    # The light variant: MacTahoe's own.
    for section in SECTIONS:
        (src / 'src' / section).rename(base / section)
    (base / 'status').mkdir()
    for size in STATUS_SIZES:
        (src / 'src/status' / size).rename(base / 'status' / size)
    for name in ('user-trash-dark.svg', 'user-trash-full-dark.svg'):
        (base / 'places/scalable' / name).unlink(missing_ok=True)
    for section in [*SECTIONS, 'status']:
        if (src / 'links' / section).exists():
            merge(src / 'links' / section, base / section)

    for folder in (base, dark):
        for section in [*SECTIONS, 'status']:
            link = folder / f'{section}@2x'
            if not link.exists():
                link.symlink_to(section)
    # The folders to repaint at each theme switch, kept with the theme, and
    # the outline of the app tiles.
    (src / 'colors/color-blue').rename(base / '.jade-folders')
    if plate:
        (base / '.jade-folders/plate.txt').write_text(plate.group(1))
    (base / '.jade-source').write_text(TAG + '\n')
    update_cache()


def folder_icons(accent):
    """The folder icons in `accent`: {file name: SVG text}."""
    src = icons_home() / NAME / '.jade-folders'
    if not src.exists():
        return {}
    return {path.name: path.read_text().replace(FOLDER_BLUE, accent.lower()) for path in sorted(src.glob('*.svg'))}


# MacTahoe draws Files as Finder and Software as the App Store: Apple's own
# marks, which make the whole desktop look like a knock-off. Jade draws those
# two itself: Files as the theme's folder, Software as a tile in the accent
# with a shopping bag (GNOME Software's own symbol), on MacTahoe's tile.
OWN_APPS = {'file-manager.svg': 'files', 'softwarecenter.svg': 'software'}


def mix(color, toward, amount):
    a = [int(color.lstrip('#')[i:i + 2], 16) for i in (0, 2, 4)]
    b = [int(toward.lstrip('#')[i:i + 2], 16) for i in (0, 2, 4)]
    return '#' + ''.join(f'{round(x + (y - x) * amount):02x}' for x, y in zip(a, b, strict=True))


def software_icon(accent):
    plate_file = icons_home() / NAME / '.jade-folders/plate.txt'
    if not plate_file.exists():
        return None
    top, bottom = mix(accent, '#ffffff', 0.28), mix(accent, '#000000', 0.12)
    return f'''<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 16.933 16.933">
<defs><linearGradient id="t" x1="8.466" x2="8.466" y1="1.058" y2="15.875" gradientUnits="userSpaceOnUse">
<stop offset="0" stop-color="{top}"/><stop offset="1" stop-color="{bottom}"/></linearGradient>
<linearGradient id="s" x1="8.466" x2="8.466" y1="1.058" y2="8.466" gradientUnits="userSpaceOnUse">
<stop offset="0" stop-color="#fff" stop-opacity=".22"/>
<stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient></defs>
<path fill="url(#t)" d="{plate_file.read_text()}"/>
<path fill="url(#s)" d="{plate_file.read_text()}"/>
<g fill="none" stroke="#fff" stroke-width=".62" stroke-linecap="round">
<path d="M6.95 6.9V5.95a1.52 1.52 0 0 1 3.04 0v.95"/></g>
<path fill="#fff" d="M4.93 6.3h7.07c.3 0 .55.23.58.53l.5 5.35c.08.83-.57 1.55-1.4 1.55H5.25
c-.83 0-1.48-.72-1.4-1.55l.5-5.35c.03-.3.28-.53.58-.53z"/>
<path fill="none" stroke="{bottom}" stroke-width=".6" stroke-linecap="round" d="M6.95 8.6a1.52 1.52 0 0 0 3.04 0"/>
</svg>
'''


def own_app_icons(accent, folders):
    """{file name under apps/scalable: SVG text} for the apps Jade draws."""
    out = {}
    if 'folder.svg' in folders:
        out['file-manager.svg'] = folders['folder.svg']
    software = software_icon(accent)
    if software:
        out['softwarecenter.svg'] = software
    return out


def update_cache(wait=True):
    """Tell GTK and GNOME Shell the icons changed: a theme folder that is newer
    makes them look again (and ignore the old icon cache), and the cache is
    then rebuilt, in the background unless `wait` (0.7 s, not worth holding a
    theme switch for)."""
    folders = [str(folder) for folder in theme_dirs() if folder.exists()]
    for folder in folders:
        os.utime(folder)
    tool = shutil.which('gtk-update-icon-cache') or shutil.which('gtk4-update-icon-cache')
    if not tool or not folders:
        return
    script = '; '.join(f'"$0" -f -q -t "${i + 1}"' for i in range(len(folders)))
    process = subprocess.Popen(['sh', '-c', script, tool, *folders], stdout=subprocess.DEVNULL,
                               stderr=subprocess.DEVNULL, start_new_session=True)
    if wait:
        process.wait()


def install(progress=lambda _text: None):
    """Build the icons, unless the pinned release is built already. One that
    fails, or is stopped, leaves nothing half-built behind."""
    if installed():
        return False
    progress('Preparing the Mac-style icons')
    home = icons_home()
    work = home / f'.MacTahoe-icon-theme-{TAG}.{os.getpid()}'  # beside the themes: moved into them, not copied
    building = False
    try:
        home.mkdir(parents=True, exist_ok=True)
        remove_orphans()
        shutil.rmtree(source_dir(), ignore_errors=True)
        if shutil.disk_usage(home).free < SPACE:
            raise IconsUnavailable(FULL)
        shutil.rmtree(work, ignore_errors=True)
        work.mkdir()
        src = unpack(release(work), work)
        building = True
        build(src)
    except BaseException as error:
        if building:
            for folder in theme_dirs():
                shutil.rmtree(folder, ignore_errors=True)
        if isinstance(error, OSError):
            raise IconsUnavailable(reason(error)) from None
        if isinstance(error, http.client.HTTPException):  # a download cut short
            raise IconsUnavailable("the download didn't work") from None
        raise
    finally:
        shutil.rmtree(work, ignore_errors=True)
        work.with_name(f'{work.name}.tar.gz').unlink(missing_ok=True)
    return True


def remove():
    for folder in theme_dirs():
        shutil.rmtree(folder, ignore_errors=True)
    shutil.rmtree(source_dir(), ignore_errors=True)
    remove_orphans()
