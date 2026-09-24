import GLib from 'gi://GLib';
import St from 'gi://St';
import * as AppDisplay from 'resource:///org/gnome/shell/ui/appDisplay.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {ExtensionState} from 'resource:///org/gnome/shell/misc/extensionUtils.js';

import {Bar} from './bar.js';
import {Genie} from './genie.js';
import {retint, smooth} from './items.js';

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
            this._bar.onRestyle = () => this._retintGrid();
            this._patchGrid();
            this._retintGrid();
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

    // The app grid's icons follow the dock's: tinted with it (Settings ›
    // Dock › Icons), so the look is one across the Shell.
    _patchGrid() {
        if (this._createIcon)
            return;
        const createIcon = AppDisplay.AppIcon.prototype._createIcon;
        this._createIcon = createIcon;
        AppDisplay.AppIcon.prototype._createIcon = function (size) {
            return smooth(createIcon.call(this, size));
        };
        // A folder's preview: four of its apps' icons.
        const createFolderIcon = AppDisplay.FolderView.prototype.createFolderIcon;
        this._createFolderIcon = createFolderIcon;
        AppDisplay.FolderView.prototype.createFolderIcon = function (size) {
            const icon = createFolderIcon.call(this, size);
            for (const bin of icon.get_children()) {
                if (bin.child instanceof St.Icon)
                    smooth(bin.child);
            }
            return icon;
        };
    }

    _unpatchGrid() {
        if (!this._createIcon)
            return;
        AppDisplay.AppIcon.prototype._createIcon = this._createIcon;
        AppDisplay.FolderView.prototype.createFolderIcon = this._createFolderIcon;
        this._createIcon = this._createFolderIcon = null;
    }

    _retintGrid() {
        const appDisplay = Main.overview._overview?.controls?.appDisplay;
        const views = [appDisplay, ...(appDisplay?._orderedItems ?? []).map(item => item._folderView ?? item.view)];
        for (const view of views) {
            for (const item of view?._orderedItems ?? []) {
                const icon = item.icon?.icon;
                if (icon instanceof St.Icon)
                    retint(icon);
                else  // a folder's preview
                    icon?.get_children().forEach(bin => bin.child instanceof St.Icon && retint(bin.child));
            }
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
        this._unpatchGrid();
        this._retintGrid();  // the tint is off with the dock
        this._syncGenie();
        // Another dock may have taken the overview's dash over meanwhile.
        if (!this._otherDock())
            Main.overview.dash.show();
    }
}
