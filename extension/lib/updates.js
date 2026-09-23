import Gio from 'gi://Gio';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import * as SystemActions from 'resource:///org/gnome/shell/misc/systemActions.js';

import {Debouncer, jadeCommand, run, stateDir} from './util.js';

const RELEASES = 'https://github.com/parvezrob/jade-shell/releases';

// Set once a finish has started this session: the part starts again after
// every unlock, and one setup per login is enough.
let finishStarted = false;
// The one notice about updates on screen: a newer one replaces it.
let notice = null;

// dnf, apt or GNOME Software can update the package at any time; Jade Shell
// finishes the update itself:
// - while the old version still runs, it says a new one is installed and
//   offers to log out (the Shell loads extension code once per login);
// - at the first login with a new version, it runs `jade setup
//   --after-update` in the background (settings and migrations the new
//   version needs, the theme rebuilt), then says so.
// Only packages stamp a version (version-name); a checkout has none and is
// left alone.
export class Updates {
    constructor(extension) {
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
    }

    disable() {
        if (!this._monitor)
            return;
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
        const log = stateDir().get_child('update.log');
        try {
            log.replace_contents(new TextEncoder().encode(`${stdout}${stderr}`), null, false,
                Gio.FileCreateFlags.PRIVATE | Gio.FileCreateFlags.REPLACE_DESTINATION, null);
        } catch {}
        if (ok) {
            notify(`Jade Shell updated to ${this._version}`, 'Your theme and settings are up to date.',
                [["What's new", () => openUri(`${RELEASES}/tag/v${this._version}`)]]);
        } else {
            notify(`Jade Shell ${this._version} could not finish updating`,
                'Run "jade setup" in a terminal to see why and try again.',
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

function readJson(file) {
    try {
        const [, bytes] = file.load_contents(null);
        return JSON.parse(new TextDecoder().decode(bytes));
    } catch {
        return null;
    }
}

function openUri(uri) {
    try {
        Gio.AppInfo.launch_default_for_uri(uri, global.create_app_launch_context(0, -1));
    } catch (e) {
        console.error(`Jade Shell: could not open ${uri}: ${e.message}`);
    }
}

function notify(title, body, actions) {
    const source = new MessageTray.Source({
        title: 'Jade Shell',
        icon: new Gio.ThemedIcon({name: 'software-update-available-symbolic'}),
    });
    Main.messageTray.add(source);
    const notification = new MessageTray.Notification({source, title, body});
    for (const [label, callback] of actions)
        notification.addAction(label, callback);
    notice?.destroy();
    notice = notification;
    notification.connect('destroy', () => {
        if (notice === notification)
            notice = null;
    });
    source.addNotification(notification);
}
