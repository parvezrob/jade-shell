// What's playing, in the top bar: a chip with the track, shown while a
// player plays or is paused. Click for its cover and controls, scroll for
// the previous or next track.
//
// The players come from GNOME's own MPRIS source (the one the notification
// list's media controls use), so nothing more listens on the bus.
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';
import Gettext from 'gettext';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';

import {addToPanel, VERTICAL} from './util.js';

// What GNOME puts in place of a missing artist (Firefox often sends none).
const UNKNOWN_ARTIST = Gettext.dgettext('gnome-shell', 'Unknown artist');

const MediaButton = GObject.registerClass(
class JadeMediaButton extends PanelMenu.Button {
    _init(onScroll) {
        super._init(0.5, 'Media');
        this._onScroll = onScroll;
    }

    vfunc_scroll_event(event) {
        const direction = event.get_scroll_direction();
        if (direction === Clutter.ScrollDirection.UP || direction === Clutter.ScrollDirection.DOWN)
            this._onScroll(direction === Clutter.ScrollDirection.DOWN ? 1 : -1);
        return Clutter.EVENT_STOP;
    }
});

function iconButton(name, accessibleName, action) {
    const button = new St.Button({
        style_class: 'jade-media-control', can_focus: true, accessible_name: accessibleName,
        child: new St.Icon({icon_name: name}),
    });
    button.connect('clicked', action);
    return button;
}

export class Media {
    enable() {
        this._source = Main.panel.statusArea.dateMenu._messageList?._messageView?._mediaSource ?? null;
        if (!this._source)
            throw new Error("GNOME's media source is not where Jade Shell expects it");
        this._button = new MediaButton(step => this._skip(step));
        this._button.add_style_class_name('jade-media');
        const chip = new St.BoxLayout({style_class: 'jade-media-chip', y_align: Clutter.ActorAlign.CENTER});
        this._state = new St.Icon({icon_name: 'media-playback-start-symbolic', style_class: 'system-status-icon'});
        this._chipLabel = new St.Label({style_class: 'jade-media-label', y_align: Clutter.ActorAlign.CENTER});
        this._chipLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        chip.add_child(this._state);
        chip.add_child(this._chipLabel);
        this._button.add_child(chip);

        // The menu: cover, title, artist, and the controls.
        const menu = this._button.menu;
        menu.box.add_style_class_name('jade-frame');
        menu.box.add_style_class_name('jade-media-menu');
        const card = new St.BoxLayout({style_class: 'jade-media-card'});
        this._cover = new St.Icon({style_class: 'jade-media-cover', icon_size: 72, icon_name: 'audio-x-generic-symbolic'});
        card.add_child(this._cover);
        const text = new St.BoxLayout({orientation: VERTICAL, y_align: Clutter.ActorAlign.CENTER, x_expand: true});
        this._title = new St.Label({style_class: 'jade-media-title'});
        this._artist = new St.Label({style_class: 'jade-media-artist'});
        this._appName = new St.Label({style_class: 'jade-media-app'});
        for (const label of [this._title, this._artist, this._appName]) {
            label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            text.add_child(label);
        }
        card.add_child(text);
        menu.box.add_child(card);
        const controls = new St.BoxLayout({style_class: 'jade-media-controls', x_align: Clutter.ActorAlign.CENTER});
        this._previous = iconButton('media-skip-backward-symbolic', 'Previous', () => this._player?.previous());
        this._playPause = iconButton('media-playback-pause-symbolic', 'Play or pause', () => this._player?.playPause());
        this._next = iconButton('media-skip-forward-symbolic', 'Next', () => this._player?.next());
        const open = iconButton('view-restore-symbolic', 'Show the player', () => {
            this._player?.raise();
            menu.close();
        });
        for (const button of [this._previous, this._playPause, this._next, open])
            controls.add_child(button);
        menu.box.add_child(controls);

        addToPanel('jade-media', this._button);
        this._players = new Set();
        this._source.connectObject(
            'player-added', (_s, player) => this._watch(player),
            'player-removed', (_s, player) => {
                player.disconnectObject(this);
                this._players.delete(player);
                this._sync();
            },
            this);
        for (const player of this._source.players)
            this._watch(player);
        this._sync();
    }

    disable() {
        this._source?.disconnectObject(this);
        for (const player of this._players ?? [])
            player.disconnectObject(this);
        this._players?.clear();
        this._button?.destroy();
        this._button = this._source = this._player = null;
    }

    _watch(player) {
        if (this._players.has(player))
            return;
        this._players.add(player);
        player.connectObject('changed', () => {
            if (player.status === 'Playing')
                this._lastPlaying = player;
            this._sync();
        }, this);
        if (player.status === 'Playing')
            this._lastPlaying = player;
    }

    // The player to show: the one playing (the latest to start), else one paused.
    _pick() {
        const players = [...this._players].filter(player => player.canPlay);
        const playing = players.filter(player => player.status === 'Playing');
        if (playing.length)
            return playing.includes(this._lastPlaying) ? this._lastPlaying : playing[0];
        return players.find(player => player.status === 'Paused') ?? null;
    }

    _sync() {
        const player = this._pick();
        this._player = player;
        this._button.visible = Boolean(player);
        if (!player) {
            this._button.menu.close();
            return;
        }
        const title = player.trackTitle || player.app?.get_name() || 'Playing';
        const artists = (player.trackArtists ?? []).filter(a => a && a !== UNKNOWN_ARTIST).join(', ');
        this._chipLabel.text = artists ? `${title} · ${artists}` : title;
        const playing = player.status === 'Playing';
        this._state.icon_name = playing ? 'media-playback-start-symbolic' : 'media-playback-pause-symbolic';
        this._title.text = title;
        this._artist.text = artists;
        this._artist.visible = Boolean(artists);
        this._appName.text = player.app?.get_name() ?? '';
        this._playPause.child.icon_name = playing ? 'media-playback-pause-symbolic' : 'media-playback-start-symbolic';
        this._previous.reactive = player.canGoPrevious;
        this._next.reactive = player.canGoNext;
        const cover = player.trackCoverUrl;
        if (cover)
            this._cover.gicon = new Gio.FileIcon({file: Gio.File.new_for_uri(cover)});
        else if (player.app)
            this._cover.gicon = player.app.get_icon();
        else
            this._cover.icon_name = 'audio-x-generic-symbolic';
    }

    _skip(step) {
        if (step > 0 && this._player?.canGoNext)
            this._player.next();
        else if (step < 0 && this._player?.canGoPrevious)
            this._player.previous();
    }
}
