import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';

// A row showing a keyboard shortcut stored in a GSettings string list; click
// it to record a new one, the way GNOME Settings' Keyboard page does: Escape
// cancels, Backspace turns the shortcut off, and a shortcut needs Super, Ctrl
// or Alt (function keys aside) so typing can't trigger it. A reset button
// shows while it differs from the default.
export const ShortcutRow = GObject.registerClass(
class ShortcutRow extends Adw.ActionRow {
    constructor(settings, key, title) {
        super({title, activatable: true});
        this._settings = settings;
        this._key = key;
        this._label = new Adw.ShortcutLabel({disabled_text: 'Off', valign: Gtk.Align.CENTER});
        this._reset = new Gtk.Button({
            icon_name: 'edit-undo-symbolic', valign: Gtk.Align.CENTER, tooltip_text: 'Back to the default',
            css_classes: ['flat'],
        });
        this._reset.connect('clicked', () => settings.reset(key));
        this.add_suffix(this._reset);
        this.add_suffix(this._label);
        this.connect('activated', () => this._record());
        this._changed = settings.connect(`changed::${key}`, () => this._sync());
        this.connect('destroy', () => settings.disconnect(this._changed));
        this._sync();
    }

    _sync() {
        const [accel = ''] = this._settings.get_strv(this._key);
        this._label.accelerator = accel;
        this._reset.visible = this._settings.get_user_value(this._key) !== null;
    }

    _record() {
        const hint = new Gtk.Label({
            label: 'Press Escape to cancel, or Backspace to turn the shortcut off.',
            wrap: true, justify: Gtk.Justification.CENTER, css_classes: ['dim-label'],
        });
        const status = new Adw.StatusPage({
            icon_name: 'preferences-desktop-keyboard-shortcuts-symbolic',
            title: 'Press the new shortcut', description: this.title, child: hint,
        });
        const dialog = new Adw.Dialog({title: 'Set Shortcut', content_width: 420, child: status});
        const keys = new Gtk.EventControllerKey();
        keys.connect('key-pressed', (_c, keyval, keycode, state) => {
            const mods = state & Gtk.accelerator_get_default_mod_mask() & ~Gdk.ModifierType.LOCK_MASK;
            const key = Gdk.keyval_to_lower(keyval);
            if (!mods && key === Gdk.KEY_Escape) {
                dialog.close();
                return Gdk.EVENT_STOP;
            }
            if (!mods && key === Gdk.KEY_BackSpace) {
                this._settings.set_strv(this._key, []);
                dialog.close();
                return Gdk.EVENT_STOP;
            }
            const functionKey = key >= Gdk.KEY_F1 && key <= Gdk.KEY_F35;
            const strong = mods & (Gdk.ModifierType.SUPER_MASK | Gdk.ModifierType.CONTROL_MASK | Gdk.ModifierType.ALT_MASK);
            if (!Gtk.accelerator_valid(key, mods))
                return Gdk.EVENT_STOP;  // only a modifier so far
            if (!strong && !functionKey) {
                hint.label = 'Use Super, Ctrl or Alt with it, so typing can’t set it off.';
                return Gdk.EVENT_STOP;
            }
            this._settings.set_strv(this._key, [Gtk.accelerator_name_with_keycode(null, key, keycode, mods)]);
            dialog.close();
            return Gdk.EVENT_STOP;
        });
        dialog.add_controller(keys);
        dialog.present(this.get_root());
    }
});
