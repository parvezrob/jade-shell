import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

// Osaka Jade, until `jade` has written a palette.
const FALLBACK = {
    id: 'osaka-jade', name: 'Osaka Jade', accent_fg: '#111c18',
    colors: {
        background: '#111c18', dark_background: '#0d1512', foreground: '#C1C497', accent: '#509475',
        red: '#FF5345', green: '#549e6a', yellow: '#E5C736', mode: 'dark',
    },
};

export function stateFile(...names) {
    return Gio.File.new_for_path(GLib.build_filenamev([GLib.get_user_state_dir(), 'jade-shell', ...names]));
}

export function readTheme() {
    try {
        const [, bytes] = stateFile('colors.json').load_contents(null);
        const theme = JSON.parse(new TextDecoder().decode(bytes));
        if (theme?.colors?.background)
            return theme;
    } catch {}
    return FALLBACK;
}

// The window in the current theme's colors, Omarchy's way: the terminal
// font, square frames with thin rules, small capitals for headings, the
// accent on what is switched on (headings are upper-cased by capsTitles:
// GTK's CSS has no text-transform). Everything is scoped to `.jade-prefs`, as
// other extensions' settings open in the same process, and it is driven
// by libadwaita's own color variables, so every widget and dialog follows.
function css({colors: c, accent_fg: accentFg}) {
    const fg = c.foreground;
    const card = c.dark_background ?? c.background;
    const rule = `alpha(${fg}, 0.14)`;
    return `
.jade-prefs {
    --window-bg-color: ${c.background}; --window-fg-color: ${fg};
    --view-bg-color: ${c.background}; --view-fg-color: ${fg};
    --headerbar-bg-color: ${c.background}; --headerbar-fg-color: ${fg};
    --headerbar-backdrop-color: ${c.background}; --headerbar-shade-color: ${rule};
    --card-bg-color: ${card}; --card-fg-color: ${fg}; --card-shade-color: ${rule};
    --popover-bg-color: ${card}; --popover-fg-color: ${fg};
    --dialog-bg-color: ${c.background}; --dialog-fg-color: ${fg};
    --thumbnail-bg-color: ${card}; --thumbnail-fg-color: ${fg};
    --accent-bg-color: ${c.accent}; --accent-fg-color: ${accentFg ?? c.background}; --accent-color: ${c.accent};
    --destructive-bg-color: ${c.red}; --destructive-fg-color: ${c.background}; --destructive-color: ${c.red};
    --success-color: ${c.green}; --warning-color: ${c.yellow}; --error-color: ${c.red};
    --border-color: ${rule};
    font-family: "JetBrains Mono", "JetBrainsMono Nerd Font", monospace;
    font-size: 10pt;
}
.jade-prefs .boxed-list, .jade-prefs .card, .jade-prefs list.boxed-list-separate > row {
    border-radius: 0;
    box-shadow: 0 0 0 1px ${rule};
}
.jade-prefs row, .jade-prefs button, .jade-prefs entry, .jade-prefs spinbutton,
.jade-prefs .shortcut-label > *, .jade-prefs dialog, .jade-prefs dialog.floating sheet,
.jade-prefs popover > contents, .jade-prefs viewswitcher button.toggle {
    border-radius: 0;
}
.jade-prefs switch, .jade-prefs switch > slider { border-radius: 0; }
.jade-prefs switch:checked { background-color: ${c.accent}; }
.jade-prefs preferencesgroup .header .title, .jade-prefs .jade-caps {
    font-size: 8.5pt; font-weight: 800; letter-spacing: 2px;
    color: alpha(${fg}, 0.62);
}
.jade-prefs preferencesgroup .header .description { color: alpha(${fg}, 0.7); }
/* Rows name their labels the same way as group headings: plain again. */
.jade-prefs row .header .title { font-size: 10pt; font-weight: 600; letter-spacing: 0; color: ${fg}; }
.jade-prefs row .header .subtitle { font-size: 8.5pt; letter-spacing: 0; }
.jade-prefs row .subtitle, .jade-prefs .dim-label { color: alpha(${fg}, 0.62); }
.jade-prefs viewswitcher button.toggle:checked {
    background: none; box-shadow: inset 0 -2px ${c.accent}; color: ${fg};
}
.jade-prefs button.suggested-action, .jade-prefs row.button.suggested-action { color: ${accentFg}; }
.jade-prefs row.button.destructive-action { color: ${c.red}; }
.jade-prefs .jade-hero { padding: 18px; }
.jade-prefs .jade-hero-name { font-size: 17pt; font-weight: 800; }
.jade-prefs .jade-hero-picture { border: 1px solid ${rule}; }
`;
}

// Dress `window` in the theme, and follow theme switches while it is open.
export function applyStyle(window, onChange = () => {}) {
    const display = Gdk.Display.get_default();
    const provider = new Gtk.CssProvider();
    const load = () => {
        const theme = readTheme();
        provider.load_from_string(css(theme));
        onChange(theme);
    };
    window.add_css_class('jade-prefs');
    Gtk.StyleContext.add_provider_for_display(display, provider, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);
    load();
    const monitor = stateFile().monitor_directory(Gio.FileMonitorFlags.WATCH_MOVES, null);
    let pending = 0;
    monitor.connect('changed', (_m, file, other) => {
        if (![file?.get_basename(), other?.get_basename()].includes('colors.json') || pending)
            return;
        pending = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200, () => {
            pending = 0;
            load();
            return GLib.SOURCE_REMOVE;
        });
    });
    window.connect('close-request', () => {
        monitor.cancel();
        if (pending)
            GLib.source_remove(pending);
        Gtk.StyleContext.remove_provider_for_display(display, provider);
        return false;
    });
}

// Group titles in capitals, Omarchy's section style.
export function capsTitles(window) {
    const walk = widget => {
        for (let child = widget.get_first_child(); child; child = child.get_next_sibling()) {
            if (child instanceof Adw.PreferencesGroup && child.title)
                child.title = child.title.toUpperCase();
            walk(child);
        }
    };
    walk(window);
}
