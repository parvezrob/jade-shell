import Gio from 'gi://Gio';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {Debouncer, stateDir} from './util.js';

// Osaka Jade, for painted widgets until `jade` has written a palette.
const DEFAULT_PALETTE = {
    background: '#111c18', foreground: '#C1C497', accent: '#509475', selection: '#32473B',
    dark_foreground: '#81B8A8', light_foreground: '#D6D5BC', bright_red: '#db9f9c', secondary_text: '#ABB8A5',
};

// Loads the Shell theme `jade` compiles for the current palette (the same
// mechanism the User Themes extension uses) and follows it as themes switch.
// Runs on the lock screen too, so locking does not flash GNOME's colors.
// Steps aside while High Contrast (Settings › Accessibility) is on: that is
// GNOME's own stylesheet, and a theme stylesheet would hide it.
export class ShellTheme {
    constructor() {
        this.palette = {...DEFAULT_PALETTE};
        this._listeners = new Set();
    }

    enable() {
        this._cancellable = new Gio.Cancellable();
        this._dir = stateDir();
        this._css = this._dir.get_child('gnome-shell.css');
        this._colors = this._dir.get_child('colors.json');
        this._reload = new Debouncer(200, () => {
            this._loadStylesheet();
            this._loadPalette();
        });
        try {
            this._dir.make_directory_with_parents(null);
        } catch {}
        this._monitor = this._dir.monitor_directory(Gio.FileMonitorFlags.WATCH_MOVES, this._cancellable);
        this._monitorChanged = this._monitor.connect('changed', (_m, file, other) => {
            const names = [file?.get_basename(), other?.get_basename()];
            if (names.includes('gnome-shell.css') || names.includes('colors.json'))
                this._reload.schedule();
        });
        this._contrastChanged = St.Settings.get().connect('notify::high-contrast', () => this._loadStylesheet());
        this._loadStylesheet();
        this._loadPalette();
    }

    disable() {
        St.Settings.get().disconnect(this._contrastChanged);
        this._reload.cancel();
        this._monitor.disconnect(this._monitorChanged);
        this._monitor.cancel();
        this._cancellable.cancel();
        this._monitor = this._cancellable = null;
        if (this._ours()) {
            Main.setThemeStylesheet(null);
            Main.loadTheme();
        }
        this._listeners.clear();
    }

    // Called now and after every palette change.
    follow(callback) {
        this._listeners.add(callback);
        callback(this.palette);
        return () => this._listeners.delete(callback);
    }

    _ours() {
        return Main.getThemeStylesheet()?.get_path() === this._css.get_path();
    }

    _loadStylesheet() {
        const wanted = this._css.query_exists(null) && !St.Settings.get().high_contrast;
        if (!wanted && !this._ours())
            return;
        Main.setThemeStylesheet(wanted ? this._css.get_path() : null);
        Main.loadTheme();
    }

    _loadPalette() {
        const cancellable = this._cancellable;
        this._colors.load_contents_async(cancellable, (file, result) => {
            let colors = {};
            try {
                colors = JSON.parse(new TextDecoder().decode(file.load_contents_finish(result)[1])).colors ?? {};
            } catch {}
            if (cancellable.is_cancelled())
                return;
            this.palette = {...DEFAULT_PALETTE, ...colors};
            for (const callback of this._listeners)
                callback(this.palette);
        });
    }
}
