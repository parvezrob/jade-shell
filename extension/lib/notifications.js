// Notifications in a panel of their own behind a bell, the way Omarchy's
// notification center has them; the clock's menu keeps the calendar.
//
// GNOME's own message list moves here rather than a second copy being made:
// grouping, media players, "seen once shown" and hiding on the lock screen
// all keep working. Pop-ups move to the top right, under the bell, so GNOME
// holds them back while the panel is open. disable() puts everything back.
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';

import {addToPanel, label} from './util.js';

const BELL = 'preferences-system-notifications-symbolic';
const BELL_OFF = 'notifications-disabled-symbolic';

// Where GNOME puts pop-ups: on the clock's side of the top bar.
function gnomeBannerAlignment() {
    const {left, right} = Main.sessionMode.panel;
    if (left.includes('dateMenu'))
        return Clutter.ActorAlign.START;
    if (right.includes('dateMenu'))
        return Clutter.ActorAlign.END;
    return Clutter.ActorAlign.CENTER;
}

export class Notifications {
    enable() {
        const dateMenu = Main.panel.statusArea.dateMenu;
        this._list = dateMenu._messageList;
        this._view = this._list._messageView;
        this._settings = new Gio.Settings({schema_id: 'org.gnome.desktop.notifications'});
        this._build();

        // The list, without GNOME's Clear row: the header has one.
        this._listHome = this._list.get_parent();
        this._listHome.remove_child(this._list);
        this._button.menu.box.add_child(this._list);
        this._controls = this._list._clearButton.get_parent();
        this._controls.hide();
        dateMenu.menu.box.add_style_class_name('jade-calendar-only');

        // The unread dot moves from the clock to the bell. GNOME keeps
        // counting on its indicator; the bell shows what it says. The pad
        // before the clock keeps the time centered against the dot.
        this._unread = dateMenu._indicator;
        this._clockBox = this._unread.get_parent();
        const pad = this._clockBox.get_first_child();
        if (pad !== this._unread && !(pad instanceof St.Label)) {
            this._unreadPad = pad;
            this._clockBox.remove_child(pad);
        }
        this._clockBox.remove_child(this._unread);
        this._unreadChanged = this._unread.connect('notify::visible', () => this._sync());
        this._dndChanged = this._settings.connect('changed::show-banners', () => this._sync());
        this._sync();

        // Super+V, and whatever closes "the calendar" after activating a
        // notification, now mean the bell's panel.
        Main.panel.toggleCalendar = () => Main.panel._toggleMenu(this._button);
        Main.panel.closeCalendar = () => {
            Main.panel._closeMenu(dateMenu);
            Main.panel._closeMenu(this._button);
        };

        // GNOME sets the alignment again whenever the session mode changes.
        Main.messageTray.bannerAlignment = Clutter.ActorAlign.END;
        this._sessionChanged = Main.sessionMode.connect('updated', () => {
            Main.messageTray.bannerAlignment = Clutter.ActorAlign.END;
        });
    }

    // Also undoes an enable() that failed partway.
    disable() {
        const dateMenu = Main.panel.statusArea.dateMenu;
        if (this._sessionChanged)
            Main.sessionMode.disconnect(this._sessionChanged);
        Main.messageTray.bannerAlignment = gnomeBannerAlignment();
        delete Main.panel.toggleCalendar;
        delete Main.panel.closeCalendar;

        if (this._unreadChanged)
            this._unread.disconnect(this._unreadChanged);
        if (this._dndChanged)
            this._settings.disconnect(this._dndChanged);
        if (this._unreadPad && !this._unreadPad.get_parent())
            this._clockBox.insert_child_at_index(this._unreadPad, 0);
        if (this._unread && !this._unread.get_parent())
            this._clockBox.add_child(this._unread);

        dateMenu.menu.box.remove_style_class_name('jade-calendar-only');
        this._controls?.show();
        // Out of the bell's menu before it is destroyed, or GNOME's list goes with it.
        if (this._listHome && this._list.get_parent() !== this._listHome) {
            this._list.get_parent()?.remove_child(this._list);
            this._listHome.insert_child_at_index(this._list, 0);
        }

        this._bindings?.forEach(binding => binding.unbind());
        if (this._dnd)
            Gio.Settings.unbind(this._dnd, 'checked');
        this._button?.destroy();
        this._button = this._icon = this._dot = this._dnd = this._bindings = null;
        this._list = this._view = this._listHome = this._controls = null;
        this._unread = this._unreadPad = this._clockBox = null;
        this._unreadChanged = this._dndChanged = this._sessionChanged = null;
        this._settings = null;
    }

    _build() {
        this._button = new PanelMenu.Button(0.5, 'Notifications');
        // Set, not left to the dot's expanding: the bell stays the icon's size.
        const bell = new St.Widget({
            layout_manager: new Clutter.BinLayout(), x_expand: false, y_expand: false,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._icon = new St.Icon({icon_name: BELL, style_class: 'system-status-icon'});
        // BinLayout honors a child's alignment only when it expands.
        this._dot = new St.Widget({
            style_class: 'jade-bell-dot', visible: false, x_expand: true, y_expand: true,
            x_align: Clutter.ActorAlign.END, y_align: Clutter.ActorAlign.START,
        });
        bell.add_child(this._icon);
        bell.add_child(this._dot);
        this._button.add_child(bell);

        const menu = this._button.menu;
        menu.box.add_style_class_name('jade-frame');
        menu.box.add_style_class_name('jade-bell');

        const header = new St.BoxLayout({style_class: 'jade-bell-header', x_expand: true});
        header.add_child(label('NOTIFICATIONS', 'jade-bell-title', {x_expand: true}));
        this._dnd = new St.Button({
            style_class: 'jade-bell-action jade-bell-dnd', toggle_mode: true, can_focus: true,
            accessible_name: 'Do Not Disturb', child: new St.Icon({icon_name: BELL_OFF, icon_size: 14}),
        });
        this._settings.bind('show-banners', this._dnd, 'checked', Gio.SettingsBindFlags.INVERT_BOOLEAN);
        header.add_child(this._dnd);
        const clear = new St.Button({
            style_class: 'jade-bell-action', label: 'Clear', can_focus: true,
            accessible_name: 'Clear all notifications',
        });
        clear.connect('clicked', () => this._view.clear());
        header.add_child(clear);
        this._bindings = [
            this._view.bind_property('can-clear', clear, 'reactive', GObject.BindingFlags.SYNC_CREATE),
            this._view.bind_property('empty', clear, 'visible',
                GObject.BindingFlags.SYNC_CREATE | GObject.BindingFlags.INVERT_BOOLEAN),
        ];
        menu.box.add_child(header);

        // GNOME collapses an expanded group on a click or key outside it; it
        // listens on the clock's menu, so the bell's needs the same.
        for (const signal of ['captured-event::button', 'captured-event::touch', 'captured-event::key'])
            menu.actor.connect(signal, (_a, event) => this._list.maybeCollapseMessageGroupForEvent(event));

        addToPanel('jade-bell', this._button);
    }

    _sync() {
        const dnd = !this._settings.get_boolean('show-banners');
        this._icon.icon_name = dnd ? BELL_OFF : BELL;
        this._dot.visible = this._unread.visible;
    }
}
