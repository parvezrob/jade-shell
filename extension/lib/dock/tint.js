import Cogl from 'gi://Cogl';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {hexToRgb} from './glass.js';

// Tinted icons, Jade's take on macOS 26's: each icon redrawn in the theme's
// own shades by its lightness (dark parts in a deep shade of the accent, the
// middle in the accent, highlights in a pale tint of it), its shape and
// shading kept.
const DECLARATIONS = `
uniform sampler2D tex;
uniform vec3 deep;
uniform vec3 mid;
uniform vec3 pale;
`;

const CODE = `
vec4 c = texture2D(tex, cogl_tex_coord_in[0].xy);
vec3 rgb = c.a > 0.0 ? c.rgb / c.a : vec3(0.0);
float l = pow(dot(rgb, vec3(0.2126, 0.7152, 0.0722)), 1.35);
vec3 t = l < 0.5 ? mix(deep, mid, l * 2.0) : mix(mid, pale, (l - 0.5) * 2.0);
cogl_color_out = vec4(t * c.a, c.a) * cogl_color_in.a;
`;

// The three tones, 0-255: the accent's hue at set lightness (and at least
// some saturation), so a pale or grey accent (Kanagawa's cream, Vantablack's
// grey) gives icons the same depth as a vivid one instead of washing them out.
function hsl([r, g, b]) {
    [r, g, b] = [r / 255, g / 255, b / 255];
    const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, d = max - min;
    if (!d)
        return [0, 0, l];
    const s = d / (1 - Math.abs(2 * l - 1));
    const h = max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return [h * 60, s, l];
}

function rgb(h, s, l) {
    const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs((h / 60) % 2 - 1)), m = l - c / 2;
    const [r, g, b] = [[c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x]][Math.floor(h / 60) % 6];
    return [r, g, b].map(v => Math.round((v + m) * 255));
}

export function tones(accent) {
    const [h, s] = hsl(hexToRgb(accent));
    const grey = s < 0.06;  // no hue to keep: a clean monochrome
    const sat = grey ? 0 : Math.min(0.75, Math.max(s, 0.38));
    return [rgb(h, sat * 0.8, 0.17), rgb(h, sat, 0.52), rgb(h, grey ? 0 : Math.min(sat, 0.45), 0.93)];
}

export const TintEffect = GObject.registerClass(
class JadeTintEffect extends Shell.GLSLEffect {
    constructor(colors) {
        super();
        this._at = Object.fromEntries(['deep', 'mid', 'pale'].map(name => [name, this.get_uniform_location(name)]));
        this.colors = colors;
    }

    vfunc_build_pipeline() {
        this.add_glsl_snippet(Cogl.SnippetHook.FRAGMENT, DECLARATIONS, CODE, true);
    }

    set colors({accent}) {
        const [deep, mid, pale] = tones(accent).map(tone => tone.map(v => v / 255));
        this.set_uniform_float(this._at.deep, 3, deep);
        this.set_uniform_float(this._at.mid, 3, mid);
        this.set_uniform_float(this._at.pale, 3, pale);
        this.queue_repaint();
    }
});

// The same tint, done once to an icon's pixels: what the dock draws. The
// shader above draws through an offscreen buffer the size of the icon at
// rest, which a magnified icon shows as blocky pixels; a tinted copy is an
// ordinary texture, mipmapped and sharp at every size (and costs nothing per
// frame). Made once per icon, size, accent and icon theme.
const LUMA_POWER = 1.35;
const cache = new Map();
let iconTheme = null;

// Lightness 0-255 -> tinted rgb, as the shader computes it.
function table(accent) {
    const [deep, mid, pale] = tones(accent);
    const out = new Uint8Array(256 * 3);
    for (let i = 0; i < 256; i++) {
        const l = Math.pow(i / 255, LUMA_POWER);
        const [from, to, k] = l < 0.5 ? [deep, mid, l * 2] : [mid, pale, (l - 0.5) * 2];
        for (let c = 0; c < 3; c++)
            out[i * 3 + c] = Math.round(from[c] + (to[c] - from[c]) * k);
    }
    return out;
}

function paint(pixbuf, accent) {
    if (!pixbuf.get_has_alpha())
        pixbuf = pixbuf.add_alpha(false, 0, 0, 0);
    const [w, h, stride] = [pixbuf.get_width(), pixbuf.get_height(), pixbuf.get_rowstride()];
    const pixels = pixbuf.get_pixels().slice();
    const lut = table(accent);
    for (let y = 0; y < h; y++) {
        for (let i = y * stride, end = i + w * 4; i < end; i += 4) {
            if (!pixels[i + 3])
                continue;
            const l = Math.round(0.2126 * pixels[i] + 0.7152 * pixels[i + 1] + 0.0722 * pixels[i + 2]) * 3;
            pixels[i] = lut[l];
            pixels[i + 1] = lut[l + 1];
            pixels[i + 2] = lut[l + 2];
        }
    }
    const content = St.ImageContent.new_with_preferred_size(w, h);
    const context = global.stage.context.get_backend().get_cogl_context();
    content.set_bytes(context, GLib.Bytes.new(pixels), Cogl.PixelFormat.RGBA_8888, w, h, stride);
    return content;
}

// A tinted copy of `gicon` at `pixels` pixels (an St.ImageContent, which St.Icon
// takes as its gicon), or null when the icon can't be loaded.
export function tintedIcon(gicon, pixels, accent) {
    const themeName = St.Settings.get().gtk_icon_theme;
    const key = `${gicon.to_string()}|${pixels}|${accent}|${themeName}`;
    if (cache.has(key))
        return cache.get(key);
    let content = null;
    try {
        iconTheme ??= new St.IconTheme();
        const pixbuf = iconTheme.lookup_by_gicon_for_scale(gicon, pixels, 1, St.IconLookupFlags.FORCE_SIZE)?.load_icon();
        if (pixbuf)
            content = paint(pixbuf, accent);
    } catch (e) {
        console.error(`Jade Shell: tinting ${gicon.to_string()}: ${e.message}`);
    }
    if (cache.size >= 256)
        cache.clear();
    cache.set(key, content);
    return content;
}

export function forgetTinted() {
    cache.clear();
    iconTheme = null;
}
