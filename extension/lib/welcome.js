import Gio from 'gi://Gio';
import GioUnix from 'gi://GioUnix';
import GLib from 'gi://GLib';

import {notify} from './notify.js';
import {APP_ID, openSettings, shortcutText, stateDir} from './util.js';

// Long enough after login for the desktop to settle, so the first banner
// isn't lost among apps starting up.
const DELAY = 8;

// After setup, once: the Jade Shell app opens on its Welcome page (pick your
// look, the weather's city, your keys). The app records "window" in
// state/jade-shell/welcome.json when the page is on screen, so a window that
// never appeared comes back at the next login. Then show-once hints: the
// bell and AI usage (and where the picker is, when the app isn't installed).
export class Welcome {
    constructor(extension, settings, openPicker) {
        this._extension = extension;
        this._settings = settings;
        this._openPicker = openPicker;
    }

    enable() {
        this._file = stateDir().get_child('welcome.json');
        // Only on a desktop Jade Shell has set up (the installer runs setup).
        if (!stateDir().get_child('setup.json').query_exists(null))
            return;
        this._timer = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, DELAY, () => {
            this._timer = null;
            this._show();
            return GLib.SOURCE_REMOVE;
        });
    }

    disable() {
        if (this._timer)
            GLib.source_remove(this._timer);
        this._timer = null;
    }

    _hints() {
        const shortcut = shortcutText(this._settings.get_strv('toggle-picker')[0]);
        // The Welcome page says all this, and more.
        if (GioUnix.DesktopAppInfo.new(APP_ID))
            return this._notes();
        const hints = [{
            id: 'picker',
            title: 'Welcome to Jade Shell',
            body: shortcut ? `Pick a theme with ${shortcut}, or the palette icon in the top bar.`
                : 'Pick a theme from the palette icon in the top bar.',
            actions: [['Pick a Theme', () => this._openPicker()], ['Settings', () => openSettings('welcome')]],
        }];
        return [...hints, ...this._notes()];
    }

    _notes() {
        const hints = [];
        if (this._settings.get_boolean('notification-bell')) {
            hints.push({
                id: 'bell',
                title: 'Notifications are under the bell',
                body: 'Super+V opens them too. Pop-ups show at the top right; the bell’s crossed-out button silences them.',
            });
        }
        if (this._settings.get_boolean('show-usage')) {
            const minutes = this._settings.get_int('usage-refresh-minutes');
            hints.push({
                id: 'usage',
                title: 'Your AI usage is in the top bar',
                body: `Claude Code and Codex limits, refreshed every ${minutes} minutes. Click it for the details.`,
            });
        }
        return hints;
    }

    _show() {
        const state = readJson(this._file) ?? {};
        const shown = new Set(state.shown ?? []);
        if (!shown.has('window') && GioUnix.DesktopAppInfo.new(APP_ID))
            openSettings('welcome');
        for (const hint of this._hints()) {
            if (shown.has(hint.id))
                continue;
            notify(hint.title, hint.body, hint.actions ?? []);
            shown.add(hint.id);
        }
        try {
            // Re-read: the app may have recorded "window" meanwhile.
            const now = new Set(readJson(this._file)?.shown ?? []);
            this._file.replace_contents(new TextEncoder().encode(JSON.stringify({shown: [...new Set([...now, ...shown])]})), null, false,
                Gio.FileCreateFlags.REPLACE_DESTINATION, null);
        } catch (e) {
            console.error(`Jade Shell: could not record the welcome: ${e.message}`);
        }
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
