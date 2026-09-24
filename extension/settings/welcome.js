// The Welcome page: the first thing Jade Shell shows after setup (the
// extension opens the app on it once, at the first login), and the app's
// first page after that. Pick your look, the weather's city and AI usage,
// learn a handful of keys, and be done. Everything applies right away and is
// optional: closing it keeps the defaults.
import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {capture, choiceRow, jadeCommand} from './common.js';
import {weatherGroup} from './weather.js';

const COLUMNS = 4;

// The keys worth knowing on day one: [setting, what it does].
const KEYS = [
    ['toggle-picker', 'Pick a theme'],
    ['toggle-menu', 'The Jade Menu: apps, capture, toggles, settings'],
    ['show-cheatsheet', 'Every keyboard shortcut'],
    ['toggle-clipboard', 'Clipboard history'],
];

function intro() {
    const group = new Adw.PreferencesGroup();
    const box = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 6, margin_bottom: 6});
    box.append(new Gtk.Label({label: 'Welcome to Jade Shell', xalign: 0, css_classes: ['title-1']}));
    box.append(new Gtk.Label({
        label: 'Pick your look. Everything here applies right away, and you can change it any time: ' +
            'search for Jade Shell, or click its button in Quick Settings.',
        xalign: 0, wrap: true, css_classes: ['dim-label'],
    }));
    group.add(box);
    return group;
}

// The themes as the picker shows them: previews to click.
function themesGroup() {
    const group = new Adw.PreferencesGroup({title: 'Theme'});
    const status = new Gtk.Label({xalign: 0, css_classes: ['dim-label', 'caption'], margin_top: 6});
    const flow = new Gtk.FlowBox({
        homogeneous: true, max_children_per_line: COLUMNS, min_children_per_line: COLUMNS, column_spacing: 10, row_spacing: 10,
        selection_mode: Gtk.SelectionMode.SINGLE, activate_on_single_click: true,
    });
    group.add(flow);
    group.add(status);
    const jade = jadeCommand();
    let themes = [];
    const load = async () => {
        const result = jade ? await capture([jade, 'theme', 'list', '--json']) : {ok: false};
        try {
            themes = result.ok ? JSON.parse(result.stdout) : [];
        } catch {
            themes = [];
        }
        for (let child = flow.get_first_child(); child; child = flow.get_first_child())
            flow.remove(child);
        for (const theme of themes) {
            const tile = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 4, css_classes: ['jade-welcome-theme']});
            const picture = new Gtk.Picture({content_fit: Gtk.ContentFit.COVER, height_request: 64, can_shrink: true});
            if (theme.thumbnail && GLib.file_test(theme.thumbnail, GLib.FileTest.EXISTS))
                picture.set_filename(theme.thumbnail);
            tile.append(picture);
            tile.append(new Gtk.Label({label: theme.name, xalign: 0, ellipsize: 3, css_classes: ['caption']}));
            flow.append(tile);
            if (theme.current)
                flow.select_child(flow.get_child_at_index(themes.indexOf(theme)));
        }
        if (!themes.length)
            status.label = 'Could not list the themes. Run: jade doctor';
    };
    flow.connect('child-activated', async (_flow, child) => {
        const theme = themes[child.get_index()];
        if (!theme || theme.current)
            return;
        flow.sensitive = false;
        status.label = `Switching to ${theme.name}…`;
        const result = await capture([jade, 'theme', 'set', theme.id]);
        status.label = result.ok ? `${theme.name} is on. The picker has it too: the palette icon in the top bar.`
            : `Did not work: ${(result.stderr || result.stdout).trim().split('\n').pop()}`;
        await load();
        flow.sensitive = true;
    });
    load();
    return group;
}

function lookGroup(settings, iconsRow) {
    const group = new Adw.PreferencesGroup({title: 'Look'});
    const glass = choiceRow(settings, 'glass', [['solid', 'Solid'], ['frosted', 'Frosted']],
        {title: 'Glass', subtitle: 'Frosted: the top bar, menus and pop-ups blur what is behind them'});
    group.add(glass);
    iconsRow(settings, group);
    return group;
}

// A key as GNOME writes it, e.g. <Super><Control><Shift>space.
function shortcutRow(settings, key, title) {
    const row = new Adw.ActionRow({title});
    const accel = settings.get_strv(key)[0] ?? '';
    row.add_suffix(accel ? new Gtk.ShortcutLabel({accelerator: accel, valign: Gtk.Align.CENTER})
        : new Gtk.Label({label: 'Not set', css_classes: ['dim-label']}));
    return row;
}

function keysGroup(settings, keymapRow) {
    const group = new Adw.PreferencesGroup({
        title: 'Your keys',
        description: 'A screenshot (Print) now opens a card: edit it, copy its text or pin it on screen.',
    });
    group.add(keymapRow());
    for (const [key, title] of KEYS)
        group.add(shortcutRow(settings, key, title));
    // GNOME's own key for its notification list opens Jade's panel.
    const bell = new Adw.ActionRow({title: 'Notifications'});
    bell.add_suffix(new Gtk.ShortcutLabel({accelerator: '<Super>v', valign: Gtk.Align.CENTER}));
    group.add(bell);
    return group;
}

// AI usage: on when Claude Code or Codex is here, and says which it found.
function usageGroup(settings) {
    const home = GLib.get_home_dir();
    const found = [['.claude', 'Claude Code'], ['.codex', 'Codex']]
        .filter(([dir]) => GLib.file_test(GLib.build_filenamev([home, dir]), GLib.FileTest.IS_DIR))
        .map(([, name]) => name);
    const group = new Adw.PreferencesGroup({title: 'AI usage'});
    const row = new Adw.SwitchRow({
        title: 'Claude and Codex limits in the top bar',
        subtitle: found.length ? `Found ${found.join(' and ')} on this computer` : 'Neither Claude Code nor Codex is set up here',
    });
    settings.bind('show-usage', row, 'active', Gio.SettingsBindFlags.DEFAULT);
    group.add(row);
    return group;
}

export function welcomePage(settings, {window, iconsRow, keymapRow}) {
    const page = new Adw.PreferencesPage({name: 'welcome', title: 'Welcome', icon_name: 'go-home-symbolic'});
    page.add(intro());
    page.add(themesGroup());
    page.add(lookGroup(settings, iconsRow));
    page.add(weatherGroup(settings, {
        title: 'Weather',
        description: 'Jade fetches the weather for the city you pick and shows it in the top bar.',
    }));
    page.add(keysGroup(settings, keymapRow));
    page.add(usageGroup(settings));
    const done = new Adw.PreferencesGroup();
    const button = new Gtk.Button({label: 'Done', halign: Gtk.Align.CENTER, css_classes: ['suggested-action', 'pill']});
    button.connect('clicked', () => window.close());
    done.add(button);
    page.add(done);
    return page;
}
