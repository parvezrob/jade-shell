// Drives Jade Shell inside the headless test shell of tests/shell/run.sh and
// writes $JADE_SHOTS/done when finished. Two modes ($JADE_MODE):
//
//   shots   (default) opens each panel for each theme in $JADE_THEMES,
//           screenshots it into $JADE_SHOTS and logs "HARNESS …" lines.
//   timing  measures how fast the top-bar menus open and switch, and logs
//           "HARNESS TIMING …" lines (see Timing below).
//   dock    screenshots the dock at rest, magnified, with a label, a menu, a
//           launch bounce and hidden, and times its frames during sweeps
//           ("HARNESS DOCK …" lines).
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as BoxPointer from 'resource:///org/gnome/shell/ui/boxpointer.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const OUT = GLib.getenv('JADE_SHOTS');
const MODE = GLib.getenv('JADE_MODE') || 'shots';
const THEMES = (GLib.getenv('JADE_THEMES') || 'osaka-jade').split(',');
const UUID = 'jade-shell@parvezrob.github.io';
const wait = ms => new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
    resolve();
    return GLib.SOURCE_REMOVE;
}));
const log = message => console.log(`HARNESS ${message}`);

function shoot(name, actor = null) {
    return new Promise(resolve => {
        const stream = Gio.File.new_for_path(`${OUT}/${name}.png`).replace(null, false, Gio.FileCreateFlags.NONE, null);
        const done = finish => {
            try {
                finish();
            } catch (e) {
                log(`shot ${name}: ${e}`);
            }
            stream.close(null);
            resolve();
        };
        const shot = new Shell.Screenshot();
        if (!actor) {
            shot.screenshot(false, stream, (o, res) => done(() => o.screenshot_finish(res)));
            return;
        }
        const [x, y] = actor.get_transformed_position();
        const [w, h] = actor.get_transformed_size();
        const pad = 10;
        shot.screenshot_area(Math.max(0, Math.floor(x - pad)), Math.max(0, Math.floor(y - pad)),
            Math.ceil(w + 2 * pad), Math.ceil(h + 2 * pad), stream, (o, res) => done(() => o.screenshot_area_finish(res)));
    });
}

function jade(...args) {
    return new Promise(resolve => {
        const proc = Gio.Subprocess.new([`${GLib.getenv('HOME')}/.local/bin/jade`, ...args],
            Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_MERGE);
        proc.communicate_utf8_async(null, null, (p, r) => {
            const [, out] = p.communicate_utf8_finish(r);
            log(`jade ${args.join(' ')} → ${p.get_exit_status()} ${out.trim().split('\n').pop()}`);
            resolve();
        });
    });
}

async function panel(role, name, settle = 1600) {
    const button = Main.panel.statusArea[role];
    if (!button) {
        log(`no ${role} in the top bar`);
        return;
    }
    button.menu.open(false);
    await wait(settle);
    await shoot(name, button.menu.box ?? button.menu.actor);
    button.menu.close(false);
    await wait(400);
}

// A top-bar button at rest, hovered and with its menu open, cropped to its box.
async function states(role, name) {
    const button = Main.panel.statusArea[role];
    if (!button)
        return;
    const box = button.get_parent().get_parent();
    await shoot(`${name}-rest`, box);
    button.add_style_pseudo_class('hover');
    await wait(300);
    await shoot(`${name}-hover`, box);
    button.remove_style_pseudo_class('hover');
    button.menu.open(false);
    await wait(300);
    await shoot(`${name}-open`, box);
    button.menu.close(false);
    await wait(300);
}

// The weather chip: nothing without a location; with one (Dhaka), the chip
// and its forecast once the data is in.
async function weather() {
    const part = Main.extensionManager.lookup(UUID)?.stateObj?._part?.('Weather');
    if (!part) {
        log('weather: none');
        return;
    }
    log(`weather: no location → shown ${part._button.visible}`);
    const {default: GWeather} = await import('gi://GWeather');
    // A city, as GNOME Weather's search gives it.
    const station = GWeather.Location.get_world().find_by_station_code('VGHS');
    const place = station.get_parent()?.get_level() === GWeather.LocationLevel.CITY ? station.get_parent() : station;
    log(`weather: the place is ${place.get_name()} (${place.get_level()})`);
    const shellWeather = new Gio.Settings({schema_id: 'org.gnome.shell.weather'});
    shellWeather.set_boolean('automatic-location', false);
    shellWeather.set_value('locations', new GLib.Variant('av', [place.serialize()]));
    for (let i = 0; i < 40 && !part._button.visible; i++)
        await wait(500);
    log(`weather: Dhaka → shown ${part._button.visible}, "${part._temp.text}" ${part._icon.icon_name}, ` +
        `${part._hours.get_n_children()} hours`);
    await shoot('weather-chip', Main.panel);
    part._button.menu.open(false);
    await wait(700);
    await shoot('weather-menu', part._button.menu.box);
    part._button.menu.close(false);
    await wait(300);
}

// A media player on the bus (a stand-in for Spotify or Firefox): the chip
// shows while it plays or is paused, scrolling skips, and it goes with it.
const MPRIS_ROOT = `<node><interface name="org.mpris.MediaPlayer2">
<method name="Raise"/><property name="Identity" type="s" access="read"/>
<property name="DesktopEntry" type="s" access="read"/></interface></node>`;
const MPRIS_PLAYER = `<node><interface name="org.mpris.MediaPlayer2.Player">
<method name="Next"/><method name="Previous"/><method name="PlayPause"/>
<property name="PlaybackStatus" type="s" access="read"/><property name="Metadata" type="a{sv}" access="read"/>
<property name="CanPlay" type="b" access="read"/><property name="CanGoNext" type="b" access="read"/>
<property name="CanGoPrevious" type="b" access="read"/></interface></node>`;

async function media() {
    const part = Main.extensionManager.lookup(UUID)?.stateObj?._part?.('Media');
    if (!part) {
        log('media: none');
        return;
    }
    const tracks = [['Night Drive', 'Jade Ensemble'], ['Tokyo Rain', 'Neon Quartet'], ['Last Train', 'The Platforms']];
    const player = {
        track: 0, status: 'Playing',
        Identity: 'Harness Player', DesktopEntry: 'org.gnome.Loupe',
        get PlaybackStatus() {
            return this.status;
        },
        get Metadata() {
            const [title, artist] = tracks[this.track];
            return {'xesam:title': new GLib.Variant('s', title), 'xesam:artist': new GLib.Variant('as', [artist]),
                'mpris:trackid': new GLib.Variant('o', `/track/${this.track}`)};
        },
        CanPlay: true, CanGoNext: true, CanGoPrevious: true,
        Raise() {},
        Next() {
            this.track = (this.track + 1) % tracks.length;
            this.changed();
        },
        Previous() {
            this.track = (this.track + tracks.length - 1) % tracks.length;
            this.changed();
        },
        PlayPause() {
            this.status = this.status === 'Playing' ? 'Paused' : 'Playing';
            this.changed();
        },
        changed() {
            playerObject.emit_property_changed('Metadata', new GLib.Variant('a{sv}', this.Metadata));
            playerObject.emit_property_changed('PlaybackStatus', new GLib.Variant('s', this.status));
        },
    };
    const rootObject = Gio.DBusExportedObject.wrapJSObject(MPRIS_ROOT, player);
    const playerObject = Gio.DBusExportedObject.wrapJSObject(MPRIS_PLAYER, player);
    rootObject.export(Gio.DBus.session, '/org/mpris/MediaPlayer2');
    playerObject.export(Gio.DBus.session, '/org/mpris/MediaPlayer2');
    const owner = Gio.bus_own_name_on_connection(Gio.DBus.session, 'org.mpris.MediaPlayer2.jadeharness',
        Gio.BusNameOwnerFlags.NONE, null, null);
    await wait(1500);
    log(`media: playing → shown ${part._button.visible}, "${part._chipLabel.text}"`);
    await shoot('media-chip', Main.panel);
    part._button.menu.open(false);
    await wait(700);
    await shoot('media-menu', part._button.menu.box);
    part._button.menu.close(false);
    part._skip(1);
    await wait(600);
    log(`media: scrolled down → "${part._chipLabel.text}"`);
    player.PlayPause();
    await wait(600);
    log(`media: paused → shown ${part._button.visible}, icon ${part._state.icon_name}`);
    Gio.bus_unown_name(owner);
    rootObject.unexport();
    playerObject.unexport();
    await wait(1200);
    log(`media: player gone → shown ${part._button.visible}`);
}

// Super+Alt+Space: the Jade Menu, opened, walked into Toggles, searched,
// and closed with Escape; how long opening takes.
async function jadeMenu() {
    const menu = Main.extensionManager.lookup(UUID)?.stateObj?._part?.('JadeMenu');
    if (!menu) {
        log('menu: none');
        return;
    }
    const keyboard = Clutter.get_default_backend().get_default_seat().create_virtual_device(
        Clutter.InputDeviceType.KEYBOARD_DEVICE);
    const press = async (...keys) => {
        for (const key of keys)
            keyboard.notify_keyval(now(), key, Clutter.KeyState.PRESSED);
        for (const key of keys.reverse())
            keyboard.notify_keyval(now(), key, Clutter.KeyState.RELEASED);
        await wait(300);
    };
    // An entry of one's own.
    const config = GLib.build_filenamev([GLib.get_user_config_dir(), 'jade-shell']);
    GLib.mkdir_with_parents(config, 0o755);
    GLib.file_set_contents(`${config}/menu.json`,
        JSON.stringify({items: [{path: 'Setup/Harness Entry', command: 'true'}, {path: 'Mine/Deep/Thing', command: 'true'}]}));
    const opens = [];
    for (let i = 0; i < 5; i++) {
        const t = now();
        menu.open();
        const built = now() - t;
        await new Promise(resolve => {
            const id = global.stage.connect('after-paint', () => {
                global.stage.disconnect(id);
                resolve();
            });
        });
        opens.push([built / 1000, (now() - t) / 1000]);
        menu._dialog.close();
        await wait(600);
    }
    const median = list => [...list].sort((a, b) => a - b)[Math.floor(list.length / 2)].toFixed(1);
    log(`menu: open builds in ${median(opens.map(o => o[0]))} ms, first paint after ${median(opens.map(o => o[1]))} ms (median of 5)`);
    await press(Clutter.KEY_Super_L, Clutter.KEY_Alt_L, Clutter.KEY_space);
    await wait(700);
    log(`menu: open ${Boolean(menu._dialog)}, ${menu._rows?.length} rows: ${menu._rows?.map(r => r.entry.label).join(', ')}`);
    await shoot('menu');
    for (let i = 0; i < 3; i++)  // Apps, Clipboard History, Capture, then Toggles
        await press(Clutter.KEY_Down);
    await press(Clutter.KEY_Return);
    await wait(400);
    log(`menu: → ${menu._title.text}: ${menu._rows?.map(r => r.entry.label).join(', ')}`);
    await shoot('menu-toggles');
    await press(Clutter.KEY_Escape);
    for (const key of [Clutter.KEY_n, Clutter.KEY_i, Clutter.KEY_g, Clutter.KEY_h, Clutter.KEY_t])
        await press(key);
    await wait(300);
    log(`menu: "night" → ${menu._rows?.map(r => `${r.entry.label} (${r.path.join('/')})`).join(', ')}`);
    await shoot('menu-search');
    menu._entry.set_text('harness');
    await wait(300);
    log(`menu: "harness" → ${menu._rows?.map(r => `${r.entry.label} (${r.path.join('/')})`).join(', ')}; ` +
        `root has ${menu._root.map(e => e.label).join(', ')}`);
    menu._entry.set_text('');
    await press(Clutter.KEY_Escape);
    await press(Clutter.KEY_Escape);
    await wait(500);
    log(`menu: closed ${!menu._dialog}`);
    // Opened at a branch (Super+Escape with the Omarchy keymap): one Escape closes it.
    menu.toggle('System');
    await wait(500);
    const title = menu._title.text;
    await press(Clutter.KEY_Escape);
    await wait(500);
    log(`menu: at ${title}, Escape → closed ${!menu._dialog}`);
}

// Clipboard history: texts and an image kept, a password never.
async function clipboard() {
    const part = Main.extensionManager.lookup(UUID)?.stateObj?._part?.('ClipboardHistory');
    if (!part) {
        log('clipboard: none');
        return;
    }
    const {default: Meta} = await import('gi://Meta');
    const clip = St.Clipboard.get_default();
    clip.set_text(St.ClipboardType.CLIPBOARD, 'ssh robin@jade.example.org');
    await wait(400);
    clip.set_text(St.ClipboardType.CLIPBOARD, 'SELECT *\nFROM themes\nWHERE accent = \'#509475\';');
    await wait(400);
    // A password manager's copy: it offers the hint, and it is never kept.
    const secret = Meta.SelectionSourceMemory.new('x-kde-passwordManagerHint', GLib.Bytes.new(new TextEncoder().encode('secret')));
    global.display.get_selection().set_owner(Meta.SelectionType.SELECTION_CLIPBOARD, secret);
    await wait(400);
    const png = GLib.file_get_contents('/usr/share/icons/hicolor/48x48/apps/firefox.png')[1] ?? null;
    if (png)
        clip.set_content(St.ClipboardType.CLIPBOARD, 'image/png', GLib.Bytes.new(png));
    await wait(600);
    log(`clipboard: ${part.entries.length} kept: ${part.entries.map(e => e.kind === 'text' ? e.text.split('\n')[0] : 'image').join(' | ')}`);
    part.open();
    await wait(800);
    await shoot('clipboard');
    part._entry.set_text('ssh');
    await wait(300);
    log(`clipboard: "ssh" → ${part._rows.length} row(s)`);
    part._choose(0);
    await wait(400);
    const text = await new Promise(resolve => clip.get_text(St.ClipboardType.CLIPBOARD, (_c, t) => resolve(t)));
    log(`clipboard: chosen → clipboard holds "${text}", panel open ${Boolean(part._dialog)}`);
}

// A real screenshot (Shift+Print, GNOME's own shortcut): Jade's card in the
// corner instead of GNOME's banner; a pin; the color picker; and the hint
// when a tool is missing.
async function capture() {
    const part = Main.extensionManager.lookup(UUID)?.stateObj?._part?.('Capture');
    if (!part) {
        log('capture: none');
        return;
    }
    const seat = Clutter.get_default_backend().get_default_seat();
    const keyboard = seat.create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
    const pointer = seat.create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);
    keyboard.notify_keyval(now(), Clutter.KEY_Shift_L, Clutter.KeyState.PRESSED);
    keyboard.notify_keyval(now(), Clutter.KEY_Print, Clutter.KeyState.PRESSED);
    keyboard.notify_keyval(now(), Clutter.KEY_Print, Clutter.KeyState.RELEASED);
    keyboard.notify_keyval(now(), Clutter.KEY_Shift_L, Clutter.KeyState.RELEASED);
    await wait(1500);
    const banner = Main.messageTray._banner;
    const left = Main.messageTray.getSources().flatMap(source => source.notifications)
        .filter(n => n.title === 'Screenshot captured').length;
    log(`capture: card ${Boolean(part._card)}, GNOME banner ${Boolean(banner?.visible)}, left in the list ${left}`);
    await shoot('capture-card');

    // Pin it, then the color under the pointer.
    const buttons = part._card?.get_last_child()?.get_children() ?? [];
    buttons.find(b => b.accessible_name === 'Pin')?.emit('clicked', 1);
    await wait(700);
    log(`capture: pins ${part._pins.size}, card ${Boolean(part._card)}`);
    await shoot('capture-pin');
    for (const pin of [...part._pins])
        pin.destroy();

    const picked = part.pickColor();
    await wait(400);
    const monitor = Main.layoutManager.primaryMonitor;
    pointer.notify_absolute_motion(now(), monitor.x + 40, monitor.y + monitor.height / 2);
    await wait(300);
    pointer.notify_button(now(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.PRESSED);
    pointer.notify_button(now(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.RELEASED);
    await picked;
    await wait(500);
    const text = await new Promise(resolve => St.Clipboard.get_default().get_text(St.ClipboardType.CLIPBOARD, (_c, t) => resolve(t)));
    log(`capture: picked ${text}`);
    await shoot('capture-color');

    part._missing('tesseract');
    await wait(500);
    await shoot('capture-missing');
    part._dismiss(false);
}

// Dragging in the overview: a window onto another workspace's thumbnail, with
// either glass, and an app from the app grid onto the dock. The dock spans the
// monitor, and drag and drop picks every actor, reactive or not: it once took
// every drop on the screen and refused it.
async function overviewDrags() {
    const dock = Main.extensionManager.lookup(UUID)?.stateObj?._parts?.find(part => part.key === 'show-dock')?.instance;
    const settings = Extension.lookupByUUID(UUID).getSettings();
    const mutter = new Gio.Settings({schema_id: 'org.gnome.mutter'});
    const wm = new Gio.Settings({schema_id: 'org.gnome.desktop.wm.preferences'});
    const [dynamic, count, glass] = [mutter.get_boolean('dynamic-workspaces'), wm.get_int('num-workspaces'),
        settings.get_string('glass')];
    mutter.set_boolean('dynamic-workspaces', false);
    wm.set_int('num-workspaces', 4);
    const app = Shell.AppSystem.get_default().lookup_app('org.gnome.Calculator.desktop');
    app?.activate();
    for (let i = 0; i < 40 && !app?.get_windows().length; i++)
        await wait(250);
    const window = app?.get_windows()[0];
    if (!window || !dock?.bar) {
        log(`drags: no ${window ? 'dock' : 'window'}`);
        return;
    }
    await wait(1000);
    const scene = new DockScene(dock.bar);
    const center = actor => {
        const [x, y] = actor.get_transformed_position();
        const [w, h] = actor.get_transformed_size();
        return [x + w / 2 - scene.monitor.x, y + h / 2 - scene.monitor.y];
    };
    const find = (actor, test) => {
        if (test(actor))
            return actor;
        for (const child of actor.get_children()) {
            const found = find(child, test);
            if (found)
                return found;
        }
        return null;
    };
    // The first drag of a fresh Shell doesn't start (the harness, not Jade):
    // one to warm up.
    Main.overview.show();
    await wait(2500);
    const warm = find(Main.overview._overview, a => a.metaWindow === window && a.visible);
    if (warm)
        await scene.drag(...center(warm), [[center(warm)[0] + 30, center(warm)[1] + 30], center(warm)], 300);
    Main.overview.hide();
    await wait(1500);
    for (const [look, to] of [['solid', 2], ['frosted', 1]]) {
        settings.set_string('glass', look);
        await wait(1000);
        Main.overview.show();
        await wait(2500);
        const preview = find(Main.overview._overview, a => a.metaWindow === window && a.visible);
        const thumbnail = Main.overview._overview.controls._thumbnailsBox._thumbnails[to];
        if (!preview || !thumbnail) {
            log(`drags ${look}: preview ${Boolean(preview)}, thumbnail ${Boolean(thumbnail)}`);
        } else {
            const [x, y] = center(preview);
            await scene.drag(x, y, [[x + 20, y - 20], center(thumbnail)], 500);
            log(`drags ${look}: window dropped on workspace ${to + 1} → on workspace ${window.get_workspace().index() + 1}`);
        }
        Main.overview.hide();
        await wait(1500);
    }

    // An app from the grid onto the dock pins it there.
    const id = 'org.gnome.Calculator.desktop';
    const favorites = () => global.settings.get_strv('favorite-apps');
    const before = favorites();
    Main.overview.showApps();
    await wait(2500);
    const icon = find(Main.overview._overview, a => a.app?.get_id?.() === id && a.visible && a.get_parent() !== null &&
        !dock.bar.actor.contains(a));
    if (icon) {
        const [x, y] = center(icon);
        await scene.drag(x, y, [[x + 20, y - 20], [scene.centerOf(1), scene.iconY - 20], [scene.centerOf(1), scene.iconY]], 700);
        await wait(500);
        log(`drags: grid app dropped on the dock → pinned ${favorites().includes(id)}`);
    } else {
        log('drags: no grid icon');
    }
    global.settings.set_strv('favorite-apps', before);
    Main.overview.hide();
    await wait(1200);
    window.delete(global.get_current_time());
    settings.set_string('glass', glass);
    mutter.set_boolean('dynamic-workspaces', dynamic);
    wm.set_int('num-workspaces', count);
    await wait(800);
}

// Frosted glass: every surface blurs what is behind it. Each shot twice,
// solid then frosted, where the difference shows.
async function glass() {
    const jadeShell = Main.extensionManager.lookup(UUID);
    const settings = jadeShell.getSettings?.() ?? Extension.lookupByUUID(UUID).getSettings();
    const surfaces = async look => {
        settings.set_string('glass', look);
        await wait(800);
        await shoot(`glass-${look}-bar`, Main.panel);
        await panel('jade-picker', `glass-${look}-picker`);
        await panel('quickSettings', `glass-${look}-quick-settings`);
        const menu = jadeShell.stateObj._part('JadeMenu');
        menu.open();
        await wait(900);
        await shoot(`glass-${look}-menu`);
        menu._dialog?.close();
        await wait(700);
        Main.overview.showApps();
        await wait(1800);
        await shoot(`glass-${look}-appgrid`);
        Main.overview.hide();
        await wait(1200);
        Main.osdWindowManager.showAll(new Gio.ThemedIcon({name: 'audio-volume-high-symbolic'}), 'Speakers', 0.8, 1);
        await wait(500);
        await shoot(`glass-${look}-osd`);
        await wait(2500);
    };
    // Isolation test: a bare widget with a background-mode blur.
    const probe = new St.Widget({x: 100, y: 120, width: 500, height: 320, style: 'background-color: rgba(0,0,0,0.15);'});
    probe.add_effect_with_name('probe', new Shell.BlurEffect({mode: Shell.BlurMode.BACKGROUND, radius: 36, brightness: 1}));
    Main.uiGroup.add_child(probe);
    await wait(600);
    await shoot('glass-probe');
    probe.destroy();
    await surfaces('solid');
    await surfaces('frosted');
    // The sliders: a clearer tint and a stronger blur, live.
    settings.set_double('glass-tint', 0.3);
    settings.set_int('glass-blur', 70);
    await wait(600);
    log(`glass: tint 0.3 → top bar blur radius ${Main.panel.get_effect('jade-glass')?.radius}`);
    const pickerBox = Main.panel.statusArea['jade-picker'].menu.box;
    const alphaNow = () => pickerBox.get_theme_node().get_background_color().alpha;
    log(`glass: picker background alpha at tint 0.3: ${alphaNow()}`);
    await panel('jade-picker', 'glass-frosted-clear-picker');
    settings.reset('glass-tint');
    settings.reset('glass-blur');
    await wait(400);
    // A theme switch with the glass on (after the sliders moved) still loads the
    // new theme's colors: the tint stylesheet is in the theme once, never as a null.
    const sheets = () => St.ThemeContext.get_for_stage(global.stage).get_theme().get_custom_stylesheets();
    const glassSheets = () => sheets().filter(file => file?.get_basename() === 'jade-shell-glass.css').length;
    log(`glass: stylesheets ${sheets().length}, nulls ${sheets().filter(file => !file).length}, glass tint loaded ${glassSheets()}x`);
    await jade('theme', 'set', 'tokyo-night', '--only', 'gnome,shell');
    await wait(3000);
    const accent = Main.panel.statusArea['jade-picker'].menu.box.get_theme_node().get_border_color(St.Side.TOP);
    log(`glass: after a switch to Tokyo Night: nulls ${sheets().filter(file => !file).length}, glass tint ${glassSheets()}x, ` +
        `picker border #${[accent.red, accent.green, accent.blue].map(c => c.toString(16).padStart(2, '0')).join('')} (Tokyo Night's accent is #7aa2f7)`);
    await jade('theme', 'set', THEMES[0], '--only', 'gnome,shell');
    await wait(3000);
    const back = Main.panel.statusArea['jade-picker'].menu.box.get_theme_node().get_border_color(St.Side.TOP);
    log(`glass: and back: nulls ${sheets().filter(file => !file).length}, picker border ` +
        `#${[back.red, back.green, back.blue].map(c => c.toString(16).padStart(2, '0')).join('')}`);
    log(`glass: picker background alpha at the default tint: ${alphaNow()}`);
    const frostedCount = [Main.panel].filter(actor => actor.get_effect('jade-glass')).length;
    log(`glass: frosted, top bar blurred ${frostedCount === 1}, ui group class ${Main.uiGroup.has_style_class_name('jade-frosted')}`);
    // Whole frames while a frosted menu is open (windows changing under it
    // flickered it otherwise), and only then.
    const whole = () => Boolean(Clutter.get_debug_flags()[1] & Clutter.DrawDebugFlag.DISABLE_CLIPPED_REDRAWS);
    const idle = whole();
    Main.panel.statusArea.dateMenu.menu.open();
    await wait(800);
    const open = whole();
    Main.panel.statusArea.dateMenu.menu.close();
    await wait(800);
    log(`glass: whole frames at rest ${idle}, calendar open ${open}, closed ${whole()}`);
    settings.set_string('glass', 'solid');
    await wait(500);
    log(`glass: solid again, top bar blurred ${Boolean(Main.panel.get_effect('jade-glass'))}, class ${Main.uiGroup.has_style_class_name('jade-frosted')}`);
}

// The network panel: the real connection first; then, fed like jade network
// would, Wi-Fi, a speed test on its way and done, and the Wi-Fi as a QR code.
async function networkPanel() {
    const part = Main.extensionManager.lookup(UUID)?.stateObj?._part?.('Network');
    if (!part) {
        log('network: none');
        return;
    }
    // In the bar, in place of GNOME's network icon (and GNOME's back when it's off).
    const gnome = Main.panel.statusArea.quickSettings._network;
    const settings = Main.extensionManager.lookup(UUID).stateObj._settings;
    log(`network: bar icon shown ${part._button.visible} (${part._icon.icon_name}), GNOME's icon shown ${gnome?.visible}`);
    await shoot('network-bar', Main.panel);
    settings.set_boolean('show-network', false);
    await wait(300);
    log(`network: off → bar icon shown ${part._button.visible}, GNOME's icon shown ${gnome?.visible}`);
    settings.set_boolean('show-network', true);
    await wait(300);
    log(`network: on again → bar icon shown ${part._button.visible}, GNOME's icon shown ${gnome?.visible}`);
    part.toggle();
    await wait(2500);  // jade network status pings the router and 1.1.1.1
    log(`network: open ${part._button.menu.isOpen}, ${part._title.text} · ${part._meta.text} · internet ${part._facts.internet.text}`);
    await shoot('network-real', part._button.menu.box);
    part._stopRefresh();
    part._show({
        connected: true, type: 'wifi', device: 'wlan0', ssid: 'Jade Home', band: '5', channel: '36', rate: '866 Mbit/s',
        signal: 78, security: 'WPA2', address: '192.168.1.42', gateway: '192.168.1.1', ping_router: 1.8, ping_internet: 9.6,
        dns_servers: ['1.1.1.1', '1.0.0.1'], dns: 'cloudflare', band_pin: 'auto', last_speedtest: null,
    });
    part._test = {force_exit() {}};
    part._testButton._label.text = 'Stop';
    part._onTestEvent({phase: 'ping', ms: 7.4, jitter: 0.4, server: 'DAC'});
    for (const mbps of [12, 48, 81, 92.4])
        part._onTestEvent({phase: 'down', mbps, progress: 0.5});
    part._onTestEvent({phase: 'up', mbps: 37.5, progress: 0.3});
    await wait(500);
    await shoot('network-testing', part._button.menu.box);
    part._onTestEvent({phase: 'done', down: 93.6, up: 94.1, ping: 7.4, jitter: 0.4, server: 'DAC', when: Date.now() / 1000});
    part._endTest();
    const dir = GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]);
    const qr = JSON.parse(new TextDecoder().decode(GLib.file_get_contents(`${dir}/qr-sample.json`)[1]));
    part._qr.show(qr.matrix);
    part._qr.actor.visible = true;
    part._qrCaption.text = `Scan with a phone camera to join ${qr.ssid}`;
    part._qrCaption.visible = true;
    part._shareButton._label.text = 'Hide QR Code';
    part._speedSection.get_parent().visible = false;
    await wait(500);
    await shoot('network-wifi', part._button.menu.box);
    part.toggle();
    await wait(400);
    log(`network: closed ${!part._button.menu.isOpen}`);
}

// More themes than fit (community ones installed): the picker scrolls, and
// the keyboard keeps the focused tile in view.
async function pickerScrolls() {
    const base = GLib.build_filenamev([GLib.get_user_config_dir(), 'jade-shell', 'themes']);
    const colors = 'background = "#1d2021"\nforeground = "#d5c4a1"\naccent = "#83a598"\nred = "#fb4934"\n' +
        'green = "#b8bb26"\nyellow = "#fabd2f"\nblue = "#83a598"\nmagenta = "#d3869b"\ncyan = "#8ec07c"\n';
    const names = Array.from({length: 12}, (_, i) => `community-${i + 1}`);
    for (const name of names) {
        GLib.mkdir_with_parents(`${base}/${name}`, 0o755);
        GLib.file_set_contents(`${base}/${name}/colors.toml`, colors);
        GLib.file_set_contents(`${base}/${name}/source.json`, '{"url": "https://example.org/theme.git"}');
    }
    const picker = Main.panel.statusArea['jade-picker'];
    const part = Main.extensionManager.lookup(UUID)?.stateObj?._part?.('Picker');
    const closedBy = [];
    const watch = picker.menu.connect('open-state-changed', (_m, open) => !open && closedBy.push(new Error().stack.split('\n').slice(1, 8).join(' | ')));
    picker.menu.open(false);
    await wait(2500);  // jade theme list
    picker.menu.disconnect(watch);
    if (closedBy.length)
        log(`picker: closed by ${closedBy[0]}`);
    const adjustment = part._scroll.vadjustment;
    log(`picker: ${part._tiles.size} themes, still open ${picker.menu.isOpen}, scrolls ${adjustment.upper > adjustment.page_size + 1}`);
    [...part._tiles.values()].pop().grab_key_focus();
    await wait(500);
    log(`picker: last tile focused → scrolled to ${Math.round(adjustment.value)} of ${Math.round(adjustment.upper - adjustment.page_size)}`);
    await shoot('picker-community', picker.menu.box);
    picker.menu.close(false);
    for (const name of names)
        Gio.File.new_for_path(`${base}/${name}`).trash(null);
    await wait(400);
}

// GNOME's pop-ups and dialogs in the theme: volume, a password prompt (as
// polkit draws it), Run a Command; the lock screen last (it stays locked).
async function popups() {
    const ModalDialog = await import('resource:///org/gnome/shell/ui/modalDialog.js');
    const Dialog = await import('resource:///org/gnome/shell/ui/dialog.js');
    Main.osdWindowManager.showAll(new Gio.ThemedIcon({name: 'audio-volume-medium-symbolic'}), 'Speakers', 0.62, 1);
    await wait(500);
    await shoot('popup-volume');
    await wait(2500);

    const dialog = new ModalDialog.ModalDialog({styleClass: 'prompt-dialog'});
    const content = new Dialog.MessageDialogContent({
        title: 'Authentication Required',
        description: 'Authentication is required to update Jade Shell',
    });
    const entry = new St.PasswordEntry({style_class: 'prompt-dialog-password-entry', hint_text: 'Password', can_focus: true});
    content.add_child(entry);
    dialog.contentLayout.add_child(content);
    dialog.setButtons([{label: 'Cancel', action: () => dialog.close(), key: Clutter.KEY_Escape},
        {label: 'Authenticate', action: () => dialog.close(), default: true}]);
    dialog.open(global.get_current_time());
    await wait(900);
    await shoot('popup-password');
    dialog.close();
    await wait(700);

    Main.openRunDialog();
    await wait(900);
    await shoot('popup-run');
    Main.overview.hide();
    global.stage.get_key_focus()?.get_parent?.();
    const run = Main.uiGroup.get_children().find(actor => actor.constructor.name.includes('RunDialog'));
    run?.close?.();
    await wait(700);
}

async function lockScreen() {
    Main.screenShield.lock(false);
    await wait(2500);
    await shoot('lock-curtain');
    const keyboard = Clutter.get_default_backend().get_default_seat().create_virtual_device(
        Clutter.InputDeviceType.KEYBOARD_DEVICE);
    keyboard.notify_keyval(now(), Clutter.KEY_space, Clutter.KeyState.PRESSED);
    keyboard.notify_keyval(now(), Clutter.KEY_space, Clutter.KeyState.RELEASED);
    await wait(2000);
    await shoot('lock-prompt');
    keyboard.notify_keyval(now(), Clutter.KEY_Escape, Clutter.KeyState.PRESSED);
    keyboard.notify_keyval(now(), Clutter.KEY_Escape, Clutter.KeyState.RELEASED);
    await wait(1500);
    await shoot('lock-clock');
    log(`lock screen: locked ${Main.screenShield.locked}`);
}

// Modes shown while on: stay awake by its shortcut (GNOME's session manager
// is not in this shell, so only the attempt shows), Do Not Disturb with the
// bell off, turned off by a click.
async function modes() {
    const part = Main.extensionManager.lookup(UUID)?.stateObj?._parts?.find(p => p.instance?.constructor.name === 'Modes')?.instance;
    if (!part) {
        log('modes: none');
        return;
    }
    const settings = Extension.lookupByUUID(UUID).getSettings();
    const notifications = new Gio.Settings({schema_id: 'org.gnome.desktop.notifications'});
    settings.set_boolean('notification-bell', false);
    notifications.set_boolean('show-banners', false);
    await wait(600);
    log(`modes: DND with the bell off → shown ${part._icons.dnd.visible}, bar ${part._button.visible}`);
    await shoot('modes-dnd', Main.panel);
    part._icons.dnd.emit('clicked', 1);
    await wait(400);
    log(`modes: clicked → Do Not Disturb ${!notifications.get_boolean('show-banners')}, bar ${part._button.visible}`);
    settings.set_boolean('notification-bell', true);
    part.setAwake(true);
    await wait(800);
    log(`modes: stay awake → cookie ${part._cookie ?? 0}, quick toggle ${part._quick.toggle.checked}`);
    part.setAwake(false);
    await wait(300);
}

// Super+K: the cheat sheet, searched, then closed with Escape.
async function cheatSheet() {
    const sheet = Main.extensionManager.lookup(UUID)?.stateObj?._parts?.find(p => p.instance?.constructor.name === 'CheatSheet')?.instance;
    const keyboard = Clutter.get_default_backend().get_default_seat().create_virtual_device(
        Clutter.InputDeviceType.KEYBOARD_DEVICE);
    const press = async (...keys) => {
        for (const key of keys)
            keyboard.notify_keyval(now(), key, Clutter.KeyState.PRESSED);
        for (const key of keys.reverse())
            keyboard.notify_keyval(now(), key, Clutter.KeyState.RELEASED);
        await wait(250);
    };
    // A shortcut of one's own, added before opening: it is listed.
    const media = new Gio.Settings({schema_id: 'org.gnome.settings-daemon.plugins.media-keys'});
    const path = '/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/jadetest/';
    const custom = new Gio.Settings({schema_id: 'org.gnome.settings-daemon.plugins.media-keys.custom-keybinding', path});
    custom.set_string('name', 'Open the Harness Terminal');
    custom.set_string('command', 'kitty');
    custom.set_string('binding', '<Super>Return');
    media.set_strv('custom-keybindings', [...media.get_strv('custom-keybindings'), path]);
    await press(Clutter.KEY_Super_L, Clutter.KEY_k);
    await wait(900);
    const list = sheet?._dialog?.contentLayout.get_child_at_index(2)?.child;
    log(`cheat sheet: open ${Boolean(sheet?._dialog)}, ${list?.get_n_children()} lines`);
    await shoot('cheatsheet');
    for (const key of [Clutter.KEY_w, Clutter.KEY_o, Clutter.KEY_r, Clutter.KEY_k])
        await press(key);
    await wait(400);
    log(`cheat sheet: "work" → ${list?.get_n_children()} lines`);
    const entry = sheet?._dialog?.contentLayout.get_child_at_index(1);
    entry?.set_text('harness');
    await wait(300);
    const found = list?.get_children().map(line => line.get_first_child?.()?.text ?? line.text).filter(Boolean);
    log(`cheat sheet: "harness" → ${found?.join(' | ')}`);
    await shoot('cheatsheet-search');
    await press(Clutter.KEY_Escape);
    await wait(700);
    log(`cheat sheet: after Escape open ${Boolean(sheet?._dialog)}`);
}

// The bell's shortcuts, pressed on a virtual keyboard, and its dot.
async function bellShortcuts() {
    const bell = Main.extensionManager.lookup(UUID)?.stateObj?._parts?.find(p => p.key === 'notification-bell')?.instance;
    if (!bell) {
        log('bell shortcuts: no bell');
        return;
    }
    const keyboard = Clutter.get_default_backend().get_default_seat().create_virtual_device(
        Clutter.InputDeviceType.KEYBOARD_DEVICE);
    const press = async (...keys) => {
        for (const key of keys)
            keyboard.notify_keyval(now(), key, Clutter.KeyState.PRESSED);
        for (const key of keys.reverse())
            keyboard.notify_keyval(now(), key, Clutter.KeyState.RELEASED);
        await wait(500);
    };
    const count = () => Main.messageTray.getSources().flatMap(source => source.notifications).length;
    const source = new MessageTray.Source({title: 'Harness'});
    Main.messageTray.add(source);
    for (const title of ['One', 'Two', 'Three'])
        source.addNotification(new MessageTray.Notification({source, title, body: ''}));
    await wait(800);
    log(`bell shortcuts: ${count()} notifications, dot ${bell._dot.visible}`);
    await press(Clutter.KEY_Super_L, Clutter.KEY_comma);
    log(`bell shortcuts: Super+comma → ${count()}`);
    const dnd = () => !bell._settings.get_boolean('show-banners');
    await press(Clutter.KEY_Super_L, Clutter.KEY_Control_L, Clutter.KEY_comma);
    log(`bell shortcuts: Super+Ctrl+comma → Do Not Disturb ${dnd()}`);
    await press(Clutter.KEY_Super_L, Clutter.KEY_Control_L, Clutter.KEY_comma);
    await press(Clutter.KEY_Super_L, Clutter.KEY_Shift_L, Clutter.KEY_comma);
    log(`bell shortcuts: Super+Shift+comma → ${count()}, dot ${bell._dot.visible}`);
    await press(Clutter.KEY_Super_L, Clutter.KEY_Shift_L, Clutter.KEY_Alt_L, Clutter.KEY_comma);
    log(`bell shortcuts: Super+Shift+Alt+comma → panel open ${bell._button.menu.isOpen}`);
    bell._button.menu.close();
    await wait(300);
}

// The bell off puts GNOME's list, Clear row, unread dot and pop-up place back;
// on again takes them. Logs "HARNESS bell …" lines and shoots the calendar.
async function bellRoundTrip() {
    const settings = Extension.lookupByUUID(UUID)?.getSettings();
    const dateMenu = Main.panel.statusArea.dateMenu;
    const list = dateMenu._messageList;
    const where = () => {
        const clockBox = dateMenu._clockDisplay.get_parent();
        return [`list in ${list.get_parent()?.name || list.get_parent()?.style_class}`,
            `clear row ${list._clearButton.get_parent().visible ? 'shown' : 'hidden'}`,
            `clock box ${clockBox.get_children().map(c => c.constructor.name).join(',')}`,
            `banners ${Main.messageTray.bannerAlignment}`,
            `bell ${Main.panel.statusArea['jade-bell'] ? 'in bar' : 'gone'}`,
            `toggleCalendar ${Object.hasOwn(Main.panel, 'toggleCalendar') ? 'ours' : 'GNOME'}`].join('; ');
    };
    log(`bell on: ${where()}`);
    settings.set_boolean('notification-bell', false);
    await wait(500);
    log(`bell off: ${where()}`);
    await panel('dateMenu', 'bell-off-calendar');
    settings.set_boolean('notification-bell', true);
    await wait(500);
    log(`bell on again: ${where()}`);
    await panel('jade-bell', 'bell-on-again');
}

// The bar clock follows GNOME's 12h/24h and seconds settings live, unless a
// format of the user's own is set. Logs "HARNESS clock …" lines.
async function clockFollowsGnome() {
    const iface = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
    const jade = Extension.lookupByUUID(UUID)?.getSettings();
    const text = () => Main.panel.statusArea.dateMenu._clockDisplay.get_parent().get_children()
        .filter(c => c instanceof St.Label && c.visible).map(c => c.text).join(' | ');
    const show = async what => {
        await wait(400);
        log(`clock ${what}: ${text()}`);
    };
    iface.set_string('clock-format', '24h');
    await show('24h');
    iface.set_string('clock-format', '12h');
    await show('12h');
    iface.set_boolean('clock-show-seconds', true);
    await show('12h with seconds');
    jade.set_string('clock-format', '%H.%M');
    await show('own format %H.%M');
    jade.reset('clock-format');
    iface.reset('clock-show-seconds');
    iface.reset('clock-format');
    await show('back to the locale\'s default');
    await shoot('clock-12h-check', Main.panel.statusArea.dateMenu);
}

// High Contrast shows GNOME's own high-contrast Shell, and turning it off
// brings Jade's theme back. Logs "HARNESS contrast …" lines.
async function highContrast() {
    const a11y = new Gio.Settings({schema_id: 'org.gnome.desktop.a11y.interface'});
    const sheet = () => Main.getThemeStylesheet()?.get_basename() ?? 'GNOME\'s own';
    log(`contrast off: ${sheet()}`);
    a11y.set_boolean('high-contrast', true);
    await wait(1500);
    log(`contrast on: ${sheet()}`);
    await shoot('high-contrast-on', Main.panel);
    a11y.reset('high-contrast');
    await wait(1500);
    log(`contrast off again: ${sheet()}`);
}

// ------------------------------------------------------------------ timing
//
// For each Jade menu and, as a baseline, GNOME's clock and quick settings:
//   open    a cold first open, then $JADE_ROUNDS warm re-opens, each the way
//           a click opens it (PopupAnimation.FULL, pointer on the button);
//   switch  with a menu open, the pointer moves onto the next button through
//           a virtual pointer, so GNOME's own PopupMenuManager sees the enter
//           event and runs _changeMenu → newMenu.open(FADE), exactly as a
//           hover does ($JADE_ROUNDS rounds of monitor→usage→picker→monitor,
//           and GNOME's clock ↔ quick settings), then the same as a 250 ms
//           sweep, without the GPU readout, and without animations;
//   calibrate  how evenly the headless shell paints with nothing else to do;
//   spawn   what starting a process costs the main thread, also at the live
//           Shell's size ($JADE_LIVE_MB, which run.sh reads from /proc).
//
// Times are from the trigger (the open() call, or the pointer motion):
//   lat     trigger → the new menu's open() starts (event delivery)
//   sync    open() on the main thread, with every open-state-changed handler
//           (the menu manager's grab, the old menu's close, the part's own)
//   first   trigger → the end of the first frame painted after open()
//   half    trigger → first painted frame with the menu at ≥ 50% opacity
//   done    trigger → first painted frame with the menu fully opaque
//   f300    frames painted in the 300 ms after the trigger
//   gap     longest interval between painted frames while the menu animates
//   drop    frames missed while it animates (interval / frame period − 1)
//   work    the longest frame update (events, layout, paint) in the window
//   block   the longest the main loop went without running a 2 ms probe in
//           the window (about the longest main-thread stall, + ≤ 2 ms)
//   faults  the Shell's minor page faults in the 300 ms after the trigger
//   spans   the parts' own methods (and GNOME's, as gnome.*) that ran in the
//           window, summed; "async" is how long a promise took to settle
// JADE_FRAMES=1 also logs every frame and main-loop stall of each window.

const ROUNDS = Number(GLib.getenv('JADE_ROUNDS') || 10);
const JADE_ROLES = ['jade-monitor', 'jade-usage', 'jade-picker'];
const BASE_ROLES = ['dateMenu', 'quickSettings'];
const PROBE_MS = 2;
const FRAME_TRACE = GLib.getenv('JADE_FRAMES') === '1';
// Methods of Jade's parts that run when a menu opens, or soon after.
const PART_METHODS = {
    Monitor: ['_refreshDisks', '_syncActive', '_syncGpu', '_startNvidia', '_stopNvidia', '_tick', '_buildCores', '_nextTagline'],
    Usage: ['_onOpened', '_renderMenu', '_runCollector'],
    Picker: ['_refresh', '_buildGrid'],
};

const now = () => GLib.get_monotonic_time();

// Minor page faults of the whole Shell so far (/proc/self/stat field 10). A
// fork() leaves every page copy-on-write, so the Shell faults afterwards.
function minorFaults() {
    try {
        const [, bytes] = GLib.file_get_contents('/proc/self/stat');
        const text = new TextDecoder().decode(bytes);
        return Number(text.slice(text.lastIndexOf(')') + 2).split(' ')[7]);
    } catch {
        return NaN;
    }
}

function residentMb() {
    try {
        const status = new TextDecoder().decode(GLib.file_get_contents('/proc/self/status')[1]);
        return Math.round(Number(status.match(/^VmRSS:\s+(\d+) kB/m)[1]) / 1024);
    } catch {
        return NaN;
    }
}

function memoryText() {
    try {
        const status = new TextDecoder().decode(GLib.file_get_contents('/proc/self/status')[1]);
        const field = key => status.match(new RegExp(`^${key}:\\s+(\\d+) kB`, 'm'))?.[1];
        const maps = new TextDecoder().decode(GLib.file_get_contents('/proc/self/maps')[1]).split('\n').length - 1;
        return `VmRSS ${Math.round(field('VmRSS') / 1024)} MB, VmPTE ${field('VmPTE')} kB, ${maps} mappings`;
    } catch (e) {
        return e.message;
    }
}

const ms = us => us === null || us === undefined || !Number.isFinite(us) ? '-' : (us / 1000).toFixed(1);

function median(values) {
    const v = values.filter(Number.isFinite).sort((a, b) => a - b);
    if (!v.length)
        return NaN;
    return v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2;
}

function max(values) {
    const v = values.filter(Number.isFinite);
    return v.length ? Math.max(...v) : NaN;
}

class Timing {
    constructor() {
        this.frames = [];
        this.blocks = [];
        this.spans = [];
        this.results = [];
        this.watch = [];
        this.lastOpen = null;
        this._cur = null;
        this._openWaiters = new Map();
    }

    // ------------------------------------------------------------ recording

    start() {
        const stage = global.stage;
        this._stageIds = [
            stage.connect('before-update', () => {
                this._cur = {bu: now(), bp: 0, ap: 0, au: 0, ops: null};
            }),
            stage.connect('before-paint', () => {
                if (this._cur)
                    this._cur.bp = now();
            }),
            stage.connect('after-paint', () => {
                if (!this._cur)
                    return;
                this._cur.ap = now();
                if (this.watch.length)
                    this._cur.ops = this.watch.map(a => a.opacity);
            }),
            stage.connect('after-update', () => {
                if (this._cur) {
                    this._cur.au = now();
                    this.frames.push(this._cur);
                }
                this._cur = null;
            }),
        ];
        // Not 'presented': GJS cannot convert its frame-info pointer, and
        // throws on every frame. Headless, a frame is presented as it is painted.

        // A main-loop probe: a gap between two runs is time the main thread
        // spent on something else (a handler, a frame, a garbage collection).
        this._last = now();
        this._probe = GLib.timeout_add(GLib.PRIORITY_DEFAULT, PROBE_MS, () => {
            const t = now();
            if (t - this._last > 3 * PROBE_MS * 1000)
                this.blocks.push({t: this._last, end: t});
            this._last = t;
            return GLib.SOURCE_CONTINUE;
        });

        const backend = global.stage.get_context?.().get_backend?.() ?? Clutter.get_default_backend();
        this.pointer = backend.get_default_seat().create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);
        const view = global.stage.peek_stage_views()[0];
        this.hz = view?.get_refresh_rate?.() ?? view?.refresh_rate ?? 60;
        this.period = 1e6 / this.hz;
    }

    stop() {
        this._stageIds.forEach(id => global.stage.disconnect(id));
        GLib.source_remove(this._probe);
        this.pointer = null;
    }

    span(label, t, dur) {
        this.spans.push({label, t, dur});
    }

    // Time a method on an object, and when it returns a promise, the promise too.
    instrument(object, name, label) {
        const original = object[name];
        if (typeof original !== 'function')
            return;
        const self = this;
        object[name] = function (...args) {
            const t0 = now();
            const result = original.apply(this, args);
            self.span(label, t0, now() - t0);
            if (result instanceof Promise)
                result.finally(() => self.span(`${label}(done)`, t0, now() - t0)).catch(() => {});
            return result;
        };
    }

    instrumentMenu(role, menu) {
        const self = this;
        const open = menu.open;
        menu.open = function (animate) {
            const wasOpen = this.isOpen;
            const inFrame = self._cur !== null;
            const t0 = now();
            open.call(this, animate);
            const t1 = now();
            if (wasOpen || !this.isOpen)
                return;
            const record = {role, t0, t1, animate, inFrame};
            self.lastOpen = record;
            self.span(`${role}.open`, t0, t1 - t0);
            self._openWaiters.get(this)?.(record);
        };
        const close = menu.close;
        menu.close = function (animate) {
            const t0 = now();
            close.call(this, animate);
            self.span(`${role}.close`, t0, now() - t0);
        };
    }

    instrumentParts() {
        const parts = Main.extensionManager.lookup(UUID)?.stateObj?._parts ?? [];
        for (const part of parts) {
            const name = part.instance?.constructor?.name;
            for (const method of PART_METHODS[name] ?? [])
                this.instrument(part.instance, method, `${name}.${method}`);
        }
        for (const role of [...JADE_ROLES, ...BASE_ROLES]) {
            const menu = Main.panel.statusArea[role]?.menu;
            if (!menu) {
                log(`TIMING no ${role} in the top bar`);
                continue;
            }
            this.instrumentMenu(role, menu);
            // GNOME's own share of open(): placing the box and starting its animation.
            if (menu._boxPointer) {
                this.instrument(menu._boxPointer, 'setPosition', 'gnome.BoxPointer.setPosition');
                this.instrument(menu._boxPointer, 'open', 'gnome.BoxPointer.open');
                this.instrument(menu._boxPointer, 'close', 'gnome.BoxPointer.close');
            }
        }
        // Main.pushModal/popModal: the grab and the key focus they move.
        this.instrument(global.stage, 'grab', 'gnome.stage.grab');
        this.instrument(global.stage, 'set_key_focus', 'gnome.stage.set_key_focus');
    }

    waitOpen(menu, timeoutMs) {
        return new Promise(resolve => {
            const timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, timeoutMs, () => {
                this._openWaiters.delete(menu);
                resolve(null);
                return GLib.SOURCE_REMOVE;
            });
            this._openWaiters.set(menu, record => {
                GLib.source_remove(timer);
                this._openWaiters.delete(menu);
                resolve(record);
            });
        });
    }

    moveTo(actor) {
        const [x, y] = actor.get_transformed_position();
        const [w, h] = actor.get_transformed_size();
        this.pointer.notify_absolute_motion(now(), x + w / 2, y + h / 2);
    }

    // ------------------------------------------------------------ analysis

    analyse({op, group, name, t0, record, windowMs, tailMs, faults = NaN}) {
        const end = t0 + windowMs * 1000;
        const tail = t0 + tailMs * 1000;
        const t1 = record?.t1 ?? t0;
        const painted = this.frames.filter(f => f.ap && f.ap >= t0 && f.ap <= tail);
        const first = painted.find(f => f.ap >= t1);
        const opacityFrame = level => painted.find(f => f.ap >= t1 && f.ops && f.ops[0] >= level);
        const half = opacityFrame(128);
        const done = opacityFrame(255);
        const inWindow = painted.filter(f => f.ap <= end);
        // Paint intervals while the new menu animates in: first frame → fully shown.
        const animating = painted.filter(f => first && f.ap >= first.ap && f.ap <= (done ?? first).ap);
        let gap = 0;
        let drop = 0;
        for (let i = 1; i < animating.length; i++) {
            const d = animating[i].ap - animating[i - 1].ap;
            gap = Math.max(gap, d);
            drop += Math.max(0, Math.round(d / this.period) - 1);
        }
        const updated = this.frames.filter(f => f.au >= t0 && f.bu <= end);
        const work = max(updated.map(f => f.au - f.bu));
        const blocks = this.blocks.filter(b => b.end >= t0 && b.t <= tail);
        const spans = new Map();
        for (const s of this.spans.filter(x => x.t >= t0 && x.t <= tail && !x.label.endsWith('(done)')))
            spans.set(s.label, (spans.get(s.label) ?? 0) + s.dur);
        const waits = this.spans.filter(x => x.t >= t0 && x.t <= tail && x.label.endsWith('(done)'));
        const result = {
            op, group, name,
            how: record ? 'hover' : 'none',
            lat: record ? record.t0 - t0 : NaN,
            sync: record ? record.t1 - record.t0 : NaN,
            inFrame: record?.inFrame ?? false,
            first: first ? first.ap - t0 : NaN,
            firstPaint: first ? first.ap - first.bp : NaN,
            firstLayout: first ? first.bp - first.bu : NaN,
            half: half ? half.ap - t0 : NaN,
            done: done ? done.ap - t0 : NaN,
            f300: inWindow.length,
            gap: animating.length > 1 ? gap : NaN,
            drop: animating.length > 1 ? drop : NaN,
            work,
            block: blocks.length ? max(blocks.map(b => b.end - b.t)) - PROBE_MS * 1000 : 0,
            faults,
            spans,
            waits,
        };
        this.results.push(result);
        const spanText = [...spans].sort((a, b) => b[1] - a[1]).map(([l, d]) => `${l}:${ms(d)}`).join(' ');
        const waitText = waits.map(w => `${w.label}:${ms(w.dur)}`).join(' ');
        log(`TIMING ${op} ${group} ${name} lat=${ms(result.lat)} sync=${ms(result.sync)}${result.inFrame ? '(in-frame)' : ''} ` +
            `first=${ms(result.first)} [layout ${ms(result.firstLayout)} paint ${ms(result.firstPaint)}] half=${ms(result.half)} ` +
            `done=${ms(result.done)} f300=${result.f300} gap=${ms(result.gap)} drop=${result.drop} work=${ms(result.work)} ` +
            `block=${ms(result.block)} faults=${faults} | ${spanText}${waitText ? ` | async ${waitText}` : ''}`);
        if (FRAME_TRACE) {
            // Each frame: when it started after the trigger, then its events and
            // layout / paint / rest of the update, and the menu's opacity.
            const trace = this.frames.filter(f => f.au >= t0 && f.bu <= tail).slice(0, 40).map(f =>
                `+${ms(f.bu - t0)}(${f.ap ? `${ms(f.bp - f.bu)}/${ms(f.ap - f.bp)}/${ms(f.au - f.ap)}` : `${ms(f.au - f.bu)} no paint`}` +
                `${f.ops ? ` o${f.ops[0]}` : ''})`).join(' ');
            const blockText = blocks.map(b => `+${ms(b.t - t0)}:${ms(b.end - b.t)}`).join(' ');
            const spanTimes = this.spans.filter(x => x.t >= t0 && x.t <= tail).map(x => `${x.label}@+${ms(x.t - t0)}:${ms(x.dur)}`).join(' ');
            log(`TIMING frames ${op} ${group} ${name}: ${trace}`);
            log(`TIMING blocks ${op} ${group} ${name}: ${blockText} | ${spanTimes}`);
        }
        return result;
    }

    // ------------------------------------------------------------ scenarios

    async open(role, group, count) {
        const button = Main.panel.statusArea[role];
        if (!button)
            return;
        for (let i = 0; i < count; i++) {
            this.moveTo(button);
            await wait(300);
            this.watch = [button.menu.actor];
            const f0 = minorFaults();
            const t0 = now();
            button.menu.open(BoxPointer.PopupAnimation.FULL);
            const record = this.lastOpen?.t0 >= t0 ? this.lastOpen : null;
            await wait(300);
            const faults = minorFaults() - f0;
            await wait(700);
            this.watch = [];
            this.analyse({op: 'open', group, name: role, t0, record, windowMs: 300, tailMs: 1000, faults});
            button.menu.close(BoxPointer.PopupAnimation.FULL);
            await wait(600);
        }
    }

    async switches(roles, group, spacingMs = 900) {
        const buttons = roles.map(r => Main.panel.statusArea[r]);
        if (buttons.some(b => !b))
            return;
        this.moveTo(buttons[0]);
        await wait(300);
        buttons[0].menu.open(BoxPointer.PopupAnimation.FULL);
        await wait(1200);
        for (let round = 0; round < ROUNDS; round++) {
            for (let i = 1; i <= buttons.length; i++) {
                const from = buttons[(i - 1) % buttons.length];
                const to = buttons[i % buttons.length];
                const name = `${roles[(i - 1) % roles.length]}→${roles[i % roles.length]}`;
                this.watch = [to.menu.actor, from.menu.actor];
                const opened = this.waitOpen(to.menu, Math.max(spacingMs, 500));
                const f0 = minorFaults();
                const t0 = now();
                this.moveTo(to);
                let record = await opened;
                if (!record) {
                    // The hover did not switch menus: say so, and switch the
                    // way the menu manager would, so the round still runs.
                    log(`TIMING ${group} ${name}: hover did not switch, calling _changeMenu`);
                    const t = now();
                    Main.panel.menuManager._changeMenu(to.menu);
                    record = this.lastOpen?.t0 >= t ? {...this.lastOpen, direct: true} : null;
                }
                const windowMs = Math.min(300, spacingMs);
                await wait(Math.max(0, windowMs - (now() - t0) / 1000));
                const faults = minorFaults() - f0;
                await wait(Math.max(0, spacingMs - (now() - t0) / 1000));
                this.watch = [];
                const result = this.analyse({op: 'switch', group, name, t0, record, windowMs, tailMs: spacingMs, faults});
                if (record?.direct)
                    result.how = 'direct';
            }
        }
        Main.panel.menuManager.activeMenu?.close(BoxPointer.PopupAnimation.NONE);
        await wait(800);
    }

    // ------------------------------------------------------------ summary

    summarise() {
        const groups = new Map();
        for (const r of this.results) {
            const key = r.op === 'switch' ? `${r.op} ${r.group} ${r.name.split('→')[1]}` : `${r.op} ${r.group} ${r.name}`;
            if (!groups.has(key))
                groups.set(key, []);
            groups.get(key).push(r);
        }
        const metrics = ['lat', 'sync', 'first', 'firstPaint', 'half', 'done', 'f300', 'gap', 'drop', 'work', 'block', 'faults'];
        const pad = (s, n) => String(s).padStart(n);
        log(`TIMING SUMMARY refresh ${this.hz.toFixed(1)} Hz (frame ${ms(this.period)} ms); ms unless a count; median/max over n`);
        log(`TIMING SUMMARY ${'group'.padEnd(46)} ${pad('n', 3)} ${metrics.map(m => pad(m, 11)).join(' ')}`);
        for (const [key, rows] of groups) {
            const cells = metrics.map(m => {
                const values = rows.map(r => r[m]);
                const count = m === 'f300' || m === 'drop' || m === 'faults';
                const f = v => !Number.isFinite(v) ? '-' : count ? String(v) : ms(v);
                return pad(`${f(median(values))}/${f(max(values))}`, 11);
            });
            log(`TIMING SUMMARY ${key.padEnd(46)} ${pad(rows.length, 3)} ${cells.join(' ')}`);
        }
        // Where the time goes: each method's median and max per occurrence group.
        for (const [key, rows] of groups) {
            const labels = new Map();
            for (const r of rows) {
                for (const [label, dur] of r.spans) {
                    if (!labels.has(label))
                        labels.set(label, []);
                    labels.get(label).push(dur);
                }
            }
            const text = [...labels].sort((a, b) => median(b[1]) - median(a[1])).slice(0, 8)
                .map(([label, durs]) => `${label} ${ms(median(durs))}/${ms(max(durs))}×${durs.length}`).join(', ');
            log(`TIMING SPANS ${key}: ${text}`);
        }
        const hover = this.results.filter(r => r.op === 'switch');
        log(`TIMING switches by hover ${hover.filter(r => r.how === 'hover').length}/${hover.length}, ` +
            `in a frame update ${hover.filter(r => r.inFrame).length}/${hover.length}`);
    }

    // How evenly the headless shell paints when nothing else runs: a small
    // square fades for 500 ms, so every frame has something to paint.
    async calibrate() {
        const square = new St.Widget({width: 8, height: 8, x: 0, y: 0, style: 'background-color: #808080;'});
        Main.layoutManager.uiGroup.add_child(square);
        await wait(300);
        for (let i = 0; i < 3; i++) {
            const t0 = now();
            square.ease({opacity: i % 2 ? 255 : 20, duration: 500, mode: Clutter.AnimationMode.LINEAR});
            await wait(700);
            const painted = this.frames.filter(f => f.ap >= t0 && f.ap <= t0 + 500000);
            const intervals = painted.slice(1).map((f, j) => f.ap - painted[j].ap);
            log(`TIMING calibrate: ${painted.length} frames in 500 ms (expected ${Math.round(this.hz / 2)}), ` +
                `interval median ${ms(median(intervals))} max ${ms(max(intervals))}, ` +
                `frame work median ${ms(median(painted.map(f => f.au - f.bu)))} ms`);
        }
        square.destroy();
    }

    // What starting a process costs the Shell's main thread. Gio.Subprocess
    // closes the child's inherited descriptors, which GLib can only do after a
    // fork() of the whole Shell; INHERIT_FDS lets it use posix_spawn instead.
    async spawnBench(variants = null, tag = '') {
        const F = Gio.SubprocessFlags;
        variants ??= [
            ['Gio.Subprocess NONE (fork)', F.NONE],
            ['Gio.Subprocess STDOUT_PIPE|STDERR_PIPE (fork, as util.run)', F.STDOUT_PIPE | F.STDERR_PIPE],
            ['Gio.Subprocess INHERIT_FDS (posix_spawn)', F.INHERIT_FDS],
            ['Gio.Subprocess INHERIT_FDS|STDOUT_PIPE (posix_spawn)', F.INHERIT_FDS | F.STDOUT_PIPE],
        ];
        for (const [name, flags] of variants) {
            const durations = [];
            const faults = [];
            for (let i = 0; i < ROUNDS; i++) {
                const f0 = minorFaults();
                const t0 = now();
                const proc = Gio.Subprocess.new(['/usr/bin/true'], flags);
                durations.push(now() - t0);
                await new Promise(resolve => proc.wait_async(null, () => resolve()));
                await wait(200);
                faults.push(minorFaults() - f0);
            }
            log(`TIMING spawn${tag} ${name}: main thread median ${ms(median(durations))} max ${ms(max(durations))} ms; ` +
                `minor faults in the next 200 ms median ${median(faults)} max ${max(faults)}`);
        }
        if (tag)
            return;
        const idle = [];
        for (let i = 0; i < 5; i++) {
            const f0 = minorFaults();
            await wait(200);
            idle.push(minorFaults() - f0);
        }
        log(`TIMING spawn baseline: minor faults per idle 200 ms median ${median(idle)} max ${max(idle)}`);
    }

    async run() {
        log(`TIMING start: ${ROUNDS} rounds, refresh ${this.hz.toFixed(1)} Hz, animations ${St.Settings.get().enable_animations}`);
        log(`TIMING test shell ${memoryText()}`);
        log(`TIMING jade on PATH: ${GLib.find_program_in_path('jade')}`);
        // Cold: the first open of each menu since the Shell started.
        for (const role of [...JADE_ROLES, ...BASE_ROLES])
            await this.open(role, 'cold', 1);
        for (const role of [...JADE_ROLES, ...BASE_ROLES])
            await this.open(role, 'warm', ROUNDS);
        await this.switches(JADE_ROLES, 'jade');
        // The other way round: each menu entered from its other neighbour, so
        // a slow switch shows whether the opening or the closing menu costs it.
        await this.switches([...JADE_ROLES].reverse(), 'jade-reverse');
        await this.switches(BASE_ROLES, 'gnome');
        // A pointer sweeping across the icons: a switch every 250 ms, so one
        // menu's late work lands during the next one's animation.
        await this.switches(JADE_ROLES, 'jade-sweep', 250);

        // What the GPU readout costs: the same switches without nvidia-smi.
        const settings = Main.extensionManager.lookup(UUID)?.stateObj?._settings;
        if (settings) {
            settings.set_boolean('monitor-gpu', false);
            await wait(500);
            await this.switches(JADE_ROLES, 'jade-nogpu');
            settings.set_boolean('monitor-gpu', true);
            await wait(500);
        }
        // What GNOME's 150 ms fade costs: the same switches without animations
        // (the private keyfile settings of the test shell, not the live ones).
        const iface = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        iface.set_boolean('enable-animations', false);
        await wait(500);
        log(`TIMING animations now ${St.Settings.get().enable_animations}`);
        await this.switches(JADE_ROLES, 'jade-noanim');
        iface.set_boolean('enable-animations', true);
        await wait(500);
        await this.calibrate();
        await this.spawnBench();
        log(`TIMING test shell ${memoryText()}`);
        // A fork() costs by the size of the process. Grow this Shell to the
        // live one's resident size ($JADE_LIVE_MB, from run.sh) and fork again.
        const growMb = Math.max(0, Number(GLib.getenv('JADE_LIVE_MB') || 0) - residentMb());
        if (growMb > 0) {
            const ballast = new Uint8Array(growMb * 1024 * 1024);
            for (let i = 0; i < ballast.length; i += 4096)
                ballast[i] = 1;
            this._ballast = ballast;
            log(`TIMING grown by ${growMb} MB: ${memoryText()}`);
            await this.spawnBench([['Gio.Subprocess STDOUT_PIPE|STDERR_PIPE (fork, as util.run)',
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE],
            ['Gio.Subprocess INHERIT_FDS|STDOUT_PIPE (posix_spawn)',
                Gio.SubprocessFlags.INHERIT_FDS | Gio.SubprocessFlags.STDOUT_PIPE]], ` at +${growMb} MB`);
            this._ballast = null;
        }
        this.summarise();
    }
}


// The dock, driven with a virtual pointer. Screenshots go to $JADE_SHOTS;
// "HARNESS DOCK …" lines report what happened and how long frames took.
class DockScene {
    constructor(bar) {
        this.bar = bar;
        const backend = Clutter.get_default_backend();
        this.pointer = backend.get_default_seat().create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);
        this.monitor = Main.layoutManager.primaryMonitor;
        const view = global.stage.peek_stage_views()[0];
        this.hz = view?.get_refresh_rate?.() ?? view?.refresh_rate ?? 60;
    }

    move(x, y) {
        this.pointer.notify_absolute_motion(now(), this.monitor.x + x, this.monitor.y + y);
    }

    async click(x, y, button = Clutter.BUTTON_PRIMARY) {
        this.move(x, y);
        await wait(120);
        this.pointer.notify_button(now(), button, Clutter.ButtonState.PRESSED);
        await wait(90);
        this.pointer.notify_button(now(), button, Clutter.ButtonState.RELEASED);
    }

    // Press at (x, y), move through `points` a few pixels at a time, hold
    // `holdMs` at the last one (calling `during` then), release.
    async drag(x, y, points, holdMs = 300, during = null) {
        this.move(x, y);
        await wait(200);
        this.pointer.notify_button(now(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.PRESSED);
        await wait(120);
        let [cx, cy] = [x, y];
        for (const [tx, ty] of points) {
            const steps = Math.max(1, Math.round(Math.hypot(tx - cx, ty - cy) / 6));
            for (let i = 1; i <= steps; i++) {
                this.move(cx + (tx - cx) * i / steps, cy + (ty - cy) * i / steps);
                await wait(8);
            }
            [cx, cy] = [tx, ty];
        }
        await wait(holdMs);
        await during?.();
        this.pointer.notify_button(now(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.RELEASED);
        await wait(700);
    }

    // The bottom of the screen, tall enough for magnified icons and labels.
    shootDock(name) {
        const b = this.bar;
        const top = b._slabTop - b.metrics.icon * b._maxScale - 70;
        return new Promise(resolve => {
            const stream = Gio.File.new_for_path(`${OUT}/${name}.png`).replace(null, false, Gio.FileCreateFlags.NONE, null);
            new Shell.Screenshot().screenshot_area(this.monitor.x, this.monitor.y + top, this.monitor.width,
                this.monitor.height - top, stream, (o, res) => {
                    try {
                        o.screenshot_area_finish(res);
                    } catch (e) {
                        log(`shot ${name}: ${e}`);
                    }
                    stream.close(null);
                    resolve();
                });
        });
    }

    centerOf(index) {
        const item = this.bar._items[index];
        return item.translation_x + item.span / 2;
    }

    get iconY() {
        return this.bar._iconTop + this.bar.metrics.icon / 2;
    }

    // Sweep the pointer across the dock and back, one step a frame, timing
    // the dock's work per frame and the gaps between frames.
    async sweep(label, seconds = 2) {
        const bar = this.bar;
        const work = [];
        const original = bar._frame;
        bar._frame = delta => {
            const t = now();
            original.call(bar, delta);
            work.push(now() - t);
        };
        const gaps = [];
        let last = 0;
        const clock = Clutter.Timeline.new_for_actor(global.stage, 1000 * 60);
        clock.connect('new-frame', () => {
            const t = now();
            if (last)
                gaps.push(t - last);
            last = t;
        });
        clock.start();
        const [left, right] = bar._extent;
        const steps = Math.round(seconds * this.hz);
        for (let i = 0; i <= steps; i++) {
            const f = i / steps;
            const x = left + 10 + (right - left - 20) * (f < 0.5 ? f * 2 : 2 - f * 2);
            this.move(x, this.iconY);
            await wait(1000 / this.hz);
        }
        clock.stop();
        bar._frame = original;
        const sorted = [...work].sort((a, b) => a - b);
        const period = 1e6 / this.hz;
        const drops = gaps.filter(g => g > period * 1.5).length;
        const q = f => sorted.length ? (sorted[Math.floor((sorted.length - 1) * f)] / 1000).toFixed(3) : '-';
        log(`DOCK sweep ${label}: ${work.length} dock frames, work median ${q(0.5)} ms p95 ${q(0.95)} ms max ${q(1)} ms; ` +
            `${gaps.length} stage frames at ${this.hz.toFixed(0)} Hz, ${drops} longer than 1.5 periods`);
    }

    async run() {
        const bar = this.bar;
        // Fresh each time: items come and go as apps are pinned and unpinned.
        const appItems = () => bar._items.filter(item => item.kind === 'app');
        log(`DOCK items: ${bar._items.map(item => item.kind === 'app' ? item.id : item.kind).join(', ')}`);
        log(`DOCK metrics ${JSON.stringify(bar.metrics)} slab top ${bar._slabTop} extent ${bar._extent?.map(Math.round)}`);
        this.move(this.monitor.width / 2, 200);
        await wait(1500);
        await this.shootDock('dock-rest');
        await shoot('dock-desktop');

        // Magnified over the third app, and between two apps.
        this.move(this.centerOf(2), this.iconY);
        await wait(900);
        await this.shootDock('dock-magnified');
        log(`DOCK label "${bar._label.text}" opacity ${bar._label.opacity}; envelope ${bar._envelope.toFixed(3)}`);
        this.move((this.centerOf(4) + this.centerOf(5)) / 2, this.iconY);
        await wait(700);
        await this.shootDock('dock-magnified-between');
        this.move(this.centerOf(0) - 20, this.iconY);
        await wait(700);
        await this.shootDock('dock-magnified-edge');
        await this.sweep('magnified');

        // The overview and the app grid: the dock stays, GNOME's dash is gone.
        this.move(this.monitor.width / 2, 200);
        Main.overview.show();
        await wait(1500);
        log(`DOCK overview: dock shown ${bar._shown}, GNOME dash visible ${Main.overview.dash.visible}`);
        await shoot('dock-overview');
        bar._showApps.activate();
        await wait(1500);
        await shoot('dock-app-grid');
        bar._showApps.activate();
        await wait(1200);
        log(`DOCK overview closed: ${!Main.overview.visible}`);

        // Badges: an app's own count and progress (Unity LauncherEntry), and
        // notifications waiting for another.
        Gio.DBus.session.emit_signal(null, '/com/canonical/unity/launcherentry/1', 'com.canonical.Unity.LauncherEntry',
            'Update', new GLib.Variant('(sa{sv})', ['application://org.gnome.Nautilus.desktop', {
                'count': new GLib.Variant('x', 3), 'count-visible': new GLib.Variant('b', true),
                'progress': new GLib.Variant('d', 0.62), 'progress-visible': new GLib.Variant('b', true),
            }]));
        const calendarApp = Shell.AppSystem.get_default().lookup_app('org.gnome.Calendar.desktop');
        const calendarSource = new MessageTray.Source({
            title: 'Calendar', policy: MessageTray.NotificationPolicy.newForApp(calendarApp),
        });
        Main.messageTray.add(calendarSource);
        for (const title of ['Standup in 10 minutes', 'Lunch with Sam', 'Dentist'])
            calendarSource.addNotification(new MessageTray.Notification({source: calendarSource, title, body: ''}));
        await wait(800);
        const badge = id => bar._apps.get(id)?._badge;
        log(`DOCK badges: Files "${badge('org.gnome.Nautilus.desktop')?.text}" ${badge('org.gnome.Nautilus.desktop')?.visible}, ` +
            `Calendar "${badge('org.gnome.Calendar.desktop')?.text}" ${badge('org.gnome.Calendar.desktop')?.visible}, ` +
            `progress ${bar._apps.get('org.gnome.Nautilus.desktop')?._progress.visible}`);
        await this.shootDock('dock-badges');
        this.move(this.centerOf(1), this.iconY);
        await wait(800);
        await this.shootDock('dock-badges-magnified');
        this.move(this.monitor.width / 2, 200);
        calendarSource.destroy();
        Gio.DBus.session.emit_signal(null, '/com/canonical/unity/launcherentry/1', 'com.canonical.Unity.LauncherEntry',
            'Update', new GLib.Variant('(sa{sv})', ['application://org.gnome.Nautilus.desktop', {
                'count-visible': new GLib.Variant('b', false), 'progress-visible': new GLib.Variant('b', false),
            }]));
        await wait(800);
        log(`DOCK badges cleared: Files ${badge('org.gnome.Nautilus.desktop')?.visible}, Calendar ${badge('org.gnome.Calendar.desktop')?.visible}`);

        // Dragging along the dock reorders it; dragged off and held, a pinned
        // app shows "Remove", and dropping it there unpins it.
        const favorites = () => global.settings.get_strv('favorite-apps');
        const before = favorites();
        await this.drag(this.centerOf(0), this.iconY, [[this.centerOf(0), this.iconY - 30],
            [(this.centerOf(3) + this.centerOf(4)) / 2, this.iconY]], 500);
        log(`DOCK dragged Firefox along: ${favorites().slice(0, 5).map(id => id.split('.').slice(-2, -1)[0]).join(' ')}`);
        this.move(this.monitor.width / 2, 200);
        await wait(900);  // at rest again, so the icons are where they rest
        const weather = bar._items.findIndex(item => item.id === 'org.gnome.Weather.desktop');
        await this.drag(this.centerOf(weather), this.iconY, [[this.centerOf(weather), this.iconY - 260]], 1000, async () => {
            log(`DOCK held off the dock: remove label ${bar._removeLabel ? `"${bar._removeLabel.text}"` : 'none'}`);
            await shoot('dock-remove');
        });
        await wait(800);
        log(`DOCK dropped off the dock: Weather pinned ${favorites().includes('org.gnome.Weather.desktop')}, in dock ${bar._apps.has('org.gnome.Weather.desktop')}`);
        global.settings.set_strv('favorite-apps', before);
        this.move(this.monitor.width / 2, 200);
        await wait(1200);

        // Its menu.
        await this.click(this.centerOf(1), this.iconY, Clutter.BUTTON_SECONDARY);
        await wait(900);
        await shoot('dock-menu');
        Main.panel.menuManager.activeMenu?.close();
        for (const item of appItems())
            item.icon._menu?.close();
        this.move(this.monitor.width / 2, 200);
        await wait(800);

        // Launch one: it bounces until its window is up.
        const calculator = appItems().find(item => item.id === 'org.gnome.Calculator.desktop');
        const index = bar._items.indexOf(calculator);
        await this.click(this.centerOf(index), this.iconY);
        await wait(200);
        this.move(this.monitor.width / 2, 200);
        await wait(80);
        await this.shootDock('dock-bounce');
        log(`DOCK launched ${calculator.id}: bouncing ${calculator.isBouncing}, state ${calculator.app.state}`);
        let window = null;
        for (let i = 0; i < 60 && !window; i++) {
            await wait(250);
            window = calculator.app.get_windows()[0] ?? null;
        }
        await wait(1500);
        log(`DOCK window ${window ? 'up' : 'never came'}; bouncing ${calculator.isBouncing}; dot ${calculator._dot.visible}`);
        await this.shootDock('dock-running');
        await shoot('dock-running-desktop');
        if (!window)
            return;

        // A window over it: the dock gets out of the way, and a push on the
        // bottom edge brings it back.
        const frame = window.get_frame_rect();
        window.move_frame(true, this.monitor.x + (this.monitor.width - frame.width) / 2,
            this.monitor.y + this.monitor.height - frame.height + 20);
        await wait(1200);
        log(`DOCK window over it: overlap ${bar._overlap}, shown ${bar._shown}, slide ${Math.round(bar._slide)}`);
        await shoot('dock-hidden');
        this.move(this.monitor.width / 2, this.monitor.height - 2);
        for (let i = 0; i < 40; i++) {
            this.pointer.notify_relative_motion(now(), 0, 6);
            await wait(12);
        }
        await wait(700);
        log(`DOCK after a push on the edge: shown ${bar._shown}, slide ${Math.round(bar._slide)}, hover ${bar._hover}`);
        await shoot('dock-revealed');
        this.move(this.monitor.width / 2, 200);
        await wait(1400);
        log(`DOCK pointer away again: shown ${bar._shown}, slide ${Math.round(bar._slide)}`);

        // Minimizing flies into the icon.
        const [ok, rect] = window.get_icon_geometry();
        log(`DOCK minimize target ${ok ? `${rect.x},${rect.y} ${rect.width}x${rect.height}` : 'none'}`);
        log(`DOCK animations ${St.Settings.get().enable_animations}, wm would animate ${Main.wm._shouldAnimate()}`);
        this.move(this.monitor.width / 2, 200);
        window.minimize();
        for (const ms of [90, 180, 270, 360, 450]) {
            await wait(90);
            await shoot(`dock-genie-${ms}`);
        }
        await wait(1200);
        log(`DOCK minimized: ${window.minimized}, actor visible ${window.get_compositor_private()?.visible}`);
        window.unminimize();
        for (const ms of [120, 240, 360]) {
            await wait(120);
            await shoot(`dock-ungenie-${ms}`);
        }
        await wait(600);
        log(`DOCK unminimized: shown ${window.get_compositor_private()?.visible}, opacity ${window.get_compositor_private()?.opacity}`);
        window.minimize();
        await wait(1200);
        log(`DOCK minimized: overlap ${bar._overlap}, shown ${bar._shown}`);
        await this.shootDock('dock-after-minimize');
        window.delete(global.get_current_time());
        await wait(1500);
        log(`DOCK closed: items ${bar._items.filter(item => item.kind === 'app').length} apps`);

        // Animations off (no GPU, or Settings › Accessibility): a click still
        // launches, without a bounce.
        const iface = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        iface.set_boolean('enable-animations', false);
        await wait(300);
        const editor = appItems().find(item => item.id === 'org.gnome.TextEditor.desktop');
        await this.click(this.centerOf(bar._items.indexOf(editor)), this.iconY);
        let editorWindow = null;
        for (let i = 0; i < 60 && !editorWindow; i++) {
            await wait(250);
            editorWindow = editor.app.get_windows()[0] ?? null;
        }
        log(`DOCK animations off: launched ${Boolean(editorWindow)}, bounced ${editor.isBouncing}`);
        editorWindow?.delete(global.get_current_time());
        iface.set_boolean('enable-animations', true);
        await wait(800);
    }
}

export default class Harness extends Extension {
    enable() {
        if (this._ran)
            return;
        this._ran = true;
        const run = {timing: () => this._timing(), dock: () => this._dock(), looks: () => this._looks()}[MODE]?.() ??
            this._run();
        run.catch(e => log(`failed: ${e}\n${e.stack}`))
            .finally(() => GLib.file_set_contents(`${OUT}/done`, 'ok'));
    }

    async _timing() {
        await wait(6000);
        const jadeShell = Main.extensionManager.lookup(UUID);
        log(`jade-shell state ${jadeShell?.state} ${jadeShell?.error ?? ''}`);
        const timing = new Timing();
        timing.start();
        timing.instrumentParts();
        try {
            await timing.run();
        } finally {
            timing.stop();
        }
    }

    // The dock in each theme ($JADE_THEMES) with each kind of icons: GNOME's
    // and the Mac-style ones, in color and tinted. Needs $JADE_ICONS.
    async _looks() {
        await wait(6000);
        const jadeShell = Main.extensionManager.lookup(UUID);
        const settings = jadeShell.getSettings?.() ?? Extension.lookupByUUID(UUID).getSettings();
        const iface = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        const dock = jadeShell?.stateObj?._parts?.find(part => part.key === 'show-dock')?.instance;
        for (const theme of THEMES) {
            await jade('theme', 'set', theme, '--only', 'gnome,shell,icons');
            await wait(2500);
            const mac = iface.get_string('icon-theme');
            for (const [name, icons, style] of [['gnome', 'Adwaita', 'color'], ['tahoe', mac, 'color'],
                ['tahoe-tinted', mac, 'tinted'], ['gnome-tinted', 'Adwaita', 'tinted']]) {
                iface.set_string('icon-theme', icons);
                settings.set_string('dock-icon-style', style);
                await wait(1500);
                const scene = new DockScene(dock.bar);
                scene.move(scene.centerOf(3), scene.iconY);
                await wait(900);
                await scene.shootDock(`look-${theme}-${name}`);
                scene.move(scene.monitor.width / 2, 200);
                await wait(500);
                if (theme === THEMES[0] && name.startsWith('tahoe')) {  // the app grid follows
                    Main.overview.showApps();
                    await wait(1800);
                    await shoot(`look-${theme}-${name}-grid`);
                    Main.overview.hide();
                    await wait(1200);
                }
            }
            iface.set_string('icon-theme', mac);
            settings.set_string('dock-icon-style', 'color');
        }
    }

    async _dock() {
        await wait(6000);
        const jadeShell = Main.extensionManager.lookup(UUID);
        log(`jade-shell state ${jadeShell?.state} ${jadeShell?.error ?? ''}`);
        const dock = jadeShell?.stateObj?._parts?.find(part => part.key === 'show-dock')?.instance;
        if (!dock?.bar) {
            log('DOCK no dock');
            return;
        }
        for (const theme of THEMES) {
            if (theme !== THEMES[0]) {
                await jade('theme', 'set', theme, '--only', 'gnome,shell');
                await wait(2500);
            }
            const bar = dock.bar;
            const scene = new DockScene(bar);
            scene.move(scene.monitor.width / 2, 200);
            await wait(1000);
            if (theme !== THEMES[0]) {
                await scene.shootDock(`dock-rest-${theme}`);
                scene.move(scene.centerOf(3), scene.iconY);
                await wait(900);
                await scene.shootDock(`dock-magnified-${theme}`);
                continue;
            }
            // Pressed and magnified: a darkened copy of the icon, drawn as sharp
            // as at rest (an offscreen effect would draw it blocky).
            scene.move(scene.centerOf(3), scene.iconY);
            await wait(900);
            scene.pointer.notify_button(now(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.PRESSED);
            await wait(300);
            const pressed = bar._items[3];
            const effects = [pressed, pressed.icon, pressed.icon.icon, pressed.icon.icon.icon]
                .flatMap(actor => actor?.get_effects?.() ?? []).map(e => e.constructor.name);
            log(`DOCK pressed: ${pressed.label}, icon ${pressed.icon.icon.icon?.gicon?.constructor.name}, effects [${effects}]`);
            await scene.shootDock('dock-pressed');
            scene.move(scene.monitor.width / 2, 200);  // released away from it: nothing launches
            await wait(300);
            scene.pointer.notify_button(now(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.RELEASED);
            await wait(900);
            await scene.run();
        }
    }

    async _run() {
        await wait(6000);
        const jadeShell = Main.extensionManager.lookup(UUID);
        log(`jade-shell state ${jadeShell?.state} ${jadeShell?.error ?? ''}`);
        const source = MessageTray.getSystemSource();
        for (const [title, body] of [['Screenshot captured', 'You can paste the image from the clipboard.'],
            ['Jade Shell', 'Tokyo Night applied · 9 changes']])
            source.addNotification(new MessageTray.Notification({source, title, body}));
        await wait(1000);
        for (const theme of THEMES) {
            if (theme !== 'osaka-jade' || theme !== THEMES[0]) { // run.sh starts on Osaka Jade
                await jade('theme', 'set', theme, '--only', 'gnome,shell');
                await wait(2500);
            }
            await shoot(`${theme}-desktop`);
            await shoot(`${theme}-bar`, Main.panel);
            await states('dateMenu', `${theme}-clock`);
            await states('jade-monitor', `${theme}-monitor-button`);
            await panel('jade-picker', `${theme}-picker`);
            await panel('jade-monitor', `${theme}-monitor`, 3000);
            await panel('jade-usage', `${theme}-usage`);
            await panel('dateMenu', `${theme}-calendar`);
            await states('jade-bell', `${theme}-bell-button`);
            // The unread dot: GNOME's indicator decides, the bell shows it.
            const unread = Main.panel.statusArea.dateMenu._indicator;
            unread.visible = true;
            await wait(300);
            await shoot(`${theme}-bell-unread`, Main.panel.statusArea['jade-bell']);
            unread._sync();
            await panel('jade-bell', `${theme}-bell`);
            await panel('quickSettings', `${theme}-quick-settings`);
        }
        await bellRoundTrip();
        await bellShortcuts();
        await cheatSheet();
        await modes();
        await media();
        await weather();
        await jadeMenu();
        await clipboard();
        await capture();
        await pickerScrolls();
        await networkPanel();
        await glass();
        await overviewDrags();
        await popups();
        await clockFollowsGnome();
        await highContrast();
        await lockScreen();  // last: it stays locked
    }

    disable() {}
}
