import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Graphene from 'gi://Graphene';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as AppDisplay from 'resource:///org/gnome/shell/ui/appDisplay.js';
import * as BoxPointer from 'resource:///org/gnome/shell/ui/boxpointer.js';
import * as DND from 'resource:///org/gnome/shell/ui/dnd.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {TintEffect} from './tint.js';

// Icons are rendered this many times larger than they sit in the dock, so a
// magnified icon is as sharp as a resting one.
const OVERSAMPLE = 3;
// Icons grow from their bottom edge, as on a Mac.
const PIVOT = new Graphene.Point({x: 0.5, y: 1});

// One bounce: up with the pull of gravity slowing it, down with it speeding
// it up, no rebound. A launch bounces about half an icon high and keeps
// bouncing until the app's first window is up; a call for attention bounces
// a full icon high.
const BOUNCE_MS = 330;
const LAUNCH_HEIGHT = 0.55;
const ATTENTION_HEIGHT = 0.95;
const LAUNCH_GIVE_UP_S = 12;
const ATTENTION_BOUNCES = 3;
const URGENT_GIVE_UP_S = 20;

// An icon drawn from a texture several times its size needs mipmaps, or its
// edges shimmer; St.Icon puts the texture in a child actor when it loads.
export function smooth(icon) {
    const prepare = child => {
        child.set_content_scaling_filters(Clutter.ScalingFilter.TRILINEAR, Clutter.ScalingFilter.LINEAR);
        tintTexture(child);
    };
    icon.get_children().forEach(prepare);
    icon.connect('child-added', (_icon, child) => prepare(child));
    return icon;
}

// The palette while the dock's icons are tinted (Settings › Dock), else null.
let tint = null;

export function setTint(palette) {
    tint = palette;
}

function tintTexture(texture) {
    texture.remove_effect_by_name('jade-tint');
    if (tint)
        texture.add_effect_with_name('jade-tint', new TintEffect(tint));
}

export function retint(icon) {
    if (icon instanceof St.Icon)
        icon.get_children().forEach(tintTexture);
}

// Everything the dock lines up: apps, the separator, Show Apps and the trash.
// The dock places items by transforms only (see Bar): `presence` eases from
// 0 to 1 as an item arrives and back as it leaves, and its slot grows and
// shrinks with it, so neighbours slide aside.
export const Item = GObject.registerClass(
class JadeDockItem extends St.Widget {
    _init(kind, width) {
        super._init({layout_manager: new Clutter.FixedLayout(), reactive: false});
        this.kind = kind;
        this.slot = width;
        this.presence = 0;
        this.target = 1;
        this.scale = 1;
    }

    get settled() {
        return Math.abs(this.presence - this.target) < 0.002;
    }

    // Leaving: the Bar shrinks the slot to nothing, then destroys it.
    leave() {
        this.target = 0;
        this.reactive = false;
    }

    // Transforms for this frame: `center` on the dock's axis, `scale` of the
    // icon, `fade` from the item's arrival or departure.
    place(_center, _scale, _fade) {}

    // Where the icon rests, in stage coordinates (the minimize target).
    setRest(_rect) {}

    // Sizes change with the dock's icon size.
    resize(_size, _metrics) {}

    // Colors change with the theme.
    restyle(_bar) {}

    get label() {
        return null;
    }

    get menuOpen() {
        return false;
    }
});

// GNOME's own app icon: its menu (windows, New Window, Pin/Unpin, Quit), its
// launching and its dragging, with the dock's look instead of the grid's.
const AppIcon = GObject.registerClass(
class JadeDockAppIcon extends AppDisplay.AppIcon {
    _init(app, owner) {
        super._init(app, {setSizeManually: true, showLabel: false, popupMenuSide: St.Side.BOTTOM});
        this._owner = owner;
        this.add_style_class_name('jade-dock-icon');
        this.pivot_point = PIVOT;
        this._dot.hide();
        // Pressed, the icon darkens, as a Mac's does.
        this._pressed = new Clutter.BrightnessContrastEffect({enabled: false});
        this._pressed.set_brightness(-0.28);
        this.icon.add_effect(this._pressed);
        this.connect('notify::pressed', () => {
            this._pressed.enabled = this.pressed;
        });
    }

    _createIcon(size) {
        const {scaleFactor} = St.ThemeContext.get_for_stage(global.stage);
        const icon = smooth(this.app.create_icon_texture(size * OVERSAMPLE));
        icon.set_size(size * scaleFactor, size * scaleFactor);
        icon.style = this._owner?.iconStyle ?? null;
        return icon;
    }

    _updateRunningStyle() {
        this._dot?.hide();
        this._owner?.syncRunning();
    }

    // Called before GNOME launches the app: whatever happens here must not
    // stop the launch.
    animateLaunch() {
        try {
            this._owner?.bounce('launch');
        } catch (e) {
            console.error(`Jade Shell: dock bounce: ${e.message}`);
        }
    }

    // No folders in the dock: let the drag reach the dock itself.
    handleDragOver() {
        return DND.DragMotionResult.CONTINUE;
    }

    acceptDrop() {
        return false;
    }

    getDragActor() {
        return this.app.create_icon_texture(this._owner.span);
    }

    get menuOpen() {
        return this._menu?.isOpen ?? false;
    }
});

export const AppItem = GObject.registerClass(
class JadeDockAppItem extends Item {
    _init(app, bar) {
        super._init('app', bar.metrics.icon);
        this.app = app;
        this.id = app.get_id();
        this._bar = bar;
        this.span = bar.metrics.icon;
        this.icon = new AppIcon(app, this);
        this.icon.connect('menu-state-changed', (_icon, open) => this._bar.menuChanged(open));
        this.icon.connect('enter-event', () => this._bar.wake());
        this.add_child(this.icon);
        this._dot = new St.Widget({style_class: 'jade-dock-dot'});
        this.add_child(this._dot);
        // On the icon itself, so they grow with it: the count badge at its top
        // right, the progress bar across its foot.
        this._badge = new St.Label({
            visible: false, x_expand: true, y_expand: true,
            x_align: Clutter.ActorAlign.END, y_align: Clutter.ActorAlign.START,
        });
        this._badge.clutter_text.x_align = Clutter.ActorAlign.CENTER;
        this.icon._iconContainer.add_child(this._badge);
        this._progress = new St.Widget({
            visible: false, x_expand: true, y_expand: true,
            x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.END,
        });
        this._progressFill = new St.Widget();
        this._progress.add_child(this._progressFill);
        this.icon._iconContainer.add_child(this._progress);
        this.resize(bar.metrics.icon, bar.metrics);

        this._bouncing = null;
        app.connectObject(
            'windows-changed', () => {
                this._bar.queueRestUpdate();
                this._stopLaunchBounceIfUp();
            },
            'notify::state', () => this._stopLaunchBounceIfUp(),
            this);
        this.syncRunning();
        this.connect('destroy', () => this._stopBouncing());
    }

    resize(size, metrics) {
        this.span = size;
        this.slot = size;
        this.icon.set_size(size, size);
        this.icon.icon.setIconSize(metrics.logical);
        this.icon.set_position(0, 0);
        const dot = metrics.dot;
        this._dot.set_size(dot, dot);
        this._dot.set_position(Math.round((size - dot) / 2), size + metrics.dotOffset);
        const badge = Math.round(size * 0.4);
        this._badgeSize = badge;
        this._badge.translation_x = Math.round(badge * 0.3);
        this._badge.translation_y = -Math.round(badge * 0.25);
        this._progress.set_size(Math.round(size * 0.72), Math.max(3, Math.round(size * 0.09)));
        this._progress.translation_y = -Math.round(size * 0.05);
        this._styleBadge();
        this._syncProgress();
    }

    _styleBadge() {
        const h = this._badgeSize;
        if (!h || !this._badgeColors)
            return;
        const [bg, fg] = this._badgeColors;
        this._badge.style = `background-color: ${bg}; color: ${fg}; font-weight: 700;` +
            ` font-size: ${Math.round(h * 0.6)}px; min-width: ${h}px; height: ${h}px;` +
            ` border-radius: ${Math.round(h / 2)}px; padding: 0 ${this._badge.text.length > 1 ? Math.round(h * 0.28) : 0}px;` +
            ` box-shadow: 0 1px 3px rgba(0, 0, 0, 0.35);`;
    }

    // An app's unread count, as on a Mac: a number, 99+ past 99.
    setBadge(count) {
        this._badge.visible = count > 0;
        const text = count > 99 ? '99+' : String(count);
        if (count > 0 && text !== this._badge.text) {
            this._badge.text = text;
            this._styleBadge();  // a circle for one digit, a pill for more
        }
    }

    setProgress(progress) {
        this._progressValue = progress;
        this._syncProgress();
    }

    _syncProgress() {
        const progress = this._progressValue ?? null;
        this._progress.visible = progress !== null;
        if (progress === null)
            return;
        const [width, height] = this._progress.get_size();
        this._progressFill.set_size(Math.max(height, Math.round(width * progress)), height);
    }

    restyle(bar) {
        this._badgeColors = bar._badgeColors;
        this._styleBadge();
        this._progress.style = bar._progressStyle;
        this._progressFill.style = bar._progressFillStyle;
        this.iconStyle = bar._iconStyle;
        this._dot.set_style(bar._dotStyle);
        if (this.icon.icon.icon) {
            this.icon.icon.icon.style = this.iconStyle;
            retint(this.icon.icon.icon);
        }
    }

    syncRunning() {
        this._dot.visible = this.app.state !== Shell.AppState.STOPPED;
    }

    place(center, scale, fade) {
        this.translation_x = Math.round((center - this.span / 2) * 2) / 2;
        this.icon.set_scale(scale * (0.5 + 0.5 * fade), scale * (0.5 + 0.5 * fade));
        this.opacity = Math.round(255 * fade);
        this.scale = scale;
    }

    setRest(rect) {
        for (const window of this.app.get_windows())
            window.set_icon_geometry(rect);
    }

    get label() {
        return this.app.get_name();
    }

    get menuOpen() {
        return this.icon.menuOpen;
    }

    // Bounce the icon: 'launch' until the app has a window, 'attention' a few
    // times, 'urgent' until the app is used.
    bounce(kind) {
        if (this._bouncing && (this._bouncing.kind === kind || kind === 'attention'))
            return;
        // With animations off (Settings › Accessibility, or no GPU), no bounce.
        if (!this._bar.bounces || !St.Settings.get().enable_animations)
            return;
        this._stopBouncing();
        const started = GLib.get_monotonic_time();
        const state = {kind, count: 0, stop: false, started};
        this._bouncing = state;
        const hop = () => {
            if (this._bouncing !== state)
                return;
            const elapsed = (GLib.get_monotonic_time() - started) / 1e6;
            const done = state.stop ||
                (kind === 'launch' && (this._launched() || elapsed > LAUNCH_GIVE_UP_S)) ||
                (kind === 'attention' && state.count >= ATTENTION_BOUNCES) ||
                (kind === 'urgent' && (!this._wantsAttention() || elapsed > URGENT_GIVE_UP_S));
            if (done) {
                this._bouncing = null;
                return;
            }
            state.count++;
            const height = this.span * (kind === 'launch' ? LAUNCH_HEIGHT : ATTENTION_HEIGHT);
            this.icon.ease({
                translation_y: -height,
                duration: BOUNCE_MS,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onComplete: () => this.icon.ease({
                    translation_y: 0,
                    duration: BOUNCE_MS,
                    mode: Clutter.AnimationMode.EASE_IN_QUAD,
                    // From the main loop: an ease that ends at once (animations
                    // turned off meanwhile) must not make this recurse.
                    onComplete: () => GLib.idle_add_once(GLib.PRIORITY_DEFAULT, hop),
                }),
            });
        };
        hop();
    }

    get isBouncing() {
        return this._bouncing !== null;
    }

    // Finish the hop in the air, then stop: an icon never stops mid-flight.
    _stopLaunchBounceIfUp() {
        if (this._bouncing?.kind === 'launch' && this._launched())
            this._bouncing.stop = true;
    }

    _stopBouncing() {
        this._bouncing = null;
        this.icon.remove_all_transitions();
        this.icon.translation_y = 0;
    }

    _launched() {
        return this.app.state === Shell.AppState.RUNNING && this.app.get_n_windows() > 0;
    }

    _wantsAttention() {
        return this.app.get_windows().some(w => w.demands_attention || w.urgent);
    }
});

export const Separator = GObject.registerClass(
class JadeDockSeparator extends Item {
    _init(bar) {
        super._init('separator', 1);
        this._line = new St.Widget({style_class: 'jade-dock-separator'});
        this.add_child(this._line);
        this.resize(bar.metrics.icon, bar.metrics);
    }

    resize(size, metrics) {
        this.span = metrics.separator;
        this.slot = metrics.separator;
        const height = Math.round(size * 0.72);
        this._line.set_size(Math.max(1, Math.round(metrics.scale)), height);
        this._line.set_position(Math.round((metrics.separator - 1) / 2), Math.round((size - height) / 2));
    }

    restyle(bar) {
        this._line.set_style(bar._separatorStyle);
    }

    place(center, _scale, fade) {
        this.translation_x = Math.round(center - this.span / 2);
        this.opacity = Math.round(255 * fade);
    }
});

// A tile the dock draws itself (Show Apps, the trash): a button with an icon.
const ButtonItem = GObject.registerClass(
class JadeDockButtonItem extends Item {
    _init(kind, bar, name) {
        super._init(kind, bar.metrics.icon);
        this._bar = bar;
        this.name = name;
        this.button = new St.Button({
            style_class: 'jade-dock-button', reactive: true, can_focus: true, track_hover: true,
            button_mask: St.ButtonMask.ONE | St.ButtonMask.THREE,
        });
        this.button.pivot_point = PIVOT;
        this.button.connect('enter-event', () => this._bar.wake());
        this.button.connect('clicked', (_b, button) => this.activate(button));
        this._pressed = new Clutter.BrightnessContrastEffect({enabled: false});
        this._pressed.set_brightness(-0.28);
        this.button.add_effect(this._pressed);
        this.button.connect('notify::pressed', () => {
            this._pressed.enabled = this.button.pressed;
        });
        this.add_child(this.button);
        this.resize(bar.metrics.icon, bar.metrics);
    }

    resize(size, metrics) {
        this.span = size;
        this.slot = size;
        this.button.set_size(size, size);
        this.button.set_position(0, 0);
        this.setIconSize(size, metrics);
    }

    // `size` in pixels; St.Icon's icon_size is in logical pixels.
    setIconSize(_size, _metrics) {}

    place(center, scale, fade) {
        this.translation_x = Math.round((center - this.span / 2) * 2) / 2;
        this.button.set_scale(scale, scale);
        this.opacity = Math.round(255 * fade);
        this.scale = scale;
    }

    get label() {
        return this.name;
    }

    activate(_button) {}
});

// macOS's Launchpad, GNOME's app grid.
export const ShowAppsItem = GObject.registerClass(
class JadeDockShowApps extends ButtonItem {
    _init(bar) {
        super._init('show-apps', bar, 'Show Apps');
        this.button.add_style_class_name('jade-dock-tile');
        this._interface = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        this._interface.connectObject('changed::icon-theme', () => this.setIconSize(this._size, this._metrics), this);
        this.connect('destroy', () => this._interface.disconnectObject(this));
        this.setIconSize(this._size, this._metrics);  // first drawn before the setting was at hand
    }

    // With the Mac-style icons, their Launchpad icon. Otherwise a tile like
    // an app icon's: rounded, in the theme's accent, inset by the margin app
    // icons have around their artwork.
    setIconSize(size, metrics) {
        this._size = size;
        this._metrics = metrics;
        this.button.child?.destroy();
        this._tile = null;
        if (this._interface?.get_string('icon-theme').startsWith('Jade-MacTahoe')) {
            this.button.child = smooth(new St.Icon({icon_name: 'view-app-grid', icon_size: metrics.logical * OVERSAMPLE}));
            this.button.child.set_size(size, size);
            this.button.child.style = this._iconStyle ?? null;
            return;
        }
        const tile = Math.round(size * 0.8);
        this._tile = new St.Bin({
            style_class: 'jade-dock-tile', width: tile, height: tile,
            x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER,
            child: new St.Icon({icon_name: 'view-app-grid-symbolic', icon_size: Math.round(metrics.logical * 0.4)}),
        });
        this.button.child = this._tile;
        if (this._style)
            this._tile.set_style(this._style);
    }

    restyle(bar) {
        this._style = bar._tileStyle;
        this._iconStyle = bar._iconStyle;
        if (this._tile) {
            this._tile.set_style(this._style);
        } else if (this.button.child) {
            this.button.child.style = this._iconStyle;
            retint(this.button.child);
        }
    }

    // Opens the app grid; a second click closes it, as Launchpad does.
    activate() {
        const button = Main.overview.dash.showAppsButton;
        if (!Main.overview.visible)
            Main.overview.showApps();
        else if (button.checked)
            Main.overview.hide();
        else
            button.checked = true;
    }
});

// The trash: full or empty, opens in Files, and empties from its menu.
export const TrashItem = GObject.registerClass(
class JadeDockTrash extends ButtonItem {
    _init(bar) {
        super._init('trash', bar, 'Trash');
        this._file = Gio.File.new_for_uri('trash:///');
        this._full = false;
        this._cancellable = new Gio.Cancellable();
        try {
            this._monitor = this._file.monitor_directory(Gio.FileMonitorFlags.NONE, this._cancellable);
            this._monitor.connect('changed', () => this._check());
        } catch {}
        this._check();
        this.connect('destroy', () => {
            this._cancellable.cancel();
            this._monitor?.cancel();
            this._menu?.destroy();
        });
    }

    setIconSize(size, metrics) {
        this._size = size;
        this._logical = metrics.logical;
        this.button.child?.destroy();
        this.button.child = null;
        this._icon();
    }

    _icon() {
        if (!this._size)
            return;
        const gicon = new Gio.ThemedIcon({name: this._full ? 'user-trash-full' : 'user-trash'});
        if (this.button.child)
            this.button.child.gicon = gicon;
        else
            this.button.child = smooth(new St.Icon({gicon, icon_size: this._logical * OVERSAMPLE}));
        this.button.child.set_size(this._size, this._size);
        this.button.child.style = this._iconStyle ?? null;
    }

    _check() {
        this._file.query_info_async('trash::item-count', Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_LOW,
            this._cancellable, (file, result) => {
                try {
                    const info = file.query_info_finish(result);
                    this._full = info.get_attribute_uint32('trash::item-count') > 0;
                    this._icon();
                } catch {}
            });
    }

    restyle(bar) {
        this._iconStyle = bar._iconStyle;
        if (this.button.child) {
            this.button.child.style = this._iconStyle;
            retint(this.button.child);
        }
    }

    activate(button) {
        if (button === Clutter.BUTTON_SECONDARY) {
            this._openMenu();
            return;
        }
        try {
            Gio.AppInfo.launch_default_for_uri('trash:///', global.create_app_launch_context(0, -1));
        } catch (e) {
            console.error(`Jade Shell: could not open the trash: ${e.message}`);
        }
        Main.overview.hide();
    }

    _openMenu() {
        if (!this._menu) {
            this._menu = new PopupMenu.PopupMenu(this.button, 0.5, St.Side.BOTTOM);
            this._menu.addAction('Open', () => this.activate(Clutter.BUTTON_PRIMARY));
            this._empty = this._menu.addAction('Empty Trash…', () => emptyTrash());
            Main.uiGroup.add_child(this._menu.actor);
            this._menuManager = new PopupMenu.PopupMenuManager(this.button);
            this._menuManager.addMenu(this._menu);
            this._menu.connect('open-state-changed', (_m, open) => this._bar.menuChanged(open));
        }
        this._empty.setSensitive(this._full);
        this._menu.open(BoxPointer.PopupAnimation.FULL);
    }

    get menuOpen() {
        return this._menu?.isOpen ?? false;
    }
});

// Files empties it, after asking in its own dialog.
function emptyTrash() {
    Gio.DBus.session.call('org.gnome.Nautilus', '/org/gnome/Nautilus/FileOperations2',
        'org.gnome.Nautilus.FileOperations2', 'EmptyTrash',
        new GLib.Variant('(ba{sv})', [true, {}]), null, Gio.DBusCallFlags.NONE, -1, null,
        (bus, result) => {
            try {
                bus.call_finish(result);
            } catch (e) {
                console.error(`Jade Shell: could not empty the trash: ${e.message}`);
            }
        });
}
