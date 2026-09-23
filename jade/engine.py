"""Plan, apply and undo a theme across every available target."""
import contextlib
import datetime
import fcntl
import json
import os
import pathlib
import shutil
import sys
from dataclasses import dataclass, field

from . import store, themes
from . import targets as registry
from .store import File, Setting, Settings, read_text, state_home, write_text
from .targets.base import Absent

KEEP = 30  # newest backups kept apart from the oldest; older ones are folded into it
# The apps a person asked Jade Shell to leave alone (`jade apps off`, or the settings window).
LEFT_ALONE = ('org.gnome.shell.extensions.jade-shell', 'left-alone')


@dataclass
class Context:
    settings: Settings
    theme: object = None
    wallpaper_index: int = 0
    wallpaper_error: str | None = None  # set when the wallpaper could not be downloaded
    skipped: dict = field(default_factory=dict)  # targets that failed or were refused, by name: why
    absent: dict = field(default_factory=dict)  # targets whose app isn't here, by name: why


class Busy(RuntimeError):
    pass


def state_dir():
    return state_home() / 'jade-shell'


@contextlib.contextmanager
def exclusive():
    """One theme change at a time: two at once would mix themes and history."""
    state_dir().mkdir(parents=True, exist_ok=True)
    with (state_dir() / 'lock').open('w') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise Busy('Another theme change is still running; try again in a moment') from None
        yield


def current():
    try:
        return json.loads((state_dir() / 'current.json').read_text())
    except (OSError, ValueError):
        return {}


def selected(only=None, skip=None):
    return [t for t in registry.ALL if (not only or t.name in only) and t.name not in (skip or ())]


def left_alone(settings):
    schema, key = LEFT_ALONE
    try:
        return frozenset(settings.get(schema).get_strv(key)) if settings.has(schema, key) else frozenset()
    except AttributeError:  # a stand-in without GSettings (tests)
        return frozenset()


def target_named(name):
    return next(t for t in registry.ALL if t.name == name)


def first_line(error):
    return str(error).splitlines()[0] if str(error) else type(error).__name__


def fetch_wallpaper(theme, ctx, only=None, skip=None):
    """Download the wallpaper before anything changes; offline, keep the current one."""
    if ctx.wallpaper_index is None or not any(t.name == 'gnome' for t in selected(only, skip)):
        return
    try:
        theme.fetch_wallpaper(ctx.wallpaper_index)
    except themes.WallpaperUnavailable as error:
        ctx.wallpaper_error = str(error)
        ctx.skipped['wallpaper'] = f'{error}; kept the current one'


def target_changes(target, theme, ctx):
    """The changes one target would make; raises if its config can't be handled."""
    out = []
    for change in target.changes(theme, ctx):
        if isinstance(change, Setting):
            if ctx.settings.differs(change):
                out.append(change)
        elif read_text(change.path) != change.content:
            reason = store.read_only_reason(change.path)
            if reason:
                raise PermissionError(reason)
            out.append(change)
    return out


def plan(theme, ctx, only=None, skip=None, fetch=False):
    """Every change that would alter something, grouped by target."""
    ctx.theme = theme
    alone = left_alone(ctx.settings)
    for name in alone & set(only or ()):
        ctx.skipped[name] = f'left alone (turn it back on with: jade apps on {name})'
    skip = set(skip or ()) | alone
    if fetch:
        fetch_wallpaper(theme, ctx, only, skip)
    result = []
    for target in selected(only, skip):
        reason = target.available(ctx)
        if reason:
            (ctx.absent if isinstance(reason, Absent) else ctx.skipped)[target.name] = reason
            continue
        try:
            changes = target_changes(target, theme, ctx)
        except Exception as error:  # one odd config must not block every other target
            ctx.skipped[target.name] = first_line(error)
            continue
        result += [(target, change) for change in changes]
    return result


def backup_order(path):
    # Jade Shell 0.9 named backups by local time (no 'T'); they all come first.
    name = path.name
    return (1, int(name.split('-')[0]), name) if 'T' in name else (0, 0, name)


def backups():
    folder = state_dir() / 'backups'
    if not folder.exists():
        return []
    # A dot folder is one being written (or set aside); only finished backups count.
    found = [p for p in folder.iterdir() if not p.name.startswith('.') and (p / 'manifest.json').is_file()]
    return sorted(found, key=backup_order)


def new_backup_name(history):
    # A sequence number, not the clock, keeps the order when the clock moves
    # back (daylight saving, a new timezone); the UTC time is for people.
    numbered = [backup_order(p)[1] for p in history if backup_order(p)[0]]
    stamp = datetime.datetime.now(datetime.UTC).strftime('%Y%m%dT%H%M%SZ')
    return f'{max(numbered, default=0) + 1:06d}-{stamp}'


def apply(theme, ctx, only=None, skip=None):
    changes = plan(theme, ctx, only, skip, fetch=True)
    if not changes:
        return changes, None  # nothing to change, so nothing to undo
    root = state_dir() / 'backups'
    root.mkdir(parents=True, exist_ok=True)
    os.chmod(root, 0o700)  # copies of the user's configs stay private
    for leftover in root.glob('.partial-*'):  # from a run that was killed; we hold the lock
        shutil.rmtree(leftover, ignore_errors=True)
    name = new_backup_name(backups())
    staging, backup = root / f'.partial-{name}', root / name
    manifest = {'before': current(), 'theme': theme.id, 'settings': [], 'files': [], 'targets': []}
    try:
        for target, change in changes:
            if target.name not in manifest['targets']:
                manifest['targets'].append(target.name)
            if isinstance(change, Setting):
                manifest['settings'].append({'schema': change.schema, 'path': change.path, 'key': change.key,
                                             'old': ctx.settings.user_value(change), 'target': target.name})
                continue
            old = store.read_bytes(change.path)
            saved = None
            if old is not None:
                saved = f'files/{len(manifest["files"])}'
                store.write_bytes(staging / saved, old, mode=change.path.stat().st_mode & 0o777)
            # What Jade wrote: undo only puts the old copy back while the file still holds this.
            manifest['files'].append({'path': str(change.path), 'saved': saved, 'target': target.name,
                                      'written': [store.digest(store.encode(change.content))]})
        write_text(staging / 'manifest.json', json.dumps(manifest, indent=2))
        os.replace(staging, backup)
    except BaseException:
        shutil.rmtree(staging, ignore_errors=True)
        raise

    ctx.settings.write([c for _t, c in changes if isinstance(c, Setting)])
    for _target, change in changes:
        if isinstance(change, File):
            write_text(change.path, change.content)
    wallpaper = current().get('wallpaper') if ctx.wallpaper_error else ctx.wallpaper_index
    write_text(state_dir() / 'current.json', json.dumps({'theme': theme.id, 'wallpaper': wallpaper}))
    reload(manifest['targets'], ctx)
    try:
        prune()
    except Exception as error:  # the switch is done; an extra old backup is harmless
        print(f'jade: could not tidy old backups: {first_line(error)}', file=sys.stderr)
    return changes, backup


def reload(names, ctx):
    for target in registry.ALL:
        if target.name in names:
            try:
                target.reload(ctx)
            except Exception as error:  # a reload hiccup must not undo a written theme
                ctx.skipped[target.name] = f'reload failed: {error}'


def load_manifest(backup):
    return json.loads((backup / 'manifest.json').read_text())


def fold(base, later):
    """Merge a backup into an older one, so undoing the older one alone still
    gives back what was there before both."""
    into, other = load_manifest(base), load_manifest(later)
    keys = {(e['schema'], e['path'], e['key']) for e in into['settings']}
    into['settings'] += [e for e in other['settings'] if (e['schema'], e['path'], e['key']) not in keys]
    into['targets'] += [t for t in other['targets'] if t not in into['targets']]
    files = {e['path']: e for e in into['files']}
    for entry in other['files']:
        mine = files.get(entry['path'])
        if mine is not None and mine.get('written') is None:
            continue  # a backup from before Jade Shell kept hashes: its copy wins, as it always did
        if mine is not None and entry.get('written') is not None:
            saved = store.read_bytes(later / entry['saved']) if entry['saved'] else None
            if store.digest(saved) in mine['written']:
                # Nothing touched the file between the two switches: accept either version as Jade's.
                mine['written'] += [h for h in entry['written'] if h not in mine['written']]
                continue
        # The older backup never saw this file, or it was edited in between:
        # keep the later copy, but with Jade Shell's part (from the older
        # switch) taken out when the target can, so the edit stays and the
        # original comes back on undo.
        copy = dict(entry)
        content = None
        if entry['saved']:
            source = later / entry['saved']
            content = source.read_bytes()
            if mine is not None and mine.get('written') is not None:
                merged = edited_between(into, mine, base, entry, source)
                if merged is not None:
                    content = store.encode(merged)
            n = len(into['files'])
            while (base / f'files/{n}').exists():
                n += 1
            copy['saved'] = f'files/{n}'
            store.write_bytes(base / copy['saved'], content, mode=source.stat().st_mode & 0o777)
        if mine is not None:
            into['files'][into['files'].index(mine)] = copy
        else:
            into['files'].append(copy)
        files[entry['path']] = copy
    write_text(base / 'manifest.json', json.dumps(into, indent=2))


def edited_between(manifest, mine, base, entry, source):
    """The file as the user left it between two switches, minus the older
    switch's part: the later backup's copy, reverted against the older one's."""
    later_text = read_text(source)
    older = read_text(base / mine['saved']) if mine['saved'] else None
    if later_text is None or (mine['saved'] and older is None):
        return None
    names = [mine['target']] if mine.get('target') else manifest['targets']
    for target in registry.ALL:
        if target.name in names and hasattr(target, 'revert'):
            try:
                text = target.revert(pathlib.Path(entry['path']), later_text, older)
            except Exception:  # a config it can't read: keep the later copy
                text = None
            if text is not None:
                return text
    return None


def prune():
    """Keep the oldest backup (the desktop before Jade Shell) and the KEEP newest."""
    history = backups()
    while len(history) > KEEP + 1:
        try:
            fold(history[0], history[1])
        except (OSError, ValueError, KeyError):
            return  # leave the history as it is rather than lose part of it
        shutil.rmtree(history[1])
        del history[1]


def set_aside(backup):
    """Move an unreadable backup out of the way, keeping it for a person to look at."""
    backup.rename(backup.with_name(f'.broken-{backup.name}'))


def targeted_revert(manifest, entry, path, backup):
    """A shared file edited since the switch, with only Jade Shell's part taken out.

    The target that wrote it does the work, from the file as it is now and the
    copy saved before the switch. None when that can't be done cleanly.
    """
    now = read_text(path)
    old = read_text(backup / entry['saved']) if entry['saved'] else None
    if now is None or (entry['saved'] and old is None):
        return None
    # Older backups don't name the target: ask each one that switch used.
    names = [entry['target']] if entry.get('target') else manifest['targets']
    for target in registry.ALL:
        if target.name in names and hasattr(target, 'revert'):
            try:
                text = target.revert(path, now, old)
            except Exception:  # a config it can't read: keep the file, as for any other
                text = None
            if text is not None:
                return text
    return None


def put_back(name, ctx):
    """Give one app back what it had before Jade Shell, across the whole undo
    history: each file and setting its target changed, as the earliest backup
    saved it ('restored'), or gone when Jade Shell made it ('removed'). A
    config edited since keeps the edits and loses only Jade
    Shell's part (listed in 'merged'), or is left as it is when that can't be
    done cleanly ('kept'). The history then forgets the app, so a later undo
    or restore leaves it alone too."""
    target = target_named(name)
    result = {'restored': [], 'removed': [], 'merged': [], 'kept': [], 'skipped': []}
    manifests = []
    for backup in backups():
        try:
            manifests.append((backup, load_manifest(backup)))
        except (OSError, ValueError):
            continue  # undo and restore report an unreadable backup
    first_files, last_files, first_settings = {}, {}, {}
    for backup, manifest in manifests:
        for entry in manifest['files']:
            if entry.get('target') == name:
                first_files.setdefault(entry['path'], (backup, entry))
                last_files[entry['path']] = entry
        for entry in manifest['settings']:
            if entry.get('target') == name:
                first_settings.setdefault((entry['schema'], entry['path'], entry['key']), entry)

    for key, (backup, first) in first_files.items():
        path = pathlib.Path(key)
        now = store.read_bytes(path)
        if now is None and first['saved'] is None:
            continue  # Jade Shell made it and it is gone already
        written = last_files[key].get('written') or []
        try:
            if store.digest(now) in written:
                if first['saved']:
                    store.write_bytes(path, (backup / first['saved']).read_bytes())
                    result['restored'].append(key)
                else:
                    path.unlink(missing_ok=True)
                    result['removed'].append(key)
                continue
            old = read_text(backup / first['saved']) if first['saved'] else None
            text = read_text(path)
            reverted = target.revert(path, text, old) if text is not None and hasattr(target, 'revert') else None
            if reverted is None:
                result['kept'].append(key)
            else:
                write_text(path, reverted)
                result['merged'].append(key)
        except OSError as error:
            result['skipped'].append(f'{path}: {error.strerror or error}')
    result['skipped'] += ctx.settings.restore_all(list(first_settings.values()))

    for backup, manifest in manifests:
        files = [e for e in manifest['files'] if e.get('target') != name]
        settings = [e for e in manifest['settings'] if e.get('target') != name]
        if (files, settings) == (manifest['files'], manifest['settings']):
            continue
        manifest['files'], manifest['settings'] = files, settings
        # Older backups don't name the target of each setting: the name stays there.
        if not any(e.get('target') in (name, None) for e in files + settings):
            manifest['targets'] = [t for t in manifest['targets'] if t != name]
        write_text(backup / 'manifest.json', json.dumps(manifest, indent=2))
    reload([name], ctx)
    return result


def undo(ctx, ignore=()):
    """Restore everything the most recent apply changed.

    A shared config edited since that apply keeps the edits and loses only Jade
    Shell's part (listed in 'merged'); a file where that can't be done cleanly
    is left as it is (listed in 'kept'), and a setting whose app is gone is
    skipped (listed in 'skipped'). Backups in `ignore` are passed over.
    """
    history = [b for b in backups() if b not in ignore]
    if not history:
        return None
    backup = history[-1]
    try:
        manifest = load_manifest(backup)
    except (OSError, ValueError):
        try:
            set_aside(backup)
        except OSError as error:  # left in place: the caller passes over it (as `stuck`) and goes on
            return {'before': {}, 'kept': [], 'stuck': backup,
                    'skipped': [f'{backup.name}: unreadable backup, could not set it aside ({error.strerror or error})']}
        return {'before': {}, 'kept': [], 'skipped': [f'{backup.name}: unreadable backup, set aside']}
    manifest['kept'], manifest['merged'] = [], []
    manifest['skipped'] = ctx.settings.restore_all(manifest['settings'])
    for entry in manifest['files']:
        path = pathlib.Path(entry['path'])
        written = entry.get('written')  # missing in backups made before Jade Shell kept hashes
        if written is not None and store.digest(store.read_bytes(path)) not in written:
            reverted = targeted_revert(manifest, entry, path, backup)
            if reverted is None:
                manifest['kept'].append(str(path))
                continue
            try:
                write_text(path, reverted)
                manifest['merged'].append(str(path))
            except OSError as error:
                manifest['skipped'].append(f'{path}: {error.strerror or error}')
            continue
        try:
            if entry['saved']:
                store.write_bytes(path, (backup / entry['saved']).read_bytes())
            else:
                path.unlink(missing_ok=True)
        except OSError as error:
            manifest['skipped'].append(f'{path}: {error.strerror or error}')
    before = manifest.get('before') or {}
    if before:
        write_text(state_dir() / 'current.json', json.dumps(before))
    else:
        (state_dir() / 'current.json').unlink(missing_ok=True)
    try:
        reload(manifest['targets'], ctx)
    finally:
        # Everything is back: the backup is spent, and keeping it would make the next undo repeat it.
        shutil.rmtree(backup)
    return manifest
