// The Jade Menu: one keyboard menu for everything, on Super+Alt+Space.
// Inspired by the Omarchy Menu; the structure and code are Jade's own.
//
// Apps, Capture, Toggles (with live check marks), Style, Setup, Learn and
// System, in a searchable tree framed like Jade's panels. Typing searches the
// whole tree; arrows move, Enter or → opens, ← or Backspace goes back, Escape
// closes. Entries of one's own come from ~/.config/jade-shell/menu.json:
//   {"items": [{"path": "Setup/Edit my notes", "command": "gnome-text-editor ~/notes.md"}]}
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';
import * as SystemActions from 'resource:///org/gnome/shell/misc/systemActions.js';

import {notify} from './notify.js';
import {jadeCommand, openSettings, run, SPAWN} from './util.js';

const README = 'https://github.com/parvezrob/jade-shell#readme';
const MAX_RESULTS = 60;

// A command line, started in the background (the shell's PATH, ~ expanded).
function launch(commandLine) {
    try {
        const [, argv] = GLib.shell_parse_argv(commandLine.replace(/(^|\s)~(?=\/|\s|$)/g, `$1${GLib.get_home_dir()}`));
        Gio.Subprocess.new(argv, SPAWN);
    } catch (e) {
        notify('Could not run it', `${commandLine}\n${e.message}`);
    }
}

// `jade …`, told about by a notification only when it fails.
async function jade(...args) {
    const command = jadeCommand();
    if (!command) {
        notify('Jade Shell', 'The jade command is missing. Reinstall Jade Shell.');
        return null;
    }
    const result = await run([command, ...args]);
    if (!result.ok)
        notify(`jade ${args[0]} ${args[1] ?? ''} did not work`, (result.stderr || result.stdout).trim().split('\n').pop());
    return result;
}

// Shortcuts that open the menu at one of its branches, as Omarchy's do.
const BRANCH_KEYS = [['menu-capture', 'Capture'], ['menu-toggles', 'Toggles'], ['menu-system', 'System']];

function readJson(path) {
    try {
        const [, bytes] = Gio.File.new_for_path(path).load_contents(null);
        return JSON.parse(new TextDecoder().decode(bytes));
    } catch {
        return null;
    }
}

export class JadeMenu {
    constructor(extension, settings, parts) {
        this._extension = extension;
        this._settings = settings;
        this._parts = parts;  // (ClassName) → the running part, or null
    }

    enable() {
        this._enabled = {};  // a new token each time: work queued before a disable is dropped
        Main.wm.addKeybinding('toggle-menu', this._settings, Meta.KeyBindingFlags.NONE,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW, () => this.toggle());
        for (const [key, start] of BRANCH_KEYS) {
            Main.wm.addKeybinding(key, this._settings, Meta.KeyBindingFlags.NONE,
                Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW, () => this.toggle(start));
        }
    }

    disable() {
        Main.wm.removeKeybinding('toggle-menu');
        for (const [key] of BRANCH_KEYS)
            Main.wm.removeKeybinding(key);
        this._dialog?.destroy();
        this._dialog = null;
        this._enabled = null;
    }

    toggle(start = null) {
        if (this._dialog)
            this._dialog.close();
        else
            this.open(start);
    }

    // ---------------------------------------------------------------- the tree

    // Each entry: {label, icon, children?: () => entries, action?: () => void,
    // checked?: () => bool, hint?}. Built each time the menu opens, so check
    // marks and lists are current.
    _tree() {
        const settings = this._settings;
        const iface = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        const notifications = new Gio.Settings({schema_id: 'org.gnome.desktop.notifications'});
        const color = new Gio.Settings({schema_id: 'org.gnome.settings-daemon.plugins.color'});
        const system = SystemActions.getDefault();
        const modes = this._parts('Modes');
        const toggle = (label, icon, get, set) => ({label, icon, checked: get, action: () => set(!get())});
        const setting = (key, label, icon) => toggle(label, icon, () => settings.get_boolean(key),
            on => settings.set_boolean(key, on));
        const own = name => new Gio.FileIcon({file: this._extension.dir.get_child('icons').get_child(`${name}-symbolic.svg`)});
        const state = readJson(GLib.build_filenamev([GLib.get_user_state_dir(), 'jade-shell', 'current.json'])) ?? {};

        const tree = [
            {label: 'Apps', icon: 'view-app-grid-symbolic', children: () => this._apps()},
            {label: 'Clipboard History', icon: 'edit-paste-symbolic', action: () => this._parts('ClipboardHistory')?.open()},
            {label: 'Capture', icon: 'camera-photo-symbolic', children: () => [
                {label: 'Screenshot', icon: 'camera-photo-symbolic', action: () => Main.screenshotUI.open(0)},
                {label: 'Screen Recording', icon: 'camera-web-symbolic', action: () => Main.screenshotUI.open(1)},
                {label: 'Color Picker', icon: 'color-select-symbolic', action: () => this._parts('Capture')?.pickColor()},
                {label: 'Copy Text from Screen', icon: 'format-text-plaintext-symbolic', action: () => this._parts('Capture')?.grab('tesseract')},
                {label: 'Read QR Code', gicon: own('qr'), action: () => this._parts('Capture')?.grab('zbarimg')},
            ]},
            {label: 'Toggles', icon: 'emblem-system-symbolic', children: () => [
                ...modes ? [{...toggle('Stay Awake', null, () => modes.awake, on => modes.setAwake(on)), gicon: own('awake')}] : [],
                toggle('Night Light', 'night-light-symbolic', () => color.get_boolean('night-light-enabled'),
                    on => color.set_boolean('night-light-enabled', on)),
                toggle('Do Not Disturb', 'notifications-disabled-symbolic',
                    () => !notifications.get_boolean('show-banners'), on => notifications.set_boolean('show-banners', !on)),
                toggle('Dark Style', 'weather-clear-night-symbolic', () => iface.get_string('color-scheme') === 'prefer-dark',
                    on => iface.set_string('color-scheme', on ? 'prefer-dark' : 'default')),
                setting('show-dock', 'Dock', 'user-bookmarks-symbolic'),
                toggle('Frosted Glass', 'weather-fog-symbolic', () => settings.get_string('glass') === 'frosted',
                    on => settings.set_string('glass', on ? 'frosted' : 'solid')),
                {...setting('show-monitor', 'System Monitor', null), gicon: own('cpu')},
                {...setting('show-usage', 'AI Usage', null), gicon: own('ai-usage')},
                {...setting('notification-bell', 'Notification Bell', null), gicon: own('bell')},
            ]},
            {label: 'Style', icon: 'applications-graphics-symbolic', children: () => [
                {label: 'Theme', icon: 'preferences-desktop-appearance-symbolic', children: () => this._themes(state.theme)},
                {label: 'Next Wallpaper', icon: 'preferences-desktop-wallpaper-symbolic', action: () => jade('theme', 'wallpaper')},
                {label: 'Theme Picker', icon: 'view-grid-symbolic', action: () => this._parts('Picker')?.toggle()},
                {label: 'Font', icon: 'preferences-desktop-font-symbolic', children: () => this._fonts()},
                {label: 'Icons', icon: 'image-x-generic-symbolic', children: () => this._icons()},
            ]},
            {label: 'Setup', icon: 'preferences-system-symbolic', children: () => [
                {label: 'Jade Shell Settings', icon: 'preferences-system-symbolic', action: () => openSettings()},
                {label: 'GNOME Settings', icon: 'org.gnome.Settings-symbolic', action: () => launch('gnome-control-center')},
                {label: 'Network', icon: 'network-wired-symbolic', action: () => this._parts('Network')?.toggle()},
                {label: 'Speed Test', icon: 'network-transmit-receive-symbolic', action: () => this._parts('Network')?.toggle(true)},
                {label: 'Keyboard Shortcuts', icon: 'input-keyboard-symbolic', action: () => this._parts('CheatSheet')?.open()},
                {label: 'Check for Updates', icon: 'software-update-available-symbolic', action: () => this._checkUpdates()},
                {label: 'Undo the Last Theme Switch', icon: 'edit-undo-symbolic', action: () => jade('theme', 'undo')},
            ]},
            {label: 'Learn', icon: 'help-browser-symbolic', children: () => [
                {label: 'Keyboard Shortcuts', icon: 'input-keyboard-symbolic', action: () => this._parts('CheatSheet')?.open()},
                {label: 'Jade Shell Manual', icon: 'help-browser-symbolic', action: () => Gio.AppInfo.launch_default_for_uri(README, null)},
            ]},
            {label: 'System', icon: 'system-shutdown-symbolic', children: () => [
                {label: 'Lock', icon: 'system-lock-screen-symbolic', action: () => system.activateLockScreen()},
                ...system.canSuspend ? [{label: 'Suspend', icon: 'media-playback-pause-symbolic', action: () => system.activateSuspend()}] : [],
                {label: 'Log Out…', icon: 'system-log-out-symbolic', action: () => system.activateLogout()},
                {label: 'Restart…', icon: 'system-reboot-symbolic', action: () => system.activateRestart()},
                {label: 'Power Off…', icon: 'system-shutdown-symbolic', action: () => system.activatePowerOff()},
            ]},
        ];
        this._addOwn(tree);
        return tree;
    }

    _apps() {
        return Shell.AppSystem.get_default().get_installed()
            .filter(info => info.should_show())
            .map(info => ({label: info.get_display_name(), appIcon: info.get_icon(), app: info.get_id(),
                action: () => Shell.AppSystem.get_default().lookup_app(info.get_id())?.activate()}))
            .sort((a, b) => a.label.localeCompare(b.label));
    }

    _themes(current) {
        return (this._themeList ?? []).map(({id, name}) => ({label: name, icon: 'preferences-desktop-appearance-symbolic',
            checked: () => id === current, action: () => jade('theme', 'set', id)}));
    }

    async _loadThemes() {
        const command = jadeCommand();
        if (!command)
            return;
        const result = await run([command, 'theme', 'list', '--json']);
        try {
            this._themeList = JSON.parse(result.stdout).map(({id, name}) => ({id, name}));
        } catch {}
        this._refreshOpenBranch('Theme');
    }

    // A submenu entered before its list had loaded fills in now.
    _refreshOpenBranch(label) {
        const top = this._stack?.at(-1);
        if (!this._dialog || top?.label !== label || !top.children)
            return;
        top.entries = top.children();
        this._show();
    }

    _fonts() {
        return (this._fontList?.families ?? []).map(family => ({
            label: family, icon: 'preferences-desktop-font-symbolic',
            checked: () => family === this._fontList.current, action: () => jade('font', 'set', family),
        }));
    }

    async _loadFonts() {
        const command = jadeCommand();
        if (!command)
            return;
        const result = await run([command, 'font', 'list', '--json']);
        try {
            this._fontList = JSON.parse(result.stdout);
        } catch {}
        this._refreshOpenBranch('Font');
    }

    _icons() {
        const iface = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        const tahoe = () => iface.get_string('icon-theme').startsWith('Jade-MacTahoe');
        const style = () => this._settings.get_string('dock-icon-style');
        const pick = async (wantTahoe, wantStyle) => {
            this._settings.set_string('dock-icon-style', wantStyle);
            if (wantTahoe !== tahoe())
                await jade('apps', wantTahoe ? 'on' : 'off', 'icons');
        };
        return [['GNOME', false, 'color'], ['GNOME, Tinted', false, 'tinted'], ['Tahoe', true, 'color'],
            ['Tahoe, Tinted', true, 'tinted']].map(([label, wantTahoe, wantStyle]) => ({
            label, icon: 'image-x-generic-symbolic', checked: () => tahoe() === wantTahoe && style() === wantStyle,
            action: () => pick(wantTahoe, wantStyle),
        }));
    }

    async _checkUpdates() {
        const result = await jade('update', '--check', '--json');
        if (!result?.ok)
            return;
        try {
            const {latest, current, available, error} = JSON.parse(result.stdout);
            if (error) {
                notify('Could not check for updates', error);
            } else {
                notify(available ? `Jade Shell ${latest} is out` : 'Jade Shell is up to date',
                    available ? `You have ${current}. Update with: jade update` : `Version ${current}.`);
            }
        } catch {}
    }

    // ~/.config/jade-shell/menu.json: {"items": [{"path": "Section/Label", "command": "…"}]}
    _addOwn(tree) {
        const own = readJson(GLib.build_filenamev([GLib.get_user_config_dir(), 'jade-shell', 'menu.json']));
        for (const item of own?.items ?? []) {
            const parts = String(item.path ?? '').split('/').map(p => p.trim()).filter(Boolean);
            if (!parts.length || !item.command)
                continue;
            let level = tree;
            for (const name of parts.slice(0, -1)) {
                let branch = level.find(entry => entry.label.toLowerCase() === name.toLowerCase() && entry.children);
                if (!branch) {
                    branch = {label: name, icon: 'folder-symbolic', own: []};
                    branch.children = () => branch.own;
                    level.push(branch);
                }
                if (!branch.own) {
                    const base = branch.children;
                    branch.own = [];
                    branch.children = () => [...base(), ...branch.own];
                }
                level = branch.own;
            }
            level.push({label: parts.at(-1), icon: item.icon ?? 'system-run-symbolic', action: () => launch(item.command)});
        }
    }

    // ---------------------------------------------------------------- the panel

    open(start = null) {
        this._loadThemes();
        this._loadFonts();
        const dialog = new ModalDialog.ModalDialog({styleClass: 'jade-menu', destroyOnClose: true});
        this._dialog = dialog;
        dialog.connect('destroy', () => {
            if (this._dialog === dialog)
                this._dialog = null;
        });
        this._root = this._tree();
        this._stack = [];  // [{label, entries}] of the submenus opened
        this._title = new St.Label({style_class: 'jade-menu-title'});
        this._entry = new St.Entry({style_class: 'jade-menu-search', hint_text: 'Search…', can_focus: true, x_expand: true});
        this._list = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style_class: 'jade-menu-list'});
        this._scroll = new St.ScrollView({
            style_class: 'jade-menu-scroll', hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC, overlay_scrollbars: true, child: this._list,
        });
        this._scroll.style = `max-height: ${Math.round(Main.layoutManager.primaryMonitor.height * 0.5)}px;`;
        dialog.contentLayout.add_child(this._title);
        dialog.contentLayout.add_child(this._entry);
        dialog.contentLayout.add_child(this._scroll);
        dialog.buttonLayout.hide();  // keys and clicks only: no buttons
        this._entry.clutter_text.connect('text-changed', () => this._show());
        this._entry.clutter_text.connect('key-press-event', (_t, event) => this._key(event));
        if (start) {
            const branch = this._root.find(entry => entry.label.toLowerCase() === start.toLowerCase());
            if (branch?.children)
                this._stack.push({label: branch.label, entries: branch.children(), children: branch.children});
        }
        this._floor = this._stack.length;  // opened at a branch (Super+Escape…): Escape closes from there
        this._show();
        dialog.open(global.get_current_time());
        GLib.idle_add_once(GLib.PRIORITY_DEFAULT, () => {
            if (this._dialog === dialog)
                this._entry.grab_key_focus();
        });
    }

    _entries() {
        return this._stack.at(-1)?.entries ?? this._root;
    }

    // Everything under the root, for searching: [{entry, path}].
    _flatten() {
        const out = [];
        const walk = (entries, path, depth) => {
            for (const entry of entries) {
                out.push({entry, path});
                // Apps are searched too, by name; deeper lists only by what is open.
                if (entry.children && depth < 2)
                    walk(entry.children(), [...path, entry.label], depth + 1);
            }
        };
        walk(this._root, [], 0);
        return out;
    }

    _show() {
        const query = this._entry.get_text().trim().toLowerCase();
        let rows;
        if (query) {
            const score = label => {
                const text = label.toLowerCase();
                if (text === query)
                    return 0;
                if (text.startsWith(query))
                    return 1;
                if (text.split(/\s+/).some(word => word.startsWith(query)))
                    return 2;
                return text.includes(query) ? 3 : null;
            };
            rows = this._flatten().map(row => ({...row, score: score(row.entry.label)}))
                .filter(row => row.score !== null)
                .sort((a, b) => a.score - b.score || a.path.length - b.path.length || a.entry.label.localeCompare(b.entry.label))
                .slice(0, MAX_RESULTS);
            this._title.text = 'JADE MENU · SEARCH';
        } else {
            rows = this._entries().map(entry => ({entry, path: []}));
            this._title.text = ['JADE MENU', ...this._stack.map(level => level.label.toUpperCase())].join(' › ');
        }
        this._rows = rows;
        this._list.destroy_all_children();
        rows.forEach((row, i) => this._list.add_child(this._row(row, i)));
        this._select(0);
    }

    _row({entry, path}, index) {
        const box = new St.BoxLayout({style_class: 'jade-menu-row-box', x_expand: true});
        const icon = entry.appIcon ? new St.Icon({gicon: entry.appIcon, style_class: 'jade-menu-app-icon'})
            : new St.Icon({gicon: entry.gicon ?? new Gio.ThemedIcon({name: entry.icon ?? 'emblem-default-symbolic'}),
                style_class: 'jade-menu-icon'});
        box.add_child(icon);
        box.add_child(new St.Label({text: entry.label, style_class: 'jade-menu-label', y_align: Clutter.ActorAlign.CENTER}));
        if (path.length)
            box.add_child(new St.Label({text: path.join(' › '), style_class: 'jade-menu-path', y_align: Clutter.ActorAlign.CENTER}));
        box.add_child(new St.Widget({x_expand: true}));
        let mark = '';
        try {
            mark = entry.checked?.() ? '✓' : '';
        } catch {}
        if (entry.children)
            mark = '›';
        box.add_child(new St.Label({text: mark, style_class: 'jade-menu-mark', y_align: Clutter.ActorAlign.CENTER}));
        const button = new St.Button({style_class: 'jade-menu-row', child: box, x_expand: true, can_focus: false});
        button.connect('clicked', () => this._activate(index));
        button.connect('enter-event', () => this._select(index, false));
        return button;
    }

    _select(index, scroll = true) {
        const rows = this._list.get_children();
        if (!rows.length) {
            this._selected = -1;
            return;
        }
        this._selected = (index + rows.length) % rows.length;
        rows.forEach((row, i) => (i === this._selected ? row.add_style_pseudo_class('selected')
            : row.remove_style_pseudo_class('selected')));
        if (scroll) {
            const row = rows[this._selected];
            const adjustment = this._scroll.vadjustment;
            const box = row.get_allocation_box();
            if (box.y1 < adjustment.value)
                adjustment.value = box.y1;
            else if (box.y2 > adjustment.value + adjustment.page_size)
                adjustment.value = box.y2 - adjustment.page_size;
        }
    }

    _activate(index = this._selected) {
        const row = this._rows?.[index];
        if (!row)
            return;
        const {entry} = row;
        if (entry.children) {
            this._stack.push({label: entry.label, entries: entry.children(), children: entry.children});
            this._entry.set_text('');
            this._show();
            return;
        }
        const keepOpen = Boolean(entry.checked);  // toggles stay open, their marks change
        const act = () => {
            try {
                entry.action?.();
            } catch (e) {
                notify('Jade Menu', e.message);
            }
        };
        if (!keepOpen) {
            // Closed first: an action may open a dialog of its own.
            this._dialog?.close();
            const enabled = this._enabled;
            GLib.idle_add_once(GLib.PRIORITY_DEFAULT, () => {
                if (enabled === this._enabled)  // not after the extension went (the screen locked)
                    act();
            });
            return;
        }
        act();
        if (keepOpen) {
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => {
                if (this._dialog && this._rows)
                    this._refreshMarks();
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    _refreshMarks() {
        this._list.get_children().forEach((button, i) => {
            const entry = this._rows[i]?.entry;
            if (!entry?.checked)
                return;
            const mark = button.child.get_last_child();
            try {
                mark.text = entry.checked() ? '✓' : '';
            } catch {}
        });
    }

    _back() {
        if (this._stack.length) {
            this._stack.pop();
            this._show();
            return true;
        }
        return false;
    }

    _key(event) {
        const key = event.get_key_symbol();
        const empty = this._entry.get_text() === '';
        switch (key) {
        case Clutter.KEY_Down:
        case Clutter.KEY_Tab:
            this._select(this._selected + 1);
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Up:
        case Clutter.KEY_ISO_Left_Tab:
            this._select(this._selected - 1);
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Return:
        case Clutter.KEY_KP_Enter:
            this._activate();
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Right:
            if (empty && this._rows?.[this._selected]?.entry.children) {
                this._activate();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        case Clutter.KEY_Left:
        case Clutter.KEY_BackSpace:
            if (empty && this._back())
                return Clutter.EVENT_STOP;
            return Clutter.EVENT_PROPAGATE;
        case Clutter.KEY_Escape:
            if (!empty)
                this._entry.set_text('');
            else if (this._stack.length <= this._floor || !this._back())
                this._dialog.close();
            return Clutter.EVENT_STOP;
        default:
            return Clutter.EVENT_PROPAGATE;
        }
    }
}
