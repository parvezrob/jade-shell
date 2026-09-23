// Helpers for the settings window (a separate process from GNOME Shell: none
// of the Shell's own modules can be imported here).
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

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
