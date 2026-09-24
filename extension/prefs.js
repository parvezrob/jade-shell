import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';
import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {aboutPage} from './settings/about.js';
import {dockPage} from './settings/dock.js';
import {jadeCommand, output, run} from './settings/common.js';
import {hero} from './settings/hero.js';
import {ShortcutRow} from './settings/shortcut.js';
import {applyStyle, capsTitles} from './settings/style.js';

const TIMER = 'jade-usage.timer';

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

        const page = new Adw.PreferencesPage({title: 'Desktop', icon_name: 'preferences-desktop-appearance-symbolic'});
        window.add(page);
        const top = hero(this.metadata['version-name'] ?? null);
        page.add(top.group);

        const bar = new Adw.PreferencesGroup({title: 'Top bar'});
        page.add(bar);
        switchRow(settings, bar, 'show-workspaces', 'Workspaces', 'Numbered workspace buttons in place of Activities');
        switchRow(settings, bar, 'show-monitor', 'System monitor', 'An icon that opens CPU, memory, GPU and storage');
        switchRow(settings, bar, 'monitor-show-values', 'Monitor numbers in the top bar', 'Instead of the icon; measures every two seconds');
        switchRow(settings, bar, 'monitor-gpu', 'GPU usage', 'Paused while running on battery');
        switchRow(settings, bar, 'show-picker', 'Theme picker icon', 'The shortcut opens it either way');
        switchRow(settings, bar, 'show-clock-format', 'Custom clock format');
        const clock = new Adw.EntryRow({title: 'Clock format (empty: weekday and time, as GNOME’s Settings say)'});
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

        const keyboard = new Adw.PreferencesGroup({title: 'Keyboard'});
        page.add(keyboard);
        keyboard.add(new ShortcutRow(settings, 'toggle-picker', 'Open the theme picker'));

        const apps = new Adw.PreferencesGroup({
            title: 'Apps',
            description: 'Themed along with the desktop. Turn one off to leave it alone: its own config comes back, and theme switches pass it by.',
        });
        page.add(apps);
        this._fillApps(apps);

        window.add(dockPage(settings, switchRow));

        // Jade Shell's own icons (the AI usage mark) for the page tabs.
        Gtk.IconTheme.get_for_display(Gdk.Display.get_default()).add_search_path(this.dir.get_child('icons').get_path());
        const usagePage = new Adw.PreferencesPage({title: 'AI Usage', icon_name: 'ai-usage-symbolic'});
        window.add(usagePage);
        const usage = new Adw.PreferencesGroup({
            title: 'Collection',
            description: 'Collected in the background while AI usage is on. Opening the menu also fetches current limits, and Refresh rescans everything.',
        });
        const usageSwitch = new Adw.PreferencesGroup();
        usagePage.add(usageSwitch);
        switchRow(settings, usageSwitch, 'show-usage', 'AI usage in the top bar', 'Claude and Codex limits');
        usagePage.add(usage);
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

        window.add(aboutPage(settings, this.metadata, switchRow));
        window.set_default_size(720, 860);
        capsTitles(window);
        applyStyle(window, top.update);
    }

    // One switch per app `jade apps` knows, which also does the work: putting
    // an app's own config back, or theming it again.
    async _fillApps(group) {
        const jade = jadeCommand();
        let apps = null;
        try {
            apps = JSON.parse(jade ? await output([jade, 'apps', 'list', '--json']) : '');
        } catch {}
        if (!Array.isArray(apps)) {
            group.add(new Adw.ActionRow({title: 'Could not list the apps', subtitle: 'Run: jade doctor'}));
            return;
        }
        for (const app of apps) {
            const state = on => on ? app.note ?? 'Themed' : 'Left alone';
            const row = new Adw.SwitchRow({title: app.label, subtitle: state(!app.left_alone), active: !app.left_alone});
            let reverting = false;
            row.connect('notify::active', async () => {
                if (reverting)
                    return;
                const on = row.active;
                row.sensitive = false;
                row.subtitle = on ? 'Applying the theme…' : 'Putting back its own config…';
                try {
                    await run([jade, 'apps', on ? 'on' : 'off', app.name]);
                    row.subtitle = state(on);
                } catch (e) {
                    // Nothing changed: the switch goes back to how things are.
                    reverting = true;
                    row.active = !on;
                    reverting = false;
                    row.subtitle = `Did not work. Try: jade apps ${on ? 'on' : 'off'} ${app.name}`;
                    console.error(e);
                }
                row.sensitive = true;
            });
            group.add(row);
        }
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
