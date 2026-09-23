// CPU, memory, GPU and CPU temperature in the top bar, kept cheap: /proc and
// sysfs reads every two seconds (the approach of TopHat and GNOME's own
// System Monitor extension), and for NVIDIA one long-running nvidia-smi that
// prints a line per interval (the approach of Vitals) instead of a new
// process, or a full XML report, on every tick.
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';

import {addToPanel, label} from './util.js';

const INTERVAL_S = 2;
const ALARM = {cpu: 90, mem: 90, gpu: 95, temp: 85};
const CPU_SENSORS = ['k10temp', 'coretemp', 'zenpower', 'cpu_thermal', 'acpitz'];
const MONITOR_APPS = ['org.gnome.SystemMonitor.desktop', 'gnome-system-monitor.desktop', 'net.nokyan.Resources.desktop'];

function readText(path) {
    try {
        const [ok, bytes] = GLib.file_get_contents(path);
        return ok ? new TextDecoder().decode(bytes) : null;
    } catch {
        return null;
    }
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

function findAmdGpu() {
    return listDir('/sys/class/drm').filter(n => /^card\d+$/.test(n))
        .map(n => `/sys/class/drm/${n}/device/gpu_busy_percent`)
        .find(p => GLib.file_test(p, GLib.FileTest.EXISTS)) ?? null;
}

function onBattery() {
    return listDir('/sys/class/power_supply').some(n => n.startsWith('BAT'));
}

export class Monitor {
    constructor(settings) {
        this._settings = settings;
    }

    enable() {
        this._button = new PanelMenu.Button(0.5, 'System monitor', true);
        this._button.add_style_class_name('jade-monitor');
        const box = new St.BoxLayout({style_class: 'jade-monitor-box'});
        this._values = {};
        for (const [key, name] of [['cpu', 'CPU'], ['mem', 'MEM'], ['gpu', 'GPU'], ['temp', '']]) {
            const item = new St.BoxLayout({style_class: 'jade-monitor-item', visible: false});
            if (name)
                item.add_child(label(name, 'jade-monitor-name'));
            const value = label('', 'jade-monitor-value');
            item.add_child(value);
            box.add_child(item);
            this._values[key] = {item, value};
        }
        this._button.add_child(box);
        this._button.connect('button-release-event', () => this._openMonitorApp());
        addToPanel('jade-monitor', this._button);

        this._previousCpu = null;
        this._temperature = findCpuTemperature();
        this._amdGpu = findAmdGpu();
        this._settingsChanged = this._settings.connect('changed::monitor-gpu', () => this._syncGpu());
        this._syncGpu();
        this._tick();
        this._timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, INTERVAL_S, () => {
            this._tick();
            return GLib.SOURCE_CONTINUE;
        });
    }

    disable() {
        GLib.source_remove(this._timer);
        this._timer = null;
        this._settings.disconnect(this._settingsChanged);
        this._stopNvidia();
        this._button.destroy();
        this._button = this._values = null;
    }

    _show(key, text, alarm = false) {
        const {item, value} = this._values[key];
        item.visible = text !== null;
        if (text === null)
            return;
        value.text = text;
        value[alarm ? 'add_style_class_name' : 'remove_style_class_name']('jade-alarm');
    }

    _tick() {
        const cpu = this._cpuPercent();
        this._show('cpu', cpu === null ? null : `${cpu}%`, cpu >= ALARM.cpu);
        const mem = this._memPercent();
        this._show('mem', mem === null ? null : `${mem}%`, mem >= ALARM.mem);
        const temp = this._temperature ? Number(readText(this._temperature)) / 1000 : NaN;
        this._show('temp', Number.isFinite(temp) ? `${Math.round(temp)}°` : null, temp >= ALARM.temp);
        if (this._amdGpu && this._gpuWanted()) {
            const gpu = Number(readText(this._amdGpu));
            this._show('gpu', Number.isFinite(gpu) ? `${gpu}%` : null, gpu >= ALARM.gpu);
        }
    }

    _cpuPercent() {
        const fields = readText('/proc/stat')?.split('\n', 1)[0].trim().split(/\s+/).slice(1).map(Number);
        if (!fields || fields.length < 5)
            return null;
        const idle = fields[3] + (fields[4] ?? 0);
        const total = fields.slice(0, 8).reduce((a, v) => a + v, 0);
        const previous = this._previousCpu;
        this._previousCpu = {idle, total};
        if (!previous || total === previous.total)
            return previous ? 0 : null;
        return Math.round(100 * (1 - (idle - previous.idle) / (total - previous.total)));
    }

    _memPercent() {
        const text = readText('/proc/meminfo');
        const value = key => Number(text?.match(new RegExp(`^${key}:\\s+(\\d+)`, 'm'))?.[1]);
        const total = value('MemTotal');
        const available = value('MemAvailable');
        return total && Number.isFinite(available) ? Math.round(100 * (1 - available / total)) : null;
    }

    // A discrete GPU stays awake while it is being polled, so laptops opt in.
    _gpuWanted() {
        return this._settings.get_boolean('monitor-gpu') && !onBattery();
    }

    _syncGpu() {
        const nvidia = GLib.file_test('/proc/driver/nvidia', GLib.FileTest.EXISTS) && GLib.find_program_in_path('nvidia-smi');
        if (nvidia && this._gpuWanted())
            this._startNvidia();
        else
            this._stopNvidia();
        if (!this._gpuWanted() || (!nvidia && !this._amdGpu))
            this._show('gpu', null);
    }

    _startNvidia() {
        if (this._nvidia)
            return;
        try {
            this._nvidia = Gio.Subprocess.new(
                ['nvidia-smi', '--query-gpu=utilization.gpu', '--format=csv,noheader,nounits', `--loop-ms=${INTERVAL_S * 1000}`],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
        } catch (e) {
            console.error(`Jade Shell: cannot start nvidia-smi: ${e.message}`);
            return;
        }
        this._nvidiaCancellable = new Gio.Cancellable();
        this._readNvidia(new Gio.DataInputStream({base_stream: this._nvidia.get_stdout_pipe()}), this._nvidiaCancellable);
    }

    _readNvidia(stream, cancellable) {
        stream.read_line_async(GLib.PRIORITY_LOW, cancellable, (s, result) => {
            let line;
            try {
                [line] = s.read_line_finish_utf8(result);
            } catch {
                return; // cancelled, or nvidia-smi went away
            }
            if (line === null || cancellable.is_cancelled())
                return;
            const gpu = Number(line.trim().split(',')[0]);
            this._show('gpu', Number.isFinite(gpu) ? `${gpu}%` : null, gpu >= ALARM.gpu);
            this._readNvidia(stream, cancellable);
        });
    }

    _stopNvidia() {
        this._nvidiaCancellable?.cancel();
        this._nvidia?.force_exit();
        this._nvidia = this._nvidiaCancellable = null;
    }

    _openMonitorApp() {
        const apps = Shell.AppSystem.get_default();
        const app = MONITOR_APPS.map(id => apps.lookup_app(id)).find(Boolean);
        app?.activate();
        return Clutter.EVENT_STOP;
    }
}
