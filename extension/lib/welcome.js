import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {notify} from './notify.js';
import {stateDir} from './util.js';

// Long enough after login for the desktop to settle, so the first banner
// isn't lost among apps starting up.
const DELAY = 8;

// Show-once hints after setup: where the picker is, the bell, AI usage. Each
// is recorded in state/jade-shell/welcome.json once shown; one that could not
// be shown (the Shell restarted, say) comes at the next login instead.
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
        const hints = [{
            id: 'picker',
            title: 'Welcome to Jade Shell',
            body: shortcut ? `Pick a theme with ${shortcut}, or the palette icon in the top bar.`
                : 'Pick a theme from the palette icon in the top bar.',
            actions: [['Pick a Theme', () => this._openPicker()], ['Settings', () => this._extension.openPreferences()]],
        }];
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
        const shown = new Set(readJson(this._file)?.shown ?? []);
        for (const hint of this._hints()) {
            if (shown.has(hint.id))
                continue;
            notify(hint.title, hint.body, hint.actions ?? []);
            shown.add(hint.id);
        }
        try {
            this._file.replace_contents(new TextEncoder().encode(JSON.stringify({shown: [...shown]})), null, false,
                Gio.FileCreateFlags.REPLACE_DESTINATION, null);
        } catch (e) {
            console.error(`Jade Shell: could not record the welcome: ${e.message}`);
        }
    }
}

// '<Super><Control><Shift>space' as people write it: 'Super+Ctrl+Shift+Space'.
function shortcutText(accel) {
    if (!accel)
        return null;
    const names = {super: 'Super', control: 'Ctrl', primary: 'Ctrl', ctrl: 'Ctrl', alt: 'Alt', shift: 'Shift'};
    const order = ['Super', 'Ctrl', 'Alt', 'Shift'];
    const mods = [...new Set([...accel.matchAll(/<(\w+)>/g)].map(m => names[m[1].toLowerCase()] ?? m[1]))]
        .sort((a, b) => order.indexOf(a) - order.indexOf(b));
    const key = accel.replace(/<\w+>/g, '');
    return [...mods, key.length === 1 ? key.toUpperCase() : key[0].toUpperCase() + key.slice(1)].join('+');
}

function readJson(file) {
    try {
        const [, bytes] = file.load_contents(null);
        return JSON.parse(new TextDecoder().decode(bytes));
    } catch {
        return null;
    }
}
