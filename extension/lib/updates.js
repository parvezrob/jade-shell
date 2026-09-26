import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import * as SystemActions from 'resource:///org/gnome/shell/misc/systemActions.js';

import {notify as show, openUri} from './notify.js';
import {Debouncer, SPAWN, jadeCommand, run, stateDir} from './util.js';

const RELEASES = 'https://github.com/parvezrob/jade-shell/releases';
const HOUR = 60 * 60;
// The first check waits for the session to settle after login.
const FIRST_CHECK = 3 * 60;

// Set once a finish has started this session: the part starts again after
// every unlock, and one setup per login is enough.
let finishStarted = false;
let notice = null;
// A check or an update running; one at a time.
let busy = false;
// `jade update` running: it says how it went, so the package's new
// metadata.json (on disk before it ends) brings no notice of its own.
let updating = false;

// dnf, apt or GNOME Software can update the package at any time; Jade Shell
// finishes the update itself:
// - while the old version still runs, it says a new one is installed and
//   offers to log out (the Shell loads extension code once per login);
// - at the first login with a new version, it runs `jade setup
//   --after-update` in the background (settings and migrations the new
//   version needs, the theme rebuilt), then says so.
// - once a day (when turned on in the preferences) it asks the latest release
//   for its version, and offers a newer one: "Update" runs `jade update`,
//   which asks for the password in GNOME's own dialog.
// Only packages stamp a version (version-name); a checkout has none and is
// left alone.
export class Updates {
    constructor(extension, settings) {
        this._settings = settings;
        this._dir = extension.dir;
        this._version = extension.metadata['version-name'] ?? null;
    }

    enable() {
        if (!this._version)
            return;
        this._told = null;
        this._finish().catch(e => console.error(`Jade Shell: finishing the update failed: ${e.message}`));
        this._check = new Debouncer(1000, () => this._checkInstalled());
        this._monitor = this._dir.monitor_directory(Gio.FileMonitorFlags.WATCH_MOVES, null);
        this._monitorChanged = this._monitor.connect('changed', (_m, file, other) => {
            if ([file?.get_basename(), other?.get_basename()].includes('metadata.json'))
                this._check.schedule();
        });
        this._checksChanged = this._settings.connect('changed::check-updates', () => this._scheduleChecks());
        this._scheduleChecks();
    }

    disable() {
        if (!this._monitor)
            return;
        this._settings.disconnect(this._checksChanged);
        this._stopChecks();
        if (this._starting)
            GLib.source_remove(this._starting);
        this._starting = 0;
        this._check.cancel();
        this._monitor.disconnect(this._monitorChanged);
        this._monitor.cancel();
        this._monitor = this._check = null;
    }

    async _finish() {
        if (finishStarted)
            return;
        const setupFor = readJson(stateDir().get_child('setup.json'))?.version;
        // Never set up (the installer's job), or set up by an older Jade Shell
        // that did not record its version and set things up the same way.
        if (!setupFor || setupFor === this._version)
            return;
        const jade = jadeCommand();
        if (!jade)
            return;
        finishStarted = true;
        const {ok, stdout, stderr} = await run([jade, 'setup', '--after-update']);
        const log = writeLog(`${stdout}${stderr}`);
        if (ok) {
            notify(`Jade Shell updated to ${this._version}`, 'Your theme and settings are up to date.',
                [["What's new", () => openUri(`${RELEASES}/tag/v${this._version}`)]]);
        } else {
            notify(`Jade Shell ${this._version} could not finish updating`,
                'Run "jade setup" in a terminal to see why and try again.',
                [['Show details', () => openUri(log.get_uri())]]);
        }
    }

    _scheduleChecks() {
        this._stopChecks();
        if (!this._settings.get_boolean('check-updates'))
            return;
        this._timer = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, FIRST_CHECK, () => {
            this._checkLatest();
            this._timer = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, HOUR, () => {
                this._checkLatest();
                return GLib.SOURCE_CONTINUE;
            });
            return GLib.SOURCE_REMOVE;
        });
    }

    _stopChecks() {
        if (this._timer)
            GLib.source_remove(this._timer);
        this._timer = null;
    }

    // Wakes every hour but asks once a day: `jade update --check` records when
    // it asked. Offline, it records nothing and the next hour tries again.
    async _checkLatest() {
        const checked = readJson(stateDir().get_child('update.json'))?.checked ?? 0;
        const jade = jadeCommand();
        if (busy || !jade || GLib.get_real_time() / 1e6 - checked < 24 * HOUR)
            return;
        busy = true;
        const {ok, stdout} = await run([jade, 'update', '--check', '--json']);
        busy = false;
        let result;
        try {
            result = ok ? JSON.parse(stdout) : null;
        } catch {}
        if (!result?.available || !result.package || !this._timer)
            return;
        notify(`Jade Shell ${result.latest} is available`, `You have ${this._version}.`, [
            ['Update', () => this._startUpdate(result.latest)],
            ["What's new", () => openUri(`${RELEASES}/tag/v${result.latest}`)],
        ]);
    }

    // From a notification's button: GNOME closes that notification once the
    // callback returns, so the update's own notice comes after.
    _startUpdate(version) {
        if (this._starting)
            return;
        this._starting = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._starting = 0;
            this._update(version).catch(e => {
                busy = updating = false;
                console.error(`Jade Shell: update failed: ${e.message}`);
            });
            return GLib.SOURCE_REMOVE;
        });
    }

    // The download takes a while before GNOME's password dialog opens: the
    // notice says what is happening from the click on, following the lines
    // `jade update` prints, and ends with the result.
    async _update(version) {
        const jade = jadeCommand();
        if (busy || !jade)
            return;
        busy = updating = true;
        const progress = notify(`Downloading Jade Shell ${version}…`, 'Your password is asked for next.');
        const {ok, status, lines, errors} = await runLines([jade, 'update'], line => {
            if (notice !== progress)  // closed meanwhile
                return;
            if (line.startsWith('Installing Jade Shell'))
                progress.set({title: `Installing Jade Shell ${version}…`, body: 'Type your password in the window that opens.'});
            else if (line.startsWith('Waiting for other updates'))
                progress.set({body: 'Waiting for other updates on this computer to finish…'});
        });
        busy = updating = false;
        // `jade update` keeps update.log itself; a crash doesn't get there.
        if (errors.length)
            writeLog(`${errors.join('\n')}\n`, true);
        const log = stateDir().get_child('update.log');
        const retry = ['Try again', () => this._startUpdate(version)];
        if (ok) {
            this._told = version;
            notify(`Jade Shell ${version} is installed`, 'Log out and back in to start the new version.', [
                ['Log out', () => SystemActions.getDefault().activateLogout()],
                ["What's new", () => openUri(`${RELEASES}/tag/v${version}`)],
            ]);
        } else if (status === 2) {
            notify('Jade Shell was not updated', 'The password window was closed.', [retry]);
        } else {
            // Its last line says why, in plain words (none after a crash).
            const why = lines.filter(line => line.trim()).at(-1);
            const crashed = errors.some(line => line.startsWith('Traceback'));
            notify("Jade Shell couldn't update", why && !crashed ? why : 'Something went wrong while updating.',
                [retry, ['Show details', () => openUri(log.get_uri())]]);
        }
    }

    // The package on disk changed under the running version.
    _checkInstalled() {
        const installed = readJson(this._dir.get_child('metadata.json'))?.['version-name'];
        if (!installed || installed === this._version || installed === this._told || updating)
            return;
        this._told = installed;
        notify(`Jade Shell ${installed} is installed`, 'Log out and back in to finish the update.', [
            ['Log out', () => SystemActions.getDefault().activateLogout()],
            ["What's new", () => openUri(`${RELEASES}/tag/v${installed}`)],
        ]);
    }
}

function writeLog(text, append = false) {
    const log = stateDir().get_child('update.log');
    try {
        if (append) {
            const stream = log.append_to(Gio.FileCreateFlags.PRIVATE, null);
            stream.write_all(new TextEncoder().encode(text), null);
            stream.close(null);
        } else {
            log.replace_contents(new TextEncoder().encode(text), null, false,
                Gio.FileCreateFlags.PRIVATE | Gio.FileCreateFlags.REPLACE_DESTINATION, null);
        }
    } catch {}
    return log;
}

// Run a command, calling onLine with each line it prints as it comes;
// resolves as run() does, with the lines of stdout and stderr. The pipes
// stay apart: STDERR_MERGE with SPAWN's INHERIT_FDS loses stdout (GLib 2.88).
function runLines(argv, onLine) {
    return new Promise(resolve => {
        let proc;
        try {
            proc = Gio.Subprocess.new(argv, SPAWN | Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
        } catch (e) {
            resolve({ok: false, status: null, lines: [], errors: [e.message]});
            return;
        }
        const out = [], err = [];
        let open = 2;
        // Bytes, decoded leniently: a line that isn't UTF-8 must not stop the
        // reading (a full pipe would hold `jade update` forever).
        const decoder = new TextDecoder();
        const read = (pipe, lines, callback) => {
            const stream = new Gio.DataInputStream({base_stream: pipe, close_base_stream: true});
            const next = () => stream.read_line_async(GLib.PRIORITY_DEFAULT, null, (s, result) => {
                let line;
                try {
                    const [bytes] = s.read_line_finish(result);
                    line = bytes === null ? null : decoder.decode(bytes);
                } catch {
                    line = null;
                }
                if (line === null) {
                    if (--open === 0)
                        finish();
                    return;
                }
                lines.push(line);
                try {
                    callback?.(line);
                } catch (e) {
                    console.error(`Jade Shell: ${e.message}`);
                }
                next();
            });
            next();
        };
        const finish = () => proc.wait_async(null, (p, result) => {
            try {
                p.wait_finish(result);
            } catch {}
            resolve({ok: p.get_successful(), status: p.get_if_exited() ? p.get_exit_status() : null, lines: out, errors: err});
        });
        read(proc.get_stdout_pipe(), out, onLine);
        read(proc.get_stderr_pipe(), err, null);
    });
}

function readJson(file) {
    try {
        const [, bytes] = file.load_contents(null);
        return JSON.parse(new TextDecoder().decode(bytes));
    } catch {
        return null;
    }
}

// The one notice about updates on screen: a newer one replaces it.
function notify(title, body, actions = []) {
    notice?.destroy();
    const notification = show(title, body, actions, 'software-update-available-symbolic');
    notice = notification;
    notification.connect('destroy', () => {
        if (notice === notification)
            notice = null;
    });
    return notification;
}
