"""Resolve an Omarchy colors.toml into the full palette every target reads.

Ported from Omarchy's `omarchy-theme-color` (MIT) so each key resolves to the
same value Omarchy would give it: legacy short names, ANSI fallbacks, and
derived shades for anything a theme leaves out.
"""
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
    return '#%02x%02x%02x' % tuple(channels)


def mix(start, end, amount):
    """Blend `amount` (0–1, or a '30%' string) of `end` into `start`."""
    if isinstance(amount, str):
        amount = float(amount.rstrip('%')) / (100 if amount.endswith('%') else 1)
    amount = max(0.0, min(1.0, amount))
    return to_hex(int(s * (1 - amount) + e * amount + 0.5) for s, e in zip(rgb(start), rgb(end)))


def resolve(raw):
    c = {k: v for k, v in raw.items() if isinstance(v, str)}

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
    palette.update(overrides or {})
    return palette
