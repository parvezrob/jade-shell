// After a screenshot, a card in the corner, as macOS shows one: the shot, and
// what to do next. Edit (in Gradia or Satty when one is installed, else the
// image viewer), Copy Text (Tesseract reads it), Pin (the shot stays on
// screen above the windows) and Show in Files. It stands in for GNOME's
// banner; GNOME still copies and saves the shot as it always does.
//
// And the capture tools GNOME lacks, for the Jade Menu: a color picker
// (Super+Print), copy text from part of the screen (Super+Ctrl+Print), both
// on Omarchy's keys, and read a QR code. They reuse GNOME's own area
// selector and color picker.
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GioUnix from 'gi://GioUnix';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';
import Gettext from 'gettext';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {PickPixel, SelectArea} from 'resource:///org/gnome/shell/ui/screenshot.js';

import {frost} from './glass.js';
import {run, SPAWN, VERTICAL} from './util.js';

const _gs = text => Gettext.dgettext('gnome-shell', text);
const CARD = {width: 260, height: 160};  // the shot fits in this
const SHOWN_FOR = 7000;                   // ms, unless the pointer is on it
const GRADIA = 'be.alexandervanhee.gradia.desktop';

// What to install for a tool, by the package names of this distribution.
const PACKAGES = {
    tesseract: {fedora: 'tesseract', debian: 'tesseract-ocr'},
    zbarimg: {fedora: 'zbar', debian: 'zbar-tools'},
};

function installHint(tool) {
    let family = 'fedora';
    try {
        const release = new TextDecoder().decode(GLib.file_get_contents('/etc/os-release')[1]);
        if (/^ID(_LIKE)?=.*(debian|ubuntu)/m.test(release))
            family = 'debian';
    } catch {}
    const name = PACKAGES[tool][family];
    return family === 'debian' ? `sudo apt install ${name}` : `sudo dnf install ${name}`;
}

function screenshotsDir() {
    return GLib.build_filenamev([
        GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_PICTURES) || GLib.get_home_dir(), _gs('Screenshots'),
    ]);
}

// The file GNOME just saved the shot to (it saves before it notifies).
function newestShot() {
    const dir = Gio.File.new_for_path(screenshotsDir());
    let newest = null, newestTime = 0;
    try {
        const files = dir.enumerate_children('standard::name,time::modified', Gio.FileQueryInfoFlags.NONE, null);
        for (let info; (info = files.next_file(null));) {
            const time = info.get_attribute_uint64('time::modified');
            if (info.get_name().endsWith('.png') && time > newestTime)
                [newest, newestTime] = [dir.get_child(info.get_name()), time];
        }
    } catch {
        return null;
    }
    return newest && GLib.get_real_time() / 1e6 - newestTime < 10 ? newest : null;
}

function launch(argv) {
    try {
        Gio.Subprocess.new(argv, SPAWN);
        return true;
    } catch (e) {
        console.error(`Jade Shell: ${argv[0]}: ${e.message}`);
        return false;
    }
}

function iconButton(icon, label, action) {
    const button = new St.Button({
        style_class: 'jade-capture-button', can_focus: true, accessible_name: label,
        child: new St.BoxLayout({orientation: VERTICAL, style_class: 'jade-capture-button-box'}),
    });
    button.child.add_child(new St.Icon({icon_name: icon, style_class: 'jade-capture-button-icon', x_align: Clutter.ActorAlign.CENTER}));
    button.child.add_child(new St.Label({text: label, style_class: 'jade-capture-button-label', x_align: Clutter.ActorAlign.CENTER}));
    button.connect('clicked', action);
    return button;
}

// A shot scaled to fit `box`, keeping its shape.
function fitted(content, box) {
    const [, w, h] = content.get_preferred_size();
    const scale = Math.min(box.width / w, box.height / h, 1);
    return new Clutter.Actor({
        content, width: Math.round(w * scale), height: Math.round(h * scale),
        content_gravity: Clutter.ContentGravity.RESIZE_ASPECT,
    });
}

export class Capture {
    constructor(settings, parts) {
        this._settings = settings;
        this._parts = parts;
    }

    enable() {
        this._pins = new Set();
        Main.messageTray.connectObject('source-added', (_t, source) => this._watch(source), this);
        for (const source of Main.messageTray.getSources())
            this._watch(source);
        Main.wm.addKeybinding('pick-color', this._settings, Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW, () => this.pickColor());
        Main.wm.addKeybinding('capture-text', this._settings, Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW, () => this.grab('tesseract'));
    }

    disable() {
        Main.wm.removeKeybinding('pick-color');
        Main.wm.removeKeybinding('capture-text');
        Main.messageTray.disconnectObject(this);
        for (const source of Main.messageTray.getSources())
            source.disconnectObject(this);
        this._dismiss(false);
        for (const pin of this._pins)
            pin.destroy();
        this._pins = null;
    }

    // ---------------------------------------------------------------- the card

    // GNOME's "Screenshot captured": its image becomes the card, and GNOME's
    // banner is skipped (it would say the same thing at the other end).
    _watch(source) {
        if (source.title !== _gs('Screen Capture'))
            return;
        source.connectObject('notification-added', (_s, notification) => {
            if (notification.title !== _gs('Screenshot captured') || !this._settings.get_boolean('capture-card'))
                return;
            notification.acknowledged = true;  // before the tray asks for a banner
            this.show(notification.gicon, newestShot());
            // GNOME drops it once its banner has shown; without one it would
            // wait in the list (and light the bell's dot).
            GLib.idle_add_once(GLib.PRIORITY_DEFAULT, () => notification.destroy());
        }, this);
    }

    show(content, file) {
        this._dismiss(false);
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor || !content)
            return;
        const card = new St.BoxLayout({orientation: VERTICAL, style_class: 'jade-capture-card', reactive: true, track_hover: true});
        const shot = new St.Button({style_class: 'jade-capture-shot', can_focus: true, accessible_name: 'Edit',
            child: fitted(content, CARD), x_align: Clutter.ActorAlign.CENTER});
        shot.connect('clicked', () => this._edit(file));
        card.add_child(shot);
        const actions = new St.BoxLayout({style_class: 'jade-capture-actions', x_align: Clutter.ActorAlign.CENTER});
        if (file)
            actions.add_child(iconButton('document-edit-symbolic', this._editor() ? 'Edit' : 'Open', () => this._edit(file)));
        if (file)
            actions.add_child(iconButton('format-text-plaintext-symbolic', 'Text', () => this._readFile(file, 'tesseract')));
        actions.add_child(iconButton('view-pin-symbolic', 'Pin', () => {
            this.pin(content);
            this._dismiss();
        }));
        if (file) {
            actions.add_child(iconButton('folder-symbolic', 'Files', () => {
                launch(['nautilus', '--select', file.get_path()]) || Gio.app_info_launch_default_for_uri(
                    file.get_parent().get_uri(), global.create_app_launch_context(0, -1));
                this._dismiss();
            }));
        }
        actions.add_child(iconButton('window-close-symbolic', 'Close', () => this._dismiss()));
        card.add_child(actions);
        this._present(card, monitor);
    }

    // Into the corner, sliding in from the edge as macOS's does.
    _present(card, monitor) {
        this._card = card;
        Main.layoutManager.addTopChrome(card);
        frost(card);
        const area = Main.layoutManager.getWorkAreaForMonitor(monitor.index);
        const dock = monitor === Main.layoutManager.primaryMonitor ? this._parts('Dock')?.bar : null;
        const bottom = Math.min(area.y + area.height, dock?.top ?? Infinity);
        const [, width] = card.get_preferred_width(-1);
        const [, height] = card.get_preferred_height(width);
        card.set_position(area.x + area.width - width - 20, bottom - height - 20);
        card.translation_x = width + 40;
        card.ease({translation_x: 0, duration: 380, mode: Clutter.AnimationMode.EASE_OUT_EXPO});
        card.connect('notify::hover', () => this._arm());
        this._arm();
    }

    // Hide after a while, but never while the pointer is on the card.
    _arm() {
        if (this._timeout)
            GLib.source_remove(this._timeout);
        this._timeout = 0;
        if (!this._card || this._card.hover)
            return;
        this._timeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SHOWN_FOR, () => {
            this._timeout = 0;
            this._dismiss();
            return GLib.SOURCE_REMOVE;
        });
    }

    _dismiss(animate = true) {
        if (this._timeout)
            GLib.source_remove(this._timeout);
        this._timeout = 0;
        const card = this._card;
        this._card = null;
        if (!card)
            return;
        if (!animate) {
            card.destroy();
            return;
        }
        card.ease({
            translation_x: card.width + 40, opacity: 0, duration: 260, mode: Clutter.AnimationMode.EASE_IN_QUAD,
            onStopped: () => card.destroy(),
        });
    }

    _editor() {
        if (GLib.find_program_in_path('gradia'))
            return ['gradia'];
        if (GioUnix.DesktopAppInfo.new(GRADIA))
            return ['flatpak', 'run', GRADIA.replace(/\.desktop$/, '')];
        if (GLib.find_program_in_path('satty'))
            return ['satty', '--filename'];
        return null;
    }

    _edit(file) {
        this._dismiss();
        if (!file)
            return;
        const editor = this._editor();
        if (editor) {
            const argv = [...editor, file.get_path()];
            if (editor[0] === 'satty')
                argv.push('--output-filename', file.get_path());
            launch(argv);
        } else {
            Gio.app_info_launch_default_for_uri(file.get_uri(), global.create_app_launch_context(0, -1));
        }
    }

    // ---------------------------------------------------------------- pins

    // The shot on screen above the windows: drag it anywhere, scroll to
    // resize it, double-click (or its ×) to let it go.
    pin(content) {
        const [, w, h] = content.get_preferred_size();
        const monitor = Main.layoutManager.primaryMonitor;
        const scale = Math.min(monitor.width * 0.4 / w, monitor.height * 0.4 / h, 1);
        const pin = new St.Widget({style_class: 'jade-capture-pin', reactive: true, track_hover: true,
            layout_manager: new Clutter.BinLayout()});
        const image = new Clutter.Actor({content, width: Math.round(w * scale), height: Math.round(h * scale),
            content_gravity: Clutter.ContentGravity.RESIZE_ASPECT, x_expand: true, y_expand: true});
        pin.add_child(image);
        const close = new St.Button({style_class: 'jade-capture-pin-close', child: new St.Icon({icon_name: 'window-close-symbolic'}),
            x_align: Clutter.ActorAlign.END, y_align: Clutter.ActorAlign.START, opacity: 0});
        close.connect('clicked', () => pin.destroy());
        pin.add_child(close);
        pin.connect('notify::hover', () => close.ease({opacity: pin.hover ? 255 : 0, duration: 150}));

        const pan = new Clutter.PanGesture({begin_threshold: 2});
        let from = null;
        pan.connect('recognize', () => {
            const {x, y} = pan.get_centroid_abs();
            from = [x - pin.x, y - pin.y];
        });
        pan.connect('pan-update', () => {
            const {x, y} = pan.get_centroid_abs();
            pin.set_position(Math.round(x - from[0]), Math.round(y - from[1]));
        });
        pin.add_action(pan);
        const click = new Clutter.ClickGesture({n_clicks_required: 2});
        click.connect('recognize', () => pin.destroy());
        pin.add_action(click);
        pin.connect('scroll-event', (_a, event) => {
            const step = {[Clutter.ScrollDirection.UP]: 1.1, [Clutter.ScrollDirection.DOWN]: 1 / 1.1}[event.get_scroll_direction()];
            if (step) {
                image.width = Math.max(80, Math.round(image.width * step));
                image.height = Math.max(50, Math.round(image.height * step));
            }
            return Clutter.EVENT_STOP;
        });
        pin.connect('destroy', () => this._pins?.delete(pin));

        Main.layoutManager.addTopChrome(pin);
        this._pins.add(pin);
        pin.set_position(monitor.x + Math.round((monitor.width - image.width) / 2),
            monitor.y + Math.round((monitor.height - image.height) / 2));
        pin.set_pivot_point(0.5, 0.5);
        pin.scale_x = pin.scale_y = 0.9;
        pin.opacity = 0;
        pin.ease({scale_x: 1, scale_y: 1, opacity: 255, duration: 220, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        return pin;
    }

    // ---------------------------------------------------------------- tools

    // A color from anywhere on screen, copied as #rrggbb.
    async pickColor() {
        let color;
        try {
            color = await new PickPixel(new Shell.Screenshot()).pickAsync();
        } catch {
            return;  // Escape
        }
        if (!color)
            return;
        const hex = `#${[color.red, color.green, color.blue].map(c => c.toString(16).padStart(2, '0')).join('')}`;
        St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, hex);
        this.toast(`${hex} copied`, {swatch: hex});
    }

    // Part of the screen, read by `tool` (tesseract for text, zbarimg for QR codes).
    async grab(tool) {
        if (!GLib.find_program_in_path(tool)) {
            this._missing(tool);
            return;
        }
        let area;
        try {
            area = await new SelectArea().selectAsync();
        } catch {
            return;  // Escape
        }
        if (!area || area.width < 4 || area.height < 4)
            return;
        const file = Gio.File.new_for_path(GLib.build_filenamev([GLib.get_user_runtime_dir(), `jade-capture-${GLib.random_int()}.png`]));
        try {
            const stream = file.replace(null, false, Gio.FileCreateFlags.PRIVATE, null);
            await new Shell.Screenshot().screenshot_area(area.x, area.y, area.width, area.height, stream);
            stream.close(null);
            await this._readFile(file, tool);
        } catch (e) {
            console.error(`Jade Shell: capture: ${e.message}`);
            this.toast('Could not capture that part of the screen');
        } finally {
            file.delete_async(GLib.PRIORITY_DEFAULT, null, null);
        }
    }

    async _readFile(file, tool) {
        this._dismiss();
        if (!GLib.find_program_in_path(tool)) {
            this._missing(tool);
            return;
        }
        const argv = tool === 'tesseract' ? ['tesseract', file.get_path(), '-', '--psm', '3'] : ['zbarimg', '--raw', '-q', file.get_path()];
        const {stdout} = await run(argv);
        const text = stdout.replace(/\f/g, '').trim();
        if (!text) {
            this.toast(tool === 'tesseract' ? 'No text found there' : 'No QR code found there');
            return;
        }
        St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, text);
        const first = text.split('\n')[0];
        const link = tool === 'zbarimg' && /^https?:\/\/\S+$/.test(first) ? first : null;
        const words = text.split(/\s+/).length;
        this.toast(tool === 'tesseract' ? `Copied ${words} word${words === 1 ? '' : 's'}` : 'QR code copied', {
            detail: first.length > 60 ? `${first.slice(0, 60)}…` : first,
            action: link && ['Open', () => Gio.app_info_launch_default_for_uri(link, global.create_app_launch_context(0, -1))],
        });
    }

    _missing(tool) {
        const what = tool === 'tesseract' ? 'Copying text needs Tesseract' : 'Reading QR codes needs ZBar';
        this.toast(what, {detail: `Install it with: ${installHint(tool)}`});
    }

    // A small card in the corner: what just happened.
    toast(text, {swatch = null, detail = null, action = null} = {}) {
        this._dismiss(false);
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor)
            return;
        const card = new St.BoxLayout({style_class: 'jade-capture-card jade-capture-toast', reactive: true, track_hover: true});
        if (swatch)
            card.add_child(new St.Widget({style_class: 'jade-capture-swatch', style: `background-color: ${swatch};`}));
        const texts = new St.BoxLayout({orientation: VERTICAL, y_align: Clutter.ActorAlign.CENTER, x_expand: true});
        texts.add_child(new St.Label({text, style_class: 'jade-capture-toast-title'}));
        if (detail)
            texts.add_child(new St.Label({text: detail, style_class: 'jade-capture-toast-detail'}));
        card.add_child(texts);
        if (action) {
            const button = new St.Button({label: action[0], style_class: 'jade-capture-toast-action', can_focus: true,
                y_align: Clutter.ActorAlign.CENTER});
            button.connect('clicked', () => {
                action[1]();
                this._dismiss();
            });
            card.add_child(button);
        }
        this._present(card, monitor);
    }
}
