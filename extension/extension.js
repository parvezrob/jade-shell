// Jade Shell: Omarchy's look and theme switching for GNOME.
//
// The Shell theme is loaded in every session mode, so the lock screen keeps
// the theme's colors. Everything in the top bar exists only in the normal
// user session and is torn down while the screen is locked. The Desktop part
// (app grid and startup) stays on too: it changes nothing on the lock screen,
// and rebuilding the app grid on every lock and unlock is wasted work.
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {BarIcons} from './lib/baricons.js';
import {Capture} from './lib/capture.js';
import {CheatSheet} from './lib/cheatsheet.js';
import {ClipboardHistory} from './lib/clipboard.js';
import {Clock} from './lib/clock.js';
import {Desktop} from './lib/desktop.js';
import {Glass} from './lib/glass.js';
import {Dock} from './lib/dock/dock.js';
import {SettingsEntry} from './lib/entry.js';
import {SimpleCalendar} from './lib/datemenu.js';
import {Modes} from './lib/modes.js';
import {JadeMenu} from './lib/menu.js';
import {Media} from './lib/media.js';
import {Monitor} from './lib/monitor.js';
import {Network} from './lib/network.js';
import {Notifications} from './lib/notifications.js';
import {Picker} from './lib/picker.js';
import {ShellTheme} from './lib/theme.js';
import {Usage} from './lib/usage.js';
import {Updates} from './lib/updates.js';
import {Weather} from './lib/weather.js';
import {Welcome} from './lib/welcome.js';
import {Workspaces} from './lib/workspaces.js';

export default class JadeShell extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._shellTheme = new ShellTheme();
        this._shellTheme.enable();
        // Parts the user can turn off; null key means always on.
        this._parts = [
            {key: null, keepWhileLocked: true, make: () => new Desktop(this._settings)},
            {key: null, make: () => new Glass(this._settings, this._shellTheme)},
            {key: 'show-dock', make: () => new Dock(this._settings, this._shellTheme)},
            {key: 'show-workspaces', make: () => new Workspaces()},
            {key: 'show-clock-format', make: () => new Clock(this._settings)},
            {key: 'simple-calendar', make: () => new SimpleCalendar()},
            {key: 'show-media', make: () => new Media()},
            {key: 'show-weather', make: () => new Weather(this._settings, this.dir)},
            {key: 'show-monitor', make: () => new Monitor(this, this._settings, this._shellTheme)},
            {key: 'show-usage', make: () => new Usage(this, this._settings, this._shellTheme)},
            {key: null, make: () => new Picker(this._settings, this._shellTheme)},
            {key: null, make: () => new CheatSheet(this._settings)},
            {key: null, make: () => new Capture(this._settings, name => this._part(name))},
            {key: null, make: () => new Network(this, this._settings, this._shellTheme)},
            {key: 'clipboard-history', make: () => new ClipboardHistory(this._settings)},
            {key: null, make: () => new JadeMenu(this, this._settings, name => this._part(name))},
            {key: 'notification-bell', make: () => new Notifications(this, this._settings)},
            {key: null, make: () => new Modes(this, this._settings)},
            {key: null, make: () => new Updates(this, this._settings)},
            {key: null, make: () => new SettingsEntry(this)},
            {key: null, make: () => new Welcome(this, this._settings, () => this._openPicker())},
            // Last: every other part's icons are in the bar by now.
            {key: null, keepWhileLocked: true, make: () => new BarIcons(this)},
        ];
        this._partsChanged = this._parts.filter(p => p.key).map(
            part => this._settings.connect(`changed::${part.key}`, () => this._syncPart(part)));
        this._sessionChanged = Main.sessionMode.connect('updated', () => this._syncParts());
        this._syncParts();
    }

    disable() {
        Main.sessionMode.disconnect(this._sessionChanged);
        this._partsChanged.forEach(id => this._settings.disconnect(id));
        for (const part of [...this._parts].reverse())
            this._stopPart(part);
        this._parts = null;
        this._shellTheme.disable();
        this._shellTheme = null;
        this._settings = null;
    }

    // A running part by its class name (for the Jade Menu), or null.
    _part(name) {
        return this._parts?.find(part => part.instance?.constructor.name === name)?.instance ?? null;
    }

    _openPicker() {
        this._parts?.find(part => part.instance instanceof Picker)?.instance?.toggle();
    }

    _syncParts() {
        for (const part of this._parts)
            this._syncPart(part);
    }

    _syncPart(part) {
        const allowed = part.keepWhileLocked || !Main.sessionMode.isLocked;
        const wanted = allowed && (!part.key || this._settings.get_boolean(part.key));
        if (wanted && !part.instance) {
            part.instance = part.make();
            try {
                part.instance.enable();
            } catch (e) {
                // One part failing (say, a Shell internal it relies on moved)
                // must not take the rest of the top bar down with it.
                // Undo whatever it did before failing (disable() copes with a
                // half-done enable), so no half-built part is left behind.
                console.error(`Jade Shell: ${part.instance.constructor.name} failed to start: ${e.message}`);
                this._stopPart(part);
            }
        } else if (!wanted) {
            this._stopPart(part);
        }
    }

    _stopPart(part) {
        if (!part.instance)
            return;
        try {
            part.instance.disable();
        } catch (e) {
            console.error(`Jade Shell: ${part.instance.constructor.name} failed to stop: ${e.message}`);
        }
        part.instance = null;
    }
}
