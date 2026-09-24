import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {capture, jadeCommand} from './common.js';

// "Hide the dock: …"
const BEHAVIORS = [
    ['intellihide', 'Near a window'],
    ['autohide', 'Always'],
    ['always', 'Never'],
];

// "Icons: …": which icons, and whether the dock tints them in the theme's colors.
const LOOKS = [
    ['gnome', 'color', 'GNOME'],
    ['gnome', 'tinted', 'GNOME, tinted'],
    ['tahoe', 'color', 'Tahoe'],
    ['tahoe', 'tinted', 'Tahoe, tinted'],
];

// The icons row: Tahoe is Jade's Mac-style icon theme (`jade apps on icons`
// downloads and applies it, `off` puts the old icons back); the tint is the
// dock's own.
export function iconsRow(settings, group) {
    const iface = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
    const row = new Adw.ComboRow({
        title: 'Icons',
        subtitle: 'Tahoe: Mac-style icons, their folders in the theme’s accent (a 10 MB download, about 180 MB once built). Tinted: in the theme’s own shades.',
        model: Gtk.StringList.new(LOOKS.map(([, , label]) => label)),
    });
    const current = () => {
        const icons = iface.get_string('icon-theme').startsWith('Jade-MacTahoe') ? 'tahoe' : 'gnome';
        return Math.max(0, LOOKS.findIndex(([i, style]) => i === icons && style === settings.get_string('dock-icon-style')));
    };
    let syncing = false;
    let busy = false;  // while icons are switched, the row shows the choice being made
    const sync = () => {
        if (busy)
            return;
        syncing = true;
        row.selected = current();
        syncing = false;
    };
    sync();
    const ids = [iface.connect('changed::icon-theme', sync), settings.connect('changed::dock-icon-style', sync)];
    row.connect('destroy', () => {
        iface.disconnect(ids[0]);
        settings.disconnect(ids[1]);
    });
    row.connect('notify::selected', async () => {
        if (syncing)
            return;
        const [icons, style] = LOOKS[row.selected];
        settings.set_string('dock-icon-style', style);
        const now = iface.get_string('icon-theme').startsWith('Jade-MacTahoe') ? 'tahoe' : 'gnome';
        if (icons === now)
            return;
        const jade = jadeCommand();
        if (!jade)
            return;
        row.sensitive = false;
        busy = true;
        const subtitle = row.subtitle;
        row.subtitle = icons === 'tahoe' ? 'Downloading and applying the Tahoe icons…' : 'Putting your icons back…';
        const result = await capture([jade, 'apps', icons === 'tahoe' ? 'on' : 'off', 'icons']);
        row.subtitle = result.ok ? subtitle : `Did not work: ${(result.stderr || result.stdout).trim().split('\n').pop()}`;
        row.sensitive = true;
        busy = false;
        sync();
    });
    group.add(row);
    return row;
}

// A row with a slider, bound to a number key.
export function scaleRow(settings, group, key, title, subtitle, {lower, upper, step, digits, marks}) {
    const adjustment = new Gtk.Adjustment({lower, upper, step_increment: step, page_increment: step * 4});
    const scale = new Gtk.Scale({
        adjustment, digits, draw_value: false, hexpand: true, width_request: 260, valign: Gtk.Align.CENTER,
    });
    for (const [value, label] of marks)
        scale.add_mark(value, Gtk.PositionType.BOTTOM, label);
    settings.bind(key, adjustment, 'value', Gio.SettingsBindFlags.DEFAULT);
    const row = new Adw.ActionRow({title, subtitle});
    row.add_suffix(scale);
    group.add(row);
    return row;
}

// The dock's page: on or off, its size, how much icons grow, when it hides.
export function dockPage(settings, switchRow) {
    const page = new Adw.PreferencesPage({name: 'dock', title: 'Dock', icon_name: 'user-bookmarks-symbolic'});

    const main = new Adw.PreferencesGroup();
    page.add(main);
    switchRow(settings, main, 'show-dock', 'Jade dock',
        'At the bottom of the screen and in the overview. Off, GNOME’s own dash is back in the overview.');

    const look = new Adw.PreferencesGroup({title: 'Look'});
    page.add(look);
    scaleRow(settings, look, 'dock-icon-size', 'Icon size', null,
        {lower: 32, upper: 80, step: 2, digits: 0, marks: [[32, 'Small'], [48, null], [64, null], [80, 'Large']]});
    scaleRow(settings, look, 'dock-magnification', 'Magnification', 'How large icons grow under the pointer',
        {lower: 1, upper: 2.5, step: 0.05, digits: 2, marks: [[1, 'Off'], [1.6, null], [2.5, 'Large']]});

    iconsRow(settings, look);

    const behavior = new Adw.PreferencesGroup({title: 'Behavior'});
    page.add(behavior);
    const hide = new Adw.ComboRow({
        title: 'Hide the dock',
        subtitle: 'Push the pointer against the bottom edge to bring it back. Never: windows keep clear of it.',
        model: Gtk.StringList.new(BEHAVIORS.map(([, label]) => label)),
    });
    const sync = () => {
        hide.selected = Math.max(0, BEHAVIORS.findIndex(([value]) => value === settings.get_string('dock-behavior')));
    };
    sync();
    const changed = settings.connect('changed::dock-behavior', sync);
    hide.connect('notify::selected', () => {
        const value = BEHAVIORS[hide.selected]?.[0];
        if (value && value !== settings.get_string('dock-behavior'))
            settings.set_string('dock-behavior', value);
    });
    page.connect('destroy', () => settings.disconnect(changed));
    behavior.add(hide);
    switchRow(settings, behavior, 'dock-genie', 'Genie effect', 'Windows pour into their icon as they minimize');
    switchRow(settings, behavior, 'dock-bounce', 'Bounce', 'While an app starts, and when it needs your attention');
    switchRow(settings, behavior, 'dock-show-trash', 'Trash', 'Opens in Files; right-click to empty it');

    for (const group of [look, behavior])
        settings.bind('show-dock', group, 'sensitive', Gio.SettingsBindFlags.GET);
    return page;
}
