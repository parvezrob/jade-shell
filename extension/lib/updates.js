import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import * as SystemActions from 'resource:///org/gnome/shell/misc/systemActions.js';

import {notify as show, openUri} from './notify.js';
import {Debouncer, jadeCommand, run, stateDir} from './util.js';

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
            ['Update', () => this._update().catch(e => console.error(`Jade Shell: update failed: ${e.message}`))],
            ["What's new", () => openUri(`${RELEASES}/tag/v${result.latest}`)],
        ]);
    }

    // Once installed, the package's new metadata.json brings the "log out" notice.
    async _update() {
        const jade = jadeCommand();
        if (busy || !jade)
            return;
        busy = true;
        const {ok, status, stdout, stderr} = await run([jade, 'update']);
        busy = false;
        const log = writeLog(`${stdout}${stderr}`);
        if (!ok && status !== 2) {  // 2: the password dialog was closed
            notify('Jade Shell could not update', 'Run "jade update" in a terminal to see why and try again.',
                [['Show details', () => openUri(log.get_uri())]]);
        }
    }

    // The package on disk changed under the running version.
    _checkInstalled() {
        const installed = readJson(this._dir.get_child('metadata.json'))?.['version-name'];
        if (!installed || installed === this._version || installed === this._told)
            return;
        this._told = installed;
        notify(`Jade Shell ${installed} is installed`, 'Log out and back in to finish the update.', [
            ['Log out', () => SystemActions.getDefault().activateLogout()],
            ["What's new", () => openUri(`${RELEASES}/tag/v${installed}`)],
        ]);
    }
}

function writeLog(text) {
    const log = stateDir().get_child('update.log');
    try {
        log.replace_contents(new TextEncoder().encode(text), null, false,
            Gio.FileCreateFlags.PRIVATE | Gio.FileCreateFlags.REPLACE_DESTINATION, null);
    } catch {}
    return log;
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
function notify(title, body, actions) {
    notice?.destroy();
    const notification = show(title, body, actions, 'software-update-available-symbolic');
    notice = notification;
    notification.connect('destroy', () => {
        if (notice === notification)
            notice = null;
    });
}
