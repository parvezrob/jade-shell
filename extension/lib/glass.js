// Frosted glass for the Shell (Settings › Glass): the top bar, every menu,
// dialogs, notification banners and the volume and brightness pop-ups blur
// what is behind them, as the dock does, tinted by the theme; the overview
// sits on the blurred wallpaper.
//
// Each surface gets a Shell.BlurEffect in background mode (whatever is behind
// it, windows too, blurred as it paints), and the theme's `.jade-frosted`
// rules make its background translucent. Omarchy's frames are square, so
// the blur fits them exactly; it only runs while a surface is on screen.
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Mtk from 'gi://Mtk';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Background from 'resource:///org/gnome/shell/ui/background.js';
import * as BoxPointer from 'resource:///org/gnome/shell/ui/boxpointer.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';
import * as OsdWindow from 'resource:///org/gnome/shell/ui/osdWindow.js';
import {InjectionManager} from 'resource:///org/gnome/shell/extensions/extension.js';

const EFFECT = 'jade-glass';
const WHOLE = 'jade-glass-whole';
const BLUR_MY_SHELL = 'blur-my-shell@aunetx';

let active = false;
let radius = 36;
const frosted = new Set();
// GNOME draws menus, dialogs and the message tray through a buffer of their
// own (offscreen redirect ALWAYS), where a background blur would find
// nothing to blur. While frosted they redirect only while fading, Clutter's
// default; their own setting comes back when the glass goes.
const redirected = new Map();
const watched = {};  // the tracker for the opacity watches
const watchers = new Set();

function unredirect(actor) {
    for (let a = actor; a && a !== Main.uiGroup; a = a.get_parent()) {
        if (a.get_offscreen_redirect() === Clutter.OffscreenRedirect.ALWAYS && !redirected.has(a)) {
            redirected.set(a, Clutter.OffscreenRedirect.ALWAYS);
            a.set_offscreen_redirect(Clutter.OffscreenRedirect.AUTOMATIC_FOR_OPACITY);
            a.connectObject('destroy', () => redirected.delete(a), redirected);
        }
    }
}

// The blur copies what is on screen under the surface as it paints. When
// only part of the screen is redrawn (the clock ticking, a button lighting up
// as its menu opens), the rest of that copy is the last frame: the surface
// itself, already tinted, so the redrawn part came out a flat patch of
// another color until something redrew all of it. Whenever a surface is only
// partly redrawn, redraw all of it in the next frame.
const Whole = GObject.registerClass(class JadeGlassWhole extends Clutter.Effect {
    vfunc_paint(node, context, flags) {
        const actor = this.get_actor();
        const clip = context.get_redraw_clip();
        const monitor = clip && Main.layoutManager.findMonitorForActor(actor);
        if (monitor && actor.get_effect(EFFECT)?.enabled) {
            const box = actor.get_transformed_extents();
            const x = Math.floor(box.get_x());
            const y = Math.floor(box.get_y());
            const rect = new Mtk.Rectangle({x, y,
                width: Math.ceil(box.get_x() + box.get_width()) - x,
                height: Math.ceil(box.get_y() + box.get_height()) - y});
            const [visible, shown] = rect.intersect(new Mtk.Rectangle({  // the part on its monitor
                x: monitor.x, y: monitor.y, width: monitor.width, height: monitor.height}));
            if (visible && clip.contains_rectangle(shown) !== Mtk.RegionOverlap.IN)
                actor.queue_redraw();
        }
        super.vfunc_paint(node, context, flags);
    }
});

// Blur what is behind `actor` while frosted glass is on (Jade's own surfaces
// call this too, such as the screenshot card).
export function frost(actor) {
    if (!active || !actor)
        return;
    unredirect(actor);  // also when it has its blur already: a new parent may redirect
    if (actor.get_effect(EFFECT))
        return;
    const effect = new Shell.BlurEffect({mode: Shell.BlurMode.BACKGROUND, radius, brightness: 1});
    actor.add_effect_with_name(EFFECT, effect);
    actor.add_effect_with_name(WHOLE, new Whole());
    frosted.add(actor);
    actor.connectObject('destroy', () => frosted.delete(actor), frost);
    // While it fades in or out it's drawn through a buffer where the blur
    // can't show anyway: skip the work (it's most of the cost in those frames).
    const sync = () => (effect.enabled = actor.get_paint_opacity() === 255);
    for (let a = actor; a && a !== Main.uiGroup; a = a.get_parent()) {
        a.connectObject('notify::opacity', sync, watched);
        watchers.add(a);
    }
    sync();
}

// The tint over the blur: the theme's background at Settings › Glass tint,
// in a small stylesheet of its own (after the theme's, so it wins), made
// again when the tint or the theme changes.
const SURFACES = ['.popup-menu-content', '.popup-menu-content.jade-frame', '.candidate-popup-content',
    '.notification-banner', '.notification-banner:hover', '.osd-window', '.modal-dialog', '.jade-capture-card'];

export class Glass {
    constructor(settings, theme) {
        this._settings = settings;
        this._theme = theme;
        this._css = Gio.File.new_for_path(GLib.build_filenamev([GLib.get_user_runtime_dir(), 'jade-shell-glass.css']));
    }

    enable() {
        this._changed = ['glass', 'glass-tint', 'glass-blur'].map(key => this._settings.connect(`changed::${key}`, () => this._sync()));
        this._unfollow = this._theme.follow(palette => {
            this._palette = palette;
            this._sync();
        });
        // A theme switch loads a new Shell theme, without this stylesheet.
        St.ThemeContext.get_for_stage(global.stage).connectObject('changed', () => {
            // Only into a new theme: loading it changes the theme context too.
            if (active && St.ThemeContext.get_for_stage(global.stage).get_theme() !== this._tintedTheme)
                this._loadTint();
        }, this);
        this._sync();
    }

    disable() {
        this._changed.forEach(id => this._settings.disconnect(id));
        this._unfollow?.();
        St.ThemeContext.get_for_stage(global.stage).disconnectObject(this);
        this._stop();
        this._unloadTint();
        this._css.delete(null);
    }

    _writeTint() {
        const hex = this._palette?.background ?? '#1a1b26';
        const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
        const alpha = this._settings.get_double('glass-tint');
        const rgba = a => `rgba(${r}, ${g}, ${b}, ${a.toFixed(2)})`;
        const css = `.jade-frosted #panel { background-color: ${rgba(Math.max(0.1, alpha - 0.05))}; }\n` +
            '.jade-frosted #overviewGroup { background-color: transparent; }\n' +
            '.jade-frosted #panel:overview { background-color: transparent; }\n' +
            `${SURFACES.map(s => `.jade-frosted ${s}`).join(',\n')} { background-color: ${rgba(alpha)}; }\n`;
        this._css.replace_contents(css, null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
    }

    // Unloading and loading each change the theme, which calls back in here
    // (through the theme context's 'changed'): once only, or the stylesheet
    // would be in the theme twice, and the copy left behind by the next
    // unload has no file, which breaks GNOME's next theme load (every
    // switch after it would keep the old colors).
    _loadTint() {
        const theme = St.ThemeContext.get_for_stage(global.stage).get_theme();
        if (!active || !theme || this._loadingTint)
            return;
        this._loadingTint = true;
        this._tintedTheme = theme;
        try {
            theme.unload_stylesheet(this._css);
            theme.load_stylesheet(this._css);
        } catch (e) {
            console.error(`Jade Shell: glass tint: ${e.message}`);
        } finally {
            this._loadingTint = false;
        }
    }

    _unloadTint() {
        const theme = this._tintedTheme;
        this._tintedTheme = null;
        if (!theme || this._loadingTint)
            return;
        this._loadingTint = true;
        try {
            theme.unload_stylesheet(this._css);
        } catch (e) {
            console.error(`Jade Shell: glass tint: ${e.message}`);
        } finally {
            this._loadingTint = false;
        }
    }

    _sync() {
        const want = this._settings.get_string('glass') === 'frosted';
        radius = this._settings.get_int('glass-blur');
        if (want && !active)
            this._start();
        else if (!want && active)
            this._stop();
        if (!active) {
            this._unloadTint();
            return;
        }
        for (const actor of frosted) {
            const effect = actor.get_effect(EFFECT);
            if (effect)
                effect.radius = radius;
        }
        this._writeTint();
        this._loadTint();
        this._styleOverview();
    }

    // ---------------------------------------------------------------- the overview

    // Behind the app grid and the workspaces, as macOS's Launchpad has it:
    // each monitor's wallpaper, blurred once and kept (the blur is cached, so
    // the overview's animations cost nothing more), tinted like the glass.
    _buildOverview() {
        this._destroyOverview();
        if (Main.extensionManager.lookup(BLUR_MY_SHELL)?.state === 1)
            return;  // it blurs the overview itself
        this._overview = Main.layoutManager.monitors.map((monitor, index) => {
            const group = new Clutter.Actor({x: monitor.x, y: monitor.y, width: monitor.width, height: monitor.height,
                clip_to_allocation: true});
            const wall = new Clutter.Actor({width: monitor.width, height: monitor.height});
            const blur = new Shell.BlurEffect({mode: Shell.BlurMode.ACTOR, radius, brightness: 1});
            wall.add_effect(blur);
            group.add_child(wall);
            const tint = new St.Widget({width: monitor.width, height: monitor.height});
            group.add_child(tint);
            const backgrounds = new Background.BackgroundManager({container: wall, monitorIndex: index,
                vignette: false, controlPosition: false});
            Main.layoutManager.overviewGroup.insert_child_at_index(group, 0);
            return {group, blur, tint, backgrounds};
        });
        this._styleOverview();
    }

    _styleOverview() {
        const hex = this._palette?.background ?? '#1a1b26';
        const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
        const alpha = this._settings.get_double('glass-tint');
        for (const {blur, tint} of this._overview ?? []) {
            blur.radius = radius;
            tint.style = `background-color: rgba(${r}, ${g}, ${b}, ${alpha.toFixed(2)});`;
        }
    }

    _destroyOverview() {
        for (const {group, backgrounds} of this._overview ?? []) {
            backgrounds.destroy();
            group.destroy();
        }
        this._overview = null;
    }

    _start() {
        active = true;
        Main.uiGroup.add_style_class_name('jade-frosted');
        this._injections = new InjectionManager();
        // Menus: the box with the frame, inside GNOME's pointer.
        this._injections.overrideMethod(BoxPointer.BoxPointer.prototype, 'open', original => function (...args) {
            frost(this.bin.get_child());
            return original.apply(this, args);
        });
        this._injections.overrideMethod(ModalDialog.ModalDialog.prototype, 'open', original => function (...args) {
            frost(this.dialogLayout._dialog);
            return original.apply(this, args);
        });
        this._injections.overrideMethod(OsdWindow.OsdWindow.prototype, 'show', original => function (...args) {
            frost(this._hbox);
            return original.apply(this, args);
        });
        Main.messageTray._bannerBin?.connectObject('child-added', (_bin, banner) => frost(banner), this);
        // Blur my Shell blurs the top bar itself when it's on: leave the bar to it.
        if (Main.extensionManager.lookup(BLUR_MY_SHELL)?.state !== 1)
            frost(Main.panel);
        this._buildOverview();
        Main.layoutManager.connectObject('monitors-changed', () => this._buildOverview(), this);
    }

    _stop() {
        active = false;
        Main.layoutManager.disconnectObject(this);
        this._destroyOverview();
        Main.uiGroup.remove_style_class_name('jade-frosted');
        this._injections?.clear();
        this._injections = null;
        Main.messageTray._bannerBin?.disconnectObject(this);
        for (const actor of frosted) {
            actor.remove_effect_by_name(EFFECT);
            actor.remove_effect_by_name(WHOLE);
            actor.disconnectObject(frost);
        }
        frosted.clear();
        for (const [actor, redirect] of redirected) {
            actor.set_offscreen_redirect(redirect);
            actor.disconnectObject(redirected);
        }
        redirected.clear();
        for (const actor of watchers)
            actor.disconnectObject(watched);
        watchers.clear();
    }
}
