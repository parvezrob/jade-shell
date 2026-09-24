// Helpers for the settings window (a separate process from GNOME Shell: none
// of the Shell's own modules can be imported here).
import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

// Resolves when the command succeeds, rejects when it fails.
export function run(argv) {
    return new Promise((resolve, reject) => {
        const proc = Gio.Subprocess.new(argv, Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE);
        proc.wait_check_async(null, (p, result) => {
            try {
                p.wait_check_finish(result);
                resolve();
            } catch (e) {
                reject(e);
            }
        });
    });
}

// A command's output, whatever its exit status: {ok, stdout, stderr}.
export function capture(argv) {
    return new Promise(resolve => {
        let proc;
        try {
            proc = Gio.Subprocess.new(argv, Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
        } catch (e) {
            resolve({ok: false, stdout: '', stderr: e.message});
            return;
        }
        proc.communicate_utf8_async(null, null, (p, result) => {
            try {
                const [, stdout, stderr] = p.communicate_utf8_finish(result);
                resolve({ok: p.get_successful(), stdout: stdout ?? '', stderr: stderr ?? ''});
            } catch (e) {
                resolve({ok: false, stdout: '', stderr: e.message});
            }
        });
    });
}

// A command's trimmed stdout, whatever its exit status (is-active exits 3
// for "inactive").
export async function output(argv) {
    return (await capture(argv)).stdout.trim();
}

// The `jade` command: installed for everyone, or into ~/.local/bin.
export function jadeCommand() {
    const local = GLib.build_filenamev([GLib.get_home_dir(), '.local', 'bin', 'jade']);
    return GLib.find_program_in_path('jade') ?? (GLib.file_test(local, GLib.FileTest.IS_EXECUTABLE) ? local : null);
}

// A row choosing one of a string setting's values, [[value, label], …]. It
// follows the setting, so the same choice on two pages (the Welcome and
// Desktop) never disagrees.
export function choiceRow(settings, key, choices, props) {
    const row = new Adw.ComboRow({...props, model: Gtk.StringList.new(choices.map(([, label]) => label))});
    const sync = () => {
        row.selected = Math.max(0, choices.findIndex(([value]) => value === settings.get_string(key)));
    };
    sync();
    const changed = settings.connect(`changed::${key}`, sync);
    row.connect('notify::selected', () => {
        const value = choices[row.selected]?.[0];
        if (value && value !== settings.get_string(key))
            settings.set_string(key, value);
    });
    row.connect('destroy', () => settings.disconnect(changed));
    return row;
}
