// Drives Jade Shell inside the headless test shell of tests/shell/run.sh:
// opens each panel for each theme in $JADE_THEMES, screenshots it into
// $JADE_SHOTS, logs "HARNESS …" lines, and writes $JADE_SHOTS/done.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const OUT = GLib.getenv('JADE_SHOTS');
const THEMES = (GLib.getenv('JADE_THEMES') || 'osaka-jade').split(',');
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

export default class Harness extends Extension {
    enable() {
        if (this._ran)
            return;
        this._ran = true;
        this._run().catch(e => log(`failed: ${e}\n${e.stack}`))
            .finally(() => GLib.file_set_contents(`${OUT}/done`, 'ok'));
    }

    async _run() {
        await wait(6000);
        const jadeShell = Main.extensionManager.lookup('jade-shell@parvezrob.github.io');
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
            await panel('jade-picker', `${theme}-picker`);
            await panel('jade-monitor', `${theme}-monitor`, 3000);
            await panel('jade-usage', `${theme}-usage`);
            await panel('dateMenu', `${theme}-calendar`);
            await panel('quickSettings', `${theme}-quick-settings`);
        }
    }

    disable() {}
}
