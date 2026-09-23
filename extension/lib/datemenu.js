// The clock's menu as Omarchy's clock panel: a date and a month, without
// GNOME's world clocks and weather sections (which otherwise show as
// "Add World Clocks…" and "Select Weather Location…" until set up).
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

export class SimpleCalendar {
    enable() {
        const dateMenu = Main.panel.statusArea.dateMenu;
        this._items = [dateMenu._clocksItem, dateMenu._weatherItem].filter(Boolean);
        // GNOME shows each section again whenever it re-checks its app.
        this._signals = this._items.map(item => item.connect('notify::visible', () => {
            if (item.visible)
                item.hide();
        }));
        this._items.forEach(item => item.hide());
    }

    disable() {
        this._items?.forEach((item, i) => {
            if (this._signals?.[i])
                item.disconnect(this._signals[i]);
            item._sync?.();
        });
        this._items = this._signals = null;
    }
}
