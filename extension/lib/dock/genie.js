import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

// macOS's genie: a minimized window bends into a funnel toward its dock icon
// and pours down into it; unminimized, it pours back out. (After the idea of
// Compiz's magic lamp; the curve and timing here are our own.)
//
// GNOME animates minimizing itself (a straight shrink toward the icon). For
// windows with a dock icon, Jade answers GNOME's "animate this?" with no, so
// GNOME finishes at once, holds back that finish until the genie is done,
// and plays the genie instead.

const MINIMIZE_MS = 560;
const UNMINIMIZE_MS = 480;
const X_TILES = 6;
const Y_TILES = 48;

const smooth = u => u * u * (3 - 2 * u);
const clamp01 = u => Math.min(1, Math.max(0, u));

const GenieEffect = GObject.registerClass(
class JadeGenieEffect extends Clutter.DeformEffect {
    _init(from, icon) {
        super._init();
        this._from = from;   // the window, in stage coordinates
        this._icon = icon;   // its dock icon
        this.progress = 0;
        this.set_n_tiles(X_TILES, Y_TILES);
    }

    // Where the funnel's sides are at height `y`: the window's sides at its
    // top, bending smoothly to the icon's at the icon.
    _sides(y) {
        const w = this._from;
        const icon = this._icon;
        const span = icon.y - w.y;
        const f = span > 1 ? smooth(clamp01((y - w.y) / span)) : 1;
        return [w.x + (icon.x - w.x) * f, w.x + w.width + (icon.x + icon.width - w.x - w.width) * f];
    }

    vfunc_deform_vertex(width, height, vertex) {
        const w = this._from;
        const icon = this._icon;
        const p = this.progress;
        // First the sides bend, then the window pours down through the neck;
        // the two overlap, as on a Mac.
        const bend = smooth(clamp01(p / 0.42));
        const pour = clamp01((p - 0.22) / 0.78);
        const fall = pour * pour;
        const top = w.y + (icon.y - w.y) * fall;
        const bottom = w.y + w.height + (icon.y + icon.height - w.y - w.height) * Math.min(1, fall * 1.4);
        const y = top + vertex.ty * Math.max(0, bottom - top);
        const [left, right] = this._sides(y);
        const l = w.x + (left - w.x) * bend;
        const r = w.x + w.width + (right - w.x - w.width) * bend;
        const x = l + vertex.tx * (r - l);
        vertex.x = (x - w.x) * width / w.width;
        vertex.y = (y - w.y) * height / w.height;
    }

    // The window draws far outside its own box while it pours.
    vfunc_modify_paint_volume(_volume) {
        return false;
    }
});

export class Genie {
    enable() {
        const wm = Main.wm;
        const shellwm = wm._shellwm;
        this._claimed = new Set();
        this._genied = new Set();
        this._running = new Map();
        this._watched = new Set();

        // GNOME asks whether to animate right before it would: for a window
        // Jade animates, the answer is no.
        const shouldAnimate = wm._shouldAnimateActor;
        this._shouldAnimate = shouldAnimate;
        wm._shouldAnimateActor = (actor, types) => {
            const animate = shouldAnimate.call(wm, actor, types);
            if (animate && this._wants(actor)) {
                this._claimed.add(actor);
                // Unclaimed by the end of this turn: it was not a minimize.
                GLib.idle_add_once(GLib.PRIORITY_HIGH, () => this._claimed.delete(actor));
                return false;
            }
            return animate;
        };
        // GNOME then finishes at once; hold that until the genie is done.
        this._completedMinimize = shellwm.completed_minimize;
        this._completedUnminimize = shellwm.completed_unminimize;
        shellwm.completed_minimize = actor => {
            if (!this._claimed.has(actor))
                this._completedMinimize.call(shellwm, actor);
        };
        shellwm.completed_unminimize = actor => {
            if (!this._claimed.has(actor))
                this._completedUnminimize.call(shellwm, actor);
        };
        shellwm.connectObject(
            'minimize', (_wm, actor) => this._start(actor, true),
            'unminimize', (_wm, actor) => this._start(actor, false),
            this);
    }

    disable() {
        const wm = Main.wm;
        const shellwm = wm._shellwm;
        shellwm.disconnectObject(this);
        for (const actor of [...this._running.keys()])
            this._finish(actor);
        wm._shouldAnimateActor = this._shouldAnimate;
        // The overrides are own properties shadowing the methods.
        delete shellwm.completed_minimize;
        delete shellwm.completed_unminimize;
        for (const actor of this._watched)
            actor.disconnectObject(this);
        this._watched.clear();
        this._claimed.clear();
        this._genied.clear();
    }

    // Minimizing a window that has a dock icon (the dock sets it), or
    // unminimizing one that went in with a genie.
    _wants(actor) {
        const window = actor.meta_window;
        if (!window || Main.overview.visible || window.is_monitor_sized?.())
            return false;
        if (window.minimized)
            return window.get_icon_geometry()[0];
        return this._genied.has(actor) && window.get_icon_geometry()[0];
    }

    _start(actor, minimizing) {
        if (!this._claimed.has(actor))
            return;
        this._finish(actor);
        this._claimed.add(actor);
        const [, rect] = actor.meta_window.get_icon_geometry();
        const [x, y] = actor.get_position();
        const [width, height] = actor.get_size();
        const effect = new GenieEffect({x, y, width, height},
            {x: rect.x, y: rect.y, width: rect.width, height: rect.height});
        effect.progress = minimizing ? 0 : 1;
        if (!minimizing)
            actor.show();
        actor.add_effect_with_name('jade-genie', effect);

        const timeline = new Clutter.Timeline({actor, duration: minimizing ? MINIMIZE_MS : UNMINIMIZE_MS});
        timeline.set_progress_mode(minimizing ? Clutter.AnimationMode.EASE_IN_SINE : Clutter.AnimationMode.EASE_OUT_SINE);
        timeline.connect('new-frame', () => {
            const t = timeline.get_progress();
            effect.progress = minimizing ? t : 1 - t;
            // The last stretch fades a little, as the window becomes the icon.
            actor.opacity = Math.round(255 * (1 - 0.6 * clamp01((effect.progress - 0.8) / 0.2)));
            effect.invalidate();
        });
        timeline.connect('completed', () => this._finish(actor));
        this._running.set(actor, {timeline, minimizing});
        if (minimizing)
            this._genied.add(actor);
        else
            this._genied.delete(actor);
        if (!this._watched.has(actor)) {
            this._watched.add(actor);
            actor.connectObject('destroy', () => {
                this._watched.delete(actor);
                this._running.delete(actor);
                this._claimed.delete(actor);
                this._genied.delete(actor);
            }, this);
        }
        timeline.start();
    }

    _finish(actor) {
        const running = this._running.get(actor);
        if (!running)
            return;
        this._running.delete(actor);
        running.timeline.stop();
        actor.remove_effect_by_name('jade-genie');
        actor.opacity = 255;
        this._claimed.delete(actor);
        const shellwm = Main.wm._shellwm;
        if (running.minimizing)
            this._completedMinimize.call(shellwm, actor);
        else
            this._completedUnminimize.call(shellwm, actor);
    }
}
