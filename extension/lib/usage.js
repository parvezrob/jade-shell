// Claude and Codex usage in the top bar, with Omarchy's agent usage panel as
// its menu. `jade usage collect` (Omarchy's collectors) writes one record per
// provider; this draws whatever records exist.
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import St from 'gi://St';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {VERTICAL, addToPanel, cairoRgb, jadeCommand, label as baseLabel} from './util.js';

// Providers in display order. A record for any of them in the records
// directory earns it a tab; the collectors decide what goes in a record.
const PROVIDERS = [
    {id: 'claude', short: 'Claude', icon: 'claude-symbolic.svg'},
    {id: 'codex', short: 'Codex', icon: 'openai-symbolic.svg'},
];
const ALARM = 0.9;
const LIMITS_PROBE_GAP_S = 30;

// Painted meters and panel markup take their colors from the theme palette;
// everything else is styled by the Shell theme (shell-theme/jade.scss).
const RGB = {};
const HEX = {};

function usePalette(c) {
    RGB.fg = cairoRgb(c.foreground);
    RGB.jade = cairoRgb(c.dark_foreground);
    RGB.track = cairoRgb(c.selection);
    RGB.urgent = cairoRgb(c.bright_red);
    HEX.urgent = c.bright_red;
    HEX.muted = c.secondary_text;
}

// ------------------------------------------------------------ formatting

function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
}

function isLong(text) {
    return ['week', '7-day', 'seven', 'month', '30-day'].some(k => text.includes(k));
}

// Claude spells windows out ("Session (5-hour)"), Codex abbreviates them
// ("5h window"); a model-scoped limit arrives with its own title.
function windowTitle(limit) {
    if (limit.title)
        return String(limit.title);
    const text = String(limit.label ?? '').toLowerCase();
    if (text.includes('month'))
        return 'Monthly';
    if (isLong(text))
        return 'Weekly';
    if (text.includes('session') || /\d+\s*-?\s*(h|m)/.test(text))
        return 'Session';
    return String(limit.label ?? '').replace(/\s*\(.*\)\s*/, '').trim() || 'Limit';
}

function windowTag(limit) {
    const text = String(limit.title || limit.label || '').toLowerCase();
    if (text.includes('month') || text.includes('30-day'))
        return '30d';
    if (isLong(text))
        return '7d';
    const hours = text.match(/(\d+)\s*-?\s*h(?:our)?\b/);
    if (hours)
        return `${hours[1]}h`;
    const minutes = text.match(/(\d+)\s*-?\s*m(?:in(?:ute)?s?)?\b/);
    return minutes ? `${minutes[1]}m` : '';
}

function limitsOf(record) {
    return (record?.limits ?? [])
        .filter(l => l && Number(l.percent) >= 0)
        .map(l => ({...l, percent: clamp(Number(l.percent), 0, 1)}));
}

// The fullest window is the one that stops the next prompt.
function bindingLimit(record) {
    return limitsOf(record).reduce((best, l) => !best || l.percent > best.percent ? l : best, null);
}

function resetInMs(limit, nowMs) {
    const ms = Date.parse(limit?.resetsAt ?? '');
    return Number.isFinite(ms) ? ms - nowMs : null;
}

function formatDuration(ms) {
    const minutes = Math.floor(ms / 60000);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);
    if (days > 0)
        return `${days}d ${hours % 24}h`;
    if (hours > 0)
        return `${hours}h ${minutes % 60}m`;
    return `${Math.max(1, minutes)}m`;
}

function formatAge(ms) {
    return ms < 60000 ? 'just now' : `${formatDuration(ms)} ago`;
}

function formatTokens(n) {
    n = Number(n) || 0;
    if (n >= 1e9)
        return `${(n / 1e9).toFixed(1)}B`;
    if (n >= 1e6)
        return `${(n / 1e6).toFixed(1)}M`;
    if (n >= 1e3)
        return `${(n / 1e3).toFixed(1)}K`;
    return String(n);
}

// claude-opus-5-5 → Opus 5.5, gpt-6-astra → GPT 6 Astra.
function modelName(id) {
    const words = [];
    let version = [];
    for (const part of String(id ?? '').replace(/^claude-/, '').replace(/-\d{8}$/, '').split('-')) {
        if (!part)
            continue;
        if (/^\d/.test(part)) {
            version.push(part);
            continue;
        }
        if (version.length)
            words.push(version.join('.'));
        version = [];
        words.push(part === 'gpt' ? 'GPT' : part[0].toUpperCase() + part.slice(1));
    }
    if (version.length)
        words.push(version.join('.'));
    return words.join(' ') || 'Unknown';
}

function localDate(ms) {
    const d = new Date(ms);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function dayName(date) {
    const d = new Date(`${date}T00:00:00`);
    return Number.isNaN(d.getTime()) ? String(date) : ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()];
}

function escape(text) {
    return GLib.markup_escape_text(String(text), -1);
}

// ------------------------------------------------------------ widgets

function label(text, style = 'ai-text', props = {}) {
    return baseLabel(text, style, props);
}

function roundedRect(cr, x, y, w, h, r) {
    r = Math.min(r, h / 2, w / 2);
    cr.newSubPath();
    cr.arc(x + w - r, y + r, r, -Math.PI / 2, 0);
    cr.arc(x + w - r, y + h - r, r, 0, Math.PI / 2);
    cr.arc(x + r, y + h - r, r, Math.PI / 2, Math.PI);
    cr.arc(x + r, y + r, r, Math.PI, 1.5 * Math.PI);
    cr.closePath();
}

// A pill track with a pill fill. Painted, never sized from allocation, so a
// redraw cannot trigger relayout.
function meter(value, {color = RGB.jade, alpha = 1, height = 6, style = 'ai-meter'} = {}) {
    const area = new St.DrawingArea({style_class: style, height, x_expand: true, y_align: Clutter.ActorAlign.CENTER});
    area.connect('repaint', a => {
        const cr = a.get_context();
        const [w, h] = a.get_surface_size();
        cr.setSourceRGB(...RGB.track);
        roundedRect(cr, 0, 0, w, h, h / 2);
        cr.fill();
        const v = clamp(value, 0, 1);
        if (v > 0) {
            cr.setSourceRGBA(...color, alpha);
            roundedRect(cr, 0, 0, Math.max(h, w * v), h, h / 2);
            cr.fill();
        }
        cr.$dispose();
    });
    return area;
}

// A table row whose share bar fills the row behind its labels.
function shareRow(share, children) {
    const row = new St.Widget({
        layout_manager: new Clutter.BinLayout(), x_expand: true,
        reactive: true, track_hover: true, style_class: 'ai-model-row',
    });
    const bar = new St.DrawingArea({x_expand: true, y_expand: true});
    bar.connect('repaint', a => {
        const cr = a.get_context();
        const [w, h] = a.get_surface_size();
        cr.setSourceRGBA(...RGB.fg, 0.05);
        cr.rectangle(0, 0, w, h);
        cr.fill();
        cr.setSourceRGBA(...RGB.jade, 0.2);
        cr.rectangle(0, 0, Math.max(4, w * clamp(share, 0, 1)), h);
        cr.fill();
        cr.$dispose();
    });
    const content = new St.BoxLayout({x_expand: true, style_class: 'ai-model-content'});
    children.forEach(c => content.add_child(c));
    row.add_child(bar);
    row.add_child(content);
    return row;
}

// ------------------------------------------------------------ extension

export class Usage {
    constructor(extension, settings, theme) {
        this._extension = extension;
        this._settings = settings;
        this._theme = theme;
    }

    enable() {
        this._alive = true;
        this._records = {};
        this._selected = PROVIDERS[0].id;
        this._refreshing = false;
        this._refreshFailed = false;
        this._lastProbe = 0;
        this._cancellable = new Gio.Cancellable();
        this._recordsDir = Gio.File.new_for_path(GLib.build_filenamev([GLib.get_user_cache_dir(), 'jade-shell', 'usage', 'records']));

        this._button = new PanelMenu.Button(0.5, 'AI usage');
        this._button.add_style_class_name('jade-usage-button');
        const panelBox = new St.BoxLayout();
        this._icon = new St.Icon({gicon: this._gicon('ai-usage-symbolic.svg'), style_class: 'system-status-icon ai-panel-icon'});
        this._bar = label('', 'ai-panel-text');
        panelBox.add_child(this._icon);
        panelBox.add_child(this._bar);
        this._button.add_child(panelBox);
        this._buildMenu();
        addToPanel('jade-usage', this._button);

        this._settingsChanged = this._settings.connect('changed::usage-show-percentages', () => this._renderPanel());
        this._menuOpened = this._button.menu.connect('open-state-changed', (_m, open) => {
            if (open)
                this._onOpened();
        });
        this._keyPress = this._button.menu.actor.connect('key-press-event', (_a, event) => this._onKey(event));

        this._watch();
        this._unfollow = this._theme.follow(palette => {
            usePalette(palette);
            this._render();
        });
        this._load();
        // Keeps countdowns, ages and the stale marker honest between records.
        this._tick = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 30, () => {
            this._renderPanel();
            if (this._button.menu.isOpen)
                this._renderMenu();
            return GLib.SOURCE_CONTINUE;
        });
    }

    disable() {
        this._alive = false;
        this._cancellable.cancel();
        this._cancellable = null;
        for (const id of ['_tick', '_reloadSoon']) {
            if (this[id])
                GLib.source_remove(this[id]);
        }
        this._tick = this._reloadSoon = null;
        if (this._monitor) {
            this._monitor.disconnect(this._monitorChanged);
            this._monitor.cancel();
        }
        this._monitor = null;
        this._unfollow();
        this._settings.disconnect(this._settingsChanged);
        this._button.destroy();
        this._button = this._bar = this._icon = null;
        this._hero = this._switch = this._content = this._footer = null;
        this._switchButtons = this._refreshAction = null;
        this._records = null;
    }

    _gicon(name) {
        return new Gio.FileIcon({file: this._extension.dir.get_child('icons').get_child(name)});
    }

    // -------------------------------------------------------- data

    _watch() {
        try {
            GLib.mkdir_with_parents(this._recordsDir.get_path(), 0o700);
            this._monitor = this._recordsDir.monitor_directory(Gio.FileMonitorFlags.WATCH_MOVES, this._cancellable);
            this._monitorChanged = this._monitor.connect('changed', (_m, file, other) => {
                const names = [file?.get_basename(), other?.get_basename()];
                if (names.some(n => n && !n.startsWith('.') && n.endsWith('.json')))
                    this._scheduleReload();
            });
        } catch (e) {
            console.error(`Jade Shell: cannot watch usage records: ${e.message}`);
        }
    }

    _scheduleReload() {
        if (this._reloadSoon)
            return;
        this._reloadSoon = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => {
            this._reloadSoon = null;
            this._load();
            return GLib.SOURCE_REMOVE;
        });
    }

    _load() {
        const cancellable = this._cancellable;
        const pending = PROVIDERS.map(({id}) => new Promise(resolve => {
            this._recordsDir.get_child(`${id}.json`).load_contents_async(cancellable, (file, result) => {
                try {
                    const [, bytes] = file.load_contents_finish(result);
                    const record = JSON.parse(new TextDecoder().decode(bytes));
                    resolve([id, record && typeof record === 'object' ? record : null]);
                } catch {
                    resolve([id, null]);
                }
            });
        }));
        Promise.all(pending).then(entries => {
            if (!this._alive || cancellable !== this._cancellable)
                return;
            this._records = Object.fromEntries(entries.filter(([, r]) => r));
            this._render();
        });
    }

    _providers() {
        return PROVIDERS.filter(p => this._records[p.id]);
    }

    _ageMs(record) {
        const ms = Date.parse(record?.updatedAt ?? '');
        return Number.isFinite(ms) ? Date.now() - ms : Infinity;
    }

    // Stale once two collection intervals pass without a record, or when the
    // collector had to fall back on earlier numbers.
    _isStale(record) {
        const interval = this._settings.get_int('usage-refresh-minutes') * 60000;
        return !!record.usageStatusText || record.limitsStale || this._ageMs(record) > Math.max(2 * interval, 5 * 60000);
    }

    // -------------------------------------------------------- collector

    _runCollector(mode) {
        const jade = jadeCommand();
        if (!jade) {
            this._refreshFailed = true;
            this._renderFooter();
            return;
        }
        if (mode === '--force') {
            if (this._refreshing)
                return;
            this._refreshing = true;
            this._refreshFailed = false;
            this._renderFooter();
        }
        this._lastProbe = Date.now();
        const cancellable = this._cancellable;
        try {
            const proc = Gio.Subprocess.new([jade, 'usage', 'collect', mode],
                Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE);
            // Not cancellable: a collector that has started should finish and
            // publish even if the extension is disabled meanwhile.
            proc.wait_async(null, (p, result) => {
                let ok = false;
                try {
                    p.wait_finish(result);
                    ok = p.get_successful();
                } catch {}
                if (!this._alive || cancellable !== this._cancellable || mode !== '--force')
                    return;
                this._refreshing = false;
                this._refreshFailed = !ok;
                this._renderFooter();
            });
        } catch (e) {
            console.error(`Jade Shell: usage collector failed to start: ${e.message}`);
            if (mode === '--force') {
                this._refreshing = false;
                this._refreshFailed = true;
                this._renderFooter();
            }
        }
    }

    _onOpened() {
        this._renderMenu();
        // Opening the menu is asking for current limits; local scans are reused.
        if (!this._refreshing && Date.now() - this._lastProbe > LIMITS_PROBE_GAP_S * 1000)
            this._runCollector('--limits-only');
    }

    _onKey(event) {
        const key = event.get_key_symbol();
        if (key === Clutter.KEY_r || key === Clutter.KEY_R) {
            this._runCollector('--force');
            return Clutter.EVENT_STOP;
        }
        if (key === Clutter.KEY_h || key === Clutter.KEY_l) {
            this._step(key === Clutter.KEY_l ? 1 : -1);
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    _step(delta) {
        const providers = this._providers();
        if (providers.length < 2)
            return;
        const index = providers.findIndex(p => p.id === this._selected);
        this._select(providers[(index + delta + providers.length) % providers.length].id);
    }

    _select(id) {
        if (id === this._selected)
            return;
        this._selected = id;
        this._renderMenu();
    }

    // -------------------------------------------------------- panel

    _render() {
        this._renderPanel();
        this._renderMenu();
    }

    _renderPanel() {
        const show = this._settings.get_boolean('usage-show-percentages');
        const providers = this._providers();
        const parts = [];
        let alarming = false;
        const spoken = [];
        for (const p of providers) {
            const record = this._records[p.id];
            const limit = bindingLimit(record);
            const stale = this._isStale(record) ? '*' : '';
            if (!limit) {
                parts.push(`${escape(p.short)} —${stale}`);
                spoken.push(`${p.short} unavailable`);
                continue;
            }
            const tag = windowTag(limit);
            const pct = `${Math.round(limit.percent * 100)}%`;
            const hot = limit.percent >= ALARM;
            alarming ||= hot;
            const value = hot ? `<span foreground="${HEX.urgent}">${pct}</span>` : pct;
            parts.push(`${escape(p.short)}${tag ? ` <span foreground="${HEX.muted}">${tag}</span>` : ''} ${value}${stale}`);
            spoken.push(`${p.short} ${tag} ${pct} used`);
        }
        this._bar.visible = show && parts.length > 0;
        this._icon.visible = !this._bar.visible;
        this._bar.clutter_text.set_markup(parts.join('  ·  '));
        if (alarming)
            this._icon.add_style_class_name('ai-alarm');
        else
            this._icon.remove_style_class_name('ai-alarm');
        this._button.accessible_name = spoken.length ? `AI usage: ${spoken.join(', ')}` : 'AI usage: no data yet';
    }

    // -------------------------------------------------------- menu

    _section(actor, style) {
        const item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false, style_class: style});
        item.add_child(actor);
        this._button.menu.addMenuItem(item);
        return actor;
    }

    // The menu is four long-lived sections. Only the content section is
    // rebuilt on new data; the focusable switch and footer buttons persist so
    // keyboard focus and hover survive a refresh landing while it is open.
    _buildMenu() {
        const menu = this._button.menu;
        menu.box.add_style_class_name('jade-frame');
        menu.box.add_style_class_name('jade-usage');
        this._hero = this._section(new St.BoxLayout({x_expand: true, style_class: 'ai-hero'}), 'ai-hero-item');
        this._switch = this._section(new St.BoxLayout({x_expand: true, style_class: 'ai-switch'}), 'ai-switch-item');
        this._switchKey = null;
        this._content = this._section(new St.BoxLayout({orientation: VERTICAL, x_expand: true, style_class: 'ai-content'}), 'ai-content-item');
        this._footer = this._section(new St.BoxLayout({x_expand: true, style_class: 'ai-footer'}), 'ai-footer-item');

        const action = (text, iconName, callback) => {
            const button = new St.Button({can_focus: true, reactive: true, track_hover: true, x_expand: true, style_class: 'ai-action'});
            const box = new St.BoxLayout({style_class: 'ai-action-content', x_align: Clutter.ActorAlign.CENTER});
            const icon = new St.Icon({icon_name: iconName, icon_size: 14});
            const text_ = label(text);
            box.add_child(icon);
            box.add_child(text_);
            button.set_child(box);
            button.connect('clicked', callback);
            this._footer.add_child(button);
            return {button, icon, text: text_};
        };
        this._refreshAction = action('Refresh', 'view-refresh-symbolic', () => this._runCollector('--force'));
        action('Settings', 'emblem-system-symbolic', () => {
            menu.close();
            this._extension.openPreferences();
        });
    }

    _renderMenu() {
        if (!this._alive)
            return;
        const providers = this._providers();
        if (!providers.some(p => p.id === this._selected) && providers.length)
            this._selected = providers[0].id;
        const record = this._records[this._selected];
        this._renderHero(record);
        this._renderSwitch(providers);
        this._renderContent(record);
        this._renderFooter();
    }

    _renderHero(record) {
        this._hero.destroy_all_children();
        if (!record) {
            this._hero.add_child(label('AI usage', 'ai-hero-title'));
            return;
        }
        const provider = PROVIDERS.find(p => p.id === this._selected);
        this._hero.add_child(new St.Icon({gicon: this._gicon(provider.icon), style_class: 'ai-hero-icon', y_align: Clutter.ActorAlign.CENTER}));
        const text = new St.BoxLayout({orientation: VERTICAL, x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        text.add_child(label(record.name || provider.short, 'ai-hero-title'));
        const status = String(record.usageStatusText || '');
        text.add_child(status
            ? label(status.toUpperCase(), 'ai-hero-meta ai-urgent')
            : label((record.tierLabel || 'Subscription').toUpperCase(), 'ai-hero-meta'));
        this._hero.add_child(text);
        const age = this._ageMs(record);
        this._hero.add_child(label(Number.isFinite(age) ? formatAge(age) : '', `ai-caption${this._isStale(record) ? ' ai-urgent' : ''}`, {y_align: Clutter.ActorAlign.START}));
    }

    _renderSwitch(providers) {
        const key = providers.map(p => p.id).join(',');
        if (key !== this._switchKey) {
            this._switchKey = key;
            this._switch.destroy_all_children();
            this._switchButtons = {};
            for (const p of providers) {
                const button = new St.Button({
                    label: p.short, can_focus: true, reactive: true, track_hover: true,
                    x_expand: true, style_class: 'ai-chip', accessible_name: `Show ${p.short}`,
                });
                button.connect('clicked', () => this._select(p.id));
                this._switch.add_child(button);
                this._switchButtons[p.id] = button;
            }
        }
        this._switch.get_parent().visible = providers.length > 1;
        for (const [id, button] of Object.entries(this._switchButtons ?? {})) {
            if (id === this._selected)
                button.add_style_pseudo_class('checked');
            else
                button.remove_style_pseudo_class('checked');
        }
    }

    _header(box, text) {
        box.add_child(label(text, 'ai-section'));
    }

    _renderContent(record) {
        const box = this._content;
        box.destroy_all_children();
        if (!record) {
            box.add_child(label('No usage yet.', 'ai-text'));
            box.add_child(label('Press Refresh, or check that the collector is installed.', 'ai-caption', {x_expand: true}));
            return;
        }
        const nowMs = Date.now();

        if (record.usageStatusText && record.authHelpText) {
            const card = new St.BoxLayout({orientation: VERTICAL, style_class: 'ai-card'});
            const help = label(String(record.authHelpText), 'ai-caption');
            help.clutter_text.line_wrap = true;
            help.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
            card.add_child(help);
            if (record.limitsStale)
                card.add_child(label('Showing the last known limits.', 'ai-caption'));
            box.add_child(card);
        }

        const limits = limitsOf(record);
        if (limits.length) {
            const section = new St.BoxLayout({orientation: VERTICAL, style_class: 'ai-group ai-divided'});
            this._header(section, 'LIMITS');
            for (const limit of limits) {
                const hot = limit.percent >= ALARM;
                const row = new St.BoxLayout({orientation: VERTICAL, style_class: 'ai-limit'});
                const top = new St.BoxLayout({x_expand: true});
                top.add_child(label(windowTitle(limit), 'ai-text', {x_expand: true}));
                top.add_child(label(`${Math.round(limit.percent * 100)}%`, `ai-value${hot ? ' ai-urgent' : ''}`));
                row.add_child(top);
                row.add_child(meter(limit.percent, {color: hot ? RGB.urgent : RGB.jade}));
                const inMs = resetInMs(limit, nowMs);
                if (inMs !== null)
                    row.add_child(label(inMs > 0 ? `Resets in ${formatDuration(inMs)}` : 'Reset due · refresh for new numbers', 'ai-caption'));
                section.add_child(row);
            }
            const credits = Number(record.resetCredits) || 0;
            if (credits > 0)
                section.add_child(label(`${credits} free full reset${credits === 1 ? '' : 's'} available in Codex`, 'ai-caption ai-jade'));
            box.add_child(section);
        }

        const days = record.recentDays ?? [];
        if (days.length) {
            const section = new St.BoxLayout({orientation: VERTICAL, style_class: 'ai-group ai-divided'});
            this._header(section, 'TOKENS BY DAY');
            const peak = Math.max(1, ...days.map(d => Number(d.messageCount) || 0));
            const today = localDate(nowMs);
            for (const day of days) {
                const isToday = day.date === today;
                const row = new St.BoxLayout({x_expand: true, style_class: `ai-day${isToday ? ' ai-today' : ''}`});
                row.add_child(label(isToday ? 'Today' : dayName(day.date), 'ai-day-name'));
                row.add_child(meter((Number(day.messageCount) || 0) / peak, {alpha: isToday ? 1 : 0.55, height: 5}));
                row.add_child(label(formatTokens(day.messageCount), 'ai-day-value'));
                section.add_child(row);
            }
            // Prompt and session counts exist for today only.
            if (record.hasPromptStats !== false && days.some(d => d.date === today))
                section.add_child(label(`Today · ${Number(record.todayPrompts) || 0} prompts · ${Number(record.todaySessions) || 0} sessions`, 'ai-caption'));
            box.add_child(section);
        }

        const models = Object.entries(record.modelUsage ?? {}).map(([id, b]) => {
            const n = k => Number(b?.[k]) || 0;
            const split = [n('inputTokens'), n('outputTokens'), n('cacheReadInputTokens'), n('cacheCreationInputTokens')];
            return {name: modelName(id), split, total: split.reduce((a, v) => a + v, 0)};
        }).sort((a, b) => b.total - a.total).slice(0, 4);
        if (models.length) {
            const section = new St.BoxLayout({orientation: VERTICAL, style_class: 'ai-group ai-divided'});
            this._header(section, 'TOKENS BY MODEL');
            const detail = label('', 'ai-caption');
            const describe = m => {
                const [input, output, read, write] = m.split;
                detail.text = `${m.name} · in ${formatTokens(input)} · out ${formatTokens(output)} · cache ${formatTokens(read + write)}`;
            };
            for (const m of models) {
                const row = shareRow(m.total / Math.max(1, models[0].total), [
                    label(m.name, 'ai-text', {x_expand: true}),
                    label(formatTokens(m.total), 'ai-model-value'),
                ]);
                row.connect('notify::hover', () => describe(row.hover ? m : models[0]));
                section.add_child(row);
            }
            detail.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            describe(models[0]);
            section.add_child(detail);
            box.add_child(section);
        }
    }

    _renderFooter() {
        if (!this._refreshAction)
            return;
        const {button, text} = this._refreshAction;
        const installed = jadeCommand() !== null;
        text.text = this._refreshing ? 'Refreshing…' : !installed ? 'No collector' : this._refreshFailed ? 'Retry refresh' : 'Refresh';
        button.reactive = !this._refreshing && installed;
        if (this._refreshFailed)
            button.add_style_class_name('ai-failed');
        else
            button.remove_style_class_name('ai-failed');
    }
}
