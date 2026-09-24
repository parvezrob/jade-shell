import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Graphene from 'gi://Graphene';
import Meta from 'gi://Meta';
import Mtk from 'gi://Mtk';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as AppFavorites from 'resource:///org/gnome/shell/ui/appFavorites.js';
import * as DND from 'resource:///org/gnome/shell/ui/dnd.js';
import * as Layout from 'resource:///org/gnome/shell/ui/layout.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {Glass, hexToRgb} from './glass.js';
import {AppItem, Separator, ShowAppsItem, TrashItem, setTint} from './items.js';
import {Badges} from './badges.js';
import {forgetTinted} from './tint.js';

// Magnification, after dash2dock-motion's magnifier (GPL-2.0-or-later, see
// THIRD_PARTY_LICENSES.md): each icon's size is a raised cosine of its
// distance from the pointer, reaching three icons either side; slots widen by
// their icon's size and add up, anchored so the icon under the pointer stays
// under it; and the whole effect fades in and out on a critically damped
// spring, never overshooting.
const REACH = 6;             // slots the magnification spans
const SPRING = 20;           // rad/s: in and out in about a fifth of a second
const CURSOR_TAU = 0.045;    // s: smooths the pointer against the frame clock
const PRESENCE_TAU = 0.07;   // s: icons arriving and leaving, neighbours sliding
const MAX_DT = 1 / 30;

// Sliding in and out of the screen edge.
const SHOW_MS = 260;
const HIDE_MS = 220;
const HIDE_DELAY_MS = 450;
const CHECK_MS = 100;        // windows moving near the dock, at most this often
const PRESSURE = 50;         // px pushed into the bottom edge to reveal it
const PRESSURE_TIMEOUT = 1000;

const TOP_LEFT = new Graphene.Point({x: 0, y: 0});
const REMOVE_AFTER_MS = 650;  // held away from the dock this long, a pinned app can be dropped to remove it

// '#rrggbb' at an alpha, as CSS.
// '#rrggbb' mixed toward '#rrggbb' by `amount`, as CSS.
function mix(hex, toward, amount) {
    const [a, b] = [hexToRgb(hex), hexToRgb(toward)];
    return `rgb(${a.map((v, i) => Math.round(v + (b[i] - v) * amount)).join(', ')})`;
}

export function rgba(hex, alpha) {
    const [r, g, b] = hexToRgb(hex);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// One dock, at the bottom of one monitor.
//
// Every item is laid out once, at the left edge, and put in place with
// transforms: nothing is measured or allocated again while icons magnify, slide
// or bounce, so a frame is a handful of property writes and one shader pass.
export class Bar {
    constructor(monitorIndex, settings, theme) {
        this._monitorIndex = monitorIndex;
        this._settings = settings;
        this._theme = theme;
        this._items = [];
        this._apps = new Map();
        this._envelope = 0;
        this._velocity = 0;
        this._target = 0;
        this._cursor = null;
        this._shown = true;
        this._slide = 0;
        this._slideTarget = 0;
        this._menus = 0;
        this._overlap = false;
        this._dragging = null;
        this._timers = {};

        const monitor = Main.layoutManager.monitors[monitorIndex];
        this._monitor = monitor;
        this.actor = new St.Widget({
            name: 'jadeDock', style_class: 'jade-dock', reactive: false,
            x: monitor.x, y: monitor.y, width: monitor.width, height: monitor.height,
        });
        this.actor._delegate = this;
        this._content = new St.Widget({reactive: false, width: monitor.width, height: monitor.height});
        this._content.connect('notify::translation-y', () => {
            this._slide = this._content.translation_y;
            this._glass.slide = this._slide;
        });
        this.actor.add_child(this._content);

        this._glass = new Glass(this._content, monitorIndex);
        this._hit = new St.Widget({reactive: true, width: 1, height: 1, pivot_point: TOP_LEFT});
        this._hit.connect('enter-event', () => this.wake());
        this._content.add_child(this._hit);
        this._icons = new St.Widget({reactive: false});
        this._content.add_child(this._icons);
        this._label = new St.Label({style_class: 'jade-dock-label', opacity: 0});
        this._content.add_child(this._label);
        this._strut = new St.Widget({reactive: false, visible: false});
        this.actor.add_child(this._strut);

        // Wayland: only reactive actors take the pointer, so the monitor-sized
        // container lets every click through except on the dock itself.
        Main.layoutManager.addChrome(this.actor, {trackFullscreen: true});

        this._readSettings();
        this._separator = new Separator(this);
        this._showApps = new ShowAppsItem(this);
        this._settingsChanged = [
            'dock-icon-size', 'dock-magnification', 'dock-behavior', 'dock-show-trash', 'dock-bounce', 'dock-icon-style',
        ].map(key => settings.connect(`changed::${key}`, () => this._queueReadSettings()));

        this._appSystem = Shell.AppSystem.get_default();
        this._appSystem.connectObject(
            'installed-changed', () => this._queueRedisplay(),
            'app-state-changed', () => this._queueRedisplay(),
            this);
        AppFavorites.getAppFavorites().connectObject('changed', () => this._queueRedisplay(), this);
        Main.overview.connectObject(
            'showing', () => this._syncVisible(),
            'hidden', () => this._syncVisible(),
            'item-drag-begin', (_overview, source) => this._dragBegin(source),
            'item-drag-end', () => this._dragEnd(),
            'item-drag-cancelled', () => this._dragEnd(),
            this);
        global.display.connectObject(
            'window-created', (_d, window) => this._trackWindow(window),
            'restacked', () => this._queueCheck(),
            'window-demands-attention', (_d, window) => this._attention(window, 'attention'),
            'window-marked-urgent', (_d, window) => this._attention(window, 'urgent'),
            this);
        global.workspace_manager.connectObject('active-workspace-changed', () => this._queueCheck(), this);
        // Icons on disk changed (another icon theme, or Jade's rebuilt): the
        // tinted copies go, and the icons are drawn again once GNOME has.
        St.TextureCache.get_default().connectObject('icon-theme-changed', () => {
            forgetTinted();
            GLib.idle_add_once(GLib.PRIORITY_DEFAULT_IDLE, () => this._items && this._restyleItems());
        }, this);
        for (const actor of global.get_window_actors())
            this._trackWindow(actor.meta_window);
        this._unfollow = theme.follow(palette => this._style(palette));
        this._badges = new Badges(() => this._syncBadges());

        this._redisplay();
    }

    destroy() {
        if (this._dragMonitor)
            DND.removeDragMonitor(this._dragMonitor);
        this._disarmRemove();
        for (const id of Object.values(this._timers))
            GLib.source_remove(id);
        this._timers = {};
        this._stopTimeline();
        this._settingsChanged.forEach(id => this._settings.disconnect(id));
        this._unfollow();
        this._badges.destroy();
        this._appSystem.disconnectObject(this);
        AppFavorites.getAppFavorites().disconnectObject(this);
        Main.overview.disconnectObject(this);
        global.display.disconnectObject(this);
        global.workspace_manager.disconnectObject(this);
        St.TextureCache.get_default().disconnectObject(this);
        for (const window of this._windows ?? [])
            window.disconnectObject(this);
        this._removeBarrier();
        for (const item of this._apps.values())
            item.setRest(new Mtk.Rectangle({x: 0, y: 0, width: 0, height: 0}));
        setTint(null);
        this._glass.destroy();
        this.actor.destroy();
    }

    // ---------- geometry ----------

    // A slider in the settings sends a change every step: take the last one.
    _queueReadSettings() {
        if (this._timers.settings)
            GLib.source_remove(this._timers.settings);
        this._timers.settings = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 40, () => {
            delete this._timers.settings;
            this._readSettings();
            return GLib.SOURCE_REMOVE;
        });
    }

    _readSettings() {
        const {scaleFactor} = St.ThemeContext.get_for_stage(global.stage);
        const logical = this._settings.get_int('dock-icon-size');
        const k = logical / 48;
        const s = scaleFactor;
        this.metrics = {
            scale: s,
            logical,
            icon: Math.round(logical * s),
            gap: Math.round(6 * k * s),
            padX: Math.round(7 * k * s),
            padTop: Math.round(6 * k * s),
            padBottom: Math.round(10 * k * s),
            float: Math.round(6 * s),
            radius: Math.round(19 * k * s),
            dot: Math.max(Math.round(3 * s), Math.round(4 * k * s)),
            dotOffset: Math.round(3 * k * s),
            separator: Math.round(13 * k * s),
            labelGap: Math.round(8 * s),
            shadow: Math.round(34 * s),
        };
        this._maxScale = Math.max(1, this._settings.get_double('dock-magnification'));
        this._behavior = this._settings.get_string('dock-behavior');
        this._showTrash = this._settings.get_boolean('dock-show-trash');
        this.bounces = this._settings.get_boolean('dock-bounce');
        this._tinted = this._settings.get_string('dock-icon-style') === 'tinted';

        const m = this.metrics;
        const height = this._monitor.height;
        this._slabHeight = m.padTop + m.icon + m.padBottom;
        this._slabTop = height - m.float - this._slabHeight;
        this._iconTop = this._slabTop + m.padTop;
        const glassTop = this._slabTop - m.shadow;
        this._glassTop = glassTop;
        this._glass.place(this._monitor.width, glassTop, height - glassTop, height);
        this._icons.set_position(0, this._iconTop);
        this._strut.set_position(0, this._slabTop - m.float);
        this._strut.set_size(this._monitor.width, height - this._slabTop + m.float);
        for (const item of this._items)
            item.resize(m.icon, m);
        this._style(this._theme.palette);
        this._syncBehavior();
        this._redisplay();
    }

    _style(palette) {
        this._palette = palette;
        setTint(this._tinted ? palette : null);
        const m = this.metrics;
        this._glass.style(palette, {radius: m.radius * 1.25, scale: m.scale});
        const light = palette.mode === 'light';
        const fg = palette.foreground;
        this._dotStyle = `background-color: ${light ? rgba(fg, 0.75) : rgba(fg, 0.9)}; border-radius: ${m.dot}px;`;
        this._separatorStyle = `background-color: ${rgba(fg, light ? 0.22 : 0.26)};`;
        // Badges in the theme's red, as a Mac's are in the system red.
        this._badgeColors = [palette.red ?? '#ff453a', '#ffffff'];
        this._progressStyle = `background-color: ${rgba('#000000', light ? 0.22 : 0.45)};` +
            ` border-radius: ${Math.round(3 * m.scale)}px;`;
        this._progressFillStyle = `background-color: ${palette.accent}; border-radius: ${Math.round(3 * m.scale)}px;`;
        // Icons cast a soft shadow on the glass, as a Mac's do.
        this._iconStyle = `icon-shadow: 0 ${Math.round(2 * m.scale)}px ${Math.round(5 * m.scale)}px rgba(0, 0, 0, ${light ? 0.2 : 0.38});`;
        this._label.style = `background-color: ${rgba(palette.background, 0.9)}; color: ${fg};` +
            ` border: 1px solid ${rgba(fg, 0.14)}; border-radius: ${Math.round(8 * m.scale)}px;`;
        this._tileStyle = `background-gradient-direction: vertical;` +
            ` background-gradient-start: ${mix(palette.accent, '#ffffff', 0.2)}; background-gradient-end: ${palette.accent};` +
            ` color: ${palette.accent_fg ?? palette.background}; border-radius: ${Math.round(m.icon * 0.23)}px;` +
            ` box-shadow: 0 ${Math.round(2 * m.scale)}px ${Math.round(5 * m.scale)}px rgba(0, 0, 0, ${light ? 0.18 : 0.34});`;
        this._restyleItems();
        this.onRestyle?.();
    }

    _restyleItems() {
        for (const item of this._items)
            item.restyle(this);
    }

    // ---------- items ----------

    _queueRedisplay() {
        if (this._timers.redisplay)
            return;
        this._timers.redisplay = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            delete this._timers.redisplay;
            this._redisplay();
            return GLib.SOURCE_REMOVE;
        });
    }

    // Pinned apps, then running ones in the order they started, then the
    // separator, Show Apps and the trash: the way a Mac orders its dock.
    _redisplay() {
        if (!this._separator)
            return;
        const favorites = AppFavorites.getAppFavorites().getFavorites();
        const pinned = new Set(favorites.map(app => app.get_id()));
        const running = this._appSystem.get_running().filter(app => !pinned.has(app.get_id()));
        const previous = this._items.filter(item => item.kind === 'app' && item.target > 0 && !pinned.has(item.id))
            .map(item => item.id);
        running.sort((a, b) => {
            const [i, j] = [previous.indexOf(a.get_id()), previous.indexOf(b.get_id())];
            return (i < 0 ? Infinity : i) - (j < 0 ? Infinity : j);
        });
        const apps = [...favorites, ...running];
        const wanted = new Set(apps.map(app => app.get_id()));

        for (const [id, item] of this._apps) {
            if (!wanted.has(id)) {
                item.leave();
                this._apps.delete(id);
            }
        }
        const order = [];
        for (const app of apps) {
            let item = this._apps.get(app.get_id());
            if (!item) {
                item = new AppItem(app, this);
                item.restyle(this);
                if (!this._built)
                    item.presence = 1;
                this._icons.add_child(item);
                this._apps.set(app.get_id(), item);
                // Launched from elsewhere (the app grid, a shortcut): arrive bouncing.
                if (app.state === Shell.AppState.STARTING)
                    item.bounce('launch');
            }
            order.push(item);
        }
        // Items leaving keep their place while they shrink away.
        const leaving = this._items.filter(item => item.kind === 'app' && item.target === 0);
        for (const item of leaving) {
            const before = this._items.indexOf(item);
            const anchor = this._items.slice(0, before).reverse().find(i => order.includes(i));
            order.splice(anchor ? order.indexOf(anchor) + 1 : 0, 0, item);
        }

        const tail = [this._separator, this._showApps];
        if (this._showTrash) {
            this._trash ??= new TrashItem(this);
            tail.push(this._trash);
        } else if (this._trash) {
            this._trash.leave();
            order.push(this._trash);
            this._trash = null;
        }
        for (const item of tail) {
            if (!item.get_parent()) {
                this._icons.add_child(item);
                if (!this._built)
                    item.presence = 1;
            }
        }
        this._items = [...order, ...tail];
        this._built = true;
        this._syncBadges();
        this._restyleItems();
        this._layoutChanged();
    }

    _syncBadges() {
        if (!this._badges)
            return;
        for (const [id, item] of this._apps) {
            item.setBadge(this._badges.badge(id));
            item.setProgress(this._badges.progress(id));
        }
    }

    // Something moved: run the frame loop until everything has settled.
    _layoutChanged() {
        this._startTimeline();
        this.queueRestUpdate();
    }

    menuChanged(open) {
        this._menus = Math.max(0, this._menus + (open ? 1 : -1));
        if (open)
            this._stopTimeline();  // freeze: the icon stays magnified under its menu
        else
            this.wake();
        this._syncVisible();
    }

    // ---------- the frame loop ----------

    wake() {
        this._startTimeline();
    }

    _startTimeline() {
        if (this._timeline || this._menus > 0)
            return;
        this._cursor = null;
        this._timeline = Clutter.Timeline.new_for_actor(this.actor, 1000 * 3600);
        this._timeline.set_repeat_count(-1);
        this._timeline.connect('new-frame', () => this._frame());
        this._timeline.start();
        this._frame(0);
    }

    _stopTimeline() {
        this._timeline?.stop();
        this._timeline = null;
    }

    _frame(delta) {
        const dt = Math.min((delta ?? this._timeline?.get_delta() ?? 0) / 1000, MAX_DT);
        const [px, py] = global.get_pointer();
        const x = px - this._monitor.x;
        const y = py - this._monitor.y;
        if (this._cursor === null)
            this._cursor = x;
        else
            this._cursor += (x - this._cursor) * (1 - Math.exp(-dt / CURSOR_TAU));

        const hover = this._shown && this._slide === 0 && this._inside(x, y);
        if (hover !== this._hover) {
            this._hover = hover;
            if (!hover)
                this._leftAt = GLib.get_monotonic_time();
            this._syncVisible();
        }
        this._target = hover && this._maxScale > 1 && !this._dragging ? 1 : 0;

        this._velocity += (-2 * SPRING * this._velocity - SPRING * SPRING * (this._envelope - this._target)) * dt;
        this._envelope = Math.min(1.2, Math.max(0, this._envelope + this._velocity * dt));

        let moving = false;
        const ease = 1 - Math.exp(-dt / PRESENCE_TAU);
        for (const item of [...this._items]) {
            if (item.settled) {
                item.presence = item.target;
            } else {
                item.presence += (item.target - item.presence) * (dt > 0 ? ease : 0);
                moving = true;
            }
            if (item.target === 0 && item.presence < 0.002)
                this._drop(item);
        }

        this._layout();

        const still = this._target === 0 && Math.abs(this._envelope) < 0.002 && Math.abs(this._velocity) < 0.02;
        if (still && !moving && dt > 0) {
            this._envelope = this._velocity = 0;
            this._layout();
            this._stopTimeline();
            this.queueRestUpdate();
        }
    }

    _drop(item) {
        this._items = this._items.filter(i => i !== item);
        item.destroy();
    }

    // Is the pointer on the dock: its glass, the magnified icons above it, and
    // the strip under it down to the screen's edge?
    _inside(x, y) {
        const [left, right] = this._extent ?? [0, 0];
        const rise = this._envelope > 0.05 || this._target ? this.metrics.icon * (this._maxScale - 1) : 0;
        return x >= left && x <= right && y >= this._slabTop - rise && y <= this._monitor.height;
    }

    _layout() {
        const m = this.metrics;
        const items = this._items;
        if (items.length === 0)
            return;
        const slots = items.map(item => item.presence * (item.slot + m.gap));
        const total = slots.reduce((a, b) => a + b, 0);
        const start = Math.round((this._monitor.width - total) / 2);

        // Base slots, resting.
        const bounds = [start];
        for (const slot of slots)
            bounds.push(bounds[bounds.length - 1] + slot);

        // Magnified slots.
        const eff = this._envelope * (this._maxScale - 1);
        const width = REACH * (m.icon + m.gap);
        const cursor = this._cursor ?? 0;
        const scales = items.map((item, i) => {
            if (eff <= 0)
                return 1;
            const center = (bounds[i] + bounds[i + 1]) / 2;
            const theta = Math.min(Math.max((center - (cursor - width / 2)) / width * 2 * Math.PI, 0), 2 * Math.PI);
            return 1 + eff * (1 - Math.cos(theta)) / 2;
        });
        const grown = [start];
        for (let i = 0; i < items.length; i++)
            grown.push(grown[i] + slots[i] * scales[i]);

        // Anchor: the point under the pointer stays under it. Off the ends,
        // the dock grows away from the pointer.
        const n = items.length;
        let shift = 0;
        if (eff > 0) {
            if (cursor <= bounds[0]) {
                shift = 0;
            } else if (cursor >= bounds[n]) {
                shift = bounds[n] - grown[n];
            } else {
                let i = 0;
                while (i < n - 1 && bounds[i + 1] < cursor)
                    i++;
                shift = cursor - (grown[i] + (cursor - bounds[i]) * scales[i]);
            }
        }

        for (let i = 0; i < n; i++) {
            const center = grown[i] + slots[i] * scales[i] / 2 + shift;
            items[i].place(center, scales[i], Math.min(1, items[i].presence));
        }

        const pad = m.padX - m.gap / 2;
        const left = grown[0] + shift - pad;
        const right = grown[n] + shift + pad;
        this._extent = [left, right];
        this._glass.shape(left, m.shadow, right - left, this._slabHeight);

        // The pointer's area grows with the magnified icons.
        const rise = this._target || this._envelope > 0.05 ? m.icon * (this._maxScale - 1) : 0;
        const top = this._slabTop - rise;
        this._hit.set_translation(left, top, 0);
        this._hit.set_scale(right - left, this._monitor.height - top);

        this._layoutLabel(grown, scales, slots, shift);
    }

    // The name of the app under the pointer, above its icon as magnified.
    _layoutLabel(grown, scales, slots, shift) {
        const items = this._items;
        let index = -1;
        if (this._hover && this._menus === 0 && !this._dragging) {
            const cursor = this._cursor;
            for (let i = 0; i < items.length; i++) {
                if (cursor >= grown[i] + shift && cursor < grown[i + 1] + shift && items[i].label) {
                    index = i;
                    break;
                }
            }
        }
        if (index < 0) {
            if (this._labelFor) {
                this._labelFor = null;
                this._label.remove_all_transitions();
                this._label.ease({opacity: 0, duration: 80, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
            }
            return;
        }
        const item = items[index];
        if (this._labelFor !== item) {
            this._label.text = item.label;
            if (!this._labelFor) {
                this._label.remove_all_transitions();
                this._label.ease({opacity: 255, duration: 90, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
            }
            this._labelFor = item;
        }
        const m = this.metrics;
        const [, , width, height] = this._label.get_preferred_size();
        const center = grown[index] + slots[index] * scales[index] / 2 + shift;
        const iconTop = this._iconTop + m.icon - m.icon * scales[index];
        const x = Math.round(Math.min(Math.max(center - width / 2, 4), this._monitor.width - width - 4));
        this._label.set_translation(x, Math.round(iconTop - m.labelGap - height), 0);
    }

    // ---------- where windows minimize to ----------

    queueRestUpdate() {
        if (this._timers.rest)
            return;
        this._timers.rest = GLib.timeout_add(GLib.PRIORITY_LOW, 150, () => {
            delete this._timers.rest;
            this._updateRest();
            return GLib.SOURCE_REMOVE;
        });
    }

    // Where the dock's slab starts when shown, in stage coordinates (what
    // corner cards stay above).
    get top() {
        return this._monitor.y + this._slabTop;
    }

    // Each app's windows minimize into its icon where it rests, even while the
    // dock is hidden.
    _updateRest() {
        const m = this.metrics;
        const items = this._items.filter(item => item.target > 0);
        const total = items.reduce((sum, item) => sum + item.slot + m.gap, 0);
        let x = Math.round((this._monitor.width - total) / 2);
        for (const item of items) {
            const left = x + m.gap / 2;
            item.setRest(new Mtk.Rectangle({
                x: Math.round(this._monitor.x + left), y: Math.round(this._monitor.y + this._iconTop),
                width: item.slot, height: m.icon,
            }));
            x += item.slot + m.gap;
        }
        this._restExtent = [Math.round((this._monitor.width - total) / 2) - m.padX, Math.round((this._monitor.width + total) / 2) + m.padX];
        this._updateBarrier();
        this._queueCheck();
    }

    // ---------- showing and hiding ----------

    _syncBehavior() {
        const always = this._behavior === 'always';
        if (always !== this._strut.visible) {
            this._strut.visible = always;
            if (always)
                Main.layoutManager.trackChrome(this._strut, {affectsStruts: true});
            else
                Main.layoutManager.untrackChrome(this._strut);
        }
        this._updateBarrier();
        this._queueCheck();
        this._syncVisible();
    }

    _hideWanted() {
        if (Main.overview.visible || this._hover || this._menus > 0 || this._dragging || this._revealing)
            return false;
        if (this._behavior === 'autohide')
            return true;
        return this._behavior === 'intellihide' && this._overlap;
    }

    _syncVisible() {
        if (!this._hideWanted()) {
            if (this._timers.hide) {
                GLib.source_remove(this._timers.hide);
                delete this._timers.hide;
            }
            this._show();
            return;
        }
        if (!this._shown || this._timers.hide)
            return;
        // A moment's grace after the pointer leaves, so the dock doesn't
        // flicker away as the pointer passes over its edge.
        const since = (GLib.get_monotonic_time() - (this._leftAt ?? 0)) / 1000;
        this._timers.hide = GLib.timeout_add(GLib.PRIORITY_DEFAULT, Math.max(0, HIDE_DELAY_MS - since), () => {
            delete this._timers.hide;
            if (this._hideWanted())
                this._hide();
            return GLib.SOURCE_REMOVE;
        });
    }

    _show() {
        this._revealing = false;
        if (this._shown && this._slideTarget === 0)
            return;
        this._shown = true;
        this._animateSlide(0, SHOW_MS, Clutter.AnimationMode.EASE_OUT_CUBIC);
    }

    _hide() {
        if (!this._shown)
            return;
        this._shown = false;
        this._hover = false;
        this._animateSlide(this._monitor.height - this._slabTop + this.metrics.shadow, HIDE_MS,
            Clutter.AnimationMode.EASE_IN_CUBIC);
    }

    _animateSlide(offset, duration, mode) {
        this._slideTarget = offset;
        this._content.ease({translation_y: offset, duration, mode});
    }

    // The bottom edge: push the pointer into it to bring the dock back.
    _updateBarrier() {
        this._removeBarrier();
        if (this._behavior === 'always' || !this._restExtent)
            return;
        const [left, right] = this._restExtent;
        const y = this._monitor.y + this._monitor.height;
        this._barrier = new Meta.Barrier({
            backend: global.backend,
            x1: this._monitor.x + Math.max(0, left), x2: this._monitor.x + Math.min(this._monitor.width, right),
            y1: y, y2: y,
            directions: Meta.BarrierDirection.NEGATIVE_Y,
        });
        this._pressure = new Layout.PressureBarrier(PRESSURE, PRESSURE_TIMEOUT,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW);
        this._pressure.addBarrier(this._barrier);
        this._pressure.connect('trigger', () => {
            if (this._shown)
                return;
            this._revealing = true;
            this._show();
            // Once it is up, the pointer is on it: the frame loop takes over.
            this._timers.reveal = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SHOW_MS + 30, () => {
                delete this._timers.reveal;
                this._revealing = false;
                this.wake();
                if (!this._hover)
                    this._syncVisible();
                return GLib.SOURCE_REMOVE;
            });
        });
    }

    _removeBarrier() {
        this._pressure?.destroy();
        this._pressure = null;
        this._barrier?.destroy();
        this._barrier = null;
    }

    // ---------- windows near the dock ----------

    _trackWindow(window) {
        this._windows ??= new Set();
        if (this._windows.has(window))
            return;
        this._windows.add(window);
        window.connectObject(
            'position-changed', () => this._queueCheck(),
            'size-changed', () => this._queueCheck(),
            'notify::minimized', () => this._queueCheck(),
            'unmanaged', () => {
                window.disconnectObject(this);
                this._windows.delete(window);
                this._queueCheck();
            },
            this);
        this._queueCheck();
    }

    _queueCheck() {
        if (this._timers.check || this._behavior !== 'intellihide')
            return;
        this._timers.check = GLib.timeout_add(GLib.PRIORITY_DEFAULT, CHECK_MS, () => {
            delete this._timers.check;
            this._checkOverlap();
            return GLib.SOURCE_REMOVE;
        });
    }

    _checkOverlap() {
        const [left, right] = this._restExtent ?? [0, 0];
        const top = this._monitor.y + this._slabTop - this.metrics.float;
        const dock = {x1: this._monitor.x + left, x2: this._monitor.x + right, y1: top};
        const workspace = global.workspace_manager.get_active_workspace();
        const overlap = [...(this._windows ?? [])].some(window => {
            if (window.minimized || !window.showing_on_its_workspace() || window.get_monitor() !== this._monitorIndex)
                return false;
            if (!window.located_on_workspace(workspace) || window.skip_taskbar && window.get_window_type() !== Meta.WindowType.NORMAL)
                return false;
            if (![Meta.WindowType.NORMAL, Meta.WindowType.DIALOG, Meta.WindowType.MODAL_DIALOG,
                Meta.WindowType.UTILITY, Meta.WindowType.TOOLBAR].includes(window.get_window_type()))
                return false;
            const r = window.get_frame_rect();
            return r.x < dock.x2 && r.x + r.width > dock.x1 && r.y + r.height > dock.y1;
        });
        if (overlap !== this._overlap) {
            this._overlap = overlap;
            this._syncVisible();
        }
    }

    _attention(window, kind) {
        const app = Shell.WindowTracker.get_default().get_window_app(window);
        const item = app && this._apps.get(app.get_id());
        if (item && !window.has_focus())
            item.bounce(kind);
    }

    // ---------- dragging apps in ----------

    _dragBegin(source) {
        const item = source?._owner;
        const pinned = item && this._apps.get(item.id) === item &&
            AppFavorites.getAppFavorites().isFavorite(item.id);
        this._dragging = {index: -1, removable: pinned ? item : null};
        if (pinned) {
            this._dragMonitor = {dragMotion: () => this._dragMotion()};
            DND.addDragMonitor(this._dragMonitor);
        }
        this._syncVisible();
    }

    _dragEnd() {
        if (this._dragMonitor) {
            DND.removeDragMonitor(this._dragMonitor);
            this._dragMonitor = null;
        }
        this._disarmRemove();
        this._clearPlaceholder();
        this._dragging = null;
        this._syncVisible();
        this.wake();
    }

    // Dragged away from the dock and held there a moment, a pinned app shows
    // "Remove" by the pointer, and dropping it there unpins it, as on a Mac.
    _dragMotion() {
        const [px, py] = global.get_pointer();
        const x = px - this._monitor.x;
        const y = py - this._monitor.y;
        const [left, right] = this._extent ?? [0, 0];
        const away = y < this._slabTop - this.metrics.icon || x < left - this.metrics.icon ||
            x > right + this.metrics.icon;
        if (!away) {
            this._disarmRemove();
        } else if (this._removeLabel) {
            this._placeRemoveLabel(px, py);
        } else if (!this._timers.remove) {
            this._timers.remove = GLib.timeout_add(GLib.PRIORITY_DEFAULT, REMOVE_AFTER_MS, () => {
                delete this._timers.remove;
                this._armRemove();
                return GLib.SOURCE_REMOVE;
            });
        }
        return DND.DragMotionResult.CONTINUE;
    }

    _armRemove() {
        const item = this._dragging?.removable;
        if (!item)
            return;
        // A drop target over everything but the dragged icon itself.
        this._removeShield = new St.Widget({
            reactive: true, x: this._monitor.x, y: this._monitor.y,
            width: this._monitor.width, height: this._monitor.height,
        });
        this._removeShield._delegate = {
            handleDragOver: () => DND.DragMotionResult.MOVE_DROP,
            acceptDrop: () => {
                GLib.idle_add_once(GLib.PRIORITY_DEFAULT, () => AppFavorites.getAppFavorites().removeFavorite(item.id));
                return true;
            },
        };
        Main.uiGroup.insert_child_below(this._removeShield, Main.uiGroup.get_last_child());
        this._removeLabel = new St.Label({text: 'Remove', style_class: 'jade-dock-label', style: this._label.style,
            opacity: 0});
        Main.uiGroup.add_child(this._removeLabel);
        const [px, py] = global.get_pointer();
        this._placeRemoveLabel(px, py);
        this._removeLabel.ease({opacity: 255, duration: 120, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
    }

    _placeRemoveLabel(px, py) {
        const [, , width, height] = this._removeLabel.get_preferred_size();
        this._removeLabel.set_position(Math.round(px - width / 2), Math.round(py - this.metrics.icon * 0.9 - height));
    }

    _disarmRemove() {
        if (this._timers.remove) {
            GLib.source_remove(this._timers.remove);
            delete this._timers.remove;
        }
        this._removeShield?.destroy();
        this._removeShield = null;
        this._removeLabel?.destroy();
        this._removeLabel = null;
    }

    _clearPlaceholder() {
        if (this._placeholder) {
            this._placeholder.leave();
            this._placeholder = null;
            this._layoutChanged();
        }
    }

    // Where an app dropped at `x` would go among the pinned apps (not
    // counting the app itself, when it is one of them).
    _dropIndex(x, id) {
        const count = AppFavorites.getAppFavorites().getFavorites().length;
        const pinned = this._items.filter(item => item.kind === 'app' && item.target > 0).slice(0, count)
            .filter(item => item.id !== id);
        const index = pinned.findIndex(item => x < item.translation_x + item.span / 2);
        return index < 0 ? pinned.length : index;
    }

    handleDragOver(source, _actor, x, _y) {
        const app = source?.app;
        if (!app || !this._dragging || this._slide !== 0)
            return DND.DragMotionResult.NO_DROP;
        const index = this._dropIndex(x, app.get_id());
        if (!this._placeholder || this._dragging.index !== index) {
            this._clearPlaceholder();
            this._placeholder = new Separator(this);
            this._placeholder.kind = 'placeholder';
            this._placeholder.slot = this.metrics.icon;
            this._placeholder._line.hide();
            this._icons.add_child(this._placeholder);
            const pinned = this._items.filter(item => item.kind === 'app' && item.target > 0)
                .slice(0, AppFavorites.getAppFavorites().getFavorites().length)
                .filter(item => item.id !== app.get_id());
            const anchor = pinned[index - 1];
            const at = anchor ? this._items.indexOf(anchor) + 1 : 0;
            this._items.splice(at, 0, this._placeholder);
            this._dragging.index = index;
            this._layoutChanged();
        }
        const favorite = AppFavorites.getAppFavorites().isFavorite(app.get_id());
        return favorite ? DND.DragMotionResult.MOVE_DROP : DND.DragMotionResult.COPY_DROP;
    }

    acceptDrop(source) {
        const app = source?.app;
        if (!app || !this._dragging || this._dragging.index < 0)
            return false;
        const favorites = AppFavorites.getAppFavorites();
        const id = app.get_id();
        const index = this._dragging.index;
        GLib.idle_add_once(GLib.PRIORITY_DEFAULT, () => {
            if (favorites.isFavorite(id))
                favorites.moveFavoriteToPos(id, index);
            else
                favorites.addFavoriteAtPos(id, index);
        });
        return true;
    }
}
