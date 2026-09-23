// The theme picker: every theme as a wallpaper preview, applied with `jade`.
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {VERTICAL, addToPanel, jadeCommand, label, run} from './util.js';

const COLUMNS = 5;
const ICONS = ['preferences-desktop-appearance-symbolic', 'applications-graphics-symbolic'];

export class Picker {
    constructor(settings, theme) {
        this._settings = settings;
        this._theme = theme;
    }

    enable() {
        this._alive = true;
        this._cancellable = new Gio.Cancellable();
        this._themes = [];
        this._themesKey = null;
        this._tiles = new Map();
        this._busy = false;
        this._build();
        Main.wm.addKeybinding('toggle-picker', this._settings, Meta.KeyBindingFlags.NONE,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW, () => this._button.menu.toggle());
        this._indicatorChanged = this._settings.connect('changed::show-picker', () => this._showIndicator());
        this._showIndicator();
        // A switch rewrites the palette; the picker then marks the new theme.
        this._unfollow = this._theme.follow(() => this._refresh());
    }

    disable() {
        this._alive = false;
        this._cancellable.cancel();
        this._cancellable = null;
        this._unfollow();
        Main.wm.removeKeybinding('toggle-picker');
        this._settings.disconnect(this._indicatorChanged);
        this._button.destroy();
        this._button = this._grid = this._status = this._heroTitle = null;
        this._tiles.clear();
    }

    // The shortcut still opens the picker when the icon is hidden.
    _showIndicator() {
        this._button.visible = this._settings.get_boolean('show-picker');
    }

    _build() {
        this._button = new PanelMenu.Button(0.5, 'Theme picker');
        this._button.add_child(new St.Icon({gicon: new Gio.ThemedIcon({names: ICONS}), style_class: 'system-status-icon'}));
        const menu = this._button.menu;
        menu.box.add_style_class_name('jade-frame');
        menu.box.add_style_class_name('jade-picker');

        const hero = new St.BoxLayout({x_expand: true, style_class: 'jade-hero'});
        hero.add_child(new St.Icon({gicon: new Gio.ThemedIcon({names: ICONS}), style_class: 'jade-hero-icon', y_align: Clutter.ActorAlign.CENTER}));
        const text = new St.BoxLayout({orientation: VERTICAL, x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        this._heroTitle = label('Themes', 'jade-title');
        text.add_child(this._heroTitle);
        text.add_child(label('CURRENT THEME', 'jade-meta'));
        hero.add_child(text);
        this._item(hero);

        this._grid = new St.BoxLayout({orientation: VERTICAL, x_expand: true, style_class: 'jade-grid jade-divided'});
        this._item(this._grid);

        const footer = new St.BoxLayout({x_expand: true, style_class: 'jade-footer jade-divided'});
        this._status = label('', 'jade-status', {x_expand: true});
        footer.add_child(this._status);
        footer.add_child(this._action('Next wallpaper', 'image-x-generic-symbolic', ['theme', 'wallpaper'], 'New wallpaper set'));
        footer.add_child(this._action('Undo', 'edit-undo-symbolic', ['theme', 'undo'], 'Restored the previous look'));
        this._item(footer);

        menu.connect('open-state-changed', (_m, open) => {
            if (!open)
                return;
            this._refresh();
            const current = this._tiles.get(this._current) ?? this._tiles.values().next().value;
            GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                current?.grab_key_focus();
                return GLib.SOURCE_REMOVE;
            });
        });
        addToPanel('jade-picker', this._button);
    }

    _item(actor) {
        const item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false, style_class: 'jade-item'});
        item.add_child(actor);
        this._button.menu.addMenuItem(item);
    }

    _action(text, iconName, args, done) {
        const button = new St.Button({can_focus: true, reactive: true, track_hover: true, style_class: 'jade-action', accessible_name: text});
        const box = new St.BoxLayout({style_class: 'jade-action-content'});
        box.add_child(new St.Icon({icon_name: iconName, icon_size: 14}));
        box.add_child(label(text, 'jade-action-label'));
        button.set_child(box);
        button.connect('clicked', () => this._runJade(args, done));
        return button;
    }

    async _refresh() {
        const jade = jadeCommand();
        if (!jade) {
            this._setStatus('The jade command is not installed', true);
            return;
        }
        const cancellable = this._cancellable;
        const {ok, stdout, stderr} = await run([jade, 'theme', 'list', '--json'], cancellable);
        if (!this._alive || cancellable !== this._cancellable)
            return;
        if (!ok) {
            this._setStatus(stderr.trim().split('\n').pop(), true);
            return;
        }
        const themes = JSON.parse(stdout);
        const key = themes.map(t => `${t.id}:${t.thumbnail}`).join('|');
        if (key !== this._themesKey) {
            this._themesKey = key;
            this._themes = themes;
            this._buildGrid();
        }
        const current = themes.find(t => t.current);
        this._current = current?.id ?? null;
        this._heroTitle.text = current?.name ?? 'No theme applied yet';
        for (const [id, tile] of this._tiles)
            tile[id === this._current ? 'add_style_class_name' : 'remove_style_class_name']('jade-current');
    }

    _buildGrid() {
        this._grid.destroy_all_children();
        this._tiles.clear();
        let row = null;
        this._themes.forEach((theme, index) => {
            if (index % COLUMNS === 0) {
                row = new St.BoxLayout({style_class: 'jade-row'});
                this._grid.add_child(row);
            }
            row.add_child(this._tile(theme, index));
        });
    }

    _tile(theme, index) {
        const tile = new St.Button({can_focus: true, reactive: true, track_hover: true, style_class: 'jade-tile', accessible_name: `Switch to ${theme.name}`});
        const box = new St.BoxLayout({orientation: VERTICAL});
        const thumb = new St.Widget({style_class: 'jade-tile-thumb'});
        thumb.style = theme.thumbnail
            ? `background-image: url("${theme.thumbnail}");`
            : `background-color: ${theme.colors.background}; border-bottom: 6px solid ${theme.colors.accent};`;
        box.add_child(thumb);
        box.add_child(label(theme.name, 'jade-tile-name'));
        tile.set_child(box);
        tile.connect('clicked', () => this._runJade(['theme', 'set', theme.id], `${theme.name} applied`, `Applying ${theme.name}…`));
        tile.connect('key-press-event', (_a, event) => this._onTileKey(index, event));
        this._tiles.set(theme.id, tile);
        return tile;
    }

    // Arrow keys move through the grid; Enter and Space pick (St.Button).
    _onTileKey(index, event) {
        const step = {
            [Clutter.KEY_Left]: -1, [Clutter.KEY_Right]: 1,
            [Clutter.KEY_Up]: -COLUMNS, [Clutter.KEY_Down]: COLUMNS,
        }[event.get_key_symbol()];
        if (step === undefined)
            return Clutter.EVENT_PROPAGATE;
        const target = index + step;
        if (target >= 0 && target < this._themes.length)
            this._tiles.get(this._themes[target].id).grab_key_focus();
        return Clutter.EVENT_STOP;
    }

    // One switch at a time: clicks during a switch are ignored.
    async _runJade(args, done, pending = 'Working…') {
        const jade = jadeCommand();
        if (this._busy || !jade)
            return;
        this._busy = true;
        this._setStatus(pending);
        const cancellable = this._cancellable;
        const {ok, stderr} = await run([jade, ...args], cancellable);
        if (!this._alive || cancellable !== this._cancellable)
            return;
        this._busy = false;
        this._setStatus(ok ? done : (stderr.trim().split('\n').pop() || 'Something went wrong'), !ok);
    }

    _setStatus(text, error = false) {
        this._status.text = text;
        this._status[error ? 'add_style_class_name' : 'remove_style_class_name']('jade-error');
    }
}
