// Jade Shell: Omarchy's look and theme switching for GNOME.
//
// The Shell theme is loaded in every session mode, so the lock screen keeps
// the theme's colors. Everything in the top bar exists only in the normal
// user session and is torn down while the screen is locked. The Desktop part
// (app grid and startup) stays on too: it changes nothing on the lock screen,
// and rebuilding the app grid on every lock and unlock is wasted work.
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {CheatSheet} from './lib/cheatsheet.js';
import {Clock} from './lib/clock.js';
import {Desktop} from './lib/desktop.js';
import {Dock} from './lib/dock/dock.js';
import {SimpleCalendar} from './lib/datemenu.js';
import {Monitor} from './lib/monitor.js';
import {Notifications} from './lib/notifications.js';
import {Picker} from './lib/picker.js';
import {ShellTheme} from './lib/theme.js';
import {Usage} from './lib/usage.js';
import {Updates} from './lib/updates.js';
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
            {key: 'show-dock', make: () => new Dock(this._settings, this._shellTheme)},
            {key: 'show-workspaces', make: () => new Workspaces()},
            {key: 'show-clock-format', make: () => new Clock(this._settings)},
            {key: 'simple-calendar', make: () => new SimpleCalendar()},
            {key: 'show-monitor', make: () => new Monitor(this, this._settings, this._shellTheme)},
            {key: 'show-usage', make: () => new Usage(this, this._settings, this._shellTheme)},
            {key: null, make: () => new Picker(this._settings, this._shellTheme)},
            {key: null, make: () => new CheatSheet(this._settings)},
            {key: 'notification-bell', make: () => new Notifications(this, this._settings)},
            {key: null, make: () => new Updates(this, this._settings)},
            {key: null, make: () => new Welcome(this, this._settings, () => this._openPicker())},
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

    _openPicker() {
        this._parts.find(part => part.instance instanceof Picker)?.instance.toggle();
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
