import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';
import Gettext from 'gettext';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';

import {shortcutKeys} from './util.js';

// Where GNOME's Settings keeps the names and sections of its shortcuts.
const KEYBINDINGS_DIR = '/usr/share/gnome-control-center/keybindings';
const CONTROL_CENTER_DOMAIN = 'gnome-control-center-2.0';
const MEDIA_KEYS = 'org.gnome.settings-daemon.plugins.media-keys';

// Jade Shell's own, first.
const JADE_KEYS = [
    ['toggle-menu', 'Open the Jade Menu'],
    ['toggle-clipboard', 'Clipboard history'],
    ['pick-color', 'Pick a color from the screen'],
    ['capture-text', 'Copy text from the screen'],
    ['toggle-network', 'Network and speed test'],
    ['menu-capture', 'Capture menu'],
    ['menu-toggles', 'Toggles menu'],
    ['menu-system', 'System menu'],
    ['show-cheatsheet', 'Show this cheat sheet'],
    ['toggle-picker', 'Pick a theme'],
    ['bell-show', 'Open the notifications'],
    ['bell-dismiss', 'Dismiss the newest notification'],
    ['bell-dismiss-all', 'Dismiss all notifications'],
    ['bell-open-newest', 'Open the newest notification'],
    ['bell-toggle-dnd', 'Do Not Disturb on or off'],
    ['toggle-stay-awake', 'Stay awake on or off'],
    ['toggle-night-light', 'Night light on or off'],
];

// Every shortcut on this desktop: Jade Shell's, GNOME's (named as GNOME's
// Settings names them), and the ones people added themselves, read afresh
// each time the sheet opens. [{section, title, keys: [['Super', 'K'], …]}]
function collect(settings) {
    const rows = [];
    const accels = value => (Array.isArray(value) ? value : [value]).filter(Boolean);
    const add = (section, title, value) => {
        let keys = accels(value).map(shortcutKeys).filter(k => k.length);
        // The keypad's twin of a key already listed says nothing new.
        if (keys.some(k => !k.at(-1).startsWith('KP')))
            keys = keys.filter(k => !k.at(-1).startsWith('KP'));
        if (keys.length)
            rows.push({section, title, keys});
    };

    for (const [key, title] of JADE_KEYS) {
        if (settings.settings_schema.has_key(key))
            add('Jade Shell', title, settings.get_strv(key));
    }

    const overlay = new Gio.Settings({schema_id: 'org.gnome.mutter'}).get_string('overlay-key');
    add('System', 'Show the overview', overlay ? '<Super>' : null);

    const source = Gio.SettingsSchemaSource.get_default();
    const opened = new Map();
    const open = schema => {
        if (!opened.has(schema))
            opened.set(schema, source.lookup(schema, true) ? new Gio.Settings({schema_id: schema}) : null);
        return opened.get(schema);
    };
    let files = [];
    try {
        const dir = Gio.File.new_for_path(KEYBINDINGS_DIR);
        const children = dir.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
        for (let info; (info = children.next_file(null));)
            files.push(info.get_name());
        files = files.filter(name => name.endsWith('.xml')).sort();
    } catch {}
    const translate = text => Gettext.dgettext(CONTROL_CENTER_DOMAIN, text);
    for (const name of files) {
        let xml;
        try {
            xml = new TextDecoder().decode(Gio.File.new_for_path(`${KEYBINDINGS_DIR}/${name}`).load_contents(null)[1]);
        } catch {
            continue;
        }
        const head = xml.match(/<KeyListEntries([^>]*)>/)?.[1] ?? '';
        const attr = (text, key) => text.match(new RegExp(`\\b${key}="([^"]*)"`))?.[1];
        const section = translate(attr(head, 'name') ?? 'Other');
        for (const [, entry] of xml.matchAll(/<KeyListEntry\b([^>]*?)\/?>/gs)) {
            if (attr(entry, 'hidden') === 'true')
                continue;
            const settingsForKey = open(attr(entry, 'schema') ?? attr(head, 'schema'));
            const key = attr(entry, 'name');
            if (!settingsForKey || !key || !settingsForKey.settings_schema.has_key(key))
                continue;
            const value = settingsForKey.get_value(key).deepUnpack();
            add(section, translate(attr(entry, 'description') ?? key), value);
        }
    }

    const media = open(MEDIA_KEYS);
    for (const path of media?.get_strv('custom-keybindings') ?? []) {
        const custom = new Gio.Settings({schema_id: `${MEDIA_KEYS}.custom-keybinding`, path});
        add('Your shortcuts', custom.get_string('name') || custom.get_string('command'), custom.get_string('binding'));
    }

    // One row for a shortcut listed twice (GNOME's files overlap a little),
    // and each section together, in the order they first appear.
    const seen = new Set();
    const unique = rows.filter(row => {
        const id = `${row.title}|${row.keys.map(k => k.join('+')).join(',')}`;
        return !seen.has(id) && seen.add(id);
    });
    const order = [...new Set(unique.map(row => row.section))];
    return unique.map((row, i) => ({row, i}))
        .sort((a, b) => order.indexOf(a.row.section) - order.indexOf(b.row.section) || a.i - b.i)
        .map(({row}) => row);
}

// The sheet: a search field over the shortcuts, by section. Typing filters
// at once; Escape closes it.
export class CheatSheet {
    constructor(settings) {
        this._settings = settings;
    }

    enable() {
        Main.wm.addKeybinding('show-cheatsheet', this._settings, Meta.KeyBindingFlags.NONE,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW, () => this.toggle());
    }

    disable() {
        Main.wm.removeKeybinding('show-cheatsheet');
        this._dialog?.destroy();
        this._dialog = null;
    }

    toggle() {
        if (this._dialog) {
            this._dialog.close();
            return;
        }
        this.open();
    }

    open() {
        const rows = collect(this._settings);
        const dialog = new ModalDialog.ModalDialog({styleClass: 'jade-cheatsheet', destroyOnClose: true});
        this._dialog = dialog;
        dialog.connect('destroy', () => {
            if (this._dialog === dialog)
                this._dialog = null;
        });

        const title = new St.Label({text: 'KEYBOARD SHORTCUTS', style_class: 'jade-cheatsheet-title'});
        const entry = new St.Entry({
            style_class: 'jade-cheatsheet-search', hint_text: 'Search shortcuts…', can_focus: true, x_expand: true,
        });
        const list = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style_class: 'jade-cheatsheet-list'});
        const scroll = new St.ScrollView({
            style_class: 'jade-cheatsheet-scroll', hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC, overlay_scrollbars: true, child: list,
        });
        const monitor = Main.layoutManager.primaryMonitor;
        scroll.style = `max-height: ${Math.round(monitor.height * 0.62)}px;`;
        dialog.contentLayout.add_child(title);
        dialog.contentLayout.add_child(entry);
        dialog.contentLayout.add_child(scroll);
        const empty = new St.Label({text: 'No shortcut matches.', style_class: 'jade-cheatsheet-empty', visible: false});
        dialog.contentLayout.add_child(empty);

        const shown = query => {
            list.destroy_all_children();
            const words = query.toLowerCase().split(/\s+/).filter(Boolean);
            const matches = rows.filter(row => {
                const text = `${row.section} ${row.title} ${row.keys.map(k => k.join('+')).join(' ')}`.toLowerCase();
                return words.every(word => text.includes(word));
            });
            let section = null;
            for (const row of matches) {
                if (row.section !== section) {
                    section = row.section;
                    list.add_child(new St.Label({text: section.toUpperCase(), style_class: 'jade-cheatsheet-section'}));
                }
                const line = new St.BoxLayout({style_class: 'jade-cheatsheet-row', x_expand: true});
                line.add_child(new St.Label({
                    text: row.title, style_class: 'jade-cheatsheet-name', x_expand: true, y_align: Clutter.ActorAlign.CENTER,
                }));
                const keysBox = new St.BoxLayout({style_class: 'jade-cheatsheet-keys', y_align: Clutter.ActorAlign.CENTER});
                row.keys.slice(0, 2).forEach((keys, i) => {
                    if (i > 0)
                        keysBox.add_child(new St.Label({text: 'or', style_class: 'jade-cheatsheet-or'}));
                    for (const key of keys)
                        keysBox.add_child(new St.Label({text: key, style_class: 'jade-key'}));
                });
                line.add_child(keysBox);
                list.add_child(line);
            }
            empty.visible = matches.length === 0;
        };
        shown('');
        entry.clutter_text.connect('text-changed', () => shown(entry.get_text()));
        dialog.setButtons([{label: 'Close', action: () => dialog.close(), key: Clutter.KEY_Escape}]);
        dialog.open(global.get_current_time());
        GLib.idle_add_once(GLib.PRIORITY_DEFAULT, () => entry.grab_key_focus());
    }
}
