import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';
import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const TIMER = 'jade-usage.timer';

function run(argv) {
    return new Promise((resolve, reject) => {
        const proc = Gio.Subprocess.new(argv, Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE);
        proc.wait_check_async(null, (p, result) => {
            try {
                p.wait_check_finish(result);
                resolve();
            } catch (e) {
                reject(e);
            }
        });
    });
}

// A command's trimmed stdout, whatever its exit status (is-active exits 3
// for "inactive").
function output(argv) {
    return new Promise(resolve => {
        let proc;
        try {
            proc = Gio.Subprocess.new(argv, Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
        } catch (e) {
            console.error(e);
            resolve('');
            return;
        }
        proc.communicate_utf8_async(null, null, (p, result) => {
            try {
                resolve((p.communicate_utf8_finish(result)[1] ?? '').trim());
            } catch (e) {
                console.error(e);
                resolve('');
            }
        });
    });
}

function switchRow(settings, group, key, title, subtitle = null) {
    const row = new Adw.SwitchRow({title, subtitle});
    settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
    group.add(row);
    return row;
}

function spinRow(settings, group, key, title, subtitle, lower, upper) {
    const row = new Adw.SpinRow({
        title, subtitle, digits: 0,
        adjustment: new Gtk.Adjustment({lower, upper, step_increment: 1, page_increment: 4}),
    });
    settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
    group.add(row);
    return row;
}

export default class JadePreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window._settings = settings;

        const page = new Adw.PreferencesPage({title: 'Jade Shell', icon_name: 'preferences-desktop-appearance-symbolic'});
        window.add(page);

        const bar = new Adw.PreferencesGroup({title: 'Top bar'});
        page.add(bar);
        switchRow(settings, bar, 'show-workspaces', 'Workspaces', 'Numbered workspace buttons in place of Activities');
        switchRow(settings, bar, 'show-monitor', 'System monitor', 'An icon that opens CPU, memory, GPU and storage');
        switchRow(settings, bar, 'monitor-show-values', 'Monitor numbers in the top bar', 'Instead of the icon; measures every two seconds');
        switchRow(settings, bar, 'monitor-gpu', 'GPU usage', 'Paused while running on battery');
        switchRow(settings, bar, 'show-usage', 'AI usage', 'Claude and Codex limits');
        switchRow(settings, bar, 'show-picker', 'Theme picker icon', 'Super+Ctrl+Shift+Space opens it either way');
        switchRow(settings, bar, 'show-clock-format', 'Custom clock format');
        const clock = new Adw.EntryRow({title: 'Clock format (for example %A %H:%M)'});
        settings.bind('clock-format', clock, 'text', Gio.SettingsBindFlags.DEFAULT);
        settings.bind('show-clock-format', clock, 'sensitive', Gio.SettingsBindFlags.GET);
        bar.add(clock);

        const desktop = new Adw.PreferencesGroup({title: 'Desktop', description: 'Set a size to 0 to let GNOME choose.'});
        page.add(desktop);
        switchRow(settings, desktop, 'start-on-desktop', 'Start on the desktop', 'Skip the overview after logging in');
        switchRow(settings, desktop, 'notification-bell', 'Notification bell', 'Notifications in their own panel, pop-ups at the top right');
        switchRow(settings, desktop, 'simple-calendar', 'Simple calendar', 'Hide world clocks and weather in the clock’s menu');
        spinRow(settings, desktop, 'app-grid-columns', 'App grid columns', null, 0, 12);
        spinRow(settings, desktop, 'app-grid-rows', 'App grid rows', null, 0, 8);
        spinRow(settings, desktop, 'app-grid-icon-size', 'App grid icon size', 'In pixels', 0, 192);

        const usage = new Adw.PreferencesGroup({
            title: 'AI usage',
            description: 'Collected in the background while AI usage is on. Opening the menu also fetches current limits, and Refresh rescans everything.',
        });
        page.add(usage);
        settings.bind('show-usage', usage, 'sensitive', Gio.SettingsBindFlags.GET);
        switchRow(settings, usage, 'usage-show-percentages', 'Show percentages',
            'Each provider’s fullest limit, as percent used. Turn off for a single AI logo.');
        const interval = spinRow(settings, usage, 'usage-refresh-minutes', 'Refresh interval', 'Minutes', 1, 60);
        const status = new Adw.ActionRow({title: 'Background collector', subtitle: 'Checking…'});
        usage.add(status);
        this._showTimerState(settings, status);
        interval.connect('notify::value', () => this._scheduleTimerUpdate(settings, status));
        // Turning AI usage off also stops the collector, so nothing keeps
        // reading ~/.claude and ~/.codex or calling the providers.
        const usageChanged = settings.connect('changed::show-usage',
            () => this._setTimerEnabled(settings.get_boolean('show-usage'), status));
        window.connect('close-request', () => settings.disconnect(usageChanged));
    }

    // Only a state systemd reports; the installed interval may differ from
    // the setting until it is changed here.
    async _showTimerState(settings, status) {
        const state = await output(['systemctl', '--user', 'is-active', TIMER]);
        if (state === 'active')
            status.subtitle = 'Running in the background';
        else if (!settings.get_boolean('show-usage'))
            status.subtitle = 'Stopped while AI usage is off';
        else
            status.subtitle = 'Not running. Run: jade doctor';
    }

    async _setTimerEnabled(on, status) {
        try {
            await run(['systemctl', '--user', on ? 'enable' : 'disable', '--now', TIMER]);
            status.subtitle = on ? 'Running in the background' : 'Stopped while AI usage is off';
        } catch (e) {
            status.subtitle = 'Could not update the timer. Run: jade doctor';
            console.error(e);
        }
    }

    // Apply the interval to the systemd timer once the value settles.
    _scheduleTimerUpdate(settings, status) {
        if (this._timerSource)
            GLib.source_remove(this._timerSource);
        this._timerSource = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 800, () => {
            this._timerSource = null;
            this._applyTimer(settings.get_int('usage-refresh-minutes'), settings.get_boolean('show-usage'), status);
            return GLib.SOURCE_REMOVE;
        });
    }

    // While AI usage is off the timer stays stopped; enabling it later picks
    // up the new interval.
    async _applyTimer(minutes, running, status) {
        const dir = GLib.build_filenamev([GLib.get_user_config_dir(), 'systemd', 'user', `${TIMER}.d`]);
        const file = Gio.File.new_for_path(GLib.build_filenamev([dir, 'refresh-interval.conf']));
        try {
            GLib.mkdir_with_parents(dir, 0o700);
            file.replace_contents(`[Timer]\nOnUnitActiveSec=\nOnUnitActiveSec=${minutes}min\n`,
                null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
            await run(['systemctl', '--user', 'daemon-reload']);
            if (running) {
                await run(['systemctl', '--user', 'restart', TIMER]);
                status.subtitle = `Refreshing every ${minutes} minute${minutes === 1 ? '' : 's'}`;
            }
        } catch (e) {
            status.subtitle = 'Could not update the timer. Run: jade doctor';
            console.error(e);
        }
    }
}
