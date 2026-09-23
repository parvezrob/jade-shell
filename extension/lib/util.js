import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

export const VERTICAL = Clutter.Orientation.VERTICAL;

// Left to right in the top bar's right box.
const PANEL_ORDER = ['jade-monitor', 'jade-usage', 'jade-picker'];

export function label(text, style, props = {}) {
    return new St.Label({text, style_class: style, y_align: Clutter.ActorAlign.CENTER, ...props});
}

export function stateDir() {
    return Gio.File.new_for_path(GLib.build_filenamev([GLib.get_user_state_dir(), 'jade-shell']));
}

// The `jade` command: installed for everyone, or into ~/.local/bin (which
// the Shell's own PATH often lacks).
export function jadeCommand() {
    const local = GLib.build_filenamev([GLib.get_home_dir(), '.local', 'bin', 'jade']);
    return GLib.find_program_in_path('jade') ?? (GLib.file_test(local, GLib.FileTest.IS_EXECUTABLE) ? local : null);
}

// Run a command without blocking the Shell; resolves with its exit status and output.
export function run(argv, cancellable = null) {
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

// Add a Jade indicator in its fixed place among the others, whichever
// order they are turned on in.
export function addToPanel(role, indicator) {
    const box = Main.panel._rightBox;
    const children = box.get_children();
    const at = PANEL_ORDER.indexOf(role);
    for (const later of PANEL_ORDER.slice(at + 1)) {
        const container = Main.panel.statusArea[later]?.container;
        if (container && children.includes(container)) {
            Main.panel.addToStatusArea(role, indicator, children.indexOf(container), 'right');
            return;
        }
    }
    for (const earlier of PANEL_ORDER.slice(0, at).reverse()) {
        const container = Main.panel.statusArea[earlier]?.container;
        if (container && children.includes(container)) {
            Main.panel.addToStatusArea(role, indicator, children.indexOf(container) + 1, 'right');
            return;
        }
    }
    Main.panel.addToStatusArea(role, indicator, 0, 'right');
}

export function cairoRgb(hex) {
    return [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255);
}

// Coalesce a burst of events into one call after `ms` of quiet.
export class Debouncer {
    constructor(ms, callback) {
        this._ms = ms;
        this._callback = callback;
        this._source = null;
    }

    schedule() {
        if (this._source)
            return;
        this._source = GLib.timeout_add(GLib.PRIORITY_DEFAULT, this._ms, () => {
            this._source = null;
            this._callback();
            return GLib.SOURCE_REMOVE;
        });
    }

    cancel() {
        if (this._source)
            GLib.source_remove(this._source);
        this._source = null;
    }
}
