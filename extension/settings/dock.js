import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

const BEHAVIORS = [
    ['intellihide', 'When a window is near it'],
    ['autohide', 'Whenever the pointer is away'],
    ['always', 'Never (windows keep clear of it)'],
];

// A row with a slider, bound to a number key.
function scaleRow(settings, group, key, title, subtitle, {lower, upper, step, digits, marks}) {
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
    const page = new Adw.PreferencesPage({title: 'Dock', icon_name: 'user-bookmarks-symbolic'});

    const main = new Adw.PreferencesGroup();
    page.add(main);
    switchRow(settings, main, 'show-dock', 'Jade dock',
        'At the bottom of the screen and in the overview. Off, GNOME’s own dash is back in the overview.');

    const look = new Adw.PreferencesGroup({title: 'Size'});
    page.add(look);
    scaleRow(settings, look, 'dock-icon-size', 'Icon size', null,
        {lower: 32, upper: 80, step: 2, digits: 0, marks: [[32, 'Small'], [48, null], [64, null], [80, 'Large']]});
    scaleRow(settings, look, 'dock-magnification', 'Magnification', 'How large icons grow under the pointer',
        {lower: 1, upper: 2.5, step: 0.05, digits: 2, marks: [[1, 'Off'], [1.6, null], [2.5, 'Large']]});

    const behavior = new Adw.PreferencesGroup({title: 'Behavior'});
    page.add(behavior);
    const hide = new Adw.ComboRow({
        title: 'Hide the dock',
        subtitle: 'Push the pointer against the bottom edge to bring it back',
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
