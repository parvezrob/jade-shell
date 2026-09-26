# The Jade Shell guide

Everything Jade Shell does, in detail. The short version is the [README](../README.md).

- [Install](#install): what setup changes, updates, the first login
- [Use](#use): the picker, dock, icons, Jade Menu, capture tools, network panel, glass, keymap, command line, settings
- [What a theme switch changes](#what-a-theme-switch-changes): every app, and how undo works
- [In the top bar](#in-the-top-bar)
- [Remove](#remove)
- [Personal overrides](#personal-overrides): your own colors, templates and hooks

## Install

```bash
wget -qO- https://jadeshell.app/install | bash
```

(Or `curl -fsSL https://jadeshell.app/install | bash`: Ubuntu's desktop comes with `wget` only, Fedora's with both.) `jadeshell.app/install` is [`install.sh`](../install.sh) in this repository (it forwards there); read it first if you like.

Run it in a terminal on your desktop, as yourself. It checks your system, downloads the latest `.rpm` or `.deb` release (a download that was cut off continues where it stopped the next time), checks it against the release checksums, asks for your password once and installs it with `dnf` or `apt`, waiting if the Software app or automatic updates are busy. Then it runs `jade setup`, and last adds text and QR code reading (Tesseract and ZBar, for the screenshot's **Copy Text** and the QR code reader; Jade Shell works without them). Run again, it only sets up your desktop; `--reinstall` installs the package again. `jade setup`:

- turns off extensions that do the same jobs or would take over the top bar (Dash to Panel, OpenBar, User Themes, Blur my Shell, system monitors such as Vitals and a few more; `setup` names each one it turns off, and `jade restore` turns them back on),
- hands the dock to Jade Shell's own (turning off Dash to Dock or Ubuntu Dock; `jade restore` turns them back on). Jade Shell's dock starts at your next login, so until then the one you have stays,
- builds the Tahoe icons from the copy that comes with the package (no download),
- makes JetBrains Mono (installed with the package, as in Omarchy) the monospace font of GNOME and your terminals, unless you chose one before (`jade font set` changes it; `jade theme undo` or `jade restore` puts yours back),
- starts the usage collector if you have Claude Code or Codex,
- applies Osaka Jade, downloading only its wallpaper (offline, your current wallpaper stays until you pick a theme),
- then makes the other themes' previews in the background (the picker fetches any still missing when it opens; other wallpapers are downloaded when you pick them).

Running `jade setup` again keeps the settings and AI usage choice you made since; with AI usage turned off, the collector stays stopped.

**Updates** come through `dnf`, `apt`, GNOME Software or the installer. Jade Shell notices a new version is installed and offers to log out; at the next login it finishes the update in the background (the settings and one-time changes the new version needs, the theme rebuilt), leaves on any extension you turned back on yourself, and says when it's done. `update.log` in `~/.local/state/jade-shell` has the details.

Once a day Jade Shell also asks the latest release for its version (a few bytes from GitHub; turn it off under **Updates** in the settings). When a newer one is out, a notification offers **Update**, which asks for your password in GNOME's own dialog and installs it, and **What's new**. From a terminal, `jade update` does the same (`jade update --check` only looks). The package is checked against the release's `SHA256SUMS` before anything is installed.

If your home folder still has a copy of Jade Shell from before the packages (or from `scripts/dev-install.sh`), GNOME Shell would keep loading it instead of the package's, so the installer stops and prints the `rm -rf` command that removes it; run that, then the installer again. `jade setup` and `jade doctor` also point out such copies, and files left by older versions (Jade AI Usage, `jade-theme`), with the command to remove them. Nothing is deleted for you.

Log out and back in once to start the extension. At that first login the **Jade Shell** app opens on its **Welcome** page: pick a theme, glass, icons and the Omarchy keymap, the city for the weather, and see the keys worth knowing. Everything there is optional and applies at once. `jade doctor` checks everything is in place.

## Use

- **Picker:** click the palette icon in the top bar, or press **Super+Ctrl+Shift+Space**. Arrow keys move, Enter applies. The menu stays open while you try themes. Each theme keeps the wallpaper you last gave it; pick the current theme again for its next wallpaper.
- **Dock:** icons grow under the pointer, a label names each one, running apps have a dot, and an app's icon bounces until its window is up (or when it asks for attention). Windows pour into their icon when minimized (the genie), and the trash and the app grid sit past the separator. It hides when a window comes near it; push the pointer against the bottom edge to bring it back. Right-click an icon for its windows, New Window, Pin or Unpin and Quit; drag apps from the app grid onto it, or along it, to pin and order them. It is drawn on frosted glass in the theme's colors, and moves by transforms on the GPU, so it keeps up with high refresh rate screens. Size, magnification, when it hides and its effects are under **Dock** in the settings.
- **Icons:** Jade Shell starts with **Tahoe** icons in full color (their folders, Files and Software in the theme's accent). Under **Dock › Icons** in the settings, pick GNOME's own or **Tahoe**, Mac-style icons (the [MacTahoe](https://github.com/vinceliuice/MacTahoe-icon-theme) theme, which comes with the package and takes about 180 MB once built) with their folders in the theme's exact accent, and either one **tinted**: every icon in the dock and the app grid redrawn in the theme's own shades, as macOS 26 tints them. `jade apps on icons` and `jade apps off icons` switch the Tahoe icons from a terminal; `jade restore` puts your icons back and deletes the built ones.
- **Modes you might forget are on** show in the top bar only while on, and a click turns one off: **stay awake** (no dimming, locking or suspending, like the Caffeine extension; also a Quick Settings toggle; **Super+Ctrl+I**), **night light** (**Super+Ctrl+N**) and, while the bell is off, Do Not Disturb (**Super+Ctrl+,**). Stay awake ends with the session.
- **The Jade Menu** (**Super+Alt+Space**), a keyboard menu for everything, inspired by Omarchy's: Apps, Capture (screenshot, screen recording), Toggles with live check marks (stay awake, night light, Do Not Disturb, dark style, dock, monitor, AI usage, bell), Style (theme, next wallpaper, the picker, font, icons), Setup (Jade Shell's and GNOME's settings, shortcuts, updates, undo), Learn and System (lock, suspend, log out, restart, power off). Type to search everything at once; arrows, Enter, ← and Escape do the rest. Add your own entries in `~/.config/jade-shell/menu.json`: `{"items": [{"path": "Setup/Edit my notes", "command": "gnome-text-editor ~/notes.md"}]}`.
- **Clipboard history** (**Super+Ctrl+V**): what you copied, text and images, newest first and searchable. Enter copies an entry back, Delete forgets it. It's kept in memory only, and never what a password manager marks as secret. Turn it off in Jade Shell's settings.
- **After a screenshot**, a card in the corner (as macOS shows one) instead of GNOME's banner: **Edit** (in [Gradia](https://flathub.org/apps/be.alexandervanhee.gradia) or Satty when installed, else your image viewer), **Text** (copies the words in it), **Pin** (keeps the shot on screen above your windows: drag it, scroll to resize, double-click to let go) and **Files**. GNOME still copies and saves the shot as always; turn the card off in the settings.
- **Capture tools** in the Jade Menu's Capture: a **color picker** (**Super+Print**, copies `#rrggbb`), **Copy Text from Screen** and **Read QR Code** (select an area; the text is copied). Text and QR codes are read by Tesseract and ZBar, which the package recommends; without them Jade says what to install.
- **Network panel** (its icon in the top bar, in place of GNOME's network icon and showing the same Wi-Fi, wired and VPN states; or **Super+Ctrl+W**, as in Omarchy; or the Jade Menu's Setup › Network; turn the icon off under Settings › Top bar): your connection (Wi-Fi band, channel and signal, or Ethernet), ping to the router and the internet, address and DNS. **Test Speed** measures download and upload with live dials against Cloudflare's speed test (only when you press it; it counts only its own traffic). **Share Wi-Fi** shows the network as a QR code a phone camera joins from. **DNS** switches between your network's own, Cloudflare and Google; on Wi-Fi, **Band** pins 2.4, 5 or 6 GHz. `jade restore` puts DNS and band back. From a terminal: `jade network`, `jade network speedtest`, `jade network qr`, `jade network dns cloudflare`, `jade network band 5`. It all goes through NetworkManager, so GNOME's own Wi-Fi list and settings stay in charge of connecting.
- **Frosted glass** (Settings › Desktop › **Glass**, or the Jade Menu's Toggles): the top bar, every menu, dialogs, notification banners, the volume and brightness pop-ups and the screenshot card blur what is behind them, windows included, tinted by the theme, like the dock; the overview and app grid sit on your wallpaper, blurred, as macOS's Launchpad does. **Glass tint** (from clear to nearly solid) and **Glass blur** (from none to strong) tune it, live. It only works while a surface is on screen, and skips the blur during open and close fades. If Blur my Shell is on, the top bar is left to it.
- **Keyboard shortcuts:** **Super+K** shows every shortcut on this desktop in one searchable sheet: Jade Shell's, GNOME's (named as GNOME's Settings names them) and the ones you added yourself, read afresh each time, so changes show at once.
- **Omarchy keymap** (optional): `jade keys apply`, or the switch in the settings' Keyboard group, puts Omarchy's keys on GNOME's own shortcuts: **Super+Space** for the Jade Menu, **Super+Alt+Space** for apps, **Super+Return** for a terminal, **Super+W**/**Super+Q** to close, **Super+F** full screen, **Super+1…9** and **Super+Shift+1…9** for workspaces, **Super+Tab** for the next workspace, **Super+Escape** for the System menu, **Super+Shift+B** or **Super+Shift+Return** for the browser, **Super+Shift+F** for Files, **Super+Ctrl+L** to lock. What GNOME had on those keys moves (keyboard layouts to Super+Shift+Space, window screenshots to Shift+Alt+Print, Super+Tab's app switching stays on Alt+Tab), and your own shortcuts on them are taken off. Every key it changes is saved first: `jade keys revert` (or `jade restore`) puts them all back exactly. `jade keys` lists the keymap. Without it, Omarchy's keys that clash with nothing are on anyway: Super+Ctrl+C for Capture, Super+Ctrl+O for Toggles, Super+Print to pick a color, Super+Ctrl+Print to copy text from the screen.
- **Command line:**

  ```bash
  jade theme list                 # themes; * marks the current one
  jade theme plan tokyo-night     # show exactly what would change, change nothing
  jade theme set tokyo-night      # switch
  jade theme wallpaper            # next wallpaper of the current theme
  jade theme undo                 # restore what the last switch changed
  ```

  `--only` and `--skip` limit a switch to some targets, e.g. `jade theme set nord --skip vscode,kitty`. The target names are in the table below.
- **Community themes:** Omarchy's [community themes](https://omarchy.org/themes) work too: `jade theme install https://github.com/dhh/omarchy-giants-theme` adds one, and it shows in the picker and the Jade Menu like the others. Jade Shell keeps only a theme's colors, wallpapers and preview (in `~/.config/jade-shell/themes/`); scripts, app configs and anything else in the repo stay behind and never run. Older themes without a `colors.toml` get their colors from their Alacritty theme. `jade theme update` fetches them again, `jade theme remove giants` removes one. A theme named like one of Jade Shell's installs under another name with `--name`.
- **Font:** `jade font list` shows the monospace fonts you have; `jade font set JetBrains Mono` uses one in GNOME (your size stays), Ptyxis, Kitty, Ghostty and Alacritty, and keeps it through theme switches; `jade theme undo` puts the previous fonts back. The settings have it as **Monospace font**.
- **Leave an app alone:** turn it off under **Apps** in the settings, or run `jade apps off kitty`. Its own config comes back as it was before Jade Shell (keeping any edits you made since), and no switch, setup or picker touches it again until `jade apps on kitty`. `jade apps` lists them all.
- **Reporting a problem:** `jade debug` collects what a bug report needs (versions, GPU, extensions, `jade doctor`, the end of the install log, GNOME Shell's messages about Jade Shell) with your user name, host name and home folder replaced, and offers to save it and open a pre-filled GitHub issue. The settings' About page has the same as **Report a Problem…**.
- **Settings:** the **Jade Shell** app. Search for "Jade" (or "dock", "theme", "weather"…), click the Jade Shell button in Quick Settings next to GNOME's own, Settings in the theme picker, right-click the dock's divider for Dock Settings…, or run `jade settings [page]`. GNOME's Extensions app opens the same pages. **Welcome** is the first-run page (look, weather, keys). **Desktop** turns parts of the top bar on or off, sets the clock format, the app grid size and the picker's shortcut, and chooses which apps get themed. **Dock** sets the dock's size, magnification and when it hides. **AI Usage** sets how often usage is collected. **About** has the version and credits, the update check, **Run Checks** (what `jade doctor` checks, with what to do about each problem) and **Restore My Previous Desktop**: everything `jade doctor` and `jade restore` do, without a terminal.

## What a theme switch changes

| Target (name) | How |
|---|---|
| GNOME Shell (`shell`) | a Shell theme compiled from GNOME's own theme sources (the light ones for light themes) with the Omarchy palette and the theme's exact accent: top bar, menus, quick settings, calendar, notifications, dialogs, lock screen |
| GNOME (`gnome`) | light or dark style to match the theme, the nearest named accent for apps, wallpaper (desktop and lock screen) |
| Dock (`dock`) | Dash to Dock or Ubuntu Dock colors, if you use one instead of Jade Shell's dock (which follows the theme by itself) |
| Icons (`icons`) | the Tahoe icons' folders in the accent, and their light or dark variant (built at setup from the package's copy; `jade apps off icons` puts GNOME's back) |
| Ptyxis (`ptyxis`) | an Omarchy palette file, selected in every profile |
| GNOME apps (`gtk`) | the theme's colors in a marked block of `~/.config/gtk-4.0/gtk.css` and `gtk-3.0/gtk.css` (libadwaita's named colors and CSS variables), so Files, Settings, Text Editor and other GNOME apps follow the theme when they next start; GTK 3 apps follow with the adw-gtk3 theme. Setup lets Flatpak apps read those files; restore takes that back |
| Kitty (`kitty`) | `jade-theme.conf`, included at the end of `kitty.conf` (your own colors stay, overridden); kitty reloads |
| Ghostty (`ghostty`) | `jade-theme.conf`, loaded last from Ghostty's config (`config-file`); Ghostty reloads |
| Alacritty (`alacritty`) | `jade-theme.toml`, imported first in `alacritty.toml` (colors you set there yourself still win); Alacritty reloads by itself |
| Neovim (`neovim`) | a `jade` colorscheme drawn from the palette, no plugin needed: pick it with `:colorscheme jade` (LazyVim: `opts = { colorscheme = "jade" }`); every running Neovim using it recolors at once |
| Obsidian (`obsidian`) | a Jade Shell theme in every vault Obsidian knows about (from Omarchy's), chosen in the vaults that are on Obsidian's default theme; undo gives back only that choice |
| tmux (`tmux`) | `~/.config/tmux/jade-theme.conf` (styles only: status bar, windows, pane borders, messages, copy mode, menus; your status line's contents stay), sourced at the end of `~/.tmux.conf` or `~/.config/tmux/tmux.conf`; running tmux servers recolor at once |
| Vicinae (`vicinae`) | an `omarchy-<theme>` theme, selected in its config |
| Starship (`starship`) | a `jade` palette block (Catppuccin color names mapped to the theme) |
| btop (`btop`) | a `jade` theme; btop reloads |
| VS Code (`vscode`) | one local extension providing every theme as "Jade · Name"; switching sets `workbench.colorTheme`. The same for VS Code Insiders, VSCodium, Code - OSS and the Flatpak builds of VS Code and VSCodium, whichever are set up |
| Claude Code (`claude`) | a `jade` theme in `~/.claude/themes`, which Claude Code reloads live; choose it once with `/theme` |

Everything applies live; newly opened GTK apps pick up the accent as they start. Apps you don't have are skipped, and so is one whose config Jade Shell can't read (the switch says why). Symlinked dotfiles stay symlinks: Jade Shell writes through the link. Offline, a switch still changes the colors and keeps your current wallpaper.

Every switch first saves the value of each setting and file it will change, in `~/.local/state/jade-shell/backups/`. `jade theme undo` puts those back, and repeated undos walk further back. If you edited a config after the switch (or the app rewrote it, as btop and VS Code do), undo takes out only Jade Shell's part: the Kitty include, the Starship palette block and `palette` line, btop's `color_theme`, VS Code's `workbench.colorTheme` and its extension entry, Vicinae's theme names. Your edits stay. Where that can't be done cleanly, for example because you picked another theme in the app since, the file is left as it is and undo says so. A setting whose app is gone is skipped. The 30 most recent switches are kept, plus the state from before your first one.

## In the top bar

Modelled on Omarchy Quattro's bar: every icon on the right sits on the same rhythm, and every icon in the bar, GNOME's status icons included (volume, battery, power, Bluetooth, Wi-Fi…), comes from one family of Jade Shell's own line icons.

- **Workspaces** replace Activities: numbered, the current one filled with the accent. Click the current one for the overview; scroll to move between them.
- **Media:** what's playing (Spotify, Firefox, any player that speaks MPRIS), shown while it plays or is paused. Click for the cover and controls; scroll over it for the previous or next track.
- **Weather**, beside the clock: for the city you pick in the Jade Shell app (Welcome or Desktop page; or GNOME Weather's place until you do): its icon and temperature, and the next hours in the menu. Jade fetches it itself (MET Norway and others, as GNOME does), so it works without the GNOME Weather app, which Ubuntu doesn't ship. Units follow your language unless you choose °C or °F. Nothing shows without a place.
- **System monitor:** CPU, memory, GPU and CPU temperature. It reads `/proc` and sysfs every two seconds, and on NVIDIA keeps one `nvidia-smi` running instead of starting one per update. It never polls the GPU on battery. Click it for your system monitor app.
- **AI usage:** one icon (it turns the alarm color when a limit runs close; Settings › AI Usage › **Show percentages** puts "Claude 7d 36% · Codex 7d 10%" in the bar instead), with Omarchy's usage panel as its menu (limits, tokens by day and by model). It uses Omarchy's own collectors, run every ten minutes by a user timer.
- **Clock** as "Tuesday 14:05" or "Tuesday 2:05 PM", following the time format in GNOME's Settings (or a format of your own), and GNOME starts on the desktop instead of the overview. Its menu is the calendar.
- **Notifications** behind a bell, in a panel of their own, as in Omarchy's notification center: a dot while any wait there (or, in the settings, only for missed pop-ups, as GNOME counts them), Do Not Disturb and Clear at the top. **Super+V** opens it, and pop-ups appear at the top right under it. Omarchy's keys work too: **Super+,** dismisses the newest notification, **Super+Shift+,** all of them, **Super+Alt+,** opens the newest, **Super+Ctrl+,** turns Do Not Disturb on or off and **Super+Shift+Alt+,** opens the panel (all changeable under **Keyboard** in the settings). Turn the bell off in the settings to have GNOME's layout back.

## Remove

```bash
wget -qO- https://jadeshell.app/install | bash -s -- --uninstall
```

This asks first, then runs `jade restore`, which undoes the theme switches and the settings `jade setup` changed, then removes Jade Shell and the parts it added (sassc, text and QR code reading) that nothing else uses. Without a terminal to ask on (from a script, say), add `--yes`: `bash -s -- --uninstall --yes`. The extensions setup turned off come back; extensions you turned on or off yourself since stay as they are, and config files you edited after a switch keep your edits, the same way undo does. If an older or development copy is still in your home folder afterwards, the uninstaller prints the command to remove it. Once your desktop is back, Jade Shell's own files go too (the downloaded wallpapers and previews in `~/.local/share/jade-shell`, `~/.local/state/jade-shell` and `~/.cache/jade-shell`); the install log stays for a report. If the package was already removed another way, the uninstaller puts your desktop back with the copy of Jade Shell's code setup keeps (see below). The JetBrains Mono font stays installed, since the terminal you ran this in is still drawing with it; your package manager removes it if you want.

Removing the package another way (`dnf`, `apt`, a software app) skips `jade restore`, so your desktop keeps Jade Shell's look for now. At your next login a notification asks whether to **Restore My Desktop** (the same restore, from a copy of Jade Shell's code that setup keeps in `~/.local/share/jade-shell/restore-kit`) or **Keep This Look**. Either way, that copy then removes itself; after a restore, so do Jade Shell's downloaded wallpapers and logs.

## Personal overrides

Pin any color, or reuse wallpapers you already have, in `~/.config/jade-shell/themes/<theme>.toml`. See [examples/osaka-jade.toml](../examples/osaka-jade.toml). Besides Omarchy's keys, two GNOME shades can be pinned: `dock_background` and `secondary_text`.

### Your own templates and hooks

For an app Jade Shell doesn't theme, write a template: a copy of its config with placeholders, in `~/.config/jade-shell/themed/NAME.tpl`. At every switch Jade Shell fills it in and writes `~/.local/state/jade-shell/themed/NAME`, for your config to include. Placeholders are those of Jade Shell's own templates: any palette key (`{{ accent }}`, `{{ background }}`…), with `_strip` for no `#` or `_rgb` for `r,g,b`, `{{ mix background accent 20% }}` for a blend, and `{{ name }}`, `{{ id }}` and `{{ mode }}`. A misspelled placeholder is reported and that template skipped.

To run something after a switch (reload an app, say), put an executable in `~/.config/jade-shell/hooks/theme-set.d/`: it gets the theme's id, and `JADE_THEME`, `JADE_THEME_NAME` and `JADE_MODE`. Executables in `hooks/post-update.d/` run after an update. A hook that fails is reported; the switch stands. [examples/themed](../examples/themed) and [examples/hooks](../examples/hooks) have commented samples.
