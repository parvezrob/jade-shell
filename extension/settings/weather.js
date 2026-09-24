// The weather's place: search GWeather's cities (the same list GNOME Weather
// uses), pick one, and the top bar's weather follows it. Stored as Jade's own
// setting, weather-location: name, latitude, longitude.
import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GWeather from 'gi://GWeather?version=4.0';
import Gtk from 'gi://Gtk';

import {choiceRow} from './common.js';

const RESULTS = 6;

let cities = null;

// Every city in GWeather's world, once (about 4,300; a few tens of ms).
function allCities() {
    if (cities)
        return cities;
    cities = [];
    const walk = location => {
        for (let child = location.next_child(null); child; child = location.next_child(child)) {
            if (child.get_level() !== GWeather.LocationLevel.CITY) {
                walk(child);
                continue;
            }
            cities.push({name: child.get_name(), country: child.get_country_name() ?? '', coords: child.get_coords()});
        }
    };
    walk(GWeather.Location.get_world());
    return cities;
}

// Cities whose name starts with the text first, then ones that contain it.
export function searchCities(text) {
    const query = text.trim().toLowerCase();
    if (query.length < 2)
        return [];
    const all = allCities();
    const starts = all.filter(city => city.name.toLowerCase().startsWith(query));
    const contains = all.filter(city => !city.name.toLowerCase().startsWith(query) &&
        `${city.name} ${city.country}`.toLowerCase().includes(query));
    return [...starts, ...contains].slice(0, RESULTS);
}

// GNOME's own weather place, if it has one (what Jade shows until one is picked here).
function gnomePlace() {
    try {
        const settings = new Gio.Settings({schema_id: 'org.gnome.shell.weather'});
        const [first] = settings.get_value('locations').deepUnpack();
        return first ? GWeather.Location.get_world().deserialize(first)?.get_name() ?? null : null;
    } catch {
        return null;
    }
}

export function weatherGroup(settings, {title = 'Weather', description = null} = {}) {
    const group = new Adw.PreferencesGroup({title, description});
    const place = new Adw.ActionRow({title: 'Place'});
    const clear = new Gtk.Button({icon_name: 'edit-clear-symbolic', valign: Gtk.Align.CENTER, tooltip_text: 'Forget this place',
        css_classes: ['flat']});
    place.add_suffix(clear);
    group.add(place);
    const search = new Adw.EntryRow({title: 'Search for a city'});
    group.add(search);
    const unit = choiceRow(settings, 'weather-unit',
        [['default', 'Automatic (from your language)'], ['celsius', 'Celsius (°C)'], ['fahrenheit', 'Fahrenheit (°F)']],
        {title: 'Units'});
    group.add(unit);
    let rows = [];

    const sync = () => {
        const [name] = settings.get_value('weather-location').deepUnpack();
        const gnome = name ? null : gnomePlace();
        place.subtitle = name ? `${name}, in the top bar` : gnome ? `${gnome} (from GNOME Weather)`
            : 'None yet: the weather shows in the top bar once you pick a city';
        clear.visible = Boolean(name);
    };
    const showResults = () => {
        rows.forEach(row => group.remove(row));
        rows = searchCities(search.text).map(city => {
            const row = new Adw.ActionRow({title: city.name, subtitle: city.country, activatable: true});
            row.add_suffix(new Gtk.Image({icon_name: 'go-next-symbolic'}));
            row.connect('activated', () => {
                settings.set_value('weather-location', new GLib.Variant('(sdd)', [city.name, ...city.coords]));
                search.text = '';
            });
            group.add(row);
            return row;
        });
        // Keep the units row last, under the results.
        group.remove(unit);
        group.add(unit);
    };
    let pending = 0;
    search.connect('changed', () => {
        if (pending)
            GLib.source_remove(pending);
        pending = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => {
            pending = 0;
            showResults();
            return GLib.SOURCE_REMOVE;
        });
    });
    clear.connect('clicked', () => settings.reset('weather-location'));
    const changed = settings.connect('changed::weather-location', sync);
    group.connect('destroy', () => {
        settings.disconnect(changed);
        if (pending)
            GLib.source_remove(pending);
    });
    sync();
    return group;
}
