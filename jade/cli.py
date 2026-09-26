"""jade: Omarchy's look and theme switching for GNOME."""
import argparse
import contextlib
import json
import pathlib
import re
import subprocess
import sys

import gi

gi.require_version('Gio', '2.0')
from gi.repository import Gio

from . import __version__, community, debug, engine, icons, keys, network, setup, themes, update
from . import targets as registry
from .setup import join
from .store import File, Settings, read_text
from .targets import font as font_target
from .targets.base import Absent
from .usage import collect

TARGETS = [t.name for t in registry.ALL]

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


def print_skipped(ctx, only=None):
    """Targets that failed; an app that isn't installed only when asked for by name."""
    asked = {name: reason for name, reason in ctx.absent.items() if name in (only or ())}
    for name, reason in {**ctx.skipped, **asked}.items():
        print(f'skipped {name}: {reason}')
    for failure in ctx.hook_failures:
        print(failure, file=sys.stderr)


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
            # Changes when the preview is made again at the same path (a theme update).
            'thumbnail_revision': thumbnail.stat().st_mtime_ns if thumbnail.exists() else None,
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


def wallpaper_for(theme_id, asked):
    """The wallpaper a switch uses: the one asked for, else the one this theme
    had last time (the picker's "next wallpaper" is `theme wallpaper`)."""
    if asked is not None:
        return asked
    state = engine.current()
    if state.get('theme') == theme_id:
        return state.get('wallpaper') or 0
    return engine.remembered_wallpaper(theme_id)


def theme_plan(args, ctx):
    theme = themes.load(args.theme)
    ctx.wallpaper_index = wallpaper_for(theme.id, args.wallpaper)
    changes = engine.plan(theme, ctx, args.only, args.skip)
    by_target = {}
    for target, change in changes:
        by_target.setdefault(target, []).append(change)
    for target, group in by_target.items():
        print(f'{target.label} ({target.name}): {plural(len(group), "change")}')
        for change in group:
            print(f'    {describe(ctx, change)}')
    print_skipped(ctx, args.only)
    if not changes:
        print(f'{theme.name}: already applied')
    return 0


def theme_set(args, ctx):
    theme = themes.load(args.theme)
    ctx.wallpaper_index = wallpaper_for(theme.id, args.wallpaper)
    changes, backup = engine.apply(theme, ctx, args.only, args.skip)
    if backup is None:  # no backup was made, so `undo` would revert an older switch
        print(f'{theme.name}: already applied')
    else:
        print(f'{theme.name}: {plural(len(changes), "change")} applied (undo: jade theme undo)')
    print_skipped(ctx, args.only)
    return 0


def theme_wallpaper(args, ctx):
    state = engine.current()
    if not state.get('theme'):
        print('No theme applied yet', file=sys.stderr)
        return 1
    theme = themes.load(state['theme'])
    ctx.wallpaper_index = (state.get('wallpaper') or 0) + 1
    engine.apply(theme, ctx, only=['gnome'])
    if 'gnome' in ctx.skipped:
        print(f'Wallpaper not changed: GNOME is {ctx.skipped["gnome"]}', file=sys.stderr)
        return 1
    if ctx.wallpaper_error:  # the picker shows this line
        print(f'Wallpaper not changed: {ctx.wallpaper_error}', file=sys.stderr)
        return 1
    print(theme.wallpaper(ctx.wallpaper_index).name)
    return 0


def theme_undo(args, ctx):
    manifest = engine.undo(ctx)
    if manifest is None:
        print('Nothing to undo', file=sys.stderr)
        return 1
    before = (manifest.get('before') or {}).get('theme') or 'your previous look'
    print(f'Restored {before}')
    for path in manifest.get('merged', []):
        print(f"Took Jade Shell's part out of {path}; your edits since stay")
    for path in manifest['kept']:
        print(f'Kept {path}: it changed after the switch, so it was left as it is')
    for item in manifest['skipped']:
        print(f'Skipped {item}')
    if manifest.get('incomplete'):
        print('Some files could not be put back; their saved copies are kept. '
              'Fix what stopped them and run jade theme undo again.', file=sys.stderr)
        return 1
    return 0


def theme_reload(args, ctx):
    theme_id = engine.current().get('theme')
    if not theme_id:
        print('No theme applied yet', file=sys.stderr)
        return 1
    ctx.theme = themes.load(theme_id)
    names = [t.name for t in engine.selected(skip=engine.left_alone(ctx.settings)) if not t.available(ctx)]
    engine.reload(names, ctx)
    print(f'Reloaded {ctx.theme.name}')
    return 0


def theme_fetch(args, ctx):
    for theme_id in (themes.ids() if args.theme == 'all' else [args.theme]):
        theme = themes.load(theme_id)
        for index in range(len(theme.backgrounds) if args.every else 1):
            print(theme.fetch_wallpaper(index))
    return 0


def theme_thumbs(args, ctx):
    wanted = [themes.load(t) for t in themes.ids() if args.refresh or not themes.thumbnail_path(t).exists()]
    # A community theme with no pictures at all has nothing to preview: the picker shows its colors.
    wanted = [theme for theme in wanted if theme.backgrounds or theme.preview or not theme.community]
    # Those whose wallpaper is here first; after one download fails (offline),
    # the rest would only wait through the same retries.
    def here(theme):
        picture = theme.wallpaper(0) or theme.preview
        return bool(picture and picture.exists())

    wanted.sort(key=lambda theme: not here(theme))
    failed = None
    for theme in wanted:
        if failed and not here(theme):
            continue
        try:
            print(themes.make_thumbnail(theme))
        except themes.WallpaperUnavailable as error:
            failed = error
    if failed:
        print(f'jade: {failed}', file=sys.stderr)
    return 1 if failed else 0


def refresh_thumbnail(theme):
    try:
        themes.make_thumbnail(theme)
    except Exception:  # a broken or missing picture is not worth failing over: the picker shows its colors
        themes.thumbnail_path(theme.id).unlink(missing_ok=True)


def theme_install(args, ctx):
    try:
        tid = community.install(args.url, args.name, reserved=themes.builtin_ids())
    except community.ThemeError as error:
        print(f'jade: {error}', file=sys.stderr)
        return 1
    theme = themes.load(tid)
    refresh_thumbnail(theme)
    print(f'Installed {theme.name} ({plural(len(theme.backgrounds), "wallpaper")}): only its colors, wallpapers and '
          f'preview were kept. Pick it in the theme picker, or: jade theme set {tid}')
    return 0


def theme_update(args, ctx):
    names = args.names or community.installed()
    if not names:
        print('No community themes installed; add one with: jade theme install <git-url>')
        return 0
    active, failed = engine.current().get('theme'), 0
    for name in names:
        try:
            community.update(name)
        except community.ThemeError as error:
            print(f'jade: {name}: {error}', file=sys.stderr)
            failed += 1
            continue
        theme = themes.load(name)
        refresh_thumbnail(theme)
        print(f'Updated {theme.name}.' + (f' Apply its new colors with: jade theme set {name}' if name == active else ''))
    return 1 if failed else 0


def theme_remove(args, ctx):
    if args.name == engine.current().get('theme'):
        print(f'jade: {args.name} is the current theme; switch to another one first', file=sys.stderr)
        return 1
    try:
        community.remove(args.name)
    except community.ThemeError as error:
        print(f'jade: {error}', file=sys.stderr)
        return 1
    themes.thumbnail_path(args.name).unlink(missing_ok=True)
    print(f'Removed {args.name}.')
    return 0


# ------------------------------------------------------------------ apps

def apps_list(args, ctx):
    alone = engine.left_alone(ctx.settings)
    rows = []
    for target in registry.ALL:
        reason = target.available(ctx)
        rows.append({'name': target.name, 'title': target.title, 'label': target.label,
                     'left_alone': target.name in alone, 'installed': not isinstance(reason, Absent),
                     'problem': None if reason is None or isinstance(reason, Absent) else str(reason),
                     'note': str(reason) if reason else None})
    if getattr(args, 'json', False):
        print(json.dumps(rows))
        return 0
    for row in rows:
        state = 'left alone' if row['left_alone'] else 'themed' if not row['note'] else row['note']
        print(f"{row['name']:9} {row['label']:44} {state}")
    print('\nLeave an app alone with: jade apps off NAME (its own config comes back). Theme it again with: jade apps on NAME')
    return 0


def set_left_alone(ctx, names, alone):
    schema, key = engine.LEFT_ALONE
    if not ctx.settings.has(schema, key):
        print("jade: Jade Shell's settings are not installed; reinstall Jade Shell", file=sys.stderr)
        return False
    settings = ctx.settings.get(schema)
    now = settings.get_strv(key)
    wanted = [*now, *(n for n in dict.fromkeys(names) if n not in now)] if alone else [n for n in now if n not in names]
    settings.set_strv(key, wanted)
    Gio.Settings.sync()
    return True


def apps_off(args, ctx):
    if not set_left_alone(ctx, args.names, alone=True):
        return 1
    home = str(pathlib.Path.home())

    def short_paths(paths):
        return join([path.replace(home, '~', 1) for path in paths])

    for name in dict.fromkeys(args.names):
        result = engine.put_back(name, ctx)
        done = ([f'put back {short_paths(result["restored"])}'] if result['restored'] else []) \
            + ([f"took Jade Shell's part out of {short_paths(result['merged'])} (your edits since stay)"]
               if result['merged'] else []) \
            + ([f'removed {short_paths(result["removed"])}'] if result['removed'] else [])
        print(f'Jade Shell leaves {engine.target_named(name).title} alone now'
              + (f': {"; ".join(done)}.' if done else '.'))
        for path in result['kept']:
            print(f'  Kept {short_paths([path])}: it changed since Jade Shell wrote it, so it was left as it is.')
        for item in result['skipped']:
            print(f'  Skipped {item}')
    return 0


def apps_on(args, ctx):
    if not set_left_alone(ctx, args.names, alone=False):
        return 1
    if 'icons' in args.names:
        try:
            icons.install(lambda text: text and print(text))
        except icons.IconsUnavailable as error:
            print(f"The Mac-style icons couldn't be set up ({error}).", file=sys.stderr)
            return 1
    state = engine.current()
    titles = join([engine.target_named(n).title for n in dict.fromkeys(args.names)])
    if not state.get('theme'):
        print(f'Jade Shell themes {titles} again from the next theme you pick.')
        return 0
    theme = themes.load(state['theme'])
    ctx.wallpaper_index = state.get('wallpaper') or 0
    only = list(args.names)
    # A terminal back on gets its font file with its include, in one switch.
    if font_target.chosen() and set(only) & {'kitty', 'ghostty', 'ptyxis'}:
        only.append('font')
    engine.apply(theme, ctx, only=only)
    print(f'{theme.name} applied to {titles}.')
    print_skipped(ctx, args.names)
    return 0


# ------------------------------------------------------------------ keys

def keys_list(args, ctx):
    if getattr(args, 'json', False):
        print(json.dumps({'applied': keys.applied(), 'keys': [{'keys': k, 'what': w} for k, w in keys.rows(ctx)]}))
        return 0
    print('The Omarchy keymap is on.' if keys.applied() else 'The Omarchy keymap is off; turn it on with: jade keys apply')
    width = max(len(k) for k, _w in keys.rows(ctx))
    for combo, what in keys.rows(ctx):
        print(f'  {combo.ljust(width)}  {what}')
    return 0


def keys_apply(args, ctx):
    changes = keys.apply(ctx)
    print(f'The Omarchy keymap is on ({plural(len(changes), "shortcut")} changed). '
          'Super+K shows every key; jade keys revert puts yours back.')
    return 0


def keys_revert(args, ctx):
    skipped = keys.revert(ctx)
    if skipped is None:
        print('The Omarchy keymap is not on: nothing to put back.')
        return 0
    print('Your shortcuts are back as they were.')
    for item in skipped:
        print(f'  Skipped {item}')
    return 0


# ------------------------------------------------------------------ network

def network_status(args, ctx):
    try:
        info = network.status()
    except network.NetworkError as error:
        print(f'jade: {error}', file=sys.stderr)
        return 1
    info['last_speedtest'] = network.last_speedtest()
    if args.json:
        print(json.dumps(info))
        return 0
    if not info['connected']:
        print('Not connected.')
        return 0
    name = info.get('ssid') or info.get('connection') or info['device']
    band = f", {info['band']} GHz, signal {info['signal']}%" if info.get('band') else ''
    print(f"{name} ({info['type']} on {info['device']}{band})")
    print(f"  Address {info['address'] or '-'}, router {info['gateway'] or '-'}")
    print(f"  Ping: router {info['ping_router'] or '-'} ms, internet {info['ping_internet'] or '-'} ms")
    print(f"  DNS: {info.get('dns', 'auto')} ({', '.join(info['dns_servers']) or '-'})")
    if info['last_speedtest']:
        last = info['last_speedtest']
        print(f"  Last speed test: {last['down']} Mbps down, {last['up']} Mbps up, {last['ping']} ms")
    return 0


def network_speedtest(args, ctx):
    def emit(event):
        if args.json:
            print(json.dumps(event), flush=True)
        elif event['phase'] == 'ping':
            print(f"Ping {event['ms']} ms (jitter {event['jitter']} ms) to Cloudflare {event['server'] or ''}".rstrip())
        elif event['phase'] in ('down', 'up'):
            label = 'Download' if event['phase'] == 'down' else 'Upload'
            print(f"\r{label}: {event['mbps']:>8.1f} Mbps", end='', flush=True)
            if event['progress'] >= 1:
                print()
        elif event['phase'] == 'done':
            print(f"Download {event['down']} Mbps, upload {event['up']} Mbps, ping {event['ping']} ms.")

    try:
        network.speedtest(emit)
    except network.NetworkError as error:
        print(json.dumps({'phase': 'error', 'message': str(error)}) if args.json else f'jade: {error}',
              file=sys.stdout if args.json else sys.stderr)
        return 1
    return 0


def network_qr(args, ctx):
    try:
        qr = network.wifi_qr()
    except network.NetworkError as error:
        print(f'jade: {error}', file=sys.stderr)
        return 1
    if args.json:
        print(json.dumps(qr))
        return 0
    # Two rows per line with half blocks, framed by a quiet zone phones need.
    rows = ['0' * len(qr['matrix'][0])] * 2 + qr['matrix'] + ['0' * len(qr['matrix'][0])] * 3
    for top, bottom in zip(rows[::2], rows[1::2], strict=False):
        cells = zip('00' + top + '00', '00' + bottom + '00', strict=True)
        print('  ' + ''.join(' ▄▀█'[(t == '0') * 2 + (b == '0')] for t, b in cells))
    print(f"  Scan to join {qr['ssid']}")
    return 0


def network_dns(args, ctx):
    try:
        if not args.choice:
            print(network.status(latency=False).get('dns', 'auto'))
            return 0
        network.set_dns(' '.join(args.choice))
    except network.NetworkError as error:
        print(f'jade: {error}', file=sys.stderr)
        return 1
    print(f"DNS set to {' '.join(args.choice)}. jade restore puts the old setting back.")
    return 0


def network_band(args, ctx):
    try:
        if not args.choice:
            info = network.status(latency=False)
            print(f"{info.get('band') or '-'} GHz now; pinned: {info.get('band_pin', 'auto')}")
            return 0
        network.set_band(args.choice)
    except network.NetworkError as error:
        print(f'jade: {error}', file=sys.stderr)
        return 1
    print(f'Wi-Fi band: {args.choice}.')
    return 0


# ------------------------------------------------------------------ font

def monospace_families():
    """Installed monospace font families, by fontconfig."""
    try:
        out = subprocess.run(['fc-list', ':spacing=100', 'family'], capture_output=True, text=True, timeout=20).stdout
    except (OSError, subprocess.TimeoutExpired):
        return []
    names = {line.split(',')[0].strip() for line in out.splitlines() if line.strip()}
    return sorted(name for name in names if 'Emoji' not in name)


def current_font(ctx):
    value = ctx.settings.get('org.gnome.desktop.interface').get_string('monospace-font-name')
    return re.sub(r'\s+\d+(\.\d+)?$', '', value)


def font_list(args, ctx):
    families = monospace_families()
    current = current_font(ctx)
    if getattr(args, 'json', False):
        print(json.dumps({'families': families, 'current': current}))
        return 0
    for family in families:
        print(f'{"*" if family == current else " "} {family}')
    if not any('Nerd Font' in family and 'Symbols' not in family for family in families):
        print('\nPrompts and bars that draw icons (Starship, for one) want a Nerd Font, such as '
              'JetBrainsMono Nerd Font: https://www.nerdfonts.com/font-downloads')
    return 0


FONT_TARGETS = ['font', 'kitty', 'ghostty', 'alacritty']


def font_set(args, ctx):
    family = ' '.join(args.family)
    families = monospace_families()
    match = next((f for f in families if f.lower() == family.lower()), None)
    if families and not match:
        print(f'jade: {family} is not an installed monospace font; see: jade font list', file=sys.stderr)
        return 1
    ctx.font = match or family
    state = engine.current()
    theme = themes.load(state.get('theme') or 'osaka-jade')
    ctx.wallpaper_index = state.get('wallpaper') or 0
    changes, _backup = engine.apply(theme, ctx, only=FONT_TARGETS)
    if not changes:
        print(f'{ctx.font}: already the font')
        return 0
    places = join(['GNOME', *(t.title for t in engine.selected(only=FONT_TARGETS)
                              if t.name != 'font' and t.name not in ctx.absent and t.name not in ctx.skipped)])
    print(f'{ctx.font} set for {places} (undo: jade theme undo)')
    print_skipped(ctx, FONT_TARGETS)
    return 0


# ------------------------------------------------------------------ usage

def usage_collect(args, ctx):
    # The timer can outlive the switch (prefs could not reach systemd, say):
    # with AI usage off, a timer run collects nothing.
    if args.mode is None and ctx.settings.has(setup.JADE_SCHEMA, 'show-usage') \
            and not ctx.settings.get(setup.JADE_SCHEMA).get_boolean('show-usage'):
        return 0
    return collect.collect_all(args.mode)


# ------------------------------------------------------------------ desktop

def run_setup(args, ctx):
    return setup.setup(ctx, theme_id=args.theme, after_update=args.after_update)


SETTINGS_PAGES = ['welcome', 'desktop', 'dock', 'usage', 'about']


def run_settings(args, ctx):
    """Open the Jade Shell app (its settings), on a page if one is given."""
    import shutil
    app = shutil.which('jade-shell-settings')
    argv = [app] + (['--page', args.page] if args.page else []) if app else \
        ['gnome-extensions', 'prefs', setup.UUID]
    try:
        subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                         start_new_session=True)
    except OSError as error:
        print(f'Could not open Jade Shell\'s settings: {error}', file=sys.stderr)
        return 1
    return 0


def run_doctor(args, ctx):
    return setup.doctor(ctx, as_json=args.json)


def run_debug(args, ctx):
    return debug.debug(print_only=args.print, save_to=args.save, open_issue=args.issue)


def run_update(args, ctx):
    return update.update(check_only=args.check, as_json=args.json)


def run_restore(args, ctx):
    return setup.restore(ctx, assume_yes=args.yes)


def target_list(text):
    names = [name.strip() for name in text.split(',') if name.strip()]
    unknown = [name for name in names if name not in TARGETS]
    if unknown or not names:
        raise argparse.ArgumentTypeError(f'unknown target {", ".join(unknown) or repr(text)}; '
                                         f'targets are: {", ".join(TARGETS)}')
    return names


def parser():
    top = argparse.ArgumentParser(prog='jade', description=__doc__)
    top.add_argument('--version', action='version', version=f'jade {__version__}')
    commands = top.add_subparsers(dest='command', required=True, metavar='command')

    theme = commands.add_parser('theme', help='list, preview and switch themes').add_subparsers(
        dest='action', required=True, metavar='action')
    theme.add_parser('list', help='list themes').add_argument('--json', action='store_true')
    theme.add_parser('current', help='print the applied theme')
    for name, text in [('plan', 'show what switching would change, without changing it'), ('set', 'switch to a theme')]:
        p = theme.add_parser(name, help=text)
        p.add_argument('theme', choices=themes.ids())
        p.add_argument('--wallpaper', type=int, help="which of the theme's wallpapers (default: the one it had last time)")
        p.add_argument('--only', type=target_list, metavar='T,...', help=f'only these targets: {", ".join(TARGETS)}')
        p.add_argument('--skip', type=target_list, metavar='T,...', help='skip these targets (same names as --only)')
    theme.add_parser('wallpaper', help='next wallpaper of the current theme')
    p = theme.add_parser('install', help="add a community theme from its git URL (only its colors, wallpapers "
                                         "and preview are kept)")
    p.add_argument('url', help='e.g. https://github.com/OldJobobo/omarchy-miasma-theme')
    p.add_argument('--name', help='install it under this name (default: from the URL, as Omarchy names it)')
    theme.add_parser('update', help='fetch community themes again').add_argument(
        'names', nargs='*', metavar='NAME', help='which ones (default: all)')
    theme.add_parser('remove', help='remove a community theme').add_argument('name', help='as jade theme list shows it')
    theme.add_parser('undo', help='restore what the last switch changed')
    theme.add_parser('reload', help='ask every app to reload the current theme')
    fetch = theme.add_parser('fetch', help='download wallpapers')
    fetch.add_argument('theme', choices=[*themes.ids(), 'all'])
    fetch.add_argument('--every', action='store_true', help="all of a theme's wallpapers, not just the first")
    theme.add_parser('thumbs', help='make the picker previews').add_argument(
        '--refresh', action='store_true', help='rebuild previews that already exist')

    apps = commands.add_parser('apps', help='choose which apps Jade Shell themes').add_subparsers(
        dest='action', metavar='action')
    apps.add_parser('list', help='each app and whether Jade Shell themes it').add_argument('--json', action='store_true')
    for name, text in [('off', "leave apps alone from now on, with their own configs put back"),
                       ('on', 'theme apps again, starting with the current theme')]:
        apps.add_parser(name, help=text).add_argument('names', type=lambda t: target_list(t)[0], nargs='+',
                                                      metavar='NAME', help=', '.join(TARGETS))

    font = commands.add_parser('font', help='the monospace font of GNOME and the terminals').add_subparsers(
        dest='action', metavar='action')
    font.add_parser('list', help='installed monospace fonts; * marks the current one').add_argument(
        '--json', action='store_true')
    font.add_parser('set', help='use a font in GNOME and every themed terminal').add_argument(
        'family', nargs='+', help='a family from jade font list, e.g. JetBrains Mono')

    keymap = commands.add_parser('keys', help="Omarchy's keys on GNOME's shortcuts").add_subparsers(
        dest='action', metavar='action')
    keymap.add_parser('list', help='the keymap, and whether it is on').add_argument('--json', action='store_true')
    keymap.add_parser('apply', help="use Omarchy's keys (your shortcuts are saved first)")
    keymap.add_parser('revert', help='put your shortcuts back')

    net = commands.add_parser('network', help='the connection, a speed test, Wi-Fi QR, DNS and the Wi-Fi band')
    net.set_defaults(json=False)  # a bare `jade network` is `jade network status`
    net = net.add_subparsers(dest='action', metavar='action')
    net.add_parser('status', help='the connection now').add_argument('--json', action='store_true')
    net.add_parser('speedtest', help="download and upload speed (Cloudflare's speed test)").add_argument(
        '--json', action='store_true', help='progress as JSON lines (for the panel)')
    net.add_parser('qr', help='the current Wi-Fi as a QR code phones can join from').add_argument(
        '--json', action='store_true')
    net.add_parser('dns', help='auto, cloudflare, google, or server addresses').add_argument('choice', nargs='*')
    net.add_parser('band', help='pin the Wi-Fi band: auto, 2.4, 5 or 6').add_argument(
        'choice', nargs='?', choices=list(network.BANDS))

    usage = commands.add_parser('usage', help='Claude and Codex usage').add_subparsers(
        dest='action', required=True, metavar='action')
    p = usage.add_parser('collect', help='collect usage for the top bar')
    mode = p.add_mutually_exclusive_group()
    mode.add_argument('--force', dest='mode', action='store_const', const='force', help='rescan and re-probe everything')
    mode.add_argument('--limits-only', dest='mode', action='store_const', const='limits-only',
                      help='re-probe limits, reuse recent scans')

    p = commands.add_parser('setup', help='set up this desktop for Jade Shell (safe to run again; keeps your dock and '
                                          'top bar choices)')
    p.add_argument('--theme', choices=themes.ids(), help='theme to apply (default: keep the current one, or Osaka Jade)')
    p.add_argument('--after-update', action='store_true', help=argparse.SUPPRESS)  # run by the extension at login
    p = commands.add_parser('settings', help='open the Jade Shell app, its settings')
    p.add_argument('page', nargs='?', choices=SETTINGS_PAGES, help='the page to open')
    commands.add_parser('doctor', help='check that everything Jade Shell needs is in place').add_argument(
        '--json', action='store_true', help='print the checks as JSON (for the settings window)')
    p = commands.add_parser('debug', help='the details a bug report needs, without your name or home folder')
    p.add_argument('--print', action='store_true', help='only print them')
    p.add_argument('--save', metavar='FILE', help='save them (default ~/jade-debug.txt with --issue)')
    p.add_argument('--issue', action='store_true', help='save them and open a new GitHub issue with them')
    p = commands.add_parser('update', help='install the latest Jade Shell release')
    p.add_argument('--check', action='store_true', help="only say whether there's a newer version")
    p.add_argument('--json', action='store_true', help='print the check as JSON (for the extension)')
    p = commands.add_parser('restore', help='put back the desktop you had before Jade Shell')
    p.add_argument('--yes', action='store_true', help="don't ask for confirmation")
    return top


HANDLERS = {
    ('theme', 'list'): theme_list, ('theme', 'current'): theme_current, ('theme', 'plan'): theme_plan,
    ('theme', 'set'): theme_set, ('theme', 'wallpaper'): theme_wallpaper, ('theme', 'undo'): theme_undo,
    ('theme', 'reload'): theme_reload, ('theme', 'install'): theme_install, ('theme', 'update'): theme_update,
    ('theme', 'remove'): theme_remove, ('theme', 'fetch'): theme_fetch, ('theme', 'thumbs'): theme_thumbs,
    ('usage', 'collect'): usage_collect,
    ('network', None): network_status, ('network', 'status'): network_status,
    ('network', 'speedtest'): network_speedtest, ('network', 'qr'): network_qr,
    ('network', 'dns'): network_dns, ('network', 'band'): network_band,
    ('keys', None): keys_list, ('keys', 'list'): keys_list, ('keys', 'apply'): keys_apply,
    ('keys', 'revert'): keys_revert,
    ('font', None): font_list, ('font', 'list'): font_list, ('font', 'set'): font_set,
    ('apps', None): apps_list, ('apps', 'list'): apps_list, ('apps', 'off'): apps_off, ('apps', 'on'): apps_on,
    ('setup', None): run_setup, ('doctor', None): run_doctor, ('update', None): run_update, ('restore', None): run_restore,
    ('settings', None): run_settings,
    ('debug', None): run_debug,
}


# Commands that change the desktop or the undo history: one at a time.
# Downloads (fetch, thumbs) run alongside them: each writes its own partial
# file and moves it into place.
EXCLUSIVE = {('theme', 'set'), ('theme', 'wallpaper'), ('theme', 'undo'), ('theme', 'reload'),
             ('theme', 'install'), ('theme', 'update'), ('theme', 'remove'),
             ('setup', None), ('restore', None),
             ('apps', 'off'), ('apps', 'on'), ('font', 'set'), ('keys', 'apply'), ('keys', 'revert'),
             ('network', 'dns'), ('network', 'band')}


# `jade` alone: where to start, rather than argparse's "arguments are required".
START = '''\
jade theme list         see the themes
jade theme set <name>   change the look
jade settings           open Jade Shell's settings
jade restore            put your desktop back the way it was
jade --help             everything else'''


def main(argv=None):
    if not (sys.argv[1:] if argv is None else argv):
        print(START)
        return 0
    args = parser().parse_args(argv)
    command = args.command, getattr(args, 'action', None)
    try:
        with engine.exclusive() if command in EXCLUSIVE else contextlib.nullcontext():
            return HANDLERS[command](args, engine.Context(Settings()))
    except (engine.Busy, themes.WallpaperUnavailable) as error:  # a sentence, not a traceback
        print(f'jade: {error}', file=sys.stderr)
        return 1
