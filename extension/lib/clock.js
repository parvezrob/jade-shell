// The top bar clock in a chosen format ("Tuesday 14:05").
// Adapted from Panel Date Format (MIT; KEIII;
// https://github.com/KEIII/gnome-shell-panel-date-format): GNOME's clock
// label is hidden and a label of ours shows the same minute in our format.
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

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
        this._formatChanged = this._settings.connect('changed::clock-format', () => this._tick());
        this._tick();
    }

    disable() {
        Main.panel.statusArea.dateMenu._clock.disconnect(this._clockChanged);
        this._settings.disconnect(this._formatChanged);
        this._display.show();
        this._label.destroy();
        this._label = this._display = null;
    }

    _tick() {
        this._label.text = GLib.DateTime.new_now_local().format(this._settings.get_string('clock-format')) ?? '';
    }
}
