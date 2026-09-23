// Drives Jade Shell inside the headless test shell of tests/shell/run.sh and
// writes $JADE_SHOTS/done when finished. Two modes ($JADE_MODE):
//
//   shots   (default) opens each panel for each theme in $JADE_THEMES,
//           screenshots it into $JADE_SHOTS and logs "HARNESS …" lines.
//   timing  measures how fast the top-bar menus open and switch, and logs
//           "HARNESS TIMING …" lines (see Timing below).
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as BoxPointer from 'resource:///org/gnome/shell/ui/boxpointer.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const OUT = GLib.getenv('JADE_SHOTS');
const MODE = GLib.getenv('JADE_MODE') || 'shots';
const THEMES = (GLib.getenv('JADE_THEMES') || 'osaka-jade').split(',');
const UUID = 'jade-shell@parvezrob.github.io';
const wait = ms => new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
    resolve();
    return GLib.SOURCE_REMOVE;
}));
const log = message => console.log(`HARNESS ${message}`);

function shoot(name, actor = null) {
    return new Promise(resolve => {
        const stream = Gio.File.new_for_path(`${OUT}/${name}.png`).replace(null, false, Gio.FileCreateFlags.NONE, null);
        const done = finish => {
            try {
                finish();
            } catch (e) {
                log(`shot ${name}: ${e}`);
            }
            stream.close(null);
            resolve();
        };
        const shot = new Shell.Screenshot();
        if (!actor) {
            shot.screenshot(false, stream, (o, res) => done(() => o.screenshot_finish(res)));
            return;
        }
        const [x, y] = actor.get_transformed_position();
        const [w, h] = actor.get_transformed_size();
        const pad = 10;
        shot.screenshot_area(Math.max(0, Math.floor(x - pad)), Math.max(0, Math.floor(y - pad)),
            Math.ceil(w + 2 * pad), Math.ceil(h + 2 * pad), stream, (o, res) => done(() => o.screenshot_area_finish(res)));
    });
}

function jade(...args) {
    return new Promise(resolve => {
        const proc = Gio.Subprocess.new([`${GLib.getenv('HOME')}/.local/bin/jade`, ...args],
            Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_MERGE);
        proc.communicate_utf8_async(null, null, (p, r) => {
            const [, out] = p.communicate_utf8_finish(r);
            log(`jade ${args.join(' ')} → ${p.get_exit_status()} ${out.trim().split('\n').pop()}`);
            resolve();
        });
    });
}

async function panel(role, name, settle = 1600) {
    const button = Main.panel.statusArea[role];
    if (!button) {
        log(`no ${role} in the top bar`);
        return;
    }
    button.menu.open(false);
    await wait(settle);
    await shoot(name, button.menu.box ?? button.menu.actor);
    button.menu.close(false);
    await wait(400);
}

// A top-bar button at rest, hovered and with its menu open, cropped to its box.
async function states(role, name) {
    const button = Main.panel.statusArea[role];
    if (!button)
        return;
    const box = button.get_parent().get_parent();
    await shoot(`${name}-rest`, box);
    button.add_style_pseudo_class('hover');
    await wait(300);
    await shoot(`${name}-hover`, box);
    button.remove_style_pseudo_class('hover');
    button.menu.open(false);
    await wait(300);
    await shoot(`${name}-open`, box);
    button.menu.close(false);
    await wait(300);
}

// The bell off puts GNOME's list, Clear row, unread dot and pop-up place back;
// on again takes them. Logs "HARNESS bell …" lines and shoots the calendar.
async function bellRoundTrip() {
    const settings = Extension.lookupByUUID(UUID)?.getSettings();
    const dateMenu = Main.panel.statusArea.dateMenu;
    const list = dateMenu._messageList;
    const where = () => {
        const clockBox = dateMenu._clockDisplay.get_parent();
        return [`list in ${list.get_parent()?.name || list.get_parent()?.style_class}`,
            `clear row ${list._clearButton.get_parent().visible ? 'shown' : 'hidden'}`,
            `clock box ${clockBox.get_children().map(c => c.constructor.name).join(',')}`,
            `banners ${Main.messageTray.bannerAlignment}`,
            `bell ${Main.panel.statusArea['jade-bell'] ? 'in bar' : 'gone'}`,
            `toggleCalendar ${Object.hasOwn(Main.panel, 'toggleCalendar') ? 'ours' : 'GNOME'}`].join('; ');
    };
    log(`bell on: ${where()}`);
    settings.set_boolean('notification-bell', false);
    await wait(500);
    log(`bell off: ${where()}`);
    await panel('dateMenu', 'bell-off-calendar');
    settings.set_boolean('notification-bell', true);
    await wait(500);
    log(`bell on again: ${where()}`);
    await panel('jade-bell', 'bell-on-again');
}

// The bar clock follows GNOME's 12h/24h and seconds settings live, unless a
// format of the user's own is set. Logs "HARNESS clock …" lines.
async function clockFollowsGnome() {
    const iface = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
    const jade = Extension.lookupByUUID(UUID)?.getSettings();
    const text = () => Main.panel.statusArea.dateMenu._clockDisplay.get_parent().get_children()
        .filter(c => c instanceof St.Label && c.visible).map(c => c.text).join(' | ');
    const show = async what => {
        await wait(400);
        log(`clock ${what}: ${text()}`);
    };
    iface.set_string('clock-format', '24h');
    await show('24h');
    iface.set_string('clock-format', '12h');
    await show('12h');
    iface.set_boolean('clock-show-seconds', true);
    await show('12h with seconds');
    jade.set_string('clock-format', '%H.%M');
    await show('own format %H.%M');
    jade.reset('clock-format');
    iface.reset('clock-show-seconds');
    iface.reset('clock-format');
    await show('back to the locale\'s default');
    await shoot('clock-12h-check', Main.panel.statusArea.dateMenu);
}

// ------------------------------------------------------------------ timing
//
// For each Jade menu and, as a baseline, GNOME's clock and quick settings:
//   open    a cold first open, then $JADE_ROUNDS warm re-opens, each the way
//           a click opens it (PopupAnimation.FULL, pointer on the button);
//   switch  with a menu open, the pointer moves onto the next button through
//           a virtual pointer, so GNOME's own PopupMenuManager sees the enter
//           event and runs _changeMenu → newMenu.open(FADE), exactly as a
//           hover does ($JADE_ROUNDS rounds of monitor→usage→picker→monitor,
//           and GNOME's clock ↔ quick settings), then the same as a 250 ms
//           sweep, without the GPU readout, and without animations;
//   calibrate  how evenly the headless shell paints with nothing else to do;
//   spawn   what starting a process costs the main thread, also at the live
//           Shell's size ($JADE_LIVE_MB, which run.sh reads from /proc).
//
// Times are from the trigger (the open() call, or the pointer motion):
//   lat     trigger → the new menu's open() starts (event delivery)
//   sync    open() on the main thread, with every open-state-changed handler
//           (the menu manager's grab, the old menu's close, the part's own)
//   first   trigger → the end of the first frame painted after open()
//   half    trigger → first painted frame with the menu at ≥ 50% opacity
//   done    trigger → first painted frame with the menu fully opaque
//   f300    frames painted in the 300 ms after the trigger
//   gap     longest interval between painted frames while the menu animates
//   drop    frames missed while it animates (interval / frame period − 1)
//   work    the longest frame update (events, layout, paint) in the window
//   block   the longest the main loop went without running a 2 ms probe in
//           the window (about the longest main-thread stall, + ≤ 2 ms)
//   faults  the Shell's minor page faults in the 300 ms after the trigger
//   spans   the parts' own methods (and GNOME's, as gnome.*) that ran in the
//           window, summed; "async" is how long a promise took to settle
// JADE_FRAMES=1 also logs every frame and main-loop stall of each window.

const ROUNDS = Number(GLib.getenv('JADE_ROUNDS') || 10);
const JADE_ROLES = ['jade-monitor', 'jade-usage', 'jade-picker'];
const BASE_ROLES = ['dateMenu', 'quickSettings'];
const PROBE_MS = 2;
const FRAME_TRACE = GLib.getenv('JADE_FRAMES') === '1';
// Methods of Jade's parts that run when a menu opens, or soon after.
const PART_METHODS = {
    Monitor: ['_refreshDisks', '_syncActive', '_syncGpu', '_startNvidia', '_stopNvidia', '_tick', '_buildCores', '_nextTagline'],
    Usage: ['_onOpened', '_renderMenu', '_runCollector'],
    Picker: ['_refresh', '_buildGrid'],
};

const now = () => GLib.get_monotonic_time();

// Minor page faults of the whole Shell so far (/proc/self/stat field 10). A
// fork() leaves every page copy-on-write, so the Shell faults afterwards.
function minorFaults() {
    try {
        const [, bytes] = GLib.file_get_contents('/proc/self/stat');
        const text = new TextDecoder().decode(bytes);
        return Number(text.slice(text.lastIndexOf(')') + 2).split(' ')[7]);
    } catch {
        return NaN;
    }
}

function residentMb() {
    try {
        const status = new TextDecoder().decode(GLib.file_get_contents('/proc/self/status')[1]);
        return Math.round(Number(status.match(/^VmRSS:\s+(\d+) kB/m)[1]) / 1024);
    } catch {
        return NaN;
    }
}

function memoryText() {
    try {
        const status = new TextDecoder().decode(GLib.file_get_contents('/proc/self/status')[1]);
        const field = key => status.match(new RegExp(`^${key}:\\s+(\\d+) kB`, 'm'))?.[1];
        const maps = new TextDecoder().decode(GLib.file_get_contents('/proc/self/maps')[1]).split('\n').length - 1;
        return `VmRSS ${Math.round(field('VmRSS') / 1024)} MB, VmPTE ${field('VmPTE')} kB, ${maps} mappings`;
    } catch (e) {
        return e.message;
    }
}

const ms = us => us === null || us === undefined || !Number.isFinite(us) ? '-' : (us / 1000).toFixed(1);

function median(values) {
    const v = values.filter(Number.isFinite).sort((a, b) => a - b);
    if (!v.length)
        return NaN;
    return v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2;
}

function max(values) {
    const v = values.filter(Number.isFinite);
    return v.length ? Math.max(...v) : NaN;
}

class Timing {
    constructor() {
        this.frames = [];
        this.blocks = [];
        this.spans = [];
        this.results = [];
        this.watch = [];
        this.lastOpen = null;
        this._cur = null;
        this._openWaiters = new Map();
    }

    // ------------------------------------------------------------ recording

    start() {
        const stage = global.stage;
        this._stageIds = [
            stage.connect('before-update', () => {
                this._cur = {bu: now(), bp: 0, ap: 0, au: 0, ops: null};
            }),
            stage.connect('before-paint', () => {
                if (this._cur)
                    this._cur.bp = now();
            }),
            stage.connect('after-paint', () => {
                if (!this._cur)
                    return;
                this._cur.ap = now();
                if (this.watch.length)
                    this._cur.ops = this.watch.map(a => a.opacity);
            }),
            stage.connect('after-update', () => {
                if (this._cur) {
                    this._cur.au = now();
                    this.frames.push(this._cur);
                }
                this._cur = null;
            }),
        ];
        // Not 'presented': GJS cannot convert its frame-info pointer, and
        // throws on every frame. Headless, a frame is presented as it is painted.

        // A main-loop probe: a gap between two runs is time the main thread
        // spent on something else (a handler, a frame, a garbage collection).
        this._last = now();
        this._probe = GLib.timeout_add(GLib.PRIORITY_DEFAULT, PROBE_MS, () => {
            const t = now();
            if (t - this._last > 3 * PROBE_MS * 1000)
                this.blocks.push({t: this._last, end: t});
            this._last = t;
            return GLib.SOURCE_CONTINUE;
        });

        const backend = global.stage.get_context?.().get_backend?.() ?? Clutter.get_default_backend();
        this.pointer = backend.get_default_seat().create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);
        const view = global.stage.peek_stage_views()[0];
        this.hz = view?.get_refresh_rate?.() ?? view?.refresh_rate ?? 60;
        this.period = 1e6 / this.hz;
    }

    stop() {
        this._stageIds.forEach(id => global.stage.disconnect(id));
        GLib.source_remove(this._probe);
        this.pointer = null;
    }

    span(label, t, dur) {
        this.spans.push({label, t, dur});
    }

    // Time a method on an object, and when it returns a promise, the promise too.
    instrument(object, name, label) {
        const original = object[name];
        if (typeof original !== 'function')
            return;
        const self = this;
        object[name] = function (...args) {
            const t0 = now();
            const result = original.apply(this, args);
            self.span(label, t0, now() - t0);
            if (result instanceof Promise)
                result.finally(() => self.span(`${label}(done)`, t0, now() - t0)).catch(() => {});
            return result;
        };
    }

    instrumentMenu(role, menu) {
        const self = this;
        const open = menu.open;
        menu.open = function (animate) {
            const wasOpen = this.isOpen;
            const inFrame = self._cur !== null;
            const t0 = now();
            open.call(this, animate);
            const t1 = now();
            if (wasOpen || !this.isOpen)
                return;
            const record = {role, t0, t1, animate, inFrame};
            self.lastOpen = record;
            self.span(`${role}.open`, t0, t1 - t0);
            self._openWaiters.get(this)?.(record);
        };
        const close = menu.close;
        menu.close = function (animate) {
            const t0 = now();
            close.call(this, animate);
            self.span(`${role}.close`, t0, now() - t0);
        };
    }

    instrumentParts() {
        const parts = Main.extensionManager.lookup(UUID)?.stateObj?._parts ?? [];
        for (const part of parts) {
            const name = part.instance?.constructor?.name;
            for (const method of PART_METHODS[name] ?? [])
                this.instrument(part.instance, method, `${name}.${method}`);
        }
        for (const role of [...JADE_ROLES, ...BASE_ROLES]) {
            const menu = Main.panel.statusArea[role]?.menu;
            if (!menu) {
                log(`TIMING no ${role} in the top bar`);
                continue;
            }
            this.instrumentMenu(role, menu);
            // GNOME's own share of open(): placing the box and starting its animation.
            if (menu._boxPointer) {
                this.instrument(menu._boxPointer, 'setPosition', 'gnome.BoxPointer.setPosition');
                this.instrument(menu._boxPointer, 'open', 'gnome.BoxPointer.open');
                this.instrument(menu._boxPointer, 'close', 'gnome.BoxPointer.close');
            }
        }
        // Main.pushModal/popModal: the grab and the key focus they move.
        this.instrument(global.stage, 'grab', 'gnome.stage.grab');
        this.instrument(global.stage, 'set_key_focus', 'gnome.stage.set_key_focus');
    }

    waitOpen(menu, timeoutMs) {
        return new Promise(resolve => {
            const timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, timeoutMs, () => {
                this._openWaiters.delete(menu);
                resolve(null);
                return GLib.SOURCE_REMOVE;
            });
            this._openWaiters.set(menu, record => {
                GLib.source_remove(timer);
                this._openWaiters.delete(menu);
                resolve(record);
            });
        });
    }

    moveTo(actor) {
        const [x, y] = actor.get_transformed_position();
        const [w, h] = actor.get_transformed_size();
        this.pointer.notify_absolute_motion(now(), x + w / 2, y + h / 2);
    }

    // ------------------------------------------------------------ analysis

    analyse({op, group, name, t0, record, windowMs, tailMs, faults = NaN}) {
        const end = t0 + windowMs * 1000;
        const tail = t0 + tailMs * 1000;
        const t1 = record?.t1 ?? t0;
        const painted = this.frames.filter(f => f.ap && f.ap >= t0 && f.ap <= tail);
        const first = painted.find(f => f.ap >= t1);
        const opacityFrame = level => painted.find(f => f.ap >= t1 && f.ops && f.ops[0] >= level);
        const half = opacityFrame(128);
        const done = opacityFrame(255);
        const inWindow = painted.filter(f => f.ap <= end);
        // Paint intervals while the new menu animates in: first frame → fully shown.
        const animating = painted.filter(f => first && f.ap >= first.ap && f.ap <= (done ?? first).ap);
        let gap = 0;
        let drop = 0;
        for (let i = 1; i < animating.length; i++) {
            const d = animating[i].ap - animating[i - 1].ap;
            gap = Math.max(gap, d);
            drop += Math.max(0, Math.round(d / this.period) - 1);
        }
        const updated = this.frames.filter(f => f.au >= t0 && f.bu <= end);
        const work = max(updated.map(f => f.au - f.bu));
        const blocks = this.blocks.filter(b => b.end >= t0 && b.t <= tail);
        const spans = new Map();
        for (const s of this.spans.filter(x => x.t >= t0 && x.t <= tail && !x.label.endsWith('(done)')))
            spans.set(s.label, (spans.get(s.label) ?? 0) + s.dur);
        const waits = this.spans.filter(x => x.t >= t0 && x.t <= tail && x.label.endsWith('(done)'));
        const result = {
            op, group, name,
            how: record ? 'hover' : 'none',
            lat: record ? record.t0 - t0 : NaN,
            sync: record ? record.t1 - record.t0 : NaN,
            inFrame: record?.inFrame ?? false,
            first: first ? first.ap - t0 : NaN,
            firstPaint: first ? first.ap - first.bp : NaN,
            firstLayout: first ? first.bp - first.bu : NaN,
            half: half ? half.ap - t0 : NaN,
            done: done ? done.ap - t0 : NaN,
            f300: inWindow.length,
            gap: animating.length > 1 ? gap : NaN,
            drop: animating.length > 1 ? drop : NaN,
            work,
            block: blocks.length ? max(blocks.map(b => b.end - b.t)) - PROBE_MS * 1000 : 0,
            faults,
            spans,
            waits,
        };
        this.results.push(result);
        const spanText = [...spans].sort((a, b) => b[1] - a[1]).map(([l, d]) => `${l}:${ms(d)}`).join(' ');
        const waitText = waits.map(w => `${w.label}:${ms(w.dur)}`).join(' ');
        log(`TIMING ${op} ${group} ${name} lat=${ms(result.lat)} sync=${ms(result.sync)}${result.inFrame ? '(in-frame)' : ''} ` +
            `first=${ms(result.first)} [layout ${ms(result.firstLayout)} paint ${ms(result.firstPaint)}] half=${ms(result.half)} ` +
            `done=${ms(result.done)} f300=${result.f300} gap=${ms(result.gap)} drop=${result.drop} work=${ms(result.work)} ` +
            `block=${ms(result.block)} faults=${faults} | ${spanText}${waitText ? ` | async ${waitText}` : ''}`);
        if (FRAME_TRACE) {
            // Each frame: when it started after the trigger, then its events and
            // layout / paint / rest of the update, and the menu's opacity.
            const trace = this.frames.filter(f => f.au >= t0 && f.bu <= tail).slice(0, 40).map(f =>
                `+${ms(f.bu - t0)}(${f.ap ? `${ms(f.bp - f.bu)}/${ms(f.ap - f.bp)}/${ms(f.au - f.ap)}` : `${ms(f.au - f.bu)} no paint`}` +
                `${f.ops ? ` o${f.ops[0]}` : ''})`).join(' ');
            const blockText = blocks.map(b => `+${ms(b.t - t0)}:${ms(b.end - b.t)}`).join(' ');
            const spanTimes = this.spans.filter(x => x.t >= t0 && x.t <= tail).map(x => `${x.label}@+${ms(x.t - t0)}:${ms(x.dur)}`).join(' ');
            log(`TIMING frames ${op} ${group} ${name}: ${trace}`);
            log(`TIMING blocks ${op} ${group} ${name}: ${blockText} | ${spanTimes}`);
        }
        return result;
    }

    // ------------------------------------------------------------ scenarios

    async open(role, group, count) {
        const button = Main.panel.statusArea[role];
        if (!button)
            return;
        for (let i = 0; i < count; i++) {
            this.moveTo(button);
            await wait(300);
            this.watch = [button.menu.actor];
            const f0 = minorFaults();
            const t0 = now();
            button.menu.open(BoxPointer.PopupAnimation.FULL);
            const record = this.lastOpen?.t0 >= t0 ? this.lastOpen : null;
            await wait(300);
            const faults = minorFaults() - f0;
            await wait(700);
            this.watch = [];
            this.analyse({op: 'open', group, name: role, t0, record, windowMs: 300, tailMs: 1000, faults});
            button.menu.close(BoxPointer.PopupAnimation.FULL);
            await wait(600);
        }
    }

    async switches(roles, group, spacingMs = 900) {
        const buttons = roles.map(r => Main.panel.statusArea[r]);
        if (buttons.some(b => !b))
            return;
        this.moveTo(buttons[0]);
        await wait(300);
        buttons[0].menu.open(BoxPointer.PopupAnimation.FULL);
        await wait(1200);
        for (let round = 0; round < ROUNDS; round++) {
            for (let i = 1; i <= buttons.length; i++) {
                const from = buttons[(i - 1) % buttons.length];
                const to = buttons[i % buttons.length];
                const name = `${roles[(i - 1) % roles.length]}→${roles[i % roles.length]}`;
                this.watch = [to.menu.actor, from.menu.actor];
                const opened = this.waitOpen(to.menu, Math.max(spacingMs, 500));
                const f0 = minorFaults();
                const t0 = now();
                this.moveTo(to);
                let record = await opened;
                if (!record) {
                    // The hover did not switch menus: say so, and switch the
                    // way the menu manager would, so the round still runs.
                    log(`TIMING ${group} ${name}: hover did not switch, calling _changeMenu`);
                    const t = now();
                    Main.panel.menuManager._changeMenu(to.menu);
                    record = this.lastOpen?.t0 >= t ? {...this.lastOpen, direct: true} : null;
                }
                const windowMs = Math.min(300, spacingMs);
                await wait(Math.max(0, windowMs - (now() - t0) / 1000));
                const faults = minorFaults() - f0;
                await wait(Math.max(0, spacingMs - (now() - t0) / 1000));
                this.watch = [];
                const result = this.analyse({op: 'switch', group, name, t0, record, windowMs, tailMs: spacingMs, faults});
                if (record?.direct)
                    result.how = 'direct';
            }
        }
        Main.panel.menuManager.activeMenu?.close(BoxPointer.PopupAnimation.NONE);
        await wait(800);
    }

    // ------------------------------------------------------------ summary

    summarise() {
        const groups = new Map();
        for (const r of this.results) {
            const key = r.op === 'switch' ? `${r.op} ${r.group} ${r.name.split('→')[1]}` : `${r.op} ${r.group} ${r.name}`;
            if (!groups.has(key))
                groups.set(key, []);
            groups.get(key).push(r);
        }
        const metrics = ['lat', 'sync', 'first', 'firstPaint', 'half', 'done', 'f300', 'gap', 'drop', 'work', 'block', 'faults'];
        const pad = (s, n) => String(s).padStart(n);
        log(`TIMING SUMMARY refresh ${this.hz.toFixed(1)} Hz (frame ${ms(this.period)} ms); ms unless a count; median/max over n`);
        log(`TIMING SUMMARY ${'group'.padEnd(46)} ${pad('n', 3)} ${metrics.map(m => pad(m, 11)).join(' ')}`);
        for (const [key, rows] of groups) {
            const cells = metrics.map(m => {
                const values = rows.map(r => r[m]);
                const count = m === 'f300' || m === 'drop' || m === 'faults';
                const f = v => !Number.isFinite(v) ? '-' : count ? String(v) : ms(v);
                return pad(`${f(median(values))}/${f(max(values))}`, 11);
            });
            log(`TIMING SUMMARY ${key.padEnd(46)} ${pad(rows.length, 3)} ${cells.join(' ')}`);
        }
        // Where the time goes: each method's median and max per occurrence group.
        for (const [key, rows] of groups) {
            const labels = new Map();
            for (const r of rows) {
                for (const [label, dur] of r.spans) {
                    if (!labels.has(label))
                        labels.set(label, []);
                    labels.get(label).push(dur);
                }
            }
            const text = [...labels].sort((a, b) => median(b[1]) - median(a[1])).slice(0, 8)
                .map(([label, durs]) => `${label} ${ms(median(durs))}/${ms(max(durs))}×${durs.length}`).join(', ');
            log(`TIMING SPANS ${key}: ${text}`);
        }
        const hover = this.results.filter(r => r.op === 'switch');
        log(`TIMING switches by hover ${hover.filter(r => r.how === 'hover').length}/${hover.length}, ` +
            `in a frame update ${hover.filter(r => r.inFrame).length}/${hover.length}`);
    }

    // How evenly the headless shell paints when nothing else runs: a small
    // square fades for 500 ms, so every frame has something to paint.
    async calibrate() {
        const square = new St.Widget({width: 8, height: 8, x: 0, y: 0, style: 'background-color: #808080;'});
        Main.layoutManager.uiGroup.add_child(square);
        await wait(300);
        for (let i = 0; i < 3; i++) {
            const t0 = now();
            square.ease({opacity: i % 2 ? 255 : 20, duration: 500, mode: Clutter.AnimationMode.LINEAR});
            await wait(700);
            const painted = this.frames.filter(f => f.ap >= t0 && f.ap <= t0 + 500000);
            const intervals = painted.slice(1).map((f, j) => f.ap - painted[j].ap);
            log(`TIMING calibrate: ${painted.length} frames in 500 ms (expected ${Math.round(this.hz / 2)}), ` +
                `interval median ${ms(median(intervals))} max ${ms(max(intervals))}, ` +
                `frame work median ${ms(median(painted.map(f => f.au - f.bu)))} ms`);
        }
        square.destroy();
    }

    // What starting a process costs the Shell's main thread. Gio.Subprocess
    // closes the child's inherited descriptors, which GLib can only do after a
    // fork() of the whole Shell; INHERIT_FDS lets it use posix_spawn instead.
    async spawnBench(variants = null, tag = '') {
        const F = Gio.SubprocessFlags;
        variants ??= [
            ['Gio.Subprocess NONE (fork)', F.NONE],
            ['Gio.Subprocess STDOUT_PIPE|STDERR_PIPE (fork, as util.run)', F.STDOUT_PIPE | F.STDERR_PIPE],
            ['Gio.Subprocess INHERIT_FDS (posix_spawn)', F.INHERIT_FDS],
            ['Gio.Subprocess INHERIT_FDS|STDOUT_PIPE (posix_spawn)', F.INHERIT_FDS | F.STDOUT_PIPE],
        ];
        for (const [name, flags] of variants) {
            const durations = [];
            const faults = [];
            for (let i = 0; i < ROUNDS; i++) {
                const f0 = minorFaults();
                const t0 = now();
                const proc = Gio.Subprocess.new(['/usr/bin/true'], flags);
                durations.push(now() - t0);
                await new Promise(resolve => proc.wait_async(null, () => resolve()));
                await wait(200);
                faults.push(minorFaults() - f0);
            }
            log(`TIMING spawn${tag} ${name}: main thread median ${ms(median(durations))} max ${ms(max(durations))} ms; ` +
                `minor faults in the next 200 ms median ${median(faults)} max ${max(faults)}`);
        }
        if (tag)
            return;
        const idle = [];
        for (let i = 0; i < 5; i++) {
            const f0 = minorFaults();
            await wait(200);
            idle.push(minorFaults() - f0);
        }
        log(`TIMING spawn baseline: minor faults per idle 200 ms median ${median(idle)} max ${max(idle)}`);
    }

    async run() {
        log(`TIMING start: ${ROUNDS} rounds, refresh ${this.hz.toFixed(1)} Hz, animations ${St.Settings.get().enable_animations}`);
        log(`TIMING test shell ${memoryText()}`);
        log(`TIMING jade on PATH: ${GLib.find_program_in_path('jade')}`);
        // Cold: the first open of each menu since the Shell started.
        for (const role of [...JADE_ROLES, ...BASE_ROLES])
            await this.open(role, 'cold', 1);
        for (const role of [...JADE_ROLES, ...BASE_ROLES])
            await this.open(role, 'warm', ROUNDS);
        await this.switches(JADE_ROLES, 'jade');
        await this.switches(BASE_ROLES, 'gnome');
        // A pointer sweeping across the icons: a switch every 250 ms, so one
        // menu's late work lands during the next one's animation.
        await this.switches(JADE_ROLES, 'jade-sweep', 250);

        // What the GPU readout costs: the same switches without nvidia-smi.
        const settings = Main.extensionManager.lookup(UUID)?.stateObj?._settings;
        if (settings) {
            settings.set_boolean('monitor-gpu', false);
            await wait(500);
            await this.switches(JADE_ROLES, 'jade-nogpu');
            settings.set_boolean('monitor-gpu', true);
            await wait(500);
        }
        // What GNOME's 150 ms fade costs: the same switches without animations
        // (the private keyfile settings of the test shell, not the live ones).
        const iface = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        iface.set_boolean('enable-animations', false);
        await wait(500);
        log(`TIMING animations now ${St.Settings.get().enable_animations}`);
        await this.switches(JADE_ROLES, 'jade-noanim');
        iface.set_boolean('enable-animations', true);
        await wait(500);
        await this.calibrate();
        await this.spawnBench();
        log(`TIMING test shell ${memoryText()}`);
        // A fork() costs by the size of the process. Grow this Shell to the
        // live one's resident size ($JADE_LIVE_MB, from run.sh) and fork again.
        const growMb = Math.max(0, Number(GLib.getenv('JADE_LIVE_MB') || 0) - residentMb());
        if (growMb > 0) {
            const ballast = new Uint8Array(growMb * 1024 * 1024);
            for (let i = 0; i < ballast.length; i += 4096)
                ballast[i] = 1;
            this._ballast = ballast;
            log(`TIMING grown by ${growMb} MB: ${memoryText()}`);
            await this.spawnBench([['Gio.Subprocess STDOUT_PIPE|STDERR_PIPE (fork, as util.run)',
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE],
            ['Gio.Subprocess INHERIT_FDS|STDOUT_PIPE (posix_spawn)',
                Gio.SubprocessFlags.INHERIT_FDS | Gio.SubprocessFlags.STDOUT_PIPE]], ` at +${growMb} MB`);
            this._ballast = null;
        }
        this.summarise();
    }
}

export default class Harness extends Extension {
    enable() {
        if (this._ran)
            return;
        this._ran = true;
        const run = MODE === 'timing' ? this._timing() : this._run();
        run.catch(e => log(`failed: ${e}\n${e.stack}`))
            .finally(() => GLib.file_set_contents(`${OUT}/done`, 'ok'));
    }

    async _timing() {
        await wait(6000);
        const jadeShell = Main.extensionManager.lookup(UUID);
        log(`jade-shell state ${jadeShell?.state} ${jadeShell?.error ?? ''}`);
        const timing = new Timing();
        timing.start();
        timing.instrumentParts();
        try {
            await timing.run();
        } finally {
            timing.stop();
        }
    }

    async _run() {
        await wait(6000);
        const jadeShell = Main.extensionManager.lookup(UUID);
        log(`jade-shell state ${jadeShell?.state} ${jadeShell?.error ?? ''}`);
        const source = MessageTray.getSystemSource();
        for (const [title, body] of [['Screenshot captured', 'You can paste the image from the clipboard.'],
            ['Jade Shell', 'Tokyo Night applied · 9 changes']])
            source.addNotification(new MessageTray.Notification({source, title, body}));
        await wait(1000);
        for (const theme of THEMES) {
            if (theme !== 'osaka-jade' || theme !== THEMES[0]) { // run.sh starts on Osaka Jade
                await jade('theme', 'set', theme, '--only', 'gnome,shell');
                await wait(2500);
            }
            await shoot(`${theme}-desktop`);
            await shoot(`${theme}-bar`, Main.panel);
            await states('dateMenu', `${theme}-clock`);
            await states('jade-monitor', `${theme}-monitor-button`);
            await panel('jade-picker', `${theme}-picker`);
            await panel('jade-monitor', `${theme}-monitor`, 3000);
            await panel('jade-usage', `${theme}-usage`);
            await panel('dateMenu', `${theme}-calendar`);
            await states('jade-bell', `${theme}-bell-button`);
            // The unread dot: GNOME's indicator decides, the bell shows it.
            const unread = Main.panel.statusArea.dateMenu._indicator;
            unread.visible = true;
            await wait(300);
            await shoot(`${theme}-bell-unread`, Main.panel.statusArea['jade-bell']);
            unread._sync();
            await panel('jade-bell', `${theme}-bell`);
            await panel('quickSettings', `${theme}-quick-settings`);
        }
        await bellRoundTrip();
        await clockFollowsGnome();
    }

    disable() {}
}
