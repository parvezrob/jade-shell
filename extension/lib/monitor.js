// The system monitor: one icon in the top bar that opens a panel with CPU
// (overall and per core), memory, GPU and disks, in the spirit of Omarchy's
// hardware panel. It measures only while the panel is open, so the icon costs
// nothing; the optional readout in the bar measures every two seconds.
//
// Readings are cheap on purpose: /proc and sysfs files (the approach of
// TopHat and GNOME's own System Monitor extension), and for NVIDIA one
// long-running nvidia-smi that prints a line per interval (the approach of
// Vitals) instead of a new process on every tick.
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {SPAWN, VERTICAL, addToPanel, cairoRgb, label} from './util.js';

const INTERVAL_S = 2;
// After the panel closes, nvidia-smi keeps running this long (see _syncGpu).
const NVIDIA_LINGER_S = 5;
const TAGLINE_S = 4;
const ALARM = {cpu: 90, mem: 90, gpu: 95, temp: 85};
const CPU_SENSORS = ['k10temp', 'coretemp', 'zenpower', 'cpu_thermal', 'acpitz'];
const MONITOR_APPS = ['org.gnome.SystemMonitor.desktop', 'gnome-system-monitor.desktop', 'net.nokyan.Resources.desktop'];
const GIB = 1024 * 1024 * 1024;

// A line under "CPU" that changes with the load, a few seconds each.
const TAGLINES = {
    idle: ['Plenty of headroom', 'Fans at rest', 'Barely awake', 'A quiet desk', 'Cooling off'],
    steady: ['Keeping pace', 'Ticking along', 'Warm, not hot', 'In the flow', 'Steady hands'],
    busy: ['Working hard', 'Every core awake', 'Heads down', 'Full throttle', 'Running warm'],
    gpu: ['Frames in flight', 'The GPU is busy', 'Rendering away', 'Pixels on the move'],
};

// ------------------------------------------------------------------ readers

function readText(path) {
    try {
        const [ok, bytes] = GLib.file_get_contents(path);
        return ok ? new TextDecoder().decode(bytes) : null;
    } catch {
        return null;
    }
}

// A missing or empty read is NaN, not Number(null) === 0, so the value hides
// instead of showing a made-up 0.
function readNumber(path) {
    const text = path ? readText(path)?.trim() : '';
    return text ? Number(text) : NaN;
}

function listDir(path) {
    const names = [];
    try {
        const dir = GLib.Dir.open(path, 0);
        for (let name = dir.read_name(); name; name = dir.read_name())
            names.push(name);
        dir.close();
    } catch {}
    return names.sort();
}

function symlinkTarget(path) {
    try {
        const info = Gio.File.new_for_path(path).query_info('standard::is-symlink,standard::symlink-target',
            Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
        // Asking a non-link for its target is a GLib critical, logged each time.
        return info.get_is_symlink() ? info.get_symlink_target() : null;
    } catch {
        return null;
    }
}

// "AMD Ryzen 5 5600 6-Core Processor" → "AMD Ryzen 5 5600".
function cpuModel() {
    const name = readText('/proc/cpuinfo')?.match(/^model name\s*:\s*(.+)$/m)?.[1] ?? '';
    return name.replace(/\((R|TM)\)/gi, '').replace(/\s+CPU\s+@.*$/, '').replace(/\s+\d+-Core Processor$/, '')
        .replace(/\s+Processor$/, '').replace(/\s+/g, ' ').trim();
}

// Idle and total jiffies for the whole CPU and each core, from one read.
function cpuTimes() {
    const times = [];
    for (const line of readText('/proc/stat')?.split('\n') ?? []) {
        if (!line.startsWith('cpu'))
            break;
        const fields = line.trim().split(/\s+/).slice(1, 9).map(Number);
        times.push({idle: fields[3] + (fields[4] ?? 0), total: fields.reduce((a, v) => a + v, 0)});
    }
    return times;
}

function percent(now, before) {
    if (!now || !before || now.total <= before.total)
        return null;
    return Math.round(100 * (1 - (now.idle - before.idle) / (now.total - before.total)));
}

function memory() {
    const text = readText('/proc/meminfo') ?? '';
    const bytes = key => Number(text.match(new RegExp(`^${key}:\\s+(\\d+)`, 'm'))?.[1]) * 1024;
    const total = bytes('MemTotal');
    const swapTotal = bytes('SwapTotal');
    return {total, used: total - bytes('MemAvailable'), swapTotal, swapUsed: swapTotal - bytes('SwapFree')};
}

// The first temperature input of the first CPU sensor found (Tctl on AMD,
// the package sensor on Intel).
function findCpuTemperature() {
    const found = listDir('/sys/class/hwmon').map(dir => ({
        path: `/sys/class/hwmon/${dir}`, name: readText(`/sys/class/hwmon/${dir}/name`)?.trim(),
    }));
    for (const sensor of CPU_SENSORS) {
        const hwmon = found.find(h => h.name === sensor);
        if (hwmon && GLib.file_test(`${hwmon.path}/temp1_input`, GLib.FileTest.EXISTS))
            return `${hwmon.path}/temp1_input`;
    }
    return null;
}

function drmCards() {
    return listDir('/sys/class/drm').filter(n => /^card\d+$/.test(n)).map(n => `/sys/class/drm/${n}`);
}

function driverOf(card) {
    return symlinkTarget(`${card}/device/driver`)?.split('/').pop() ?? null;
}

// A card whose driver reports how busy it is (amdgpu; newer xe too). With an
// iGPU and a discrete card both on amdgpu, the discrete one: an APU reports
// only its small carve-out as VRAM.
function findBusyGpu() {
    const vram = dir => Number(readText(`${dir}/mem_info_vram_total`)) || 0;
    const cards = drmCards().map(card => `${card}/device`)
        .filter(dir => GLib.file_test(`${dir}/gpu_busy_percent`, GLib.FileTest.EXISTS))
        .sort((a, b) => vram(b) - vram(a));
    if (!cards.length)
        return null;
    const driver = driverOf(cards[0].replace(/\/device$/, ''));
    return {path: cards[0], name: driver === 'amdgpu' ? 'AMD GPU' : driver === 'xe' ? 'Intel GPU' : 'GPU'};
}

// Intel's i915 and xe drivers have no busy counter a user may read, but they
// count the milliseconds the render engine sleeps in RC6: the rest of each
// tick is its load (as intel_gpu_top's "100 - RC6" and Omarchy status tools
// read it). {path: null} for an Intel GPU without the counter (RC6 off).
function findIntelGpu() {
    for (const card of drmCards()) {
        const driver = driverOf(card);
        const counters = driver === 'i915' ? [`${card}/gt/gt0/rc6_residency_ms`, `${card}/power/rc6_residency_ms`]
            : driver === 'xe' ? [`${card}/device/tile0/gt0/gtidle/idle_residency_ms`] : null;
        if (counters)
            return {path: counters.find(path => GLib.file_test(path, GLib.FileTest.EXISTS)) ?? null};
    }
    return null;
}

// Load from two idle counter readings ({idle ms, at ms}); null for the first,
// or after a pause long enough to average away what is happening now.
function idleToBusy(before, now) {
    const elapsed = now.at - (before?.at ?? 0);
    if (!before || elapsed <= 0 || elapsed > 10000 || !Number.isFinite(now.idle) || now.idle < before.idle)
        return null;
    return Math.max(0, Math.min(100, Math.round(100 - 100 * (now.idle - before.idle) / elapsed)));
}

function hasNvidia() {
    return GLib.file_test('/proc/driver/nvidia', GLib.FileTest.EXISTS) && GLib.find_program_in_path('nvidia-smi') !== null;
}

// /dev/nvme0n1p3 → the model of nvme0n1; /dev/mapper/luks-… → the disk under it.
function diskModel(device) {
    let name = (symlinkTarget(device) ?? device).split('/').pop();
    const slaves = listDir(`/sys/class/block/${name}/slaves`);
    if (slaves.length)
        name = slaves[0];
    if (GLib.file_test(`/sys/class/block/${name}/partition`, GLib.FileTest.EXISTS))
        name = name.replace(/^((?:nvme\d+n\d+)|(?:mmcblk\d+))p\d+$/, '$1').replace(/^([a-z]+)\d+$/, '$1');
    return readText(`/sys/class/block/${name}/device/model`)?.trim() || null;
}

// Local disks, one row per device (its first mount wins, so "/" rather than
// the /home subvolume on the same btrfs). The small boot partitions are left
// out: they only repeat the system disk's name.
function disks() {
    const seen = new Set();
    const out = [];
    for (const line of readText('/proc/self/mounts')?.split('\n') ?? []) {
        const [device, mount, type] = line.split(' ');
        if (!device?.startsWith('/dev/') || device.startsWith('/dev/loop') || ['squashfs', 'iso9660'].includes(type) ||
            /^\/(boot|efi)(\/|$)/.test(mount))
            continue;
        const key = symlinkTarget(device) ?? device;
        if (seen.has(key))
            continue;
        seen.add(key);
        out.push({device, mount: mount.replace(/\\040/g, ' '), model: diskModel(device)});
    }
    return out;
}

function gib(bytes) {
    return (bytes / GIB).toFixed(1);
}

// ------------------------------------------------------------------ pieces

// A thin pill: the track in faint foreground, the fill in the accent.
// Painted, never sized from its value, so a new reading never relayouts.
class Meter {
    constructor(height, colors) {
        this._value = 0;
        this._colors = colors;
        this.actor = new St.DrawingArea({style_class: 'jade-meter', height, x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        this.actor.connect('repaint', area => this._paint(area));
    }

    set value(v) {
        const clamped = Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0));
        if (clamped === this._value)
            return;
        this._value = clamped;
        this.actor.queue_repaint();
    }

    _paint(area) {
        const cr = area.get_context();
        const [w, h] = area.get_surface_size();
        const pill = (width, [r, g, b, a]) => {
            const radius = h / 2;
            cr.setSourceRGBA(r, g, b, a);
            cr.newSubPath();
            cr.arc(width - radius, radius, radius, -Math.PI / 2, Math.PI / 2);
            cr.arc(radius, radius, radius, Math.PI / 2, 1.5 * Math.PI);
            cr.closePath();
            cr.fill();
        };
        pill(w, this._colors.track);
        if (this._value > 0)
            pill(Math.max(h, w * this._value), this._colors.fill);
        cr.$dispose();
    }
}

// Whether the machine runs on battery, from UPower's change signal rather
// than reading the charger through sysfs (ACPI calls) on every tick.
class Battery {
    constructor(changed) {
        this.onBattery = false;
        this._cancellable = new Gio.Cancellable();
        Gio.DBusProxy.new_for_bus(Gio.BusType.SYSTEM, Gio.DBusProxyFlags.DO_NOT_AUTO_START, null,
            'org.freedesktop.UPower', '/org/freedesktop/UPower', 'org.freedesktop.UPower', this._cancellable,
            (_s, result) => {
                try {
                    this._proxy = Gio.DBusProxy.new_for_bus_finish(result);
                } catch {
                    return; // no UPower (or disabled meanwhile): mains power
                }
                const sync = () => {
                    const onBattery = this._proxy.get_cached_property('OnBattery')?.unpack() ?? false;
                    if (onBattery !== this.onBattery) {
                        this.onBattery = onBattery;
                        changed();
                    }
                };
                this._signal = this._proxy.connect('g-properties-changed', sync);
                sync();
            });
    }

    destroy() {
        this._cancellable.cancel();
        if (this._signal)
            this._proxy.disconnect(this._signal);
        this._proxy = this._signal = null;
    }
}

// ------------------------------------------------------------------ the part

export class Monitor {
    constructor(extension, settings, theme) {
        this._extension = extension;
        this._settings = settings;
        this._theme = theme;
    }

    enable() {
        this._colors = {track: [1, 1, 1, 0.12], fill: [1, 1, 1, 0.9]};
        this._meters = [];
        this._cores = [];
        this._previous = null;
        this._nvidiaFailures = 0;
        this._gpu = {name: null, percent: null, temp: NaN};
        this._temperature = findCpuTemperature();
        this._busyGpu = findBusyGpu();
        this._intelGpu = this._busyGpu ? null : findIntelGpu();
        this._intelIdle = null;
        this._model = cpuModel();
        this._bands = {idle: true, busy: false, gpu: false};
        this._deck = [];

        this._button = new PanelMenu.Button(0.5, 'System monitor');
        this._button.add_style_class_name('jade-monitor');
        const bar = new St.BoxLayout({style_class: 'jade-monitor-box'});
        this._icon = new St.Icon({gicon: this._gicon('cpu-symbolic.svg'), style_class: 'system-status-icon'});
        bar.add_child(this._icon);
        this._barValues = new St.BoxLayout({style_class: 'jade-monitor-box'});
        this._barItems = {};
        for (const [key, name] of [['cpu', 'CPU'], ['mem', 'MEM'], ['gpu', 'GPU'], ['temp', '']]) {
            const item = new St.BoxLayout({style_class: 'jade-monitor-item', visible: false});
            if (name)
                item.add_child(label(name, 'jade-monitor-name'));
            const value = label('', 'jade-monitor-value');
            item.add_child(value);
            this._barValues.add_child(item);
            this._barItems[key] = {item, value};
        }
        bar.add_child(this._barValues);
        this._button.add_child(bar);
        // Right-click opens the full system monitor app.
        this._button.connect('button-press-event', (_a, event) => {
            if (event.get_button() !== Clutter.BUTTON_SECONDARY)
                return Clutter.EVENT_PROPAGATE;
            this._openMonitorApp();
            return Clutter.EVENT_STOP;
        });
        this._buildPanel();
        addToPanel('jade-monitor', this._button);

        this._button.menu.connect('open-state-changed', (_m, open) => {
            if (this._stopping)  // destroying an open menu closes it: no restart then
                return;
            if (open)
                this._refreshDisks();
            this._syncActive();
        });
        this._settingsChanged = ['monitor-gpu', 'monitor-show-values'].map(
            key => this._settings.connect(`changed::${key}`, () => this._syncActive()));
        this._battery = new Battery(() => this._syncActive());
        this._unfollow = this._theme.follow(palette => {
            this._colors.track = [...cairoRgb(palette.foreground), 0.12];
            this._colors.fill = [...cairoRgb(palette.accent), 0.9];
            this._meters.forEach(m => m.actor.queue_repaint());
        });
        this._syncActive();
    }

    // Also undoes an enable() that failed partway.
    disable() {
        this._stopping = true;
        this._stopTimers();
        this._cancelNvidiaRetry();
        this._stopNvidia();
        this._battery?.destroy();
        this._battery = null;
        this._unfollow?.();
        this._unfollow = null;
        this._settingsChanged?.forEach(id => this._settings.disconnect(id));
        this._settingsChanged = null;
        this._button?.destroy();
        this._button = this._meters = this._cores = this._barItems = this._diskViews = null;
        this._stopping = false;
    }

    // Our own icons are files in the extension; the rest come from the icon theme.
    _gicon(name) {
        return name.endsWith('.svg')
            ? new Gio.FileIcon({file: this._extension.dir.get_child('icons').get_child(name)})
            : new Gio.ThemedIcon({name});
    }

    // ---------------------------------------------------------------- panel

    _meter(height) {
        const meter = new Meter(height, this._colors);
        this._meters.push(meter);
        return meter;
    }

    _item(actor) {
        const item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false, style_class: 'jade-item'});
        item.add_child(actor);
        this._button.menu.addMenuItem(item);
        return actor;
    }

    _section(icon, title) {
        const box = this._item(new St.BoxLayout({orientation: VERTICAL, x_expand: true, style_class: 'jm-section jm-divided'}));
        const header = new St.BoxLayout({x_expand: true, style_class: 'jm-section-header'});
        header.add_child(new St.Icon({gicon: this._gicon(icon), style_class: 'jm-section-icon', y_align: Clutter.ActorAlign.CENTER}));
        header.add_child(label(title, 'jm-section-title', {x_expand: true}));
        const value = label('', 'jm-section-value');
        header.add_child(value);
        box.add_child(header);
        return {box, value};
    }

    _buildPanel() {
        const menu = this._button.menu;
        menu.box.add_style_class_name('jade-frame');
        menu.box.add_style_class_name('jade-monitor-panel');

        // CPU: what it is, how it feels, how busy it is.
        const hero = this._item(new St.BoxLayout({x_expand: true, style_class: 'jm-hero'}));
        hero.add_child(new St.Icon({gicon: this._gicon('cpu-symbolic.svg'), style_class: 'jm-hero-icon', y_align: Clutter.ActorAlign.START}));
        const text = new St.BoxLayout({orientation: VERTICAL, x_expand: true});
        text.add_child(label('CPU', 'jm-title'));
        this._cpuMeta = label(this._model, 'jm-meta');
        text.add_child(this._cpuMeta);
        this._tagline = label('', 'jm-tagline');
        text.add_child(this._tagline);
        hero.add_child(text);
        this._cpuValue = label('', 'jm-title jm-hero-value', {y_align: Clutter.ActorAlign.START});
        hero.add_child(this._cpuValue);
        this._coresBox = this._item(new St.BoxLayout({orientation: VERTICAL, x_expand: true, style_class: 'jm-cores'}));

        const mem = this._section('memory-symbolic.svg', 'Memory');
        this._memValue = mem.value;
        this._memMeter = this._meter(6);
        mem.box.add_child(this._memMeter.actor);
        this._memCaption = label('', 'jm-caption');
        mem.box.add_child(this._memCaption);

        const gpu = this._section('gpu-symbolic.svg', 'GPU');
        this._gpuSection = gpu.box;
        this._gpuValue = gpu.value;
        this._gpuMeter = this._meter(6);
        gpu.box.add_child(this._gpuMeter.actor);
        this._gpuCaption = label('', 'jm-caption');
        gpu.box.add_child(this._gpuCaption);
        this._gpuSection.get_parent().visible = false;

        const disk = this._section('drive-harddisk-symbolic', 'Storage');
        this._diskSection = disk.box;
        this._diskRows = new St.BoxLayout({orientation: VERTICAL, x_expand: true, style_class: 'jm-disks'});
        disk.box.add_child(this._diskRows);
        this._diskKey = null;

        const footer = this._item(new St.BoxLayout({x_expand: true, style_class: 'jm-footer jm-divided'}));
        const open = new St.Button({can_focus: true, track_hover: true, x_expand: true, style_class: 'jade-action', accessible_name: 'Open System Monitor'});
        const openBox = new St.BoxLayout({style_class: 'jade-action-content', x_align: Clutter.ActorAlign.CENTER});
        openBox.add_child(new St.Icon({gicon: this._gicon('cpu-symbolic.svg'), icon_size: 14}));
        openBox.add_child(label('System Monitor', 'jade-action-label'));
        open.set_child(openBox);
        open.connect('clicked', () => {
            menu.close();
            this._openMonitorApp();
        });
        footer.add_child(open);
    }

    // Two columns of cores up to 16, four beyond.
    _buildCores(count) {
        this._coresBox.destroy_all_children();
        const old = new Set(this._cores.map(c => c.meter));
        this._meters = this._meters.filter(m => !old.has(m));
        this._cores = [];
        const columns = count <= 1 ? 1 : count <= 16 ? 2 : 4;
        let row = null;
        for (let i = 0; i < count; i++) {
            if (i % columns === 0) {
                row = new St.BoxLayout({x_expand: true, style_class: 'jm-core-row'});
                this._coresBox.add_child(row);
            }
            const cell = new St.BoxLayout({x_expand: true, style_class: 'jm-core'});
            cell.add_child(label(`C${i}`, 'jm-core-name'));
            const meter = this._meter(4);
            cell.add_child(meter.actor);
            const value = label('', 'jm-core-value');
            cell.add_child(value);
            row.add_child(cell);
            this._cores.push({meter, value});
        }
    }

    // ---------------------------------------------------------------- measuring

    _open() {
        return this._button.menu.isOpen;
    }

    _showValues() {
        return this._settings.get_boolean('monitor-show-values');
    }

    // Measure while the panel is open or the bar shows numbers; otherwise
    // nothing runs at all.
    _syncActive() {
        const active = this._open() || this._showValues();
        this._barValues.visible = this._showValues();
        this._icon.visible = !this._showValues();
        if (active && !this._timer) {
            this._previous = cpuTimes();
            // A first reading a moment later, so the panel is not empty for two seconds.
            this._soon = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
                this._soon = null;
                this._tick();
                return GLib.SOURCE_REMOVE;
            });
            this._timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, INTERVAL_S, () => {
                this._tick();
                return GLib.SOURCE_CONTINUE;
            });
        } else if (!active) {
            this._stopTimers();
        }
        if (this._open() && !this._taglineTimer) {
            this._nextTagline(false);
            this._taglineTimer = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, TAGLINE_S, () => {
                this._nextTagline(true);
                return GLib.SOURCE_CONTINUE;
            });
        } else if (!this._open() && this._taglineTimer) {
            GLib.source_remove(this._taglineTimer);
            this._taglineTimer = null;
        }
        this._syncGpu(active);
    }

    _stopTimers() {
        for (const id of ['_timer', '_soon', '_taglineTimer']) {
            if (this[id])
                GLib.source_remove(this[id]);
            this[id] = null;
        }
    }

    _tick() {
        const times = cpuTimes();
        const cpu = percent(times[0], this._previous?.[0]);
        const cores = times.slice(1).map((t, i) => percent(t, this._previous?.[i + 1]));
        this._previous = times;
        const mem = memory();
        const memPercent = mem.total ? Math.round(100 * mem.used / mem.total) : null;
        const temp = readNumber(this._temperature) / 1000;
        // nvidia-smi owns the GPU reading while it runs (or is due a restart),
        // so a Ryzen iGPU next to an NVIDIA card does not alternate with it.
        if (!this._nvidia && !this._nvidiaRetry && this._gpuWanted()) {
            if (this._busyGpu) {
                const busy = readNumber(`${this._busyGpu.path}/gpu_busy_percent`);
                this._gpu = {name: this._busyGpu.name, percent: Number.isFinite(busy) ? busy : null, temp: NaN};
            } else if (this._intelGpu?.path) {
                const now = {idle: readNumber(this._intelGpu.path), at: GLib.get_monotonic_time() / 1000};
                const busy = idleToBusy(this._intelIdle, now);
                this._intelIdle = now;
                // Between the first two readings, the last value stays.
                if (busy !== null)
                    this._gpu = {name: 'Intel GPU', percent: busy, temp: NaN};
            } else if (this._intelGpu) {
                this._gpu = {name: 'Intel GPU', percent: null, temp: NaN, unavailable: true};
            }
        }
        this._updateBands(cpu ?? 0, this._gpu.percent ?? 0);

        if (this._showValues()) {
            this._bar('cpu', cpu === null ? null : `${cpu}%`, cpu >= ALARM.cpu);
            this._bar('mem', memPercent === null ? null : `${memPercent}%`, memPercent >= ALARM.mem);
            this._bar('temp', Number.isFinite(temp) ? `${Math.round(temp)}°` : null, temp >= ALARM.temp);
            this._bar('gpu', this._gpu.percent === null ? null : `${this._gpu.percent}%`, this._gpu.percent >= ALARM.gpu);
        }
        if (!this._open())
            return;

        this._cpuValue.text = cpu === null ? '' : `${cpu}%`;
        this._cpuMeta.text = [this._model, Number.isFinite(temp) ? `${Math.round(temp)}°C` : null].filter(Boolean).join(' · ');
        if (cores.length !== this._cores.length)
            this._buildCores(cores.length);
        cores.forEach((value, i) => {
            this._cores[i].meter.value = (value ?? 0) / 100;
            this._cores[i].value.text = value === null ? '' : `${value}%`;
        });
        this._memValue.text = memPercent === null ? '' : `${memPercent}%`;
        this._memMeter.value = mem.total ? mem.used / mem.total : 0;
        this._memCaption.text = `${gib(mem.used)} / ${gib(mem.total)} GiB` +
            (mem.swapTotal ? ` · swap ${gib(mem.swapUsed)} / ${gib(mem.swapTotal)} GiB` : '');
        this._showGpu();
    }

    _bar(key, text, alarm) {
        const {item, value} = this._barItems[key];
        item.visible = text !== null;
        if (text === null)
            return;
        value.text = text;
        value[alarm ? 'add_style_class_name' : 'remove_style_class_name']('jade-alarm');
    }

    _showGpu() {
        const {name, percent: busy, temp, unavailable} = this._gpu;
        this._gpuSection.get_parent().visible = busy !== null || Boolean(unavailable);
        if (unavailable) {
            this._gpuValue.text = '—';
            this._gpuMeter.value = 0;
            this._gpuCaption.text = 'GPU usage isn’t available for this GPU';
            return;
        }
        if (busy === null)
            return;
        this._gpuValue.text = `${busy}%`;
        this._gpuMeter.value = busy / 100;
        this._gpuCaption.text = [name, Number.isFinite(temp) ? `${temp}°C` : null].filter(Boolean).join(' · ');
    }

    _refreshDisks() {
        const list = disks();
        const key = list.map(d => d.device).join('|');
        if (key !== this._diskKey) {
            this._diskKey = key;
            this._diskRows.destroy_all_children();
            const old = new Set((this._diskViews ?? []).map(v => v.meter));
            this._meters = this._meters.filter(m => !old.has(m));
            this._diskViews = list.map(disk => {
                const box = new St.BoxLayout({orientation: VERTICAL, x_expand: true, style_class: 'jm-disk'});
                const top = new St.BoxLayout({x_expand: true});
                // A disk without a model name (a virtual one) is named by its place.
                const name = disk.model ?? (disk.mount === '/' ? 'System' : GLib.path_get_basename(disk.mount));
                top.add_child(label(name, 'jm-disk-name', {x_expand: true}));
                const value = label('', 'jm-section-value');
                top.add_child(value);
                box.add_child(top);
                const meter = this._meter(6);
                box.add_child(meter.actor);
                const caption = label(disk.mount, 'jm-caption');
                box.add_child(caption);
                this._diskRows.add_child(box);
                return {disk, value, meter, caption};
            });
        }
        this._diskSection.get_parent().visible = list.length > 0;
        for (const view of this._diskViews) {
            Gio.File.new_for_path(view.disk.mount).query_filesystem_info_async(
                'filesystem::size,filesystem::used', GLib.PRIORITY_LOW, null, (file, result) => {
                    let info;
                    try {
                        info = file.query_filesystem_info_finish(result);
                    } catch {
                        return;
                    }
                    const size = info.get_attribute_uint64('filesystem::size');
                    const used = info.get_attribute_uint64('filesystem::used');
                    if (!this._button || !size)
                        return;
                    view.value.text = `${Math.round(100 * used / size)}%`;
                    view.meter.value = used / size;
                    view.caption.text = `${view.disk.mount} · ${gib(used)} / ${gib(size)} GiB`;
                });
        }
    }

    // ---------------------------------------------------------------- taglines

    // Bands with separate ways in and out, so a load sitting on a threshold
    // does not flip the taglines back and forth every sample.
    _updateBands(cpu, gpu) {
        const b = this._bands;
        const before = `${b.idle}${b.busy}${b.gpu}`;
        if (b.idle && (cpu > 25 || gpu > 25))
            b.idle = false;
        else if (!b.idle && cpu <= 15 && gpu <= 15)
            b.idle = true;
        b.busy = b.busy ? cpu >= 40 : cpu >= 50;
        b.gpu = b.gpu ? gpu >= 40 : gpu >= 50;
        if (`${b.idle}${b.busy}${b.gpu}` !== before)
            this._deck = []; // draw from the new mix at the next change
    }

    // A shuffled deck, so nothing repeats until every line has had its turn.
    _nextTagline(fade) {
        if (!this._deck.length) {
            const b = this._bands;
            const pool = [...TAGLINES[b.idle ? 'idle' : 'steady'], ...(b.busy ? TAGLINES.busy : []), ...(b.gpu ? TAGLINES.gpu : [])];
            for (let i = pool.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [pool[i], pool[j]] = [pool[j], pool[i]];
            }
            if (pool.length > 1 && pool[0].toUpperCase() === this._tagline.text)
                pool.push(pool.shift());
            this._deck = pool;
        }
        const next = this._deck.shift().toUpperCase();
        if (!fade) {
            this._tagline.text = next;
            return;
        }
        this._tagline.ease({
            opacity: 0, duration: 180, mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => {
                this._tagline.text = next;
                this._tagline.ease({opacity: 255, duration: 260, mode: Clutter.AnimationMode.EASE_IN_QUAD});
            },
        });
    }

    // ---------------------------------------------------------------- GPU

    // A discrete GPU stays awake while it is being polled, so polling pauses
    // while the machine runs on battery.
    _gpuWanted() {
        return this._settings.get_boolean('monitor-gpu') && !this._battery?.onBattery;
    }

    _syncGpu(active) {
        const wanted = active && this._gpuWanted();
        if (wanted && hasNvidia()) {
            this._cancelNvidiaLinger();
            if (!this._nvidiaRetry)
                this._startNvidia();
            return;
        }
        this._cancelNvidiaRetry();
        // Only closed: nvidia-smi exiting (NVML letting go of the driver)
        // costs a frame, which would land in the close animation or the next
        // menu's opening. Let it run a few seconds more and stop it while no
        // top-bar menu is open; reopening meanwhile keeps it.
        if (this._nvidia && this._gpuWanted()) {
            this._nvidiaLinger ??= GLib.timeout_add_seconds(GLib.PRIORITY_LOW, NVIDIA_LINGER_S, () => {
                if (Main.panel.menuManager.activeMenu)
                    return GLib.SOURCE_CONTINUE;  // another menu is open: later
                this._nvidiaLinger = null;
                this._stopNvidia();
                return GLib.SOURCE_REMOVE;
            });
        } else {
            this._stopNvidia();
        }
        // Closing the panel keeps the last reading, so the GPU section is
        // there at once on the next open instead of appearing a moment later
        // and resizing the menu. Only turning GPU usage off hides it.
        if (!this._gpuWanted())
            this._gpu = {name: this._gpu.name, percent: null, temp: NaN};
    }

    _startNvidia() {
        if (this._nvidia)
            return;
        try {
            this._nvidia = Gio.Subprocess.new(
                ['nvidia-smi', '--id=0', '--query-gpu=name,utilization.gpu,temperature.gpu',
                    '--format=csv,noheader,nounits', `--loop-ms=${INTERVAL_S * 1000}`],
                SPAWN | Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
        } catch (e) {
            console.error(`Jade Shell: cannot start nvidia-smi: ${e.message}`);
            return;
        }
        this._nvidiaCancellable = new Gio.Cancellable();
        this._readNvidia(new Gio.DataInputStream({base_stream: this._nvidia.get_stdout_pipe()}), this._nvidiaCancellable);
    }

    _readNvidia(stream, cancellable) {
        stream.read_line_async(GLib.PRIORITY_LOW, cancellable, (s, result) => {
            let line = null;
            try {
                [line] = s.read_line_finish_utf8(result);
            } catch {}
            // A callback from a process already stopped must not touch a newer one.
            if (cancellable.is_cancelled() || cancellable !== this._nvidiaCancellable)
                return;
            if (line === null) {
                // nvidia-smi exited (a driver updated but not yet rebooted, say):
                // hide the stale value and try again later, backing off up to
                // five minutes.
                this._stopNvidia();
                this._gpu = {name: this._gpu.name, percent: null, temp: NaN};
                const delay = Math.min(10 * 2 ** this._nvidiaFailures++, 300);
                this._nvidiaRetry = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, delay, () => {
                    this._nvidiaRetry = null;
                    this._syncGpu(this._open() || this._showValues());
                    return GLib.SOURCE_REMOVE;
                });
                return;
            }
            const [name, busy, temp] = line.split(',').map(field => field.trim());
            const value = busy ? Number(busy) : NaN;
            if (Number.isFinite(value)) {
                // Only a real reading proves nvidia-smi works; its error text does not.
                this._nvidiaFailures = 0;
                this._gpu = {name, percent: value, temp: temp ? Number(temp) : NaN};
                if (this._open())
                    this._showGpu();
                if (this._showValues())
                    this._bar('gpu', `${value}%`, value >= ALARM.gpu);
            }
            this._readNvidia(stream, cancellable);
        });
    }

    _cancelNvidiaLinger() {
        if (this._nvidiaLinger)
            GLib.source_remove(this._nvidiaLinger);
        this._nvidiaLinger = null;
    }

    _cancelNvidiaRetry() {
        if (this._nvidiaRetry)
            GLib.source_remove(this._nvidiaRetry);
        this._nvidiaRetry = null;
    }

    _stopNvidia() {
        this._cancelNvidiaLinger();
        this._nvidiaCancellable?.cancel();
        this._nvidia?.force_exit();
        this._nvidia = this._nvidiaCancellable = null;
    }

    _openMonitorApp() {
        const apps = Shell.AppSystem.get_default();
        MONITOR_APPS.map(id => apps.lookup_app(id)).find(Boolean)?.activate();
    }
}
