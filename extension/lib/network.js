// The network panel (Super+Ctrl+W, as in Omarchy): the connection, ping to
// the router and the internet, a speed test with live dials, the Wi-Fi as a
// QR code to join from a phone, DNS presets and the Wi-Fi band.
//
// The work is `jade network …` (NetworkManager's nmcli underneath), so the
// Shell only draws; GNOME's Quick Settings still lists and joins networks.
// In the top bar (Settings › Top bar › Network) it takes the place of
// GNOME's network icon and shows the same icon GNOME would: Wi-Fi signal,
// wired, no internet, VPN.
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {familyGicon} from './baricons.js';
import {SPAWN, VERTICAL, addToPanel, cairoRgb, jadeCommand, label, run} from './util.js';

const SWEEP = 1.5 * Math.PI;  // the dials' arc: 270°
const REFRESH_MS = 5000;      // while open

// Mbps on a log scale, so 5 and 900 both read well: 0 at the start, 1000+ at the end.
const dialPosition = mbps => Math.min(1, Math.log10(1 + Math.max(0, mbps)) / 3);

function ago(seconds) {
    const minutes = Math.round((Date.now() / 1000 - seconds) / 60);
    if (minutes < 1)
        return 'just now';
    if (minutes < 60)
        return `${minutes} min ago`;
    const hours = Math.round(minutes / 60);
    return hours < 24 ? `${hours} h ago` : `${Math.round(hours / 24)} d ago`;
}

function wifiIcon(signal) {
    const level = signal >= 80 ? 'excellent' : signal >= 55 ? 'good' : signal >= 30 ? 'ok' : 'weak';
    return `network-wireless-signal-${level}-symbolic`;
}

function mbpsText(mbps) {
    return mbps >= 100 ? String(Math.round(mbps)) : mbps.toFixed(1);
}

// A speed dial: a 270° arc filled to the speed, the number in its middle.
class Dial {
    constructor(caption, colors) {
        this._colors = colors;
        this._value = 0;
        this.actor = new St.Widget({layout_manager: new Clutter.BinLayout(), style_class: 'jn-dial', x_expand: true});
        this._area = new St.DrawingArea({style_class: 'jn-dial-arc', x_expand: true, y_expand: true});
        this._area.connect('repaint', area => this._paint(area));
        this.actor.add_child(this._area);
        const text = new St.BoxLayout({orientation: VERTICAL, x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER});
        this._number = label('–', 'jn-dial-value', {x_align: Clutter.ActorAlign.CENTER});
        text.add_child(this._number);
        text.add_child(label('Mbps', 'jn-dial-unit', {x_align: Clutter.ActorAlign.CENTER}));
        const captionLabel = label(caption, 'jn-dial-caption', {x_align: Clutter.ActorAlign.CENTER});
        captionLabel.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;  // its letter spacing isn't measured
        text.add_child(captionLabel);
        this.actor.add_child(text);
    }

    set(mbps, active = false) {
        this._value = mbps ?? 0;
        this._number.text = mbps === null || mbps === undefined ? '–' : mbpsText(mbps);
        this.actor[active ? 'add_style_pseudo_class' : 'remove_style_pseudo_class']('active');
        this._area.queue_repaint();
    }

    _paint(area) {
        const cr = area.get_context();
        const [w, h] = area.get_surface_size();
        const radius = Math.min(w, h) / 2 - 6;
        const [cx, cy] = [w / 2, h / 2];
        const start = Math.PI * 0.75;
        cr.setLineWidth(6);
        cr.setLineCap(1);  // round
        cr.setSourceRGBA(...this._colors.track);
        cr.arc(cx, cy, radius, start, start + SWEEP);
        cr.stroke();
        const position = dialPosition(this._value);
        if (position > 0) {
            cr.setSourceRGBA(...this._colors.fill);
            cr.arc(cx, cy, radius, start, start + SWEEP * position);
            cr.stroke();
        }
        cr.$dispose();
    }
}

// The Wi-Fi as a QR code, dark modules on a light square with its quiet zone.
class QrCode {
    constructor() {
        this.matrix = null;
        this.actor = new St.DrawingArea({style_class: 'jn-qr', x_align: Clutter.ActorAlign.CENTER});
        this.actor.connect('repaint', area => this._paint(area));
    }

    show(matrix) {
        this.matrix = matrix;
        this.actor.queue_repaint();
    }

    _paint(area) {
        const cr = area.get_context();
        const [w, h] = area.get_surface_size();
        cr.setSourceRGB(1, 1, 1);
        cr.rectangle(0, 0, w, h);
        cr.fill();
        if (this.matrix) {
            const n = this.matrix.length;
            const cell = Math.floor(Math.min(w, h) / (n + 4));  // four modules of quiet zone
            const offset = [(w - cell * n) / 2, (h - cell * n) / 2].map(Math.round);
            cr.setSourceRGB(0, 0, 0);
            this.matrix.forEach((row, y) => [...row].forEach((bit, x) => {
                if (bit === '1')
                    cr.rectangle(offset[0] + x * cell, offset[1] + y * cell, cell, cell);
            }));
            cr.fill();
        }
        cr.$dispose();
    }
}

export class Network {
    constructor(extension, settings, theme) {
        this._extension = extension;
        this._settings = settings;
        this._theme = theme;
    }

    enable() {
        this._colors = {track: [1, 1, 1, 0.12], fill: [1, 1, 1, 0.9]};
        this._button = new PanelMenu.Button(0.5, 'Network', false);
        this._button.add_style_class_name('jade-network');
        const icons = new St.BoxLayout({style_class: 'panel-status-indicators-box'});
        this._icon = new St.Icon({icon_name: 'network-wired-symbolic', style_class: 'system-status-icon'});
        this._vpnIcon = new St.Icon({icon_name: 'network-vpn-symbolic', style_class: 'system-status-icon', visible: false});
        icons.add_child(this._icon);
        icons.add_child(this._vpnIcon);
        this._button.add_child(icons);
        this._build();
        addToPanel('jade-network', this._button);
        this._shownChanged = this._settings.connect('changed::show-network', () => this._syncShown());
        this._syncShown();
        this._followGnome();
        this._unfollow = this._theme.follow(palette => {
            this._colors.track = [...cairoRgb(palette.foreground), 0.12];
            this._colors.fill = [...cairoRgb(palette.accent), 0.95];
            this._dials?.forEach(dial => dial._area.queue_repaint());
        });
        Main.wm.addKeybinding('toggle-network', this._settings, Meta.KeyBindingFlags.NONE,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW, () => this.toggle());
    }

    disable() {
        Main.wm.removeKeybinding('toggle-network');
        if (this._shownChanged)
            this._settings.disconnect(this._shownChanged);
        this._shownChanged = 0;
        if (this._waitId)
            GLib.source_remove(this._waitId);
        this._waitId = 0;
        this._releaseGnome();
        this._stopTest();
        this._stopRefresh();
        this._cancellable?.cancel();
        this._unfollow?.();
        this._button?.destroy();
        this._button = null;
    }

    // ---------------------------------------------------------------- the bar

    _shown() {
        return this._settings.get_boolean('show-network');
    }

    _syncShown() {
        this._button.visible = this._shown();
        this._hideGnome();
        if (!this._shown() && this._gnome)
            this._gnome.visible = this._gnome._client?.nm_running ?? true;  // back as GNOME had it
    }

    // GNOME's network indicator is built after the Shell starts: wait for it.
    // Its icon (and VPN icon) become ours; it hides while ours is shown.
    _followGnome(tries = 40) {
        const gnome = Main.panel.statusArea.quickSettings?._network;
        if (gnome === undefined && tries > 0) {
            this._waitId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
                this._waitId = 0;
                this._followGnome(tries - 1);
                return GLib.SOURCE_REMOVE;
            });
            return;
        }
        if (!gnome)
            return;  // no NetworkManager: GNOME shows no network icon either
        this._gnome = gnome;
        const icon = () => (this._icon.icon_name = gnome._primaryIndicator?.icon_name || 'network-offline-symbolic');
        const vpn = () => {
            this._vpnIcon.visible = Boolean(gnome._vpnIndicator?.visible);
            this._vpnIcon.icon_name = gnome._vpnIndicator?.icon_name || 'network-vpn-symbolic';
        };
        gnome._primaryIndicator?.connectObject('notify::icon-name', icon, this);
        gnome._vpnIndicator?.connectObject('notify::visible', vpn, 'notify::icon-name', vpn, this);
        gnome.connectObject('notify::visible', () => this._hideGnome(), this);
        icon();
        vpn();
        this._hideGnome();
    }

    _hideGnome() {
        if (this._gnome && this._shown() && this._gnome.visible)
            this._gnome.visible = false;
    }

    _releaseGnome() {
        const gnome = this._gnome;
        this._gnome = null;
        if (!gnome)
            return;
        gnome._primaryIndicator?.disconnectObject(this);
        gnome._vpnIndicator?.disconnectObject(this);
        gnome.disconnectObject(this);
        gnome.visible = gnome._client?.nm_running ?? true;
    }

    // Opened from the bar, the shortcut or the Jade Menu (under the right end
    // of the top bar when its icon is hidden).
    toggle(startTest = false) {
        const menu = this._button.menu;
        if (!menu.isOpen && !this._button.mapped) {
            const monitor = Main.layoutManager.primaryMonitor;
            const [, panelY] = Main.panel.get_transformed_position();
            Main.layoutManager.setDummyCursorGeometry(monitor.x + monitor.width - 1, panelY, 0, Main.panel.height);
            menu.sourceActor = Main.layoutManager.dummyCursor;
        }
        // Focus left on another menu's button would make GNOME's menu manager
        // switch to that menu the moment this one takes the focus.
        if (!menu.isOpen)
            global.stage.set_key_focus(null);
        menu.toggle();
        if (startTest && menu.isOpen && !this._test)
            this._startTest();
    }

    // ---------------------------------------------------------------- the panel

    // Each section in a row styled like a menu item; the rows scroll together
    // when the panel is taller than the screen.
    _item(actor) {
        this._content.add_child(new St.Bin({style_class: 'popup-menu-item jade-item', x_expand: true, child: actor}));
        return actor;
    }

    _action(text, icon, action) {
        const button = new St.Button({can_focus: true, track_hover: true, x_expand: true, style_class: 'jade-action', accessible_name: text});
        const box = new St.BoxLayout({style_class: 'jade-action-content', x_align: Clutter.ActorAlign.CENTER});
        const gicon = icon.endsWith('.svg')  // Jade's own
            ? new Gio.FileIcon({file: this._extension.dir.get_child('icons').get_child(icon)}) : familyGicon(icon);
        box.add_child(new St.Icon({gicon, icon_size: 14}));
        button._label = label(text, 'jade-action-label');
        box.add_child(button._label);
        button.set_child(box);
        button.connect('clicked', action);
        return button;
    }

    // A row of choices, one checked: DNS presets, Wi-Fi bands.
    _choices(title, options, pick) {
        const box = new St.BoxLayout({orientation: VERTICAL, x_expand: true, style_class: 'jn-choice-row'});
        box.add_child(label(title, 'jm-tagline'));
        const row = new St.BoxLayout({x_expand: true, style_class: 'jn-choices'});
        const buttons = new Map();
        for (const [value, text] of options) {
            const button = new St.Button({label: text, can_focus: true, track_hover: true, x_expand: true,
                toggle_mode: false, style_class: 'jn-choice'});
            button.connect('clicked', () => pick(value));
            row.add_child(button);
            buttons.set(value, button);
        }
        box.add_child(row);
        box.select = value => buttons.forEach((button, key) => (button.checked = key === value));
        return box;
    }

    _build() {
        const menu = this._button.menu;
        menu.box.add_style_class_name('jade-frame');
        menu.box.add_style_class_name('jade-monitor-panel');
        menu.box.add_style_class_name('jade-network-panel');
        this._content = new St.BoxLayout({orientation: VERTICAL, x_expand: true});
        this._scroll = new St.ScrollView({
            hscrollbar_policy: St.PolicyType.NEVER, vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true, x_expand: true, child: this._content,
        });
        const holder = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false, style_class: 'jn-holder'});
        holder.add_child(this._scroll);
        menu.addMenuItem(holder);

        // The connection.
        const hero = this._item(new St.BoxLayout({x_expand: true, style_class: 'jm-hero'}));
        this._heroIcon = new St.Icon({gicon: familyGicon('network-wired-symbolic'), style_class: 'jm-hero-icon', y_align: Clutter.ActorAlign.START});
        hero.add_child(this._heroIcon);
        const text = new St.BoxLayout({orientation: VERTICAL, x_expand: true});
        this._title = label('Network', 'jm-title');
        this._meta = label('', 'jm-meta');
        this._tagline = label('', 'jm-tagline');
        [this._title, this._meta, this._tagline].forEach(actor => text.add_child(actor));
        hero.add_child(text);

        // Ping, address, DNS.
        const facts = this._item(new St.BoxLayout({orientation: VERTICAL, x_expand: true, style_class: 'jm-section jm-divided'}));
        this._facts = {};
        for (const [key, title] of [['router', 'Router'], ['internet', 'Internet'], ['address', 'Address'], ['dns', 'DNS']]) {
            const row = new St.BoxLayout({x_expand: true, style_class: 'jn-fact'});
            row.add_child(label(title, 'jm-caption', {x_expand: true}));
            this._facts[key] = label('…', 'jn-fact-value');
            row.add_child(this._facts[key]);
            facts.add_child(row);
        }

        // Speed test.
        const speed = this._item(new St.BoxLayout({orientation: VERTICAL, x_expand: true, style_class: 'jm-section jm-divided'}));
        this._speedSection = speed;
        const dials = new St.BoxLayout({x_expand: true, style_class: 'jn-dials'});
        this._down = new Dial('DOWNLOAD', this._colors);
        this._up = new Dial('UPLOAD', this._colors);
        this._dials = [this._down, this._up];
        this._dials.forEach(dial => dials.add_child(dial.actor));
        speed.add_child(dials);
        this._speedCaption = label('', 'jm-caption jn-speed-caption', {x_align: Clutter.ActorAlign.CENTER});
        speed.add_child(this._speedCaption);
        this._testButton = this._action('Test Speed', 'network-transmit-receive-symbolic', () => this._startTest());
        speed.add_child(this._testButton);

        // Wi-Fi: share it, pin its band.
        this._wifiBox = this._item(new St.BoxLayout({orientation: VERTICAL, x_expand: true, style_class: 'jm-section jm-divided'}));
        this._qr = new QrCode();
        this._qr.actor.visible = false;
        this._qrCaption = label('', 'jm-caption', {x_align: Clutter.ActorAlign.CENTER, visible: false});
        this._shareButton = this._action('Share Wi-Fi', 'qr-symbolic.svg', () => this._toggleQr());
        this._band = this._choices('WI-FI BAND', [['auto', 'Auto'], ['2.4', '2.4 GHz'], ['5', '5 GHz'], ['6', '6 GHz']],
            value => this._runChange(['network', 'band', value], `Band: ${value}`));
        [this._qr.actor, this._qrCaption, this._shareButton, this._band].forEach(actor => this._wifiBox.add_child(actor));
        this._wifiBox.get_parent().visible = false;

        // DNS.
        const dnsBox = this._item(new St.BoxLayout({orientation: VERTICAL, x_expand: true, style_class: 'jm-section jm-divided'}));
        this._dns = this._choices('DNS', [['auto', 'Automatic'], ['cloudflare', 'Cloudflare'], ['google', 'Google']],
            value => this._runChange(['network', 'dns', value], `DNS: ${value}`));
        dnsBox.add_child(this._dns);

        // GNOME's own network lists and settings.
        const footer = this._item(new St.BoxLayout({x_expand: true, style_class: 'jm-footer jm-divided jn-footer'}));
        footer.add_child(this._action('Networks', 'network-wireless-symbolic', () => {
            menu.close();
            Main.panel.statusArea.quickSettings?.menu.open();
        }));
        footer.add_child(this._action('Settings', 'emblem-system-symbolic', () => {
            menu.close();
            try {
                Gio.Subprocess.new(['gnome-control-center', this._status?.type === 'wifi' ? 'wifi' : 'network'], SPAWN);
            } catch (e) {
                console.error(`Jade Shell: network settings: ${e.message}`);
            }
        }));

        menu.connect('open-state-changed', (_m, open) => {
            if (open) {
                const monitor = Main.layoutManager.primaryMonitor;
                this._scroll.style = `max-height: ${Math.max(240, monitor.height - Main.panel.height - 48)}px;`;
                this._refresh();
                this._refreshTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, REFRESH_MS, () => {
                    if (!this._test)
                        this._refresh();
                    return GLib.SOURCE_CONTINUE;
                });
            } else {
                menu.sourceActor = this._button;
                this._stopRefresh();
                this._stopTest();
                this._hideQr();
            }
        });
    }

    _stopRefresh() {
        if (this._refreshTimer)
            GLib.source_remove(this._refreshTimer);
        this._refreshTimer = 0;
    }

    async _refresh() {
        const jade = jadeCommand();
        if (!jade || this._refreshing)
            return;
        this._refreshing = true;
        this._cancellable ??= new Gio.Cancellable();
        const {ok, stdout} = await run([jade, 'network', 'status', '--json'], this._cancellable, {kill: true});
        this._refreshing = false;
        if (!this._button || !ok)
            return;
        try {
            this._show(JSON.parse(stdout));
        } catch (e) {
            console.error(`Jade Shell: network status: ${e.message}`);
        }
    }

    _show(status) {
        this._status = status;
        if (!status.connected) {
            this._heroIcon.gicon = familyGicon('network-offline-symbolic');
            this._title.text = 'Not connected';
            this._meta.text = '';
            this._tagline.text = '';
            Object.values(this._facts).forEach(fact => (fact.text = '–'));
            this._wifiBox.get_parent().visible = false;
            return;
        }
        const wifi = status.type === 'wifi';
        this._heroIcon.gicon = familyGicon(wifi ? wifiIcon(status.signal ?? 0) : 'network-wired-symbolic');
        this._title.text = wifi ? status.ssid || 'Wi-Fi' : status.connection || 'Wired';
        this._meta.text = wifi
            ? [`${status.band ?? '?'} GHz`, status.channel && `channel ${status.channel}`, status.rate].filter(Boolean).join(' · ')
            : `Ethernet · ${status.device}`;
        this._tagline.text = wifi ? `SIGNAL ${status.signal ?? '?'}% · ${(status.security || 'OPEN').toUpperCase()}` : 'WIRED';
        const ms = value => (value === null || value === undefined ? '–' : `${value} ms`);
        this._facts.router.text = `${status.gateway ?? '–'}  ${ms(status.ping_router)}`;
        this._facts.internet.text = ms(status.ping_internet);
        this._facts.address.text = status.address ?? '–';
        this._facts.dns.text = (status.dns_servers ?? []).slice(0, 2).join(', ') || '–';
        this._dns.select(status.dns ?? 'auto');
        this._wifiBox.get_parent().visible = wifi;
        this._band.select(status.band_pin ?? 'auto');
        if (!this._test)
            this._showLast(status.last_speedtest);
    }

    _showLast(last) {
        this._down.set(last?.down ?? null);
        this._up.set(last?.up ?? null);
        this._speedCaption.text = last
            ? `Ping ${last.ping} ms · jitter ${last.jitter} ms · ${last.server ? `Cloudflare ${last.server} · ` : ''}${ago(last.when)}`
            : 'Not tested yet';
    }

    // One change at a time (DNS, band): run it, then show where things stand.
    async _runChange(args, done) {
        const jade = jadeCommand();
        if (!jade || this._changing)
            return;
        this._changing = true;
        this._speedCaption.text = 'Changing…';
        const {ok, stderr} = await run([jade, ...args], this._cancellable);
        this._changing = false;
        if (!this._button)
            return;
        this._speedCaption.text = ok ? done : (stderr.trim().split('\n').pop() || 'That did not work');
        this._refresh();
    }

    // ---------------------------------------------------------------- speed test

    _startTest() {
        const jade = jadeCommand();
        if (!jade)
            return;
        if (this._test) {  // the button stops a test too
            this._stopTest();
            this._showLast(this._status?.last_speedtest);
            return;
        }
        let proc;
        try {
            proc = Gio.Subprocess.new([jade, 'network', 'speedtest', '--json'], SPAWN | Gio.SubprocessFlags.STDOUT_PIPE);
        } catch (e) {
            this._speedCaption.text = e.message;
            return;
        }
        this._test = proc;
        this._testButton._label.text = 'Stop';
        this._down.set(0, true);
        this._up.set(null);
        this._speedCaption.text = 'Measuring ping…';
        const lines = new Gio.DataInputStream({base_stream: proc.get_stdout_pipe(), close_base_stream: true});
        const next = () => lines.read_line_async(GLib.PRIORITY_DEFAULT, null, (stream, result) => {
            let line;
            try {
                [line] = stream.read_line_finish_utf8(result);
            } catch {
                line = null;
            }
            if (this._test !== proc)
                return;
            if (line === null) {
                this._endTest();
                return;
            }
            try {
                this._onTestEvent(JSON.parse(line));
            } catch {}
            next();
        });
        next();
    }

    _onTestEvent(event) {
        switch (event.phase) {
        case 'ping':
            this._speedCaption.text = `Ping ${event.ms} ms · jitter ${event.jitter} ms${event.server ? ` · Cloudflare ${event.server}` : ''}`;
            break;
        case 'down':
            this._down.set(event.mbps, true);
            break;
        case 'up':
            this._down.actor.remove_style_pseudo_class('active');
            this._up.set(event.mbps, true);
            break;
        case 'done':
            if (this._status)
                this._status.last_speedtest = event;
            this._showLast(event);
            break;
        case 'error':
            this._speedCaption.text = event.message;
            break;
        }
    }

    _endTest() {
        this._test = null;
        this._testButton._label.text = 'Test Speed';
        this._dials.forEach(dial => dial.actor.remove_style_pseudo_class('active'));
    }

    _stopTest() {
        if (!this._test)
            return;
        this._test.force_exit();
        this._endTest();
    }

    // ---------------------------------------------------------------- Wi-Fi QR

    async _toggleQr() {
        if (this._qr.actor.visible) {
            this._hideQr();
            return;
        }
        const jade = jadeCommand();
        if (!jade)
            return;
        this._shareButton._label.text = 'Reading…';
        const request = this._qrRequest = {};
        const {ok, stdout, stderr} = await run([jade, 'network', 'qr', '--json'], this._cancellable, {kill: true});
        // The code carries the Wi-Fi password: only for the request still
        // asked for, in the menu still open (closing it cancels the share).
        if (!this._button || request !== this._qrRequest || !this._button.menu.isOpen)
            return;
        this._qrRequest = null;
        this._shareButton._label.text = 'Hide QR Code';
        if (!ok) {
            this._shareButton._label.text = 'Share Wi-Fi';
            this._qrCaption.text = stderr.trim().split('\n').pop()?.replace(/^jade: /, '') || 'No QR code';
            this._qrCaption.visible = true;
            return;
        }
        const qr = JSON.parse(stdout);
        this._qr.show(qr.matrix);
        this._qr.actor.visible = true;
        this._stopTest();
        this._speedSection.get_parent().visible = false;  // the code takes the dials' place
        this._qrCaption.text = `Scan with a phone camera to join ${qr.ssid}`;
        this._qrCaption.visible = true;
    }

    _hideQr() {
        this._qrRequest = null;
        if (!this._qr)
            return;
        this._qr.actor.visible = false;
        this._qrCaption.visible = false;
        this._shareButton._label.text = 'Share Wi-Fi';
        this._speedSection.get_parent().visible = true;
    }
}
