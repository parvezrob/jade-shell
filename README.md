# Jade Shell

Omarchy's look on the GNOME you already run. One install gives Fedora or Ubuntu Omarchy's themes, a theme picker that re-colors the whole desktop at once, workspace buttons, a light system monitor and your Claude and Codex usage in the top bar. No new OS, no tiling window manager to learn.

**Status: early (0.9), GNOME 50 only.** Tested on Fedora 44 and Ubuntu 26.04.

![The Jade Shell theme picker: Omarchy's themes as wallpaper previews](docs/picker.png)

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/parvezrob/jade-shell/main/install.sh | bash
```

Run it as your desktop user. It downloads the latest `.rpm` or `.deb` release, checks it against the release checksums, installs it with `dnf` or `apt` (asking for your password), then runs `jade setup`, which:

- turns off extensions that do the same jobs (OpenBar, User Themes, Simple Workspaces Bar, Blur My Shell, Astra Monitor and a few more; `setup` names each one it turns off),
- sets up the dock (Dash to Dock on Fedora, Ubuntu Dock on Ubuntu),
- starts the usage collector if you have Claude Code or Codex,
- applies Osaka Jade.

Log out and back in once to start the extension. `jade doctor` checks everything is in place.

## Use

- **Picker:** click the palette icon in the top bar, or press **Super+Ctrl+Shift+Space**. Arrow keys move, Enter applies. The menu stays open while you try themes.
- **Command line:**

  ```bash
  jade theme list                 # themes; * marks the current one
  jade theme plan tokyo-night     # show exactly what would change, change nothing
  jade theme set tokyo-night      # switch
  jade theme wallpaper            # next wallpaper of the current theme
  jade theme undo                 # restore what the last switch changed
  ```

  `--only` and `--skip` limit a switch to some targets, e.g. `jade theme set nord --skip vscode,kitty`.
- **Settings:** open the extension's preferences (Extensions app, or Settings in the AI usage menu) to turn parts of the top bar on or off, change the clock format or the app grid size.

## What a theme switch changes

| Target | How |
|---|---|
| GNOME Shell | a Shell theme compiled from GNOME's own theme sources with the Omarchy palette and the theme's exact accent: top bar, menus, quick settings, calendar, notifications, dialogs, lock screen |
| GNOME | dark style, the nearest named accent for apps, wallpaper (desktop and lock screen) |
| Dock | Dash to Dock or Ubuntu Dock colors |
| Ptyxis | an Omarchy palette file, selected in every profile |
| Kitty | `jade-theme.conf`, included at the end of `kitty.conf` (your own colors stay, overridden); kitty reloads |
| Vicinae | an `omarchy-<theme>` theme, selected in its config |
| Starship | a `jade` palette block (Catppuccin color names mapped to the theme) |
| btop | a `jade` theme; btop reloads |
| VS Code | one local extension providing every theme as "Jade · Name"; switching sets `workbench.colorTheme` |

Everything applies live; newly opened GTK apps pick up the accent as they start. Apps you don't have are skipped.

Every switch first saves the value of each setting and file it will change, in `~/.local/state/jade-shell/backups/`. `jade theme undo` puts those back, and repeated undos walk further back.

## In the top bar

- **Workspaces** replace Activities: numbered, the current one filled with the accent. Click the current one for the overview; scroll to move between them.
- **System monitor:** CPU, memory, GPU and CPU temperature. It reads `/proc` and sysfs every two seconds, and on NVIDIA keeps one `nvidia-smi` running instead of starting one per update. It never polls the GPU on battery. Click it for your system monitor app.
- **AI usage:** Claude and Codex limits, with Omarchy's usage panel as its menu (limits, tokens by day and by model). It uses Omarchy's own collectors, run every ten minutes by a user timer.
- **Clock** as "Tuesday 14:05", and GNOME starts on the desktop instead of the overview.

## Remove

```bash
curl -fsSL https://raw.githubusercontent.com/parvezrob/jade-shell/main/install.sh | bash -s -- --uninstall
```

This runs `jade restore`, which undoes every theme switch and every setting `jade setup` changed (the extensions it turned off come back), then removes the package.

## Personal overrides

Pin any color, or reuse wallpapers you already have, in `~/.config/jade-shell/themes/<theme>.toml`. See [examples/osaka-jade.toml](examples/osaka-jade.toml). Besides Omarchy's keys, three GNOME shades can be pinned: `dock_background`, `quick_toggle_hover` and `secondary_text`.

## Development

```bash
python3 -m unittest discover -s tests   # unit tests, plus full switch/undo and setup/restore runs in a sandbox
bin/jade theme plan osaka-jade          # dry run against your desktop
scripts/dev-install.sh                  # this checkout for your user, then: jade setup
scripts/build-packages.sh               # dist/jade-shell.rpm and .deb (needs nfpm)
scripts/test-packages.sh                # install, set up, restore, remove on fresh Fedora and Ubuntu containers
npm ci && npm run lint                  # ESLint for the extension; Python uses ruff
```

The sandbox tests use their own HOME, XDG dirs and GSettings keyfile, so they never touch your desktop. If you run the extension in a nested or headless `gnome-shell`, give it its own `XDG_RUNTIME_DIR` too: GNOME keeps a crash marker there, and a test shell that leaves it behind makes your next login disable all extensions.

## Credits

Jade Shell stands on other people's work: [Omarchy](https://github.com/basecamp/omarchy)'s themes, templates and usage collectors (MIT), GNOME Shell's theme sources (GPL-2.0-or-later), and ideas and code from [Simple Workspaces Bar](https://gitlab.com/null-git/simple-workspaces-bar), [Panel Date Format](https://github.com/KEIII/gnome-shell-panel-date-format), Just Perfection, App Grid Tuner, TopHat and Vitals. Details in [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md).

GPL-3.0-or-later. Not affiliated with Omarchy, Basecamp or GNOME.
