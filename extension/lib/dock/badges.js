import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

// What each app's dock icon shows on top: a count badge and a progress bar.
//
// Counts come from the app's own report when it makes one (the
// com.canonical.Unity.LauncherEntry signal Slack, Discord, Telegram and
// other Electron and Qt apps send, which also carries download progress),
// and otherwise from its notifications waiting in the message tray.
export class Badges {
    constructor(onChange) {
        this._onChange = onChange;
        this._entries = new Map();   // app id → {count, progress}
        this._sources = new Set();
        this._signal = Gio.DBus.session.signal_subscribe(null, 'com.canonical.Unity.LauncherEntry', 'Update',
            null, null, Gio.DBusSignalFlags.NONE, (_bus, _sender, _path, _iface, _name, params) => this._update(params));
        Main.messageTray.connectObject(
            'source-added', (_tray, source) => this._watch(source),
            'source-removed', (_tray, source) => {
                source.disconnectObject(this);
                this._sources.delete(source);
                this._changed();
            },
            this);
        for (const source of Main.messageTray.getSources())
            this._watch(source);
    }

    destroy() {
        Gio.DBus.session.signal_unsubscribe(this._signal);
        Main.messageTray.disconnectObject(this);
        for (const source of this._sources)
            source.disconnectObject(this);
        this._sources.clear();
        if (this._idle)
            GLib.source_remove(this._idle);
    }

    // The badge for `id` (a .desktop id): a number, or 0 for none; and the
    // progress, 0 to 1, or null for none.
    badge(id) {
        const entry = this._entries.get(id);
        if (entry?.count !== undefined)
            return entry.count;
        let count = 0;
        for (const source of this._sources) {
            if (sourceApp(source) === id)
                count += source.count;
        }
        return count;
    }

    progress(id) {
        return this._entries.get(id)?.progress ?? null;
    }

    _watch(source) {
        if (this._sources.has(source))
            return;
        this._sources.add(source);
        source.connectObject('notify::count', () => this._changed(), this);
        this._changed();
    }

    // application://slack.desktop, {count: <x>, count-visible: <b>, progress: <d>, progress-visible: <b>}
    _update(params) {
        const [uri, props] = params.deepUnpack();
        const id = uri.replace(/^application:\/\//, '');
        const entry = {...this._entries.get(id)};
        const value = key => props[key]?.deepUnpack();
        if ('count' in props)
            entry.rawCount = Number(value('count'));
        if ('count-visible' in props)
            entry.countVisible = value('count-visible');
        if ('progress' in props)
            entry.rawProgress = value('progress');
        if ('progress-visible' in props)
            entry.progressVisible = value('progress-visible');
        entry.count = entry.countVisible ? entry.rawCount ?? 0 : undefined;
        entry.progress = entry.progressVisible ? Math.min(1, Math.max(0, entry.rawProgress ?? 0)) : null;
        this._entries.set(id, entry);
        this._changed();
    }

    _changed() {
        if (this._idle)
            return;
        this._idle = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._idle = 0;
            this._onChange();
            return GLib.SOURCE_REMOVE;
        });
    }
}

// The .desktop id of the app a notification source belongs to, if any.
function sourceApp(source) {
    const app = source.app ?? source._app;
    if (app?.get_id)
        return app.get_id();
    const id = source.policy?.id;
    return id ? `${id}.desktop` : null;
}
