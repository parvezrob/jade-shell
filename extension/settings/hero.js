import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gtk from 'gi://Gtk';

import {stateFile} from './style.js';

const SWATCHES = ['accent', 'red', 'yellow', 'green', 'cyan', 'blue', 'magenta', 'foreground'];

// The top of the settings: the current theme's preview, its name and its
// palette, the way the picker shows it. `update` follows theme switches.
export function hero(version) {
    const group = new Adw.PreferencesGroup();
    const box = new Gtk.Box({spacing: 18, css_classes: ['card', 'jade-hero']});
    const picture = new Gtk.Picture({
        content_fit: Gtk.ContentFit.COVER, width_request: 176, height_request: 110, can_shrink: true,
        css_classes: ['jade-hero-picture'],
    });
    box.append(picture);

    const text = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 4, valign: Gtk.Align.CENTER, hexpand: true});
    text.append(new Gtk.Label({label: 'JADE SHELL · CURRENT THEME', xalign: 0, css_classes: ['jade-caps']}));
    const name = new Gtk.Label({xalign: 0, css_classes: ['jade-hero-name'], ellipsize: 3});
    text.append(name);
    const meta = new Gtk.Label({xalign: 0, css_classes: ['dim-label']});
    text.append(meta);
    const strip = new Gtk.Box({spacing: 4, margin_top: 6});
    let colors = {};
    for (const key of SWATCHES) {
        const swatch = new Gtk.DrawingArea({content_width: 16, content_height: 16, tooltip_text: key});
        swatch.set_draw_func((_area, cr, width, height) => {
            const rgba = new Gdk.RGBA();
            if (!rgba.parse(colors[key] ?? '#888888'))
                return;
            cr.setSourceRGBA(rgba.red, rgba.green, rgba.blue, 1);
            cr.rectangle(0, 0, width, height);
            cr.fill();
        });
        strip.append(swatch);
    }
    text.append(strip);
    box.append(text);
    group.add(box);

    const update = theme => {
        colors = theme.colors;
        name.label = theme.name;
        meta.label = [version ? `Version ${version}` : 'Development copy',
            theme.colors.mode === 'light' ? 'light theme' : 'dark theme'].join(' · ');
        const thumb = stateFile('thumbs', `${theme.id}.png`);
        picture.set_file(thumb.query_exists(null) ? thumb : null);
        picture.visible = thumb.query_exists(null);
        for (let child = strip.get_first_child(); child; child = child.get_next_sibling())
            child.queue_draw();
    };
    return {group, update};
}
