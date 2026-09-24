// The weather in the top bar: its icon and temperature, and in its menu the
// place, the conditions and the next hours. Jade fetches it itself, through
// GWeather (MET Norway, METAR, OpenWeatherMap: what GNOME uses), for the
// place chosen in the Jade Shell app. GNOME's own weather needs the GNOME
// Weather app, which Ubuntu doesn't ship. Until a place is chosen it uses
// GNOME's place when there is one, and stays out of sight while there's no
// place or no forecast.
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GWeather from 'gi://GWeather';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';

import {clockTime, openSettings, VERTICAL} from './util.js';

const HOURS = 5;
const REFRESH_MINUTES = 30;
const PROVIDERS = GWeather.Provider.METAR | GWeather.Provider.MET_NO | GWeather.Provider.OWM;

const UNITS = {default: GWeather.TemperatureUnit.DEFAULT, celsius: GWeather.TemperatureUnit.CENTIGRADE,
    fahrenheit: GWeather.TemperatureUnit.FAHRENHEIT};
let unit = GWeather.TemperatureUnit.DEFAULT;

function temperature(info) {
    const [ok, value] = info.get_value_temp(unit);
    return ok ? `${Math.round(value)}°` : '';
}

// The next few forecasts, at least an hour apart.
function nextHours(info) {
    const now = GLib.DateTime.new_now_local();
    const out = [];
    let last = null;
    for (const forecast of info.get_forecast_list()) {
        const [valid, stamp] = forecast.get_value_update();
        if (!valid || !stamp)
            continue;
        const time = GLib.DateTime.new_from_unix_local(stamp);
        if (now.difference(time) > 0 || (last && time.difference(last) < GLib.TIME_SPAN_HOUR))
            continue;
        out.push({time, forecast});
        last = time;
        if (out.length === HOURS)
            break;
    }
    return out;
}

// A station's nearest city, as the clock menu names it ("Dhaka", not the airport).
function placeName(location) {
    if (!location)
        return '';
    if (location.get_level() === GWeather.LocationLevel.CITY || !location.has_coords())
        return location.get_name();
    // GNOME's rule: the city only where the place's own name mentions it.
    const city = GWeather.Location.get_world().find_nearest_city(...location.get_coords())?.get_name();
    return city && location.get_name().includes(city) ? city : location.get_name();
}

export class Weather {
    constructor(settings) {
        this._settings = settings;
    }

    enable() {
        this._info = new GWeather.Info({
            application_id: 'io.github.parvezrob.JadeShell',
            contact_info: 'https://github.com/parvezrob/jade-shell',
            enabled_providers: PROVIDERS,
        });
        this._updated = this._info.connect_after('updated', () => {
            this._loading = false;
            this._fetched = GLib.get_monotonic_time();
            this._sync();
        });

        this._button = new PanelMenu.Button(0.5, 'Weather');
        this._button.add_style_class_name('jade-weather');
        const chip = new St.BoxLayout({style_class: 'jade-weather-chip', y_align: Clutter.ActorAlign.CENTER});
        this._icon = new St.Icon({style_class: 'system-status-icon', icon_name: 'weather-clear-symbolic'});
        this._temp = new St.Label({style_class: 'jade-weather-temp', y_align: Clutter.ActorAlign.CENTER});
        chip.add_child(this._icon);
        chip.add_child(this._temp);
        this._button.add_child(chip);
        this._button.visible = false;

        const menu = this._button.menu;
        menu.box.add_style_class_name('jade-frame');
        menu.box.add_style_class_name('jade-weather-menu');
        this._place = new St.Label({style_class: 'jade-weather-place'});
        this._now = new St.Label({style_class: 'jade-weather-now'});
        this._hours = new St.BoxLayout({style_class: 'jade-weather-hours'});
        const change = new St.Button({style_class: 'jade-weather-open', label: 'Change Place…', can_focus: true});
        change.connect('clicked', () => {
            menu.close();
            openSettings('desktop');
        });
        for (const actor of [this._place, this._now, this._hours, change])
            menu.box.add_child(actor);
        menu.connect('open-state-changed', (_m, isOpen) => {
            // Fresh enough for a glance; older than ten minutes, fetch again.
            if (isOpen && GLib.get_monotonic_time() - (this._fetched ?? 0) > 10 * 60 * GLib.USEC_PER_SEC)
                this._update();
        });

        // Beside the clock, as Omarchy Quattro's bar has it. The clock stays in
        // the middle of the screen: an empty twin as wide as the weather sits
        // on its other side.
        const center = Main.panel._centerBox;
        const clock = Main.panel.statusArea.dateMenu?.container;
        this._balance = new St.Widget({reactive: false, opacity: 0});
        const at = clock && center.get_children().includes(clock) ? center.get_children().indexOf(clock) : 0;
        center.insert_child_at_index(this._balance, at);
        Main.panel.addToStatusArea('jade-weather', this._button, at + 2, 'center');
        this._button.container.connectObject('notify::width', () => this._syncBalance(), this);
        this._button.connectObject('notify::visible', () => this._syncBalance(), this);
        this._syncBalance();
        // The hours as the clock shows them: 2 PM, or 14:00.
        this._interface = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        this._interface.connectObject('changed::clock-format', () => this._sync(), this);
        this._settings.connectObject('changed::weather-location', () => this._locate(),
            'changed::weather-unit', () => {
                unit = UNITS[this._settings.get_string('weather-unit')] ?? GWeather.TemperatureUnit.DEFAULT;
                this._sync();
            }, this);
        unit = UNITS[this._settings.get_string('weather-unit')] ?? GWeather.TemperatureUnit.DEFAULT;
        // GNOME's place, for as long as Jade has none of its own.
        this._client = Main.panel.statusArea.dateMenu._weatherItem?._weatherClient ?? null;
        this._client?.connectObject('changed', () => {
            if (!this._own())
                this._locate();
        }, this);
        this._timer = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, REFRESH_MINUTES * 60, () => {
            this._update();
            return GLib.SOURCE_CONTINUE;
        });
        this._locate();
    }

    disable() {
        if (this._timer)
            GLib.source_remove(this._timer);
        this._timer = 0;
        this._settings.disconnectObject(this);
        this._interface?.disconnectObject(this);
        this._client?.disconnectObject(this);
        if (this._updated)
            this._info.disconnect(this._updated);
        this._updated = 0;
        this._info?.abort();
        this._button?.container.disconnectObject(this);
        this._button?.disconnectObject(this);
        this._button?.destroy();
        this._balance?.destroy();
        this._button = this._client = this._info = this._interface = this._balance = null;
    }

    _syncBalance() {
        this._balance.width = this._button.visible ? this._button.container.width : 0;
    }

    // The place Jade was given, if any.
    _own() {
        const [name, latitude, longitude] = this._settings.get_value('weather-location').deepUnpack();
        return name ? GWeather.Location.new_detached(name, null, latitude, longitude) : null;
    }

    _locate() {
        const location = this._own() ?? (this._client?.hasLocation ? this._client.info?.location : null) ?? null;
        const key = location ? `${location.get_name()}:${location.get_coords?.().join(',')}` : null;
        if (key === this._key)
            return;
        this._key = key;
        this._shown = false;
        // The last place's requests would otherwise answer for the new one.
        this._info.abort();
        this._loading = false;
        this._fetched = 0;
        this._button.visible = false;
        if (!location)
            return;
        this._info.set_location(location);
        this._update();
    }

    _update() {
        if (!this._key)
            return;
        this._loading = true;
        this._info.update();
    }

    _sync() {
        const info = this._info;
        const ready = this._key && !this._loading && info.is_valid();
        // While loading, keep what was shown; hide only when there is nothing to show.
        if (!ready) {
            if (!this._loading || !this._shown)
                this._button.visible = false;
            return;
        }
        this._shown = true;
        this._button.visible = true;
        this._icon.icon_name = info.get_symbolic_icon_name();
        this._temp.text = temperature(info);
        this._place.text = placeName(info.location).toUpperCase();
        this._now.text = [info.get_sky(), temperature(info)].filter(Boolean).join(' · ');
        this._hours.destroy_all_children();
        for (const {time, forecast} of nextHours(info)) {
            const hour = new St.BoxLayout({orientation: VERTICAL, style_class: 'jade-weather-hour'});
            hour.add_child(new St.Label({text: clockTime(time, {hourOnly: true}), style_class: 'jade-weather-hour-time',
                x_align: Clutter.ActorAlign.CENTER}));
            hour.add_child(new St.Icon({icon_name: forecast.get_symbolic_icon_name(), style_class: 'jade-weather-hour-icon',
                x_align: Clutter.ActorAlign.CENTER}));
            hour.add_child(new St.Label({text: temperature(forecast), style_class: 'jade-weather-hour-temp',
                x_align: Clutter.ActorAlign.CENTER}));
            this._hours.add_child(hour);
        }
    }
}
