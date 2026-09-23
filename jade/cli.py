"""jade: Omarchy's look and theme switching for GNOME."""
import argparse
import json
import sys

from . import engine, setup, themes
from .store import File, Settings, read_text
from .usage import collect

SWATCH = ['background', 'foreground', 'accent', 'selection', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan']


def short(value, width=48):
    text = str(value)
    return text if len(text) <= width else text[:width - 1] + '…'


def plural(n, word):
    return f'{n} {word}{"" if n == 1 else "s"}'


def describe(ctx, change):
    if isinstance(change, File):
        old = read_text(change.path)
        if old is None:
            return f'create {change.path}'
        old_lines, new_lines = set(old.splitlines()), set(change.content.splitlines())
        return f'update {change.path} (+{len(new_lines - old_lines)} -{len(old_lines - new_lines)} lines)'
    where = f'{change.schema}{" " + change.path if change.path else ""} {change.key}'
    return f'{where}: {short(ctx.settings.current(change))} → {short(change.value)}'


def print_skipped(ctx):
    for name, reason in ctx.skipped.items():
        print(f'skipped {name}: {reason}')


# ------------------------------------------------------------------ theme

def theme_list(args, ctx):
    active = engine.current().get('theme')
    rows = []
    for theme_id in themes.ids():
        theme = themes.load(theme_id)
        thumbnail = themes.thumbnail_path(theme.id)
        rows.append({
            'id': theme.id, 'name': theme.name, 'current': theme.id == active,
            'colors': {k: theme.colors[k] for k in SWATCH},
            'wallpapers': len(theme.backgrounds),
            'thumbnail': str(thumbnail) if thumbnail.exists() else None,
        })
    if args.json:
        print(json.dumps(rows))
        return 0
    for row in rows:
        print(f"{'*' if row['current'] else ' '} {row['id']:14} {row['name']}")
    return 0


def theme_current(args, ctx):
    print(engine.current().get('theme') or 'none')
    return 0


def theme_plan(args, ctx):
    theme = themes.load(args.theme)
    ctx.wallpaper_index = args.wallpaper
    changes = engine.plan(theme, ctx, args.only, args.skip)
    by_target = {}
    for target, change in changes:
        by_target.setdefault(target, []).append(change)
    for target, group in by_target.items():
        print(f'{target.label} ({target.name}): {plural(len(group), "change")}')
        for change in group:
            print(f'    {describe(ctx, change)}')
    print_skipped(ctx)
    if not changes:
        print(f'{theme.name}: already applied')
    return 0


def theme_set(args, ctx):
    theme = themes.load(args.theme)
    ctx.wallpaper_index = args.wallpaper
    changes, _backup = engine.apply(theme, ctx, args.only, args.skip)
    print(f'{theme.name}: {plural(len(changes), "change")} applied (undo: jade theme undo)')
    print_skipped(ctx)
    return 0


def theme_wallpaper(args, ctx):
    state = engine.current()
    if not state.get('theme'):
        print('No theme applied yet', file=sys.stderr)
        return 1
    theme = themes.load(state['theme'])
    ctx.wallpaper_index = (state.get('wallpaper') or 0) + 1
    engine.apply(theme, ctx, only=['gnome'])
    print(theme.wallpaper(ctx.wallpaper_index).name)
    return 0


def theme_undo(args, ctx):
    manifest = engine.undo(ctx)
    if manifest is None:
        print('Nothing to undo', file=sys.stderr)
        return 1
    before = (manifest.get('before') or {}).get('theme') or 'your previous look'
    print(f'Restored {before}')
    return 0


def theme_reload(args, ctx):
    theme_id = engine.current().get('theme')
    if not theme_id:
        print('No theme applied yet', file=sys.stderr)
        return 1
    ctx.theme = themes.load(theme_id)
    engine.reload([t.name for t in engine.selected() if not t.available(ctx)], ctx)
    print(f'Reloaded {ctx.theme.name}')
    return 0


def theme_fetch(args, ctx):
    for theme_id in (themes.ids() if args.theme == 'all' else [args.theme]):
        theme = themes.load(theme_id)
        for index in range(len(theme.backgrounds) if args.every else 1):
            print(theme.fetch_wallpaper(index))
    return 0


def theme_thumbs(args, ctx):
    for theme_id in themes.ids():
        if args.refresh or not themes.thumbnail_path(theme_id).exists():
            print(themes.make_thumbnail(themes.load(theme_id)))
    return 0


# ------------------------------------------------------------------ usage

def usage_collect(args, ctx):
    return collect.collect_all(args.mode)


# ------------------------------------------------------------------ desktop

def run_setup(args, ctx):
    return setup.setup(ctx, theme_id=args.theme)


def run_doctor(args, ctx):
    return setup.doctor(ctx)


def run_restore(args, ctx):
    return setup.restore(ctx, assume_yes=args.yes)


def parser():
    top = argparse.ArgumentParser(prog='jade', description=__doc__)
    commands = top.add_subparsers(dest='command', required=True, metavar='command')

    theme = commands.add_parser('theme', help='list, preview and switch themes').add_subparsers(
        dest='action', required=True, metavar='action')
    theme.add_parser('list', help='list themes').add_argument('--json', action='store_true')
    theme.add_parser('current', help='print the applied theme')
    for name, text in [('plan', 'show what switching would change, without changing it'), ('set', 'switch to a theme')]:
        p = theme.add_parser(name, help=text)
        p.add_argument('theme', choices=themes.ids())
        p.add_argument('--wallpaper', type=int, default=0, help="which of the theme's wallpapers (default 0)")
        p.add_argument('--only', type=lambda s: s.split(','), help='comma-separated targets')
        p.add_argument('--skip', type=lambda s: s.split(','), help='comma-separated targets')
    theme.add_parser('wallpaper', help='next wallpaper of the current theme')
    theme.add_parser('undo', help='restore what the last switch changed')
    theme.add_parser('reload', help='ask every app to reload the current theme')
    fetch = theme.add_parser('fetch', help='download wallpapers')
    fetch.add_argument('theme', choices=themes.ids() + ['all'])
    fetch.add_argument('--every', action='store_true', help="all of a theme's wallpapers, not just the first")
    theme.add_parser('thumbs', help='make the picker previews').add_argument(
        '--refresh', action='store_true', help='rebuild previews that already exist')

    usage = commands.add_parser('usage', help='Claude and Codex usage').add_subparsers(
        dest='action', required=True, metavar='action')
    p = usage.add_parser('collect', help='collect usage for the top bar')
    mode = p.add_mutually_exclusive_group()
    mode.add_argument('--force', dest='mode', action='store_const', const='force', help='rescan and re-probe everything')
    mode.add_argument('--limits-only', dest='mode', action='store_const', const='limits-only',
                      help='re-probe limits, reuse recent scans')

    p = commands.add_parser('setup', help='set up this desktop for Jade Shell (safe to run again)')
    p.add_argument('--theme', choices=themes.ids(), default='osaka-jade', help='theme to start with')
    commands.add_parser('doctor', help='check that everything Jade Shell needs is in place')
    p = commands.add_parser('restore', help='put back the desktop you had before Jade Shell')
    p.add_argument('--yes', action='store_true', help="don't ask for confirmation")
    return top


HANDLERS = {
    ('theme', 'list'): theme_list, ('theme', 'current'): theme_current, ('theme', 'plan'): theme_plan,
    ('theme', 'set'): theme_set, ('theme', 'wallpaper'): theme_wallpaper, ('theme', 'undo'): theme_undo,
    ('theme', 'reload'): theme_reload, ('theme', 'fetch'): theme_fetch, ('theme', 'thumbs'): theme_thumbs,
    ('usage', 'collect'): usage_collect,
    ('setup', None): run_setup, ('doctor', None): run_doctor, ('restore', None): run_restore,
}


def main(argv=None):
    args = parser().parse_args(argv)
    handler = HANDLERS[args.command, getattr(args, 'action', None)]
    return handler(args, engine.Context(Settings()))
