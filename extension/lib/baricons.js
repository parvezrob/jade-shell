// The top bar's icons in one family, Jade's own (icons/bar, drawn by
// scripts/make-bar-icons.py), as Omarchy Quattro's bar draws everything from
// one glyph set: GNOME's status icons (volume, battery, power, Bluetooth…),
// the weather, and Jade's own. Every icon in the top bar that asks for a name
// the family has shows Jade's drawing of it instead, and keeps doing so as
// the name changes (a volume level, a battery charging). Icons the family
// doesn't have stay the icon theme's.
import Gio from 'gi://Gio';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

// Jade's own drawing of an icon for its menus, the Jade Menu and the
// screenshot card, or the icon theme's when the family has none by that name.
const FAMILY = Gio.File.new_for_uri(import.meta.url).get_parent().get_parent().get_child('icons').get_child('bar');
const drawn = new Map();

export function familyGicon(name) {
    if (!drawn.has(name)) {
        const file = FAMILY.get_child(`${name}.svg`);
        drawn.set(name, file.query_exists(null) ? new Gio.FileIcon({file}) : null);
    }
    return drawn.get(name) ?? new Gio.ThemedIcon({name});
}

// The name an icon in the bar asks for. Once Jade's drawing is swapped in,
// the icon's own icon-name is empty: code following another icon (Jade's
// network icon follows GNOME's hidden one) reads it here. A name set since
// wins (a handler can run before the swap for it).
export function askedIconName(icon) {
    return icon?.icon_name || icon?._jadeAsked || null;
}

export class BarIcons {
    constructor(extension) {
        this._dir = extension.dir.get_child('icons').get_child('bar');
    }

    enable() {
        this._files = new Map();  // name → Gio.FileIcon
        try {
            const children = this._dir.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
            for (let info; (info = children.next_file(null));) {
                const file = info.get_name();
                if (file.endsWith('.svg'))
                    this._files.set(file.slice(0, -4), new Gio.FileIcon({file: this._dir.get_child(file)}));
            }
        } catch (e) {
            console.error(`Jade Shell: no bar icons: ${e.message}`);
        }
        this._ours = new Set(this._files.values());
        this._originals = new Map();  // St.Icon → what it showed before
        this._watched = new Set();
        this._watch(Main.panel);
    }

    disable() {
        for (const actor of this._watched)
            actor.disconnectObject(this);
        this._watched.clear();
        this._swapping = true;
        for (const [icon, original] of this._originals) {
            delete icon._jadeAsked;
            if (original.gicon)
                icon.gicon = original.gicon;
            else
                icon.icon_name = original.iconName;
        }
        this._swapping = false;
        this._originals.clear();
        this._files = this._ours = null;
    }

    // Every actor in the bar, and those added later (an indicator that shows
    // up when a device appears, a Jade part turned on).
    _watch(actor) {
        if (this._watched.has(actor))
            return;
        this._watched.add(actor);
        actor.connectObject(
            'child-added', (_a, child) => this._watch(child),
            'destroy', () => {
                this._watched.delete(actor);
                this._originals.delete(actor);
            }, this);
        if (actor instanceof St.Icon) {
            actor.connectObject('notify::gicon', () => this._swap(actor), 'notify::icon-name', () => this._swap(actor), this);
            this._swap(actor);
        }
        for (const child of actor.get_children())
            this._watch(child);
    }

    // The name an icon asks for: a themed icon's names, its icon name, or a
    // file's name (Jade's own icons are files).
    _names(icon) {
        const {gicon} = icon;
        if (gicon instanceof Gio.ThemedIcon)
            return gicon.get_names();
        if (gicon instanceof Gio.FileIcon)
            return [gicon.get_file().get_basename().replace(/\.svg$/, '')];
        return icon.icon_name ? [icon.icon_name] : [];
    }

    _swap(icon) {
        if (this._swapping || !this._files || this._ours.has(icon.gicon))
            return;
        const name = this._names(icon).find(n => this._files.has(n));
        if (!name) {
            this._originals.delete(icon);  // a name we don't draw: the theme's, as set
            delete icon._jadeAsked;
            return;
        }
        this._originals.set(icon, {gicon: icon.gicon, iconName: icon.icon_name});
        icon._jadeAsked = this._names(icon)[0];
        this._swapping = true;
        icon.gicon = this._files.get(name);
        this._swapping = false;
    }
}
