// The top bar clock in a chosen format ("Tuesday 14:05").
// Adapted from Panel Date Format (MIT; KEIII;
// https://github.com/KEIII/gnome-shell-panel-date-format): GNOME's clock
// label is hidden and a label of ours shows the same time in our format.
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

// GLib.DateTime specifiers that include seconds (%c too, in some locales).
const SECONDS_RE = /%[-_0OE]?[STsrXc]/;

export class Clock {
    constructor(settings) {
        this._settings = settings;
    }

    enable() {
        const dateMenu = Main.panel.statusArea.dateMenu;
        this._display = dateMenu._clockDisplay;
        this._label = new St.Label({style_class: 'clock', y_align: Clutter.ActorAlign.CENTER});
        this._label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        this._display.get_parent().insert_child_below(this._label, this._display);
        this._display.hide();
        this._clockChanged = dateMenu._clock.connect('notify::clock', () => this._tick());
        this._formatChanged = this._settings.connect('changed::clock-format', () => this._sync());
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
        this._label = this._display = this._clockChanged = this._formatChanged = null;
    }

    // GNOME's wall clock only ticks every minute unless its own seconds
    // setting is on, so a format with seconds gets a timer of its own.
    _sync() {
        this._stopSeconds();
        if (SECONDS_RE.test(this._settings.get_string('clock-format')))
            this._scheduleSecond();
        this._tick();
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
        this._label.text = GLib.DateTime.new_now_local().format(this._settings.get_string('clock-format')) ?? '';
    }
}
