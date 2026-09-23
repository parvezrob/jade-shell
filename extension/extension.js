import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const COLUMNS = 5;
const VERTICAL = Clutter.Orientation.VERTICAL;
// Sit just right of these indicators, in order of preference, when present.
const NEIGHBOURS = ['osaka-ai-usage@local', 'monitor@astraext.github.io'];
const ICONS = ['preferences-desktop-appearance-symbolic', 'applications-graphics-symbolic'];

function label(text, style, props = {}) {
    return new St.Label({text, style_class: style, y_align: Clutter.ActorAlign.CENTER, ...props});
}

// Run a command without blocking the Shell; resolves with its exit status and output.
function run(argv, cancellable) {
    return new Promise(resolve => {
        let proc;
        try {
            proc = Gio.Subprocess.new(argv, Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
        } catch (e) {
            resolve({ok: false, stdout: '', stderr: e.message});
            return;
        }
        proc.communicate_utf8_async(null, cancellable, (p, result) => {
            try {
                const [, stdout, stderr] = p.communicate_utf8_finish(result);
                resolve({ok: p.get_successful(), stdout, stderr});
            } catch (e) {
                resolve({ok: false, stdout: '', stderr: e.message});
            }
        });
    });
}

export default class JadeShell extends Extension {
    enable() {
        this._alive = true;
        this._cancellable = new Gio.Cancellable();
        this._settings = this.getSettings();
        this._stateDir = Gio.File.new_for_path(GLib.build_filenamev([GLib.get_user_state_dir(), 'jade-shell']));
        this._css = this._stateDir.get_child('shell.css');
        this._cli = GLib.build_filenamev([GLib.get_home_dir(), '.local', 'bin', 'jade-theme']);
        this._themes = [];
        this._tiles = new Map();
        this._busy = false;

        this._loadStylesheet();
        // A new Shell theme drops custom stylesheets; loading ours also emits
        // 'changed', so only reload when the theme object itself was replaced.
        this._themeChanged = St.ThemeContext.get_for_stage(global.stage).connect('changed', context => {
            if (context.get_theme() !== this._theme)
                this._loadStylesheet();
        });
        this._watch();
        this._buildIndicator();
        Main.wm.addKeybinding('toggle-picker', this._settings, Meta.KeyBindingFlags.NONE,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW, () => this._button.menu.toggle());
        this._indicatorChanged = this._settings.connect('changed::show-indicator', () => this._showIndicator());
        this._showIndicator();
        this._refresh();
    }

    disable() {
        this._alive = false;
        this._cancellable.cancel();
        this._cancellable = null;
        Main.wm.removeKeybinding('toggle-picker');
        this._settings.disconnect(this._indicatorChanged);
        this._settings = null;
        St.ThemeContext.get_for_stage(global.stage).disconnect(this._themeChanged);
        this._unloadStylesheet();
        this._theme = null;
        if (this._reloadSoon)
            GLib.source_remove(this._reloadSoon);
        this._reloadSoon = null;
        this._monitor?.disconnect(this._monitorChanged);
        this._monitor?.cancel();
        this._monitor = null;
        this._button.destroy();
        this._button = this._grid = this._status = this._heroTitle = null;
        this._tiles.clear();
        this._themes = [];
    }

    // ---------------------------------------------------- generated stylesheet

    _loadStylesheet() {
        this._unloadStylesheet();
        this._theme = St.ThemeContext.get_for_stage(global.stage).get_theme();
        if (!this._css.query_exists(null))
            return;
        this._loadedCss = this._css;
        this._theme.load_stylesheet(this._css);
    }

    _unloadStylesheet() {
        if (this._loadedCss && this._theme)
            this._theme.unload_stylesheet(this._loadedCss);
        this._loadedCss = null;
    }

    _watch() {
        try {
            this._stateDir.make_directory_with_parents(null);
        } catch {}
        this._monitor = this._stateDir.monitor_directory(Gio.FileMonitorFlags.WATCH_MOVES, this._cancellable);
        this._monitorChanged = this._monitor.connect('changed', (_m, file, other) => {
            const names = [file?.get_basename(), other?.get_basename()];
            if (names.some(n => n === 'shell.css' || n === 'current.json'))
                this._scheduleReload();
        });
    }

    // A switch rewrites several files in a burst; react once it settles.
    _scheduleReload() {
        if (this._reloadSoon)
            return;
        this._reloadSoon = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200, () => {
            this._reloadSoon = null;
            this._loadStylesheet();
            this._refresh();
            return GLib.SOURCE_REMOVE;
        });
    }

    // ---------------------------------------------------- indicator and menu

    _buildIndicator() {
        this._button = new PanelMenu.Button(0.5, 'Theme picker');
        this._button.add_child(new St.Icon({gicon: new Gio.ThemedIcon({names: ICONS}), style_class: 'system-status-icon'}));
        const menu = this._button.menu;
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
        footer.add_child(this._action('Next wallpaper', 'image-x-generic-symbolic', ['wallpaper'], 'New wallpaper set'));
        footer.add_child(this._action('Undo', 'edit-undo-symbolic', ['undo'], 'Restored the previous look'));
        this._item(footer);

        this._menuOpened = menu.connect('open-state-changed', (_m, open) => {
            if (!open)
                return;
            this._refresh();
            const current = this._tiles.get(this._current) ?? this._tiles.values().next().value;
            GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                current?.grab_key_focus();
                return GLib.SOURCE_REMOVE;
            });
        });
        Main.panel.addToStatusArea(this.uuid, this._button, this._panelIndex(), 'right');
    }

    _panelIndex() {
        const children = Main.panel._rightBox.get_children();
        for (const uuid of NEIGHBOURS) {
            const neighbour = Main.panel.statusArea[uuid]?.container;
            if (neighbour)
                return children.indexOf(neighbour) + 1;
        }
        return 0;
    }

    _showIndicator() {
        this._button.visible = this._settings.get_boolean('show-indicator');
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
        button.connect('clicked', () => this._runCli(args, done));
        return button;
    }

    // ---------------------------------------------------- themes

    async _refresh() {
        const cancellable = this._cancellable;
        const {ok, stdout, stderr} = await run([this._cli, 'list', '--json'], cancellable);
        if (!this._alive || cancellable !== this._cancellable)
            return;
        if (!ok) {
            this._setStatus(GLib.file_test(this._cli, GLib.FileTest.EXISTS) ? stderr.trim().split('\n').pop() : 'jade-theme is not installed', true);
            return;
        }
        const themes = JSON.parse(stdout);
        const key = themes.map(t => `${t.id}:${t.thumbnail}`).join('|');
        if (key !== this._themesKey) {
            this._themesKey = key;
            this._themes = themes;
            this._buildGrid();
        }
        this._current = themes.find(t => t.current)?.id ?? null;
        this._heroTitle.text = themes.find(t => t.current)?.name ?? 'No theme applied yet';
        for (const [id, tile] of this._tiles) {
            if (id === this._current)
                tile.add_style_class_name('jade-current');
            else
                tile.remove_style_class_name('jade-current');
        }
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
        tile.connect('clicked', () => this._runCli(['set', theme.id], `${theme.name} applied`, `Applying ${theme.name}…`));
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

    async _runCli(args, done, pending = 'Working…') {
        if (this._busy)
            return;
        this._busy = true;
        this._setStatus(pending);
        const cancellable = this._cancellable;
        const {ok, stderr} = await run([this._cli, ...args], cancellable);
        if (!this._alive || cancellable !== this._cancellable)
            return;
        this._busy = false;
        this._setStatus(ok ? done : (stderr.trim().split('\n').pop() || 'Something went wrong'), !ok);
    }

    _setStatus(text, error = false) {
        this._status.text = text;
        if (error)
            this._status.add_style_class_name('jade-error');
        else
            this._status.remove_style_class_name('jade-error');
    }
}
