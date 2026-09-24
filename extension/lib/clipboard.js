// Clipboard history on Super+Ctrl+V, as Omarchy has it: what was copied,
// text and images, newest first, searchable, framed like Jade's panels.
// Enter copies an entry back (then paste as usual), Delete forgets it.
//
// Kept in memory only, and never what a password manager marks as secret
// (KeePassXC, Bitwarden and others offer x-kde-passwordManagerHint).
// Watches the clipboard the way Clipboard Indicator does (MIT): the
// selection's owner-changed signal, then St.Clipboard to read it.
import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';

const LIMIT = 40;
const SECRET = 'x-kde-passwordManagerHint';
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
const THUMB = 48;

function sameBytes(a, b) {
    if (!a || !b || a.get_size() !== b.get_size())
        return false;
    const [x, y] = [a.get_data(), b.get_data()];
    for (let i = 0; i < x.length; i += Math.max(1, Math.floor(x.length / 512))) {
        if (x[i] !== y[i])
            return false;
    }
    return true;
}

// A thumbnail actor for an image entry, made once.
function thumbnail(entry) {
    if (entry.thumb !== undefined)
        return entry.thumb;
    entry.thumb = null;
    try {
        const stream = Gio.MemoryInputStream.new_from_bytes(entry.bytes);
        const full = GdkPixbuf.Pixbuf.new_from_stream(stream, null);
        entry.size = `${full.get_width()} × ${full.get_height()}`;
        const scale = THUMB / Math.max(full.get_width(), full.get_height());
        const [w, h] = [Math.max(1, Math.round(full.get_width() * scale)), Math.max(1, Math.round(full.get_height() * scale))];
        const pixbuf = full.scale_simple(w, h, GdkPixbuf.InterpType.BILINEAR);
        const content = St.ImageContent.new_with_preferred_size(w, h);
        // GNOME 50 takes the Cogl context first (as its screenshot UI does).
        const context = global.stage.context.get_backend().get_cogl_context();
        content.set_bytes(context, pixbuf.read_pixel_bytes(),
            pixbuf.get_has_alpha() ? Cogl.PixelFormat.RGBA_8888 : Cogl.PixelFormat.RGB_888, w, h, pixbuf.get_rowstride());
        entry.thumb = {content, w, h};
    } catch (e) {
        console.error(`Jade Shell: clipboard thumbnail: ${e.message}`);
    }
    return entry.thumb;
}

export class ClipboardHistory {
    constructor(settings) {
        this._settings = settings;
    }

    enable() {
        this.entries = [];
        this._clipboard = St.Clipboard.get_default();
        this._selection = global.display.get_selection();
        this._selection.connectObject('owner-changed', (_s, type) => {
            if (type === Meta.SelectionType.SELECTION_CLIPBOARD)
                this._read();
        }, this);
        Main.wm.addKeybinding('toggle-clipboard', this._settings, Meta.KeyBindingFlags.NONE,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW, () => this.toggle());
    }

    disable() {
        Main.wm.removeKeybinding('toggle-clipboard');
        this._selection?.disconnectObject(this);
        this._dialog?.destroy();
        this._dialog = null;
        this.entries = [];
    }

    // ---------------------------------------------------------------- history

    _read() {
        const types = this._selection.get_mimetypes(Meta.SelectionType.SELECTION_CLIPBOARD);
        if (types.includes(SECRET))
            return;  // a password: never kept
        const image = IMAGE_TYPES.find(type => types.includes(type));
        if (image) {
            this._clipboard.get_content(St.ClipboardType.CLIPBOARD, image, (_c, bytes) => {
                // The callback's bytes aren't ours to keep (St frees them after): copy.
                if (bytes?.get_size())
                    this._add({kind: 'image', mime: image, bytes: GLib.Bytes.new(bytes.get_data())});
            });
            return;
        }
        this._clipboard.get_text(St.ClipboardType.CLIPBOARD, (_c, text) => {
            if (text?.trim())
                this._add({kind: 'text', text});
        });
    }

    _add(entry) {
        const same = this.entries.findIndex(e => e.kind === entry.kind &&
            (e.kind === 'text' ? e.text === entry.text : sameBytes(e.bytes, entry.bytes)));
        if (same === 0)
            return;
        if (same > 0)
            entry = this.entries.splice(same, 1)[0];
        entry.time ??= GLib.DateTime.new_now_local();
        this.entries.unshift(entry);
        this.entries.length = Math.min(this.entries.length, LIMIT);
    }

    _copy(entry) {
        if (entry.kind === 'text')
            this._clipboard.set_text(St.ClipboardType.CLIPBOARD, entry.text);
        else
            this._clipboard.set_content(St.ClipboardType.CLIPBOARD, entry.mime, entry.bytes);
    }

    // ---------------------------------------------------------------- the panel

    toggle() {
        if (this._dialog)
            this._dialog.close();
        else
            this.open();
    }

    open() {
        const dialog = new ModalDialog.ModalDialog({styleClass: 'jade-menu jade-clipboard', destroyOnClose: true});
        this._dialog = dialog;
        dialog.connect('destroy', () => {
            if (this._dialog === dialog)
                this._dialog = null;
        });
        dialog.contentLayout.add_child(new St.Label({text: 'CLIPBOARD · ENTER COPIES · DELETE FORGETS',
            style_class: 'jade-menu-title'}));
        this._entry = new St.Entry({style_class: 'jade-menu-search', hint_text: 'Search…', can_focus: true, x_expand: true});
        this._list = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style_class: 'jade-menu-list'});
        this._scroll = new St.ScrollView({
            style_class: 'jade-menu-scroll', hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC, overlay_scrollbars: true, child: this._list,
        });
        this._scroll.style = `max-height: ${Math.round(Main.layoutManager.primaryMonitor.height * 0.55)}px;`;
        dialog.contentLayout.add_child(this._entry);
        dialog.contentLayout.add_child(this._scroll);
        dialog.setButtons([
            {label: 'Clear All', action: () => {
                this.entries = [];
                this._show();
            }},
            {label: 'Close', action: () => dialog.close(), key: Clutter.KEY_Escape},
        ]);
        this._entry.clutter_text.connect('text-changed', () => this._show());
        this._entry.clutter_text.connect('key-press-event', (_t, event) => this._key(event));
        this._show();
        dialog.open(global.get_current_time());
        GLib.idle_add_once(GLib.PRIORITY_DEFAULT, () => this._entry.grab_key_focus());
    }

    _show() {
        const query = this._entry.get_text().trim().toLowerCase();
        this._rows = this.entries.filter(e => !query || (e.kind === 'text' ? e.text.toLowerCase().includes(query)
            : 'image'.includes(query)));
        this._list.destroy_all_children();
        if (!this._rows.length) {
            this._list.add_child(new St.Label({
                text: this.entries.length ? 'Nothing matches.' : 'Nothing copied yet.', style_class: 'jade-menu-path',
            }));
        }
        this._rows.forEach((entry, i) => this._list.add_child(this._row(entry, i)));
        this._select(0);
    }

    _row(entry, index) {
        const box = new St.BoxLayout({style_class: 'jade-menu-row-box', x_expand: true});
        if (entry.kind === 'image') {
            const thumb = thumbnail(entry);
            if (thumb)
                box.add_child(new Clutter.Actor({content: thumb.content, width: thumb.w, height: thumb.h}));
            box.add_child(new St.Label({text: `Image${entry.size ? `  ${entry.size}` : ''}`, style_class: 'jade-menu-label',
                y_align: Clutter.ActorAlign.CENTER}));
            box.add_child(new St.Widget({x_expand: true}));
        } else {
            const lines = entry.text.split('\n').filter(line => line.trim());
            const label = new St.Label({
                text: (lines[0] ?? '').trim().slice(0, 200), style_class: 'jade-menu-label', x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
            });
            label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            box.add_child(label);
            if (lines.length > 1) {
                box.add_child(new St.Label({text: `+${lines.length - 1} lines`, style_class: 'jade-menu-path',
                    y_align: Clutter.ActorAlign.CENTER}));
            }
        }
        box.add_child(new St.Label({text: entry.time.format('%H:%M'), style_class: 'jade-menu-path',
            y_align: Clutter.ActorAlign.CENTER}));
        const button = new St.Button({style_class: 'jade-menu-row', child: box, x_expand: true, can_focus: false});
        button.connect('clicked', () => this._choose(index));
        button.connect('enter-event', () => this._select(index, false));
        return button;
    }

    _select(index, scroll = true) {
        const rows = this._list.get_children().filter(child => child instanceof St.Button);
        if (!rows.length) {
            this._selected = -1;
            return;
        }
        this._selected = (index + rows.length) % rows.length;
        rows.forEach((row, i) => (i === this._selected ? row.add_style_pseudo_class('selected')
            : row.remove_style_pseudo_class('selected')));
        if (scroll) {
            const box = rows[this._selected].get_allocation_box();
            const adjustment = this._scroll.vadjustment;
            if (box.y1 < adjustment.value)
                adjustment.value = box.y1;
            else if (box.y2 > adjustment.value + adjustment.page_size)
                adjustment.value = box.y2 - adjustment.page_size;
        }
    }

    _choose(index = this._selected) {
        const entry = this._rows?.[index];
        if (!entry)
            return;
        this._copy(entry);
        this._dialog?.close();
    }

    _key(event) {
        switch (event.get_key_symbol()) {
        case Clutter.KEY_Down:
        case Clutter.KEY_Tab:
            this._select(this._selected + 1);
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Up:
        case Clutter.KEY_ISO_Left_Tab:
            this._select(this._selected - 1);
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Return:
        case Clutter.KEY_KP_Enter:
            this._choose();
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Delete: {
            const entry = this._rows?.[this._selected];
            if (entry) {
                this.entries = this.entries.filter(e => e !== entry);
                const at = this._selected;
                this._show();
                this._select(Math.min(at, this._rows.length - 1));
            }
            return Clutter.EVENT_STOP;
        }
        case Clutter.KEY_Escape:
            if (this._entry.get_text()) {
                this._entry.set_text('');
                return Clutter.EVENT_STOP;
            }
            this._dialog.close();
            return Clutter.EVENT_STOP;
        default:
            return Clutter.EVENT_PROPAGATE;
        }
    }
}
