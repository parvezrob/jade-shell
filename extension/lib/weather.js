// The weather in the top bar: its icon and temperature, and in its menu the
// place, the conditions and the next hours. It follows GNOME Weather's
// location (or the automatic one) through GNOME's own weather client, the
// one behind the clock menu's weather (which Jade's simple calendar hides),
// and stays out of sight while there's no location or no forecast.
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GWeather from 'gi://GWeather';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';

import {addToPanel, VERTICAL} from './util.js';

const HOURS = 5;

function temperature(info) {
    const [ok, value] = info.get_value_temp(GWeather.TemperatureUnit.DEFAULT);
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
        this._client = Main.panel.statusArea.dateMenu._weatherItem?._weatherClient ?? null;
        if (!this._client)
            throw new Error("GNOME's weather client is not where Jade Shell expects it");
        this._button = new PanelMenu.Button(0.5, 'Weather');
        this._button.add_style_class_name('jade-weather');
        const chip = new St.BoxLayout({style_class: 'jade-weather-chip', y_align: Clutter.ActorAlign.CENTER});
        this._icon = new St.Icon({style_class: 'system-status-icon', icon_name: 'weather-clear-symbolic'});
        this._temp = new St.Label({style_class: 'jade-weather-temp', y_align: Clutter.ActorAlign.CENTER});
        chip.add_child(this._icon);
        chip.add_child(this._temp);
        this._button.add_child(chip);

        const menu = this._button.menu;
        menu.box.add_style_class_name('jade-frame');
        menu.box.add_style_class_name('jade-weather-menu');
        this._place = new St.Label({style_class: 'jade-weather-place'});
        this._now = new St.Label({style_class: 'jade-weather-now'});
        this._hours = new St.BoxLayout({style_class: 'jade-weather-hours'});
        const open = new St.Button({style_class: 'jade-weather-open', label: 'Open Weather', can_focus: true});
        open.connect('clicked', () => {
            menu.close();
            this._client.activateApp();
        });
        for (const actor of [this._place, this._now, this._hours, open])
            menu.box.add_child(actor);
        menu.connect('open-state-changed', (_m, isOpen) => {
            if (isOpen)
                this._client.update();
        });

        addToPanel('jade-weather', this._button);
        this._changed = this._client.connect('changed', () => this._sync());
        this._client.update();
        this._sync();
    }

    disable() {
        if (this._changed)
            this._client.disconnect(this._changed);
        this._changed = 0;
        this._button?.destroy();
        this._button = this._client = null;
    }

    _sync() {
        const client = this._client;
        const info = client.info;
        const ready = client.available && client.hasLocation && !client.loading && info?.is_valid();
        // While loading, keep what was shown; hide only when there is nothing to show.
        if (!ready) {
            if (!client.loading || !this._shown)
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
            hour.add_child(new St.Label({text: time.format('%H:%M'), style_class: 'jade-weather-hour-time',
                x_align: Clutter.ActorAlign.CENTER}));
            hour.add_child(new St.Icon({icon_name: forecast.get_symbolic_icon_name(), style_class: 'jade-weather-hour-icon',
                x_align: Clutter.ActorAlign.CENTER}));
            hour.add_child(new St.Label({text: temperature(forecast), style_class: 'jade-weather-hour-temp',
                x_align: Clutter.ActorAlign.CENTER}));
            this._hours.add_child(hour);
        }
    }
}
