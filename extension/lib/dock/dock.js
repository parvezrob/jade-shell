import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {ExtensionState} from 'resource:///org/gnome/shell/misc/extensionUtils.js';

import {Bar} from './bar.js';
import {Genie} from './genie.js';

// Docks that would sit in the same place. Setup turns them off; while one is
// still running (the user turned it back on), Jade's dock stays out of its way.
const OTHER_DOCKS = [
    'dash-to-dock@micxgx.gmail.com', 'ubuntu-dock@ubuntu.com', 'dash-to-panel@jderose9.github.com',
    'dash2dock-lite@icedman.github.com', 'dash2dock-motion@unmade760.github.com',
];

// Jade's dock, on the primary monitor. It is also the overview's dock:
// GNOME's own dash stays hidden (its space in the overview is where this one
// shows), and comes back when the dock is turned off.
export class Dock {
    constructor(settings, shellTheme) {
        this._settings = settings;
        this._theme = shellTheme;
    }

    enable() {
        this._settings.connectObject('changed::dock-genie', () => this._syncGenie(), this);
        Main.extensionManager.connectObject('extension-state-changed', () => this._queueSync(), this);
        Main.layoutManager.connectObject('monitors-changed', () => this._rebuild(), this);
        if (Main.layoutManager._startingUp)
            Main.layoutManager.connectObject('startup-complete', () => this._sync(), this);
        else
            this._sync();
    }

    disable() {
        if (this._syncId)
            GLib.source_remove(this._syncId);
        this._syncId = 0;
        this._settings.disconnectObject(this);
        Main.extensionManager.disconnectObject(this);
        Main.layoutManager.disconnectObject(this);
        this._destroyBar();
    }

    get bar() {
        return this._bar ?? null;
    }

    _otherDock() {
        return OTHER_DOCKS.find(uuid => Main.extensionManager.lookup(uuid)?.state === ExtensionState.ACTIVE);
    }

    _queueSync() {
        if (this._syncId)
            return;
        this._syncId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._syncId = 0;
            this._sync();
            return GLib.SOURCE_REMOVE;
        });
    }

    _sync() {
        const other = this._otherDock();
        if (other && this._bar) {
            console.log(`Jade Shell: ${other} is on, so the Jade dock steps aside`);
            this._destroyBar();
        } else if (!other && !this._bar && Main.layoutManager.primaryMonitor) {
            this._bar = new Bar(Main.layoutManager.primaryIndex, this._settings, this._theme);
            Main.overview.dash.hide();
        }
        this._syncGenie();
    }

    // The genie needs the dock's icons to aim at.
    _syncGenie() {
        const wanted = Boolean(this._bar) && this._settings.get_boolean('dock-genie');
        if (wanted && !this._genie) {
            this._genie = new Genie();
            this._genie.enable();
        } else if (!wanted && this._genie) {
            this._genie.disable();
            this._genie = null;
        }
    }

    _rebuild() {
        this._destroyBar();
        this._sync();
    }

    _destroyBar() {
        if (!this._bar)
            return;
        this._bar.destroy();
        this._bar = null;
        this._syncGenie();
        // Another dock may have taken the overview's dash over meanwhile.
        if (!this._otherDock())
            Main.overview.dash.show();
    }
}
