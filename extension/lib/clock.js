// The top bar clock as the weekday and the time ("Tuesday 14:05"), 12- or
// 24-hour and with or without seconds as set in GNOME's Settings, or in a
// format of the user's own.
// Adapted from Panel Date Format (MIT; KEIII;
// https://github.com/KEIII/gnome-shell-panel-date-format): GNOME's clock
// label is hidden and a label of ours shows the same time in our format.
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

// GLib.DateTime specifiers that include seconds (%c too, in some locales).
const SECONDS_RE = /%[-_0OE]?[STsrXc]/;
const GNOME_KEYS = ['clock-format', 'clock-show-seconds'];

export class Clock {
    constructor(settings) {
        this._settings = settings;
    }

    enable() {
        const dateMenu = Main.panel.statusArea.dateMenu;
        this._display = dateMenu._clockDisplay;
        // The label fills the bar's height and centers its text, as GNOME's
        // does: the clock's highlight is drawn on the label.
        this._label = new St.Label({style_class: 'clock'});
        this._label.clutter_text.y_align = Clutter.ActorAlign.CENTER;
        this._label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        this._display.get_parent().insert_child_below(this._label, this._display);
        this._display.hide();
        this._clockChanged = dateMenu._clock.connect('notify::clock', () => this._tick());
        this._formatChanged = this._settings.connect('changed::clock-format', () => this._sync());
        this._interface = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        this._gnomeChanged = GNOME_KEYS.map(key => this._interface.connect(`changed::${key}`, () => this._sync()));
        this._sync();
    }

    // Also undoes an enable() that failed partway: GNOME's clock comes back first.
    disable() {
        this._stopSeconds();
        this._display?.show();
        this._label?.destroy();
        if (this._clockChanged)
            Main.panel.statusArea.dateMenu._clock.disconnect(this._clockChanged);
        if (this._formatChanged)
            this._settings.disconnect(this._formatChanged);
        this._gnomeChanged?.forEach(id => this._interface.disconnect(id));
        this._label = this._display = this._clockChanged = this._formatChanged = null;
        this._interface = this._gnomeChanged = null;
    }

    // GNOME's wall clock only ticks every minute unless its own seconds
    // setting is on, so a format with seconds gets a timer of its own.
    _sync() {
        this._stopSeconds();
        this._format = this._settings.get_string('clock-format') || this._gnomeFormat();
        if (SECONDS_RE.test(this._format))
            this._scheduleSecond();
        this._tick();
    }

    // No format of the user's own: the weekday, then the time as GNOME shows it.
    _gnomeFormat() {
        const seconds = this._interface.get_boolean('clock-show-seconds') ? ':%S' : '';
        return this._interface.get_string('clock-format') === '12h' ? `%A %-I:%M${seconds} %p` : `%A %H:%M${seconds}`;
    }

    _scheduleSecond() {
        // Wake just after the next whole second so the label never lags.
        const ms = 1000 - Math.floor(GLib.get_real_time() / 1000) % 1000;
        this._secondId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            this._secondId = 0;
            this._tick();
            this._scheduleSecond();
            return GLib.SOURCE_REMOVE;
        });
    }

    _stopSeconds() {
        if (this._secondId)
            GLib.source_remove(this._secondId);
        this._secondId = 0;
    }

    _tick() {
        this._label.text = GLib.DateTime.new_now_local().format(this._format) ?? '';
    }
}
