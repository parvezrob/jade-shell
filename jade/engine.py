"""Plan, apply and undo a theme across every available target."""
import datetime
import json
import pathlib
import shutil
from dataclasses import dataclass, field

from . import targets as registry
from . import themes
from .store import File, Setting, Settings, read_text, state_home, write_text


@dataclass
class Context:
    settings: Settings
    theme: object = None
    wallpaper_index: int = 0
    skipped: dict = field(default_factory=dict)


def state_dir():
    return state_home() / 'jade-shell'


def current():
    try:
        return json.loads((state_dir() / 'current.json').read_text())
    except (OSError, ValueError):
        return {}


def selected(only=None, skip=None):
    return [t for t in registry.ALL if (not only or t.name in only) and t.name not in (skip or ())]


def plan(theme, ctx, only=None, skip=None):
    """Every change that would alter something, grouped by target."""
    ctx.theme = theme
    result = []
    for target in selected(only, skip):
        reason = target.available(ctx)
        if reason:
            ctx.skipped[target.name] = reason
            continue
        for change in target.changes(theme, ctx):
            if isinstance(change, Setting):
                if ctx.settings.differs(change):
                    result.append((target, change))
            elif read_text(change.path) != change.content:
                result.append((target, change))
    return result


def apply(theme, ctx, only=None, skip=None):
    changes = plan(theme, ctx, only, skip)
    if not changes:
        return changes, None  # nothing to change, so nothing to undo
    if ctx.wallpaper_index is not None:
        theme.fetch_wallpaper(ctx.wallpaper_index)
    backup = state_dir() / 'backups' / datetime.datetime.now().strftime('%Y%m%d-%H%M%S-%f')
    manifest = {'before': current(), 'theme': theme.id, 'settings': [], 'files': [], 'targets': []}
    for target, change in changes:
        if target.name not in manifest['targets']:
            manifest['targets'].append(target.name)
        if isinstance(change, Setting):
            manifest['settings'].append({'schema': change.schema, 'path': change.path, 'key': change.key,
                                         'old': ctx.settings.user_value(change)})
        else:
            old = read_text(change.path)
            saved = None
            if old is not None:
                saved = f'files/{len(manifest["files"])}'
                write_text(backup / saved, old)
            manifest['files'].append({'path': str(change.path), 'saved': saved})
    write_text(backup / 'manifest.json', json.dumps(manifest, indent=2))

    ctx.settings.write([c for _t, c in changes if isinstance(c, Setting)])
    for _target, change in changes:
        if isinstance(change, File):
            write_text(change.path, change.content)
    write_text(state_dir() / 'current.json', json.dumps({'theme': theme.id, 'wallpaper': ctx.wallpaper_index}))
    reload(manifest['targets'], ctx)
    return changes, backup


def reload(names, ctx):
    for target in registry.ALL:
        if target.name in names:
            try:
                target.reload(ctx)
            except Exception as error:  # a reload hiccup must not undo a written theme
                ctx.skipped[target.name] = f'reload failed: {error}'


def backups():
    folder = state_dir() / 'backups'
    return sorted(folder.iterdir()) if folder.exists() else []


def undo(ctx):
    """Restore everything the most recent apply changed."""
    history = backups()
    if not history:
        return None
    backup = history[-1]
    manifest = json.loads((backup / 'manifest.json').read_text())
    for entry in manifest['settings']:
        ctx.settings.restore(entry['schema'], entry['path'], entry['key'], entry['old'])
    for entry in manifest['files']:
        path = pathlib.Path(entry['path'])
        if entry['saved']:
            write_text(path, (backup / entry['saved']).read_text())
        else:
            path.unlink(missing_ok=True)
    before = manifest.get('before') or {}
    if before:
        write_text(state_dir() / 'current.json', json.dumps(before))
    else:
        (state_dir() / 'current.json').unlink(missing_ok=True)
    if before.get('theme'):
        ctx.theme = themes.load(before['theme'])
    reload(manifest['targets'], ctx)
    shutil.rmtree(backup)
    return manifest
