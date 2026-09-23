"""jade-theme: switch the desktop between Omarchy themes."""
import argparse
import json
import sys

from . import engine, themes
from .store import File, Settings, read_text

SWATCH = ['background', 'foreground', 'accent', 'selection', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan']


def short(value, width=48):
    text = str(value)
    return text if len(text) <= width else text[:width - 1] + '…'


def describe(ctx, target, change):
    if isinstance(change, File):
        old = read_text(change.path)
        if old is None:
            return f'create {change.path}'
        old_lines, new_lines = set(old.splitlines()), set(change.content.splitlines())
        return f'update {change.path} (+{len(new_lines - old_lines)} -{len(old_lines - new_lines)} lines)'
    where = f'{change.schema}{" " + change.path if change.path else ""} {change.key}'
    return f'{where}: {short(ctx.settings.current(change))} → {short(change.value)}'


def cmd_list(args, ctx):
    active = engine.current().get('theme')
    rows = []
    for theme_id in themes.ids():
        theme = themes.load(theme_id)
        wallpaper = theme.wallpaper(0)
        rows.append({
            'id': theme.id, 'name': theme.name, 'current': theme.id == active,
            'colors': {k: theme.colors[k] for k in SWATCH},
            'wallpaper': str(wallpaper) if wallpaper else None,
            'wallpaperReady': bool(wallpaper and wallpaper.exists()),
            'wallpapers': len(theme.backgrounds),
            'thumbnail': str(themes.thumbnail_path(theme.id)) if themes.thumbnail_path(theme.id).exists() else None,
        })
    if args.json:
        print(json.dumps(rows))
        return 0
    for row in rows:
        print(f"{'*' if row['current'] else ' '} {row['id']:14} {row['name']}")
    return 0


def cmd_plan(args, ctx):
    theme = themes.load(args.theme)
    ctx.wallpaper_index = args.wallpaper
    changes = engine.plan(theme, ctx, args.only, args.skip)
    by_target = {}
    for target, change in changes:
        by_target.setdefault(target, []).append(change)
    for target, group in by_target.items():
        print(f'{target.label} ({target.name}): {len(group)} change{"s" if len(group) != 1 else ""}')
        for change in group:
            print(f'    {describe(ctx, target, change)}')
    for name, reason in ctx.skipped.items():
        print(f'skipped {name}: {reason}')
    if not changes:
        print(f'{theme.name}: already applied')
    return 0


def cmd_set(args, ctx):
    theme = themes.load(args.theme)
    ctx.wallpaper_index = args.wallpaper
    changes, backup = engine.apply(theme, ctx, args.only, args.skip)
    print(f'{theme.name}: {len(changes)} change{"s" if len(changes) != 1 else ""} applied (undo: jade-theme undo)')
    for name, reason in ctx.skipped.items():
        print(f'skipped {name}: {reason}')
    return 0


def cmd_wallpaper(args, ctx):
    state = engine.current()
    if not state.get('theme'):
        print('No theme applied yet', file=sys.stderr)
        return 1
    theme = themes.load(state['theme'])
    ctx.wallpaper_index = (state.get('wallpaper') or 0) + 1
    engine.apply(theme, ctx, only=['gnome'])
    print(theme.wallpaper(ctx.wallpaper_index).name)
    return 0


def cmd_undo(args, ctx):
    manifest = engine.undo(ctx)
    if manifest is None:
        print('Nothing to undo', file=sys.stderr)
        return 1
    before = (manifest.get('before') or {}).get('theme') or 'your previous look'
    print(f'Restored {before}')
    return 0


def cmd_current(args, ctx):
    print(engine.current().get('theme') or 'none')
    return 0


def cmd_fetch(args, ctx):
    for theme_id in (themes.ids() if args.theme == 'all' else [args.theme]):
        theme = themes.load(theme_id)
        for index in range(len(theme.backgrounds) if args.every else 1):
            print(theme.fetch_wallpaper(index))
    return 0


def cmd_thumbs(args, ctx):
    for theme_id in themes.ids():
        if args.refresh or not themes.thumbnail_path(theme_id).exists():
            print(themes.make_thumbnail(themes.load(theme_id)))
    return 0


def main(argv=None):
    parser = argparse.ArgumentParser(prog='jade-theme', description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    sub.add_parser('list', help='list themes').add_argument('--json', action='store_true')
    sub.add_parser('current', help='print the applied theme')
    for name, text in [('plan', 'show what switching would change, without changing it'),
                       ('set', 'switch to a theme')]:
        p = sub.add_parser(name, help=text)
        p.add_argument('theme', choices=themes.ids())
        p.add_argument('--wallpaper', type=int, default=0, help='which of the theme\'s wallpapers (default 0)')
        p.add_argument('--only', type=lambda s: s.split(','), help='comma-separated targets')
        p.add_argument('--skip', type=lambda s: s.split(','), help='comma-separated targets')
    sub.add_parser('wallpaper', help='next wallpaper of the current theme')
    sub.add_parser('undo', help='restore what the last switch changed')
    fetch = sub.add_parser('fetch', help='download wallpapers')
    fetch.add_argument('theme', choices=themes.ids() + ['all'])
    fetch.add_argument('--every', action='store_true', help='all of a theme\'s wallpapers, not just the first')
    sub.add_parser('thumbs', help='download first wallpapers and make picker previews').add_argument(
        '--refresh', action='store_true', help='rebuild previews that already exist')
    args = parser.parse_args(argv)
    ctx = engine.Context(Settings())
    return globals()[f'cmd_{args.command}'](args, ctx)


if __name__ == '__main__':
    sys.exit(main())
