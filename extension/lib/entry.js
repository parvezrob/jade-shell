// A way into Jade Shell's settings where people look for settings: a button
// in Quick Settings, next to GNOME's own Settings gear, with Jade Shell's
// icon. It opens the Jade Shell app.
//
// GNOME 50 builds that row in status/system.js (SystemItem, reached through
// the quick settings' _system indicator); the button goes in right after
// GNOME's Settings button and leaves with the extension.
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {QuickSettingsItem} from 'resource:///org/gnome/shell/ui/quickSettings.js';

import {openSettings} from './util.js';

const JadeSettingsItem = GObject.registerClass(
class JadeSettingsItem extends QuickSettingsItem {
    _init(dir) {
        super._init({
            style_class: 'icon-button',
            can_focus: true,
            accessible_name: 'Jade Shell Settings',
            child: new St.Icon({gicon: new Gio.FileIcon({file: dir.get_child('icons').get_child('jade-shell-symbolic.svg')})}),
        });
        this.connect('clicked', () => {
            Main.overview.hide();
            Main.panel.closeQuickSettings();
            openSettings();
        });
    }
});

export class SettingsEntry {
    constructor(extension) {
        this._dir = extension.dir;
    }

    enable() {
        this._tries = 0;
        this._add();
    }

    // Quick Settings builds its indicators asynchronously at startup: try
    // again for a few seconds if the row isn't there yet.
    _add() {
        const row = Main.panel.statusArea.quickSettings._system?._systemItem?.child;
        if (!row) {
            if (++this._tries > 10) {
                console.warn('Jade Shell: Quick Settings has no system row where expected; no settings button there');
                return;
            }
            this._retry = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
                this._retry = null;
                this._add();
                return GLib.SOURCE_REMOVE;
            });
            return;
        }
        this._item = new JadeSettingsItem(this._dir);
        // After GNOME's Settings button: the first icon button with the Settings app's name.
        const gnome = row.get_children().find(child => child.accessible_name && child.constructor.name === 'SettingsItem');
        if (gnome)
            row.insert_child_above(this._item, gnome);
        else
            row.add_child(this._item);
    }

    disable() {
        if (this._retry)
            GLib.source_remove(this._retry);
        this._retry = null;
        this._item?.destroy();
        this._item = null;
    }
}
