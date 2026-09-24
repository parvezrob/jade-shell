import Cogl from 'gi://Cogl';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Background from 'resource:///org/gnome/shell/ui/background.js';

// The dock's material, drawn in one shader pass: the wallpaper behind the
// dock, blurred and with its colors lifted (macOS's "vibrancy"), a tint in the
// theme's colors, a light sheen at the top, a hairline edge, and the soft
// shadow under it, all cut to a continuous-curvature rounded shape.
//
// The shape changes every frame while icons magnify, so it is a uniform, not
// a layout: the actor spans the monitor's width and never moves, the
// blurred wallpaper inside it is rendered once and cached, and a frame costs
// one textured quad. (St's own box-shadow re-blurs on the CPU at every size.)
//
// The wallpaper is the desktop's own, not what is on screen: the dock hides
// when a window comes near, so the wallpaper is what is behind it.

const DECLARATIONS = `
uniform sampler2D tex;
uniform vec2 size;
uniform vec4 rect;
uniform float radius;
uniform float saturation;
uniform float wall;
uniform vec4 tint;
uniform vec4 edge;
uniform float sheen;
uniform vec3 shadow;

// Signed distance to a rounded rectangle whose corners follow a 4-norm
// (a squircle, as macOS draws them) instead of a circle.
float shape(vec2 p, vec4 r, float rad) {
    vec2 hs = r.zw * 0.5;
    vec2 q = abs(p - (r.xy + hs)) - (hs - rad);
    vec2 m = max(q, 0.0);
    float n = pow(pow(m.x, 4.0) + pow(m.y, 4.0), 0.25);
    return n + min(max(q.x, q.y), 0.0) - rad;
}
`;

const CODE = `
vec2 uv = cogl_tex_coord_in[0].xy;
vec2 p = uv * size;
float d = shape(p, rect, radius);
float inside = clamp(0.5 - d, 0.0, 1.0);
float ring = inside - clamp(-0.5 - d, 0.0, 1.0);

vec4 bg = texture2D(tex, uv) * wall;
float luma = dot(bg.rgb, vec3(0.2126, 0.7152, 0.0722));
bg.rgb = clamp(mix(vec3(luma * bg.a), bg.rgb, saturation), 0.0, 1.0);
vec4 c = tint + bg * (1.0 - tint.a);
float top = sheen * (1.0 - smoothstep(rect.y, rect.y + rect.w * 0.55, p.y));
c.rgb = mix(c.rgb, vec3(c.a), top);
c = edge * ring + c * (1.0 - edge.a * ring);
c *= inside;

float ds = shape(p - vec2(0.0, shadow.x), rect, radius);
float s = shadow.z * (1.0 - smoothstep(-shadow.y * 0.25, shadow.y, ds)) * (1.0 - inside);
cogl_color_out = c + vec4(0.0, 0.0, 0.0, s) * (1.0 - c.a);
`;

const GlassEffect = GObject.registerClass(
class JadeGlassEffect extends Shell.GLSLEffect {
    constructor() {
        super();
        this._at = {};
        for (const name of ['size', 'rect', 'radius', 'saturation', 'wall', 'tint', 'edge', 'sheen', 'shadow'])
            this._at[name] = this.get_uniform_location(name);
    }

    vfunc_build_pipeline() {
        this.add_glsl_snippet(Cogl.SnippetHook.FRAGMENT, DECLARATIONS, CODE, true);
    }

    set(name, values) {
        this.set_uniform_float(this._at[name], values.length, values);
    }
});

// [r, g, b] from '#rrggbb' (or '#rgb').
export function hexToRgb(hex) {
    let h = (hex ?? '#888888').replace('#', '');
    if (h.length === 3)
        h = [...h].map(c => c + c).join('');
    const n = parseInt(h.slice(0, 6), 16);
    return Number.isNaN(n) ? [136, 136, 136] : [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// Premultiplied RGBA from '#rrggbb' and an alpha.
function premultiplied(hex, alpha) {
    const [r, g, b] = hexToRgb(hex);
    return [r / 255 * alpha, g / 255 * alpha, b / 255 * alpha, alpha];
}

export class Glass {
    // `parent` spans the monitor; the glass takes its bottom `height` pixels.
    constructor(parent, monitorIndex) {
        this.actor = new St.Widget({clip_to_allocation: true, reactive: false});
        this._wall = new St.Widget({reactive: false});
        this._blur = new Shell.BlurEffect({mode: Shell.BlurMode.ACTOR, radius: 60, brightness: 1});
        this._wall.add_effect(this._blur);
        this.actor.add_child(this._wall);
        this._effect = new GlassEffect();
        this.actor.add_effect(this._effect);
        parent.add_child(this.actor);

        this._backgrounds = new Background.BackgroundManager({
            container: this._wall, monitorIndex, vignette: false, controlPosition: false,
        });
        this._rect = [0, 0, 0, 0];
        this.useWallpaper = true;
    }

    destroy() {
        this._backgrounds.destroy();
        this.actor.destroy();
    }

    // Where the glass sits in the monitor-sized parent.
    place(width, top, height, monitorHeight) {
        this.actor.set_position(0, top);
        this.actor.set_size(width, height);
        this._wall.set_position(0, -top);
        this._wall.set_size(width, monitorHeight);
        this._effect.set('size', [width, height]);
    }

    // Keep the wallpaper still while the dock slides (it lives inside it).
    set slide(offset) {
        this._wall.translation_y = -offset;
    }

    set useWallpaper(on) {
        this._wall.visible = on;
        this._effect.set('wall', [on ? 1 : 0]);
        this._effect.set('saturation', [1.8]);
    }

    style(palette, {radius, scale}) {
        const light = palette.mode === 'light';
        const base = palette.dark_background ?? palette.background;
        this._effect.set('tint', premultiplied(light ? palette.background : base, light ? 0.42 : 0.38));
        this._effect.set('edge', light ? [0, 0, 0, 0.1] : [0.12, 0.12, 0.12, 0.12]);
        this._effect.set('sheen', [light ? 0.12 : 0.06]);
        this._effect.set('shadow', [4 * scale, 22 * scale, light ? 0.18 : 0.34]);
        this._effect.set('radius', [radius]);
        this._effect.queue_repaint();
    }

    // The dock's shape, in the glass's coordinates.
    shape(x, y, width, height) {
        const rect = [x, y, width, height];
        if (rect.every((v, i) => Math.abs(v - this._rect[i]) < 0.01))
            return;
        this._rect = rect;
        this._effect.set('rect', rect);
        this._effect.queue_repaint();
    }
}
