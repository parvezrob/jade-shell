#!/usr/bin/env python3
"""Draw Jade Shell's top-bar icons: extension/icons/bar/<name>.svg.

One family for everything the top bar shows (Jade's own items, GNOME's
status icons, the weather), drawn on a 16 px grid with one line weight and
round ends, as Omarchy Quattro's bar uses one glyph set. The extension shows
these in place of the icon theme's in the top bar (lib/baricons.js), under
the names GNOME asks for.

GNOME recolors a symbolic icon by overriding its fill only: every line here
is therefore drawn as a filled outline (a round-capped strip), never as a
stroke. Parts drawn at .35 opacity are the "off" parts of a level (the
unlit Wi-Fi arcs, volume waves).

    scripts/make-bar-icons.py            # writes extension/icons/bar/
    scripts/make-bar-icons.py --sheet out.png   # and a contact sheet
"""
import math
import pathlib
import sys

W = 1.5                 # the line weight
HALF = W / 2
DIM = '.35'             # opacity of an "off" part
OUT = pathlib.Path(__file__).resolve().parent.parent / 'extension/icons/bar'


def n(v):
    return f'{v:.2f}'.rstrip('0').rstrip('.') if abs(v) > 1e-9 else '0'


def pt(p):
    return f'{n(p[0])} {n(p[1])}'


# ---------------------------------------------------------------- primitives
# Each returns SVG path data (filled). Angles are in degrees on screen:
# 0 points right, 90 down (SVG's y runs down).

def line(x1, y1, x2, y2, w=W):
    """A strip from one point to another with round ends."""
    r = w / 2
    dx, dy = x2 - x1, y2 - y1
    length = math.hypot(dx, dy)
    if length < 1e-6:
        return disc(x1, y1, r)
    nx, ny = -dy / length * r, dx / length * r
    a, b = (x1 + nx, y1 + ny), (x2 + nx, y2 + ny)
    c, d = (x2 - nx, y2 - ny), (x1 - nx, y1 - ny)
    return (f'M{pt(a)}L{pt(b)}A{n(r)} {n(r)} 0 0 0 {pt(c)}'
            f'L{pt(d)}A{n(r)} {n(r)} 0 0 0 {pt(a)}Z')


def polyline(points, w=W, closed=False):
    """Joined strips: round joins come from the round ends."""
    pts = list(points) + ([points[0]] if closed else [])
    return ''.join(line(*pts[i], *pts[i + 1], w) for i in range(len(pts) - 1))


def arc(cx, cy, r, a0, a1, w=W):
    """Part of a circle, clockwise from a0 to a1, with round ends."""
    h = w / 2
    t0, t1 = math.radians(a0), math.radians(a1)
    large = 1 if (a1 - a0) % 360 > 180 else 0

    def at(radius, t):
        return cx + radius * math.cos(t), cy + radius * math.sin(t)
    return (f'M{pt(at(r + h, t0))}A{n(r + h)} {n(r + h)} 0 {large} 1 {pt(at(r + h, t1))}'
            f'A{n(h)} {n(h)} 0 0 1 {pt(at(r - h, t1))}'
            f'A{n(r - h)} {n(r - h)} 0 {large} 0 {pt(at(r - h, t0))}'
            f'A{n(h)} {n(h)} 0 0 1 {pt(at(r + h, t0))}Z')


def circle_path(cx, cy, r):
    return (f'M{n(cx + r)} {n(cy)}A{n(r)} {n(r)} 0 1 1 {n(cx - r)} {n(cy)}'
            f'A{n(r)} {n(r)} 0 1 1 {n(cx + r)} {n(cy)}Z')


def disc(cx, cy, r):
    return circle_path(cx, cy, r)


def ring(cx, cy, r, w=W):
    """A circle's outline (fill-rule evenodd)."""
    return circle_path(cx, cy, r + w / 2) + circle_path(cx, cy, r - w / 2)


def rounded(x, y, w, h, r):
    r = max(0.0, min(r, w / 2, h / 2))
    if r < 1e-6:
        return f'M{n(x)} {n(y)}H{n(x + w)}V{n(y + h)}H{n(x)}Z'
    return (f'M{n(x + r)} {n(y)}H{n(x + w - r)}A{n(r)} {n(r)} 0 0 1 {n(x + w)} {n(y + r)}'
            f'V{n(y + h - r)}A{n(r)} {n(r)} 0 0 1 {n(x + w - r)} {n(y + h)}'
            f'H{n(x + r)}A{n(r)} {n(r)} 0 0 1 {n(x)} {n(y + h - r)}'
            f'V{n(y + r)}A{n(r)} {n(r)} 0 0 1 {n(x + r)} {n(y)}Z')


def box(x, y, w, h, r, lw=W):
    """A rounded rectangle's outline, its line centred on the given box (evenodd)."""
    s = lw / 2
    return rounded(x - s, y - s, w + lw, h + lw, r + s) + rounded(x + s, y + s, w - lw, h - lw, max(0, r - s))


def filled(x, y, w, h, r):
    return rounded(x, y, w, h, r)


def curve(fn, t0, t1, steps=24):
    """Points along a parametric curve, for polyline()."""
    return [fn(t0 + (t1 - t0) * i / steps) for i in range(steps + 1)]


def circle_points(cx, cy, r, a0, a1, steps=16):
    return curve(lambda a: (cx + r * math.cos(math.radians(a)), cy + r * math.sin(math.radians(a))), a0, a1, steps)


# ---------------------------------------------------------------- icon parts

class Icon:
    def __init__(self):
        self.parts = []   # (path data, opacity or None, evenodd)

    def add(self, d, dim=False, evenodd=False):
        self.parts.append((d, DIM if dim else None, evenodd))
        return self

    def svg(self):
        body = []
        for d, opacity, evenodd in self.parts:
            extra = (f' opacity="{opacity}"' if opacity else '') + (' fill-rule="evenodd"' if evenodd else '')
            body.append(f'<path fill="#bebebe"{extra} d="{d}"/>')
        return f'<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">{"".join(body)}</svg>\n'


def slash(icon):
    return icon.add(line(2.25, 2.25, 13.75, 13.75))


# A cloud's outline: a flat base, a small bump on each side and a big one on
# top. `dy` moves it up (for rain or snow under it), `s` scales it.
def cloud_points(ox=0.0, oy=0.0, s=1.0):
    def p(x, y):
        return (ox + x * s, oy + y * s)
    right = circle_points(11.75, 10, 2.5, 90, -60, 8)          # right bump, up and around
    top = circle_points(8, 8, 3.75, -15, -165, 14)             # the big one
    left = circle_points(4.25, 10, 2.5, -120, -270, 8)         # left bump, down to the base
    return [p(x, y) for x, y in [(4.25, 12.5), (11.75, 12.5), *right[1:], *top, *left]]


def cloud(icon, ox=0.0, oy=0.0, s=1.0, dim=False):
    return icon.add(polyline(cloud_points(ox, oy, s), closed=True), dim)


def sun(icon, cx=8, cy=8, r=3, rays=(5, 6.5), angles=range(0, 360, 45)):
    icon.add(ring(cx, cy, r), evenodd=True)
    for a in angles:
        t = math.radians(a)
        icon.add(line(cx + rays[0] * math.cos(t), cy + rays[0] * math.sin(t),
                      cx + rays[1] * math.cos(t), cy + rays[1] * math.sin(t)))
    return icon


def inside(p, poly):
    """Is point p inside the polygon?"""
    x, y, hit = p[0], p[1], False
    for (x1, y1), (x2, y2) in zip(poly, poly[1:] + poly[:1], strict=True):
        if (y1 > y) != (y2 > y) and x < x1 + (y - y1) * (x2 - x1) / (y2 - y1):
            hit = not hit
    return hit


def distance_to(p, poly):
    best = math.inf
    for (x1, y1), (x2, y2) in zip(poly, poly[1:] + poly[:1], strict=True):
        dx, dy = x2 - x1, y2 - y1
        t = max(0, min(1, ((p[0] - x1) * dx + (p[1] - y1) * dy) / (dx * dx + dy * dy or 1)))
        best = min(best, math.hypot(p[0] - x1 - t * dx, p[1] - y1 - t * dy))
    return best


def behind(points, poly, gap=1.6):
    """The runs of a line that stay clear of a shape in front of it (and a
    gap around it), so the shape covers what is behind it."""
    runs, run = [], []
    for q in points:
        if inside(q, poly) or distance_to(q, poly) < gap:
            if len(run) > 1:
                runs.append(run)
            run = []
        else:
            run.append(q)
    if len(run) > 1:
        runs.append(run)
    return runs


def crescent_points(cx=7.25, cy=8.75, r=5.75, bite=(3.25, -3.25), r2=5):
    """A crescent moon's outline: the outer circle where the cutting circle
    doesn't reach, then the cutting circle's edge inside it, back."""
    ox, oy = cx + bite[0], cy + bite[1]
    outer = [(cx + r * math.cos(math.radians(a)), cy + r * math.sin(math.radians(a))) for a in range(0, 360, 3)]
    keep = [math.hypot(x - ox, y - oy) > r2 for x, y in outer]
    # Start just after the cut, so the outside run is one piece.
    start = next(i for i in range(len(outer)) if keep[i] and not keep[i - 1])
    run = []
    for k in range(len(outer)):
        i = (start + k) % len(outer)
        if not keep[i]:
            break
        run.append(outer[i])
    inner_all = [(ox + r2 * math.cos(math.radians(a)), oy + r2 * math.sin(math.radians(a))) for a in range(0, 360, 3)]
    inside_moon = [math.hypot(x - cx, y - cy) < r for x, y in inner_all]
    start = next(i for i in range(len(inner_all)) if inside_moon[i] and not inside_moon[i - 1])
    arc_in = []
    for k in range(len(inner_all)):
        i = (start + k) % len(inner_all)
        if not inside_moon[i]:
            break
        arc_in.append(inner_all[i])
    # Join the ends that meet: the outer run's end to the nearer end of the inner run.
    if math.dist(run[-1], arc_in[0]) > math.dist(run[-1], arc_in[-1]):
        arc_in.reverse()
    return run + arc_in


def moon(icon, cx=7.25, cy=8.75, r=5.75, bite=(3.25, -3.25), r2=5):
    return icon.add(polyline(crescent_points(cx, cy, r, bite, r2), closed=True))


def speaker(icon, dim=False):
    return icon.add(polyline([(1.5, 6), (4, 6), (7.25, 2.75), (7.25, 13.25), (4, 10), (1.5, 10)], closed=True), dim)


def waves(icon, lit):
    for i, r in enumerate((2.5, 4.75, 7)):
        span = 42 if i < 2 else 38
        icon.add(arc(7.75, 8, r, -span, span), dim=i >= lit)
    return icon


def wifi(icon, lit, all_dim=False):
    icon.add(disc(8, 13, 1.25), dim=all_dim)
    for i, r in enumerate((3.75, 7, 10.25)):
        icon.add(arc(8, 13.25, r, 225, 315), dim=all_dim or i >= lit)
    return icon


def wired(icon, dim=False):
    icon.add(box(5.5, 1.75, 5, 3.75, 1), dim, evenodd=True)
    icon.add(box(1.75, 10.5, 4.5, 3.75, 1), dim, evenodd=True)
    icon.add(box(9.75, 10.5, 4.5, 3.75, 1), dim, evenodd=True)
    icon.add(polyline([(8, 5.5), (8, 8)]), dim)
    icon.add(polyline([(4, 10.5), (4, 8), (12, 8), (12, 10.5)]), dim)
    return icon


def lock(icon, dim=False):
    icon.add(box(3.5, 7, 9, 6.75, 1.5), dim, evenodd=True)
    icon.add(arc(8, 7, 2.75, 180, 360), dim)
    icon.add(line(8, 9.75, 8, 11), dim)
    return icon


def battery(icon, level=None, bolt=False):
    icon.add(box(1.5, 4.5, 11.75, 7, 1.75), evenodd=True)
    icon.add(filled(13.9, 6.4, 1.35, 3.2, 0.6))
    if level is not None:
        width = 8.25 * level / 100
        if level > 0:
            icon.add(filled(3.25, 6.25, max(1.0, width), 3.5, 0.75), dim=bolt)
    if bolt:
        icon.add(polyline([(8.25, 5.75), (6.25, 8.25), (8.75, 8.25), (6.75, 10.75)]))
    return icon


def bell(icon, dim=False):
    body = [(2.75, 11.5), (4, 10), (4, 7), *circle_points(8, 7, 4, 180, 360, 14), (12, 10), (13.25, 11.5)]
    icon.add(polyline(body, closed=True), dim)
    icon.add(arc(8, 12.25, 1.75, 20, 160), dim)
    icon.add(line(8, 1.75, 8, 2.75), dim)
    return icon


def gauge(icon, angle):
    icon.add(arc(8, 10, 6, 180, 360))
    t = math.radians(angle)
    icon.add(line(8, 10, 8 + 3.75 * math.cos(t), 10 + 3.75 * math.sin(t)))
    icon.add(disc(8, 10, 1.25))
    return icon


def raindrops(icon, xs, dim=False):
    for x in xs:
        icon.add(line(x, 11.5, x - 1, 14), dim)
    return icon


def small_cloud(icon, dim=False):
    """The cloud moved up, for something falling under it."""
    return cloud(icon, 0, -3.25, 1, dim)


# ---------------------------------------------------------------- the set

def icons():
    out = {}

    def make(name, *builders):
        icon = Icon()
        for build in builders:
            build(icon)
        out[name] = icon

    # Jade's own
    make('cpu-symbolic', lambda i: [
        i.add(box(4, 4, 8, 8, 1.75), evenodd=True), i.add(filled(6.4, 6.4, 3.2, 3.2, 0.6)),
        *[i.add(line(*seg)) for p in (6.25, 9.75) for seg in ((1.75, p, 3.25, p), (12.75, p, 14.25, p),
                                                                (p, 1.75, p, 3.25), (p, 12.75, p, 14.25))]])

    def sparkles(i):
        tips = [(6.75, 2.25), (11.25, 8.75), (6.75, 15.25 - 0.5), (2.25, 8.75)]
        cx, cy = 6.75, 8.75
        inner = [(cx + 1.35 * math.cos(math.radians(a)), cy + 1.35 * math.sin(math.radians(a))) for a in (-45, 45, 135, 225)]
        pts = [tips[0], inner[0], tips[1], inner[1], tips[2], inner[2], tips[3], inner[3]]
        i.add(polyline(pts, closed=True))
        s = [(12.5, 1.25), (13.25, 2.75), (14.75, 3.5), (13.25, 4.25), (12.5, 5.75), (11.75, 4.25), (10.25, 3.5), (11.75, 2.75)]
        i.add('M' + 'L'.join(pt(p) for p in s) + 'Z')
    make('ai-usage-symbolic', sparkles)

    def palette(i):
        # A painter's palette: a round board, three paints and the thumb hole.
        i.add(ring(8, 8, 6.25), evenodd=True)
        for x, y in ((5.25, 6.5), (8, 4.5), (10.75, 6.5)):
            i.add(disc(x, y, 1.2))
        i.add(ring(9.5, 10.5, 1.4, 1.2), evenodd=True)
    make('preferences-desktop-appearance-symbolic', palette)
    out['applications-graphics-symbolic'] = out['preferences-desktop-appearance-symbolic']

    make('bell-symbolic', bell)
    make('notifications-disabled-symbolic', lambda i: [bell(i, dim=True), slash(i)])
    out['bell-off-symbolic'] = out['notifications-disabled-symbolic']

    def cup(i):
        bottom = circle_points(6.25, 10.5, 3.25, 180, 0, 16)
        i.add(polyline([(3, 6.25), *bottom, (9.5, 6.25)], closed=True))
        i.add(arc(10.25, 9, 1.75, -90, 90))
        for x in (4.75, 7.75):
            i.add(polyline(curve(lambda t, x=x: (x + 0.6 * math.sin(t * math.pi * 2), 1.75 + t * 2.75), 0, 1, 8)))
    make('awake-symbolic', cup)
    make('night-light-symbolic', lambda i: moon(i))

    # Network
    make('network-wired-symbolic', wired)
    for state in ('acquiring', 'no-route'):
        make(f'network-wired-{state}-symbolic', lambda i: wired(i, dim=True))
    make('network-wired-disconnected-symbolic', lambda i: [wired(i, dim=True), slash(i)])
    make('network-offline-symbolic', lambda i: [wired(i, dim=True), slash(i)])
    make('network-error-symbolic', lambda i: [wired(i, dim=True), slash(i)])
    levels = {'none': 0, 'weak': 0, 'ok': 1, 'good': 2, 'excellent': 3}
    for level, lit in levels.items():
        make(f'network-wireless-signal-{level}-symbolic',
             lambda i, lit=lit, level=level: wifi(i, lit, all_dim=level == 'none'))
    make('network-wireless-symbolic', lambda i: wifi(i, 3))
    make('network-wireless-encrypted-symbolic', lambda i: wifi(i, 3))
    make('network-wireless-acquiring-symbolic', lambda i: wifi(i, 0, all_dim=True))
    make('network-wireless-no-route-symbolic', lambda i: wifi(i, 0, all_dim=True))
    for state in ('offline', 'disabled'):
        make(f'network-wireless-{state}-symbolic', lambda i: [wifi(i, 0, all_dim=True), slash(i)])
    make('network-vpn-symbolic', lock)
    make('network-vpn-acquiring-symbolic', lambda i: lock(i, dim=True))
    make('network-vpn-disabled-symbolic', lambda i: [lock(i, dim=True), slash(i)])

    # Sound
    make('audio-volume-muted-symbolic', lambda i: [speaker(i), i.add(line(10.25, 6, 14.25, 10)),
                                                   i.add(line(14.25, 6, 10.25, 10))])
    for name, lit in (('low', 1), ('medium', 2), ('high', 3), ('overamplified', 3)):
        make(f'audio-volume-{name}-symbolic', lambda i, lit=lit: waves(speaker(i), lit))

    def mic(i, dim=False):
        i.add(box(5.75, 1.75, 4.5, 7.75, 2.25), dim, evenodd=True)
        i.add(arc(8, 8, 4.75, 15, 165), dim)
        i.add(line(8, 12.75, 8, 14.25), dim)
    for name in ('high', 'medium', 'low'):
        make(f'microphone-sensitivity-{name}-symbolic', mic)
    make('audio-input-microphone-symbolic', mic)
    make('microphone-sensitivity-muted-symbolic', lambda i: [mic(i, dim=True), slash(i)])
    make('audio-headphones-symbolic', lambda i: [i.add(arc(8, 9, 5.75, 180, 360)),
                                                 i.add(box(1.5, 9.25, 2.75, 4.5, 1), evenodd=True),
                                                 i.add(box(11.75, 9.25, 2.75, 4.5, 1), evenodd=True)])

    # Power
    for level in range(0, 101, 10):
        make(f'battery-level-{level}-symbolic', lambda i, level=level: battery(i, level))
        for kind in ('charging', 'plugged-in'):
            make(f'battery-level-{level}-{kind}-symbolic', lambda i, level=level: battery(i, level, bolt=True))
    make('battery-level-100-charged-symbolic', lambda i: battery(i, 100))
    make('system-shutdown-symbolic', lambda i: [i.add(arc(8, 8.75, 5.5, -55, 235)), i.add(line(8, 1.75, 8, 7.5))])
    make('power-profile-balanced-symbolic', lambda i: gauge(i, 270))
    make('power-profile-performance-symbolic', lambda i: gauge(i, 320))
    make('power-profile-power-saver-symbolic', lambda i: gauge(i, 220))

    # Radios, place, privacy
    rune = [(4.25, 5), (11.25, 10.75), (8, 13.75), (8, 2.25), (11.25, 5.25), (4.25, 11)]
    make('bluetooth-active-symbolic', lambda i: i.add(polyline(rune)))
    make('bluetooth-acquiring-symbolic', lambda i: i.add(polyline(rune), dim=True))
    make('bluetooth-disabled-symbolic', lambda i: [i.add(polyline(rune), dim=True), slash(i)])
    make('airplane-mode-symbolic', lambda i: [i.add(line(8, 1.75, 8, 13.25)),
                                              i.add(polyline([(1.75, 9.25), (8, 6.25), (14.25, 9.25)])),
                                              i.add(polyline([(5.25, 14.25), (8, 12.75), (10.75, 14.25)]))])

    def pin(i):
        pts = [*circle_points(8, 6.5, 4.5, 150, 390, 22), (8, 14.25)]
        i.add(polyline(pts, closed=True))
        i.add(disc(8, 6.5, 1.35))
    make('location-services-active-symbolic', pin)

    # Media (the playing chip)
    make('media-playback-start-symbolic', lambda i: i.add(polyline([(4.5, 2.75), (12.5, 8), (4.5, 13.25)], closed=True)))
    make('media-playback-pause-symbolic', lambda i: [i.add(line(5.25, 3, 5.25, 13)), i.add(line(10.75, 3, 10.75, 13))])

    # Weather (GWeather's names)
    make('weather-clear-symbolic', lambda i: sun(i))
    make('weather-clear-night-symbolic', lambda i: moon(i))

    def few_clouds(i, night=False):
        # The cloud in front; the sun or moon behind it shows only past it.
        front = cloud_points(-1.25, 1.75, 0.95)
        if night:
            back = [*crescent_points(10.25, 5.25, 4, (2.25, -2.25), 3.5), crescent_points(10.25, 5.25, 4, (2.25, -2.25), 3.5)[0]]
            for run in behind(back, front):
                i.add(polyline(run))
        else:
            for run in behind(circle_points(10.75, 5.25, 2.5, 0, 360, 48), front):
                i.add(polyline(run))
            for a in (-135, -90, -45, 0, 45):
                t = math.radians(a)
                seg = [(10.75 + 4.25 * math.cos(t), 5.25 + 4.25 * math.sin(t)),
                       (10.75 + 5.25 * math.cos(t), 5.25 + 5.25 * math.sin(t))]
                if behind(seg, front):
                    i.add(line(*seg[0], *seg[1]))
        i.add(polyline(front, closed=True))
    make('weather-few-clouds-symbolic', few_clouds)
    make('weather-few-clouds-night-symbolic', lambda i: few_clouds(i, night=True))
    make('weather-overcast-symbolic', lambda i: cloud(i, 0, -0.5))
    make('weather-fog-symbolic', lambda i: [i.add(line(2, 4.5, 14, 4.5)), i.add(line(2, 8, 11.5, 8)),
                                            i.add(line(4.5, 11.5, 14, 11.5))])
    make('weather-showers-symbolic', lambda i: [small_cloud(i), raindrops(i, (5, 8.5, 12))])
    make('weather-showers-scattered-symbolic', lambda i: [small_cloud(i), raindrops(i, (6.5, 10.5))])
    make('weather-snow-symbolic', lambda i: [small_cloud(i),
                                             *[i.add(disc(x, y, 1)) for x, y in ((5, 12), (8.5, 13.75), (12, 12))]])
    make('weather-storm-symbolic', lambda i: [small_cloud(i), i.add(polyline([(9, 10.25), (7, 12.75), (9.5, 12.75), (7.5, 15)]))])

    def alert(i):
        i.add(polyline([(8, 2), (14.25, 13.5), (1.75, 13.5)], closed=True))
        i.add(line(8, 6.5, 8, 9.25))
        i.add(disc(8, 11.5, 0.9))
    make('weather-severe-alert-symbolic', alert)

    def wind(i):
        i.add(polyline([(1.75, 6), *circle_points(10.25, 4, 2, 90, -180, 10)]))
        i.add(polyline([(1.75, 9.5), (12, 9.5), *circle_points(12, 11.5, 2, -90, 180, 10)]))
        i.add(line(1.75, 13, 7, 13))
    make('weather-windy-symbolic', wind)
    make('weather-tornado-symbolic', wind)
    for name in ('clear', 'clear-night', 'few-clouds', 'few-clouds-night', 'overcast', 'fog', 'showers',
                 'showers-scattered', 'snow', 'storm', 'severe-alert', 'windy', 'tornado'):
        out[f'weather-{name}'] = out[f'weather-{name}-symbolic']
    return out


def sheet(path, all_icons):
    """Every icon at 16 px and 48 px, light on the dark bar and dark on light."""
    import gi
    gi.require_version('GdkPixbuf', '2.0')
    gi.require_version('Rsvg', '2.0')
    import cairo
    from gi.repository import Rsvg
    names = sorted(n for n in all_icons if n.endswith('-symbolic'))
    cols, cell = 8, 150
    rows = math.ceil(len(names) / cols)
    surface = cairo.ImageSurface(cairo.FORMAT_ARGB32, cols * cell, rows * 90)
    ctx = cairo.Context(surface)
    ctx.set_source_rgb(0.07, 0.11, 0.09)
    ctx.paint()
    for index, name in enumerate(names):
        x, y = (index % cols) * cell, (index // cols) * 90
        svg = all_icons[name].svg().replace('#bebebe', '#c1c497')
        handle = Rsvg.Handle.new_from_data(svg.encode())
        for size, ox in ((16, 8), (48, 34)):
            ctx.save()
            ctx.translate(x + ox, y + 8 + (48 - size) / 2)
            ctx.scale(size / 16, size / 16)
            viewport = Rsvg.Rectangle()
            viewport.x, viewport.y, viewport.width, viewport.height = 0, 0, 16, 16
            handle.render_document(ctx, viewport)
            ctx.restore()
        ctx.set_source_rgb(0.6, 0.62, 0.5)
        ctx.select_font_face('monospace')
        ctx.set_font_size(8)
        ctx.move_to(x + 4, y + 76)
        ctx.show_text(name.replace('-symbolic', '')[:26])
    surface.write_to_png(path)


def main():
    all_icons = icons()
    OUT.mkdir(parents=True, exist_ok=True)
    for old in OUT.glob('*.svg'):
        old.unlink()
    for name, icon in all_icons.items():
        (OUT / f'{name}.svg').write_text(icon.svg())
    # Jade's own icons of the same things, used in its menus too.
    for name in ('cpu-symbolic', 'bell-symbolic', 'bell-off-symbolic', 'ai-usage-symbolic', 'awake-symbolic'):
        (OUT.parent / f'{name}.svg').write_text(all_icons[name].svg())
    print(f'{len(all_icons)} icons in {OUT}')
    if '--sheet' in sys.argv:
        sheet(sys.argv[sys.argv.index('--sheet') + 1], all_icons)


if __name__ == '__main__':
    main()
