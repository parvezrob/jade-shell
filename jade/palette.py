"""Resolve an Omarchy colors.toml into the full palette every target reads.

Ported from Omarchy's `omarchy-theme-color` (MIT) so each key resolves to the
same value Omarchy would give it: legacy short names, ANSI fallbacks, and
derived shades for anything a theme leaves out.
"""
import re
import tomllib

ANSI = {
    'color0': 'background', 'color1': 'red', 'color2': 'green', 'color3': 'yellow',
    'color4': 'blue', 'color5': 'magenta', 'color6': 'cyan', 'color7': 'foreground',
    'color8': 'muted', 'color9': 'bright_red', 'color10': 'bright_green',
    'color11': 'bright_yellow', 'color12': 'bright_blue', 'color13': 'bright_magenta',
    'color14': 'bright_cyan', 'color15': 'bright_foreground',
}
SHORT = {
    'background': 'bg', 'dark_background': 'dark_bg', 'darker_background': 'darker_bg',
    'lighter_background': 'lighter_bg', 'foreground': 'fg', 'dark_foreground': 'dark_fg',
    'light_foreground': 'light_fg', 'bright_foreground': 'bright_fg',
}


def rgb(hex_color):
    h = hex_color.lstrip('#')
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


def to_hex(channels):
    return '#' + ''.join(f'{int(c):02x}' for c in channels)


def mix(start, end, amount):
    """Blend `amount` (0 to 1, or a '30%' string) of `end` into `start`."""
    if isinstance(amount, str):
        amount = float(amount.rstrip('%')) / (100 if amount.endswith('%') else 1)
    amount = max(0.0, min(1.0, amount))
    return to_hex(int(s * (1 - amount) + e * amount + 0.5) for s, e in zip(rgb(start), rgb(end), strict=True))


HEX = re.compile(r'#?([0-9a-fA-F]{6}|[0-9a-fA-F]{3})')
MODES = ('dark', 'light')


def clean(raw):
    """Only what a palette may hold: colors as #rrggbb, and dark or light.

    Every value ends up inside other programs' configs (Lua for Neovim, tmux,
    CSS, TOML), so anything else, from a community theme or an override, is
    dropped here rather than escaped for each of them."""
    out = {}
    for key, value in raw.items():
        if not isinstance(value, str) or not re.fullmatch(r'\w+', key):
            continue
        if key in ('mode', 'theme_type'):
            if value in MODES:
                out[key] = value
            continue
        match = HEX.fullmatch(value.strip())
        if match:
            digits = match.group(1).lower()
            out[key] = '#' + (''.join(d * 2 for d in digits) if len(digits) == 3 else digits)
    return out


def resolve(raw):
    c = clean(raw)
    if not (c.get('background') or c.get('bg') or c.get('color0')) or \
            not (c.get('foreground') or c.get('fg') or c.get('color7')):
        raise ValueError('a palette needs a background and a foreground color')

    def alias(key, fallback):
        if not c.get(key) and c.get(fallback):
            c[key] = c[fallback]

    for key, short in SHORT.items():
        alias(key, short)
    c.setdefault('background', c.get('color0'))
    c.setdefault('foreground', c.get('color7'))
    c['color0'], c['color7'] = c['background'], c['foreground']
    for semantic, ansi in [('red', 'color1'), ('green', 'color2'), ('yellow', 'color3'),
                           ('blue', 'color4'), ('magenta', 'color5'), ('cyan', 'color6'),
                           ('bright_red', 'color9'), ('bright_green', 'color10'),
                           ('bright_yellow', 'color11'), ('bright_blue', 'color12'),
                           ('bright_magenta', 'color13'), ('bright_cyan', 'color14')]:
        alias(semantic, ansi)
    alias('magenta', 'purple')
    alias('bright_magenta', 'bright_purple')
    # A theme that leaves a base color out (or had it dropped as invalid)
    # still resolves; the text color stands in.
    for name in ['red', 'green', 'yellow', 'blue', 'magenta', 'cyan']:
        c.setdefault(name, c['foreground'])

    c.setdefault('light_foreground', c.get('color7') or c['foreground'])
    c.setdefault('bright_foreground', c.get('color15') or c['foreground'])
    c['cursor'] = c['bright_foreground']
    c.setdefault('lighter_background', c.get('color0') or c['background'])
    c.setdefault('dark_foreground', c.get('color8') or c['foreground'])
    c.setdefault('muted', c.get('color8') or c['dark_foreground'])
    c.setdefault('selection', c.get('selection_background') or c.get('color8') or c['background'])
    c.setdefault('selection_background', c['selection'])
    c.setdefault('selection_foreground', c['bright_foreground'])
    c.setdefault('orange', c['yellow'])
    c.setdefault('brown', mix(c['orange'], '#000000', 0.5))
    c.setdefault('dark_background', mix(c['background'], '#000000', 0.25))
    c.setdefault('darker_background', mix(c['background'], '#000000', 0.5))
    for name in ['red', 'yellow', 'green', 'cyan', 'blue', 'magenta']:
        c.setdefault(f'bright_{name}', mix(c[name], '#ffffff', 0.2))
    alias('purple', 'magenta')
    alias('bright_purple', 'bright_magenta')
    for ansi, semantic in ANSI.items():
        alias(ansi, semantic)
    for key, short in SHORT.items():
        c[short] = c[key]

    if not c.get('mode'):
        c['mode'] = c.get('theme_type') or ('light' if sum(rgb(c['background'])) > 382 else 'dark')
    c['theme_type'] = c['mode']
    c.setdefault('accent', c['blue'])
    return c


def load(path, overrides=None):
    palette = resolve(tomllib.loads(path.read_text()))
    palette.update(clean(overrides or {}))
    return palette
