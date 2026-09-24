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

import {familyGicon} from './baricons.js';
import {VERTICAL, addToPanel, jadeCommand, label, openSettings, run} from './util.js';

const COLUMNS = 5;
// After a failed preview download (offline), wait this long before the next try.
const PREVIEW_RETRY_MS = 5 * 60 * 1000;
const ICONS = ['preferences-desktop-appearance-symbolic', 'applications-graphics-symbolic'];

// Until its preview is here, a theme shows its colors: the background with
// an accent stripe, as tall as a preview so the grid keeps its size.
function swatch(colors) {
    const box = new St.BoxLayout({orientation: VERTICAL, style_class: 'jade-tile-thumb'});
    box.add_child(new St.Widget({y_expand: true, style: `background-color: ${colors.background};`}));
    box.add_child(new St.Widget({height: 6, style: `background-color: ${colors.accent};`}));
    return box;
}

// A theme's preview, decoded in a thread and kept in St's cache: as a CSS
// background image it was decoded on the Shell's thread at the first paint
// (46 ms for the grid on the first open after login).
function preview(path) {
    const {scaleFactor} = St.ThemeContext.get_for_stage(global.stage);
    const image = St.TextureCache.get_default().load_file_async(Gio.File.new_for_path(path), 116, 72, scaleFactor, 1);
    return new St.Bin({style_class: 'jade-tile-thumb', child: image});
}

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
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW, () => this.toggle());
        this._indicatorChanged = this._settings.connect('changed::show-picker', () => this._showIndicator());
        this._showIndicator();
        // A switch rewrites the palette; the picker then marks the new theme.
        this._unfollow = this._theme.follow(() => this._refresh());
    }

    disable() {
        this._alive = false;
        if (this._prewarmId)
            GLib.source_remove(this._prewarmId);
        this._prewarmId = 0;
        this._cancellable.cancel();
        this._cancellable = null;
        this._unfollow();
        Main.wm.removeKeybinding('toggle-picker');
        this._settings.disconnect(this._indicatorChanged);
        this._button.destroy();
        this._button = this._grid = this._scroll = this._status = this._heroTitle = null;
        this._tiles.clear();
    }

    // The shortcut still opens the picker when the icon is hidden.
    _showIndicator() {
        this._button.visible = this._settings.get_boolean('show-picker');
    }

    toggle() {
        const menu = this._button.menu;
        if (!menu.isOpen && !this._button.mapped) {
            // A hidden icon, or a top bar hidden by a fullscreen window, is
            // unmapped, so BoxPointer would never position the menu and it
            // would open at the stage origin. Anchor it to the right end of
            // the top bar on the primary monitor instead.
            const monitor = Main.layoutManager.primaryMonitor;
            const [, panelY] = Main.panel.get_transformed_position();
            Main.layoutManager.setDummyCursorGeometry(monitor.x + monitor.width - 1, panelY, 0, Main.panel.height);
            menu.sourceActor = Main.layoutManager.dummyCursor;
        }
        // Focus left on another menu's button would make GNOME's menu manager
        // switch to that menu the moment this one takes the focus.
        if (!menu.isOpen)
            global.stage.set_key_focus(null);
        menu.toggle();
    }

    _build() {
        this._button = new PanelMenu.Button(0.5, 'Theme picker');
        this._button.add_child(new St.Icon({gicon: new Gio.ThemedIcon({names: ICONS}), style_class: 'system-status-icon'}));
        const menu = this._button.menu;
        menu.box.add_style_class_name('jade-frame');
        menu.box.add_style_class_name('jade-picker');

        const hero = new St.BoxLayout({x_expand: true, style_class: 'jade-hero'});
        hero.add_child(new St.Icon({gicon: familyGicon(ICONS[0]), style_class: 'jade-hero-icon', y_align: Clutter.ActorAlign.CENTER}));
        const text = new St.BoxLayout({orientation: VERTICAL, x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        this._heroTitle = label('Themes', 'jade-title');
        text.add_child(this._heroTitle);
        text.add_child(label('CURRENT THEME', 'jade-meta'));
        hero.add_child(text);
        this._item(hero);

        // Scrolls once the themes (community ones too) outgrow the screen.
        this._grid = new St.BoxLayout({orientation: VERTICAL, x_expand: true, style_class: 'jade-grid jade-divided'});
        this._scroll = new St.ScrollView({
            hscrollbar_policy: St.PolicyType.NEVER, vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true, x_expand: true, child: this._grid,
        });
        this._item(this._scroll);

        const footer = new St.BoxLayout({x_expand: true, style_class: 'jade-footer jade-divided'});
        this._status = label('', 'jade-status', {x_expand: true});
        footer.add_child(this._status);
        footer.add_child(this._action('Next wallpaper', 'image-x-generic-symbolic', ['theme', 'wallpaper'], 'New wallpaper set'));
        footer.add_child(this._action('Undo', 'edit-undo-symbolic', ['theme', 'undo'], 'Restored the previous look'));
        // Everything else about the look (glass, icons, dock) is in the Jade Shell app.
        const more = this._footerButton('Settings', 'emblem-system-symbolic');
        more.connect('clicked', () => {
            this._button.menu.close();
            openSettings('desktop');
        });
        footer.add_child(more);
        this._item(footer);

        menu.connect('open-state-changed', (_m, open) => {
            if (!open) {
                // Point back at the icon, which the menu manager tracks it by.
                menu.sourceActor = this._button;
                return;
            }
            // The top bar, the heading and the footer, and a margin, stay on screen.
            const monitor = Main.layoutManager.primaryMonitor;
            this._scroll.style = `max-height: ${Math.max(240, monitor.height - Main.panel.height - 260)}px;`;
            this._refresh();
            const current = this._tiles.get(this._current) ?? this._tiles.values().next().value;
            GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                if (this._alive && this._button?.menu.isOpen)
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
        const button = this._footerButton(text, iconName);
        button.connect('clicked', () => this._runJade(args, done));
        return button;
    }

    // A footer button: an icon and a word.
    _footerButton(text, iconName) {
        const button = new St.Button({can_focus: true, reactive: true, track_hover: true, style_class: 'jade-action', accessible_name: text});
        const box = new St.BoxLayout({style_class: 'jade-action-content'});
        box.add_child(new St.Icon({gicon: familyGicon(iconName), icon_size: 14}));
        box.add_child(label(text, 'jade-action-label'));
        button.set_child(box);
        return button;
    }

    async _refresh() {
        const jade = jadeCommand();
        if (!jade) {
            this._setStatus('The jade command is not installed', true);
            return;
        }
        const cancellable = this._cancellable;
        const {ok, stdout, stderr} = await run([jade, 'theme', 'list', '--json'], cancellable, {kill: true});
        if (!this._alive || cancellable !== this._cancellable)
            return;
        if (!ok) {
            this._setStatus(stderr.trim().split('\n').pop(), true);
            return;
        }
        const themes = JSON.parse(stdout);
        const key = themes.map(t => `${t.id}:${t.thumbnail}`).join('|');
        if (key !== this._themesKey) {
            // Rebuilding drops the tile with the keyboard focus, and a menu
            // that loses its focus closes: hand it to the same theme's new tile.
            const focused = [...this._tiles].find(([, tile]) => tile.has_key_focus())?.[0];
            this._themesKey = key;
            this._themes = themes;
            this._buildGrid();
            this._prewarm();
            if (this._button.menu.isOpen) {
                const id = focused ?? themes.find(t => t.current)?.id;
                (this._tiles.get(id) ?? this._tiles.values().next().value)?.grab_key_focus();
            }
        }
        // Once a download went through, the themes still without a preview
        // have none to fetch (a community theme without a wallpaper): not again.
        const missing = themes.filter(t => !t.thumbnail).map(t => t.id).join('|');
        if (missing && missing !== this._previewsTried)
            this._fetchPreviews(jade, missing);
        const current = themes.find(t => t.current);
        this._current = current?.id ?? null;
        this._heroTitle.text = current?.name ?? 'No theme applied yet';
        for (const [id, tile] of this._tiles)
            tile[id === this._current ? 'add_style_class_name' : 'remove_style_class_name']('jade-current');
    }

    // Setup offline leaves themes as color swatches: download their previews
    // in the background while the picker is open, then show them.
    async _fetchPreviews(jade, missing) {
        if (this._fetching || GLib.get_monotonic_time() / 1000 < (this._previewsRetryAt ?? 0))
            return;
        this._fetching = true;
        const cancellable = this._cancellable;
        if (!this._busy)
            this._setStatus('Downloading theme previews…');
        const {ok} = await run([jade, 'theme', 'thumbs'], cancellable);
        if (!this._alive || cancellable !== this._cancellable)
            return;
        this._fetching = false;
        if (ok)
            this._previewsTried = missing;
        else
            this._previewsRetryAt = GLib.get_monotonic_time() / 1000 + PREVIEW_RETRY_MS;
        if (!this._busy)
            this._setStatus(ok ? '' : 'Previews need an internet connection', !ok);
        this._refresh();  // offline part-way, the ones that came still show
    }

    // A new grid's styles (and its previews' textures) are worked out the
    // first time it shows: 60-70 ms on the first open after login. Do that
    // work when the Shell is idle instead, so the first open is as quick as
    // the rest.
    _prewarm() {
        if (this._prewarmId || this._button.menu.isOpen)
            return;
        this._prewarmId = GLib.idle_add(GLib.PRIORITY_LOW, () => {
            this._prewarmId = 0;
            const walk = actor => {
                actor.ensure_style?.();
                actor.get_children().forEach(walk);
            };
            if (this._alive)
                walk(this._button.menu.box);
            return GLib.SOURCE_REMOVE;
        });
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
        box.add_child(theme.thumbnail ? preview(theme.thumbnail) : swatch(theme.colors));
        box.add_child(label(theme.name, 'jade-tile-name'));
        tile.set_child(box);
        // The current theme's tile moves on to its next wallpaper; any other
        // switches, with the wallpaper that theme had last time.
        tile.connect('clicked', () => theme.id === this._current
            ? this._runJade(['theme', 'wallpaper'], 'New wallpaper set', 'Changing the wallpaper…')
            : this._runJade(['theme', 'set', theme.id], `${theme.name} applied`, `Applying ${theme.name}…`));
        tile.connect('key-press-event', (_a, event) => this._onTileKey(index, event));
        tile.connect('key-focus-in', () => this._reveal(tile));
        this._tiles.set(theme.id, tile);
        return tile;
    }

    // Scroll just enough to show a tile that the keyboard moved to.
    _reveal(tile) {
        const adjustment = this._scroll.vadjustment;
        const top = tile.get_transformed_position()[1] - this._grid.get_transformed_position()[1];
        const bottom = top + tile.height;
        if (top < adjustment.value)
            adjustment.value = top;
        else if (bottom > adjustment.value + adjustment.page_size)
            adjustment.value = bottom - adjustment.page_size;
    }

    // Arrow keys move through the grid; Enter and Space pick (St.Button).
    // Up and Down off the grid bubble to the menu, whose focus manager moves
    // to the footer buttons (or the nearest tile below a short last row).
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
        else if (Math.abs(step) === COLUMNS)
            return Clutter.EVENT_PROPAGATE;
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
