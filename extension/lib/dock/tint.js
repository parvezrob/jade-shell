import Cogl from 'gi://Cogl';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';

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
        const [r, g, b] = hexToRgb(accent).map(v => v / 255);
        const mix = (to, k) => [r + (to - r) * k, g + (to - g) * k, b + (to - b) * k];
        this.set_uniform_float(this._at.deep, 3, mix(0, 0.72));
        this.set_uniform_float(this._at.mid, 3, [r, g, b]);
        this.set_uniform_float(this._at.pale, 3, mix(1, 0.74));
        this.queue_repaint();
    }
});
