// Modes that are easy to forget are on, shown in the top bar only while on,
// as Omarchy shows them: stay awake, night light, and Do Not Disturb when
// the bell (which shows it itself) is off. A click turns a mode off; a
// shortcut, on Omarchy's keys, toggles it. GNOME shows screen recording
// itself, with its own stop button.
//
// Stay awake holds GNOME's session inhibitor, as the Caffeine extension
// does, for as long as this session: it is never left on after a restart.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import {QuickToggle, SystemIndicator} from 'resource:///org/gnome/shell/ui/quickSettings.js';

import {addToPanel} from './util.js';

const INHIBIT_IDLE = 8;
const INHIBIT_SUSPEND = 4;
const COLOR = 'org.gnome.settings-daemon.plugins.color';

const AwakeToggle = GObject.registerClass(
class JadeAwakeToggle extends QuickToggle {
    _init(gicon) {
        super._init({title: 'Stay Awake', subtitle: 'No sleep or lock', gicon, toggleMode: true});
    }
});

const AwakeIndicator = GObject.registerClass(
class JadeAwakeIndicator extends SystemIndicator {
    _init(gicon) {
        super._init();
        this.toggle = new AwakeToggle(gicon);
        this.quickSettingsItems.push(this.toggle);
    }
});

export class Modes {
    constructor(extension, settings) {
        this._extension = extension;
        this._settings = settings;
    }

    enable() {
        const icon = name => new Gio.FileIcon({file: this._extension.dir.get_child('icons').get_child(name)});
        this._awakeIcon = icon('awake-symbolic.svg');
        this._button = new PanelMenu.Button(0.5, 'Modes', true);
        this._button.add_style_class_name('jade-modes');
        this._box = new St.BoxLayout({style_class: 'jade-modes-box'});
        this._button.add_child(this._box);
        this._icons = {
            awake: this._icon(this._awakeIcon, 'Stay awake is on: click to let the screen sleep again',
                () => this.setAwake(false)),
            night: this._icon(new Gio.ThemedIcon({name: 'night-light-symbolic'}), 'Night light is on: click to turn it off',
                () => this._color.set_boolean('night-light-enabled', false)),
            dnd: this._icon(icon('bell-off-symbolic.svg'), 'Do Not Disturb is on: click to turn it off',
                () => this._notifications.set_boolean('show-banners', true)),
        };
        addToPanel('jade-modes', this._button);

        // Stay awake, also in Quick Settings.
        this._quick = new AwakeIndicator(this._awakeIcon);
        this._quick.toggle.connect('clicked', () => this.setAwake(this._quick.toggle.checked));
        Main.panel.statusArea.quickSettings.addExternalIndicator(this._quick);

        // Night light: GNOME's indicator shows it too, but can't be clicked.
        this._color = new Gio.Settings({schema_id: COLOR});
        Gio.DBusProxy.new_for_bus(Gio.BusType.SESSION, Gio.DBusProxyFlags.DO_NOT_AUTO_START, null,
            'org.gnome.SettingsDaemon.Color', '/org/gnome/SettingsDaemon/Color', 'org.gnome.SettingsDaemon.Color', null,
            (_o, result) => {
                try {
                    const proxy = Gio.DBusProxy.new_for_bus_finish(result);
                    if (!this._button)  // disabled meanwhile
                        return;
                    this._colorProxy = proxy;
                    proxy.connectObject('g-properties-changed', () => this._sync(), this);
                    this._sync();
                } catch (e) {
                    console.error(`Jade Shell: no night light status: ${e.message}`);
                }
            });
        this._quietGnomeIcons();

        this._notifications = new Gio.Settings({schema_id: 'org.gnome.desktop.notifications'});
        this._notifications.connectObject('changed::show-banners', () => this._sync(), this);
        this._settings.connectObject('changed::notification-bell', () => this._sync(), this);

        Main.wm.addKeybinding('toggle-stay-awake', this._settings, Meta.KeyBindingFlags.NONE,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW, () => this.setAwake(!this._cookie && !this._inhibiting));
        Main.wm.addKeybinding('toggle-night-light', this._settings, Meta.KeyBindingFlags.NONE,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
            () => this._color.set_boolean('night-light-enabled', !this._color.get_boolean('night-light-enabled')));
        this._keys = true;
        this._sync();
    }

    disable() {
        if (this._keys) {
            Main.wm.removeKeybinding('toggle-stay-awake');
            Main.wm.removeKeybinding('toggle-night-light');
            this._keys = false;
        }
        this.setAwake(false);
        if (this._waitId)
            GLib.source_remove(this._waitId);
        this._waitId = 0;
        if (this._gnomeNightSync) {
            this._gnomeNight._sync = this._gnomeNightSync;
            this._gnomeNight._sync();
        }
        this._gnomeNight = this._gnomeNightSync = null;
        if (this._gnomeDnd) {
            this._gnomeDnd.disconnectObject(this);
            this._gnomeDnd.visible = !this._notifications.get_boolean('show-banners');
            this._gnomeDnd = null;
        }
        this._colorProxy?.disconnectObject(this);
        this._notifications?.disconnectObject(this);
        this._settings.disconnectObject(this);
        this._quick?.quickSettingsItems.forEach(item => item.destroy());
        this._quick?.destroy();
        this._button?.destroy();
        this._button = this._box = this._icons = this._quick = this._colorProxy = this._notifications = null;
    }

    // GNOME's own night light and Do Not Disturb icons, which can't be
    // clicked, give way to these (the bell shows Do Not Disturb itself).
    // Quick Settings builds them a moment after startup: wait for them.
    _quietGnomeIcons(tries = 40) {
        const quick = Main.panel.statusArea.quickSettings;
        if (!quick._nightLight || !quick._doNotDisturb) {
            if (tries > 0) {
                this._waitId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
                    this._waitId = 0;
                    this._quietGnomeIcons(tries - 1);
                    return GLib.SOURCE_REMOVE;
                });
            }
            return;
        }
        this._gnomeNight = quick._nightLight;
        if (this._gnomeNight._sync) {
            this._gnomeNightSync = this._gnomeNight._sync;
            this._gnomeNight._sync = () => {
                this._gnomeNight._indicator.visible = false;
            };
            this._gnomeNight._sync();
        }
        this._gnomeDnd = quick._doNotDisturb._indicator ?? null;
        this._gnomeDnd?.connectObject('notify::visible', () => this._gnomeDnd.visible && this._gnomeDnd.hide(), this);
        this._gnomeDnd?.hide();
    }

    _icon(gicon, accessibleName, turnOff) {
        const button = new St.Button({
            style_class: 'jade-mode', can_focus: true, accessible_name: accessibleName, visible: false,
            child: new St.Icon({gicon, style_class: 'system-status-icon'}),
        });
        button.connect('clicked', turnOff);
        this._box.add_child(button);
        return button;
    }

    get awake() {
        return Boolean(this._cookie) || Boolean(this._inhibiting);
    }

    // Hold (or let go of) GNOME's inhibitor for idling and suspend.
    setAwake(on) {
        this._wantAwake = on;  // what the answer to a pending Inhibit should find
        if (on && !this.awake) {
            this._inhibiting = true;
            Gio.DBus.session.call('org.gnome.SessionManager', '/org/gnome/SessionManager', 'org.gnome.SessionManager',
                'Inhibit', new GLib.Variant('(susu)', ['jade-shell', 0, 'Stay awake is on', INHIBIT_IDLE | INHIBIT_SUSPEND]),
                new GLib.VariantType('(u)'), Gio.DBusCallFlags.NONE, -1, null, (bus, result) => {
                    this._inhibiting = false;
                    try {
                        [this._cookie] = bus.call_finish(result).deepUnpack();
                    } catch (e) {
                        console.error(`Jade Shell: could not keep the screen awake: ${e.message}`);
                    }
                    // Turned off (or disabled) while GNOME was answering.
                    if (!this._button || !this._wantAwake)
                        this.setAwake(false);
                    this._sync();
                });
        } else if (!on && this._cookie) {
            Gio.DBus.session.call('org.gnome.SessionManager', '/org/gnome/SessionManager', 'org.gnome.SessionManager',
                'Uninhibit', new GLib.Variant('(u)', [this._cookie]), null, Gio.DBusCallFlags.NONE, -1, null, null);
            this._cookie = 0;
        }
        this._sync();
    }

    _sync() {
        if (!this._icons)
            return;
        this._icons.awake.visible = Boolean(this._cookie);
        if (this._quick)
            this._quick.toggle.checked = this.awake;
        this._icons.night.visible = Boolean(this._colorProxy?.get_cached_property('NightLightActive')?.unpack());
        this._icons.dnd.visible = !this._settings.get_boolean('notification-bell') &&
            !this._notifications.get_boolean('show-banners');
        this._button.visible = Object.values(this._icons).some(icon => icon.visible);
    }
}
