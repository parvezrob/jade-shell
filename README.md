# Jade Shell

Omarchy's theme switching, for GNOME. Pick one of Omarchy's 17 dark themes and the whole desktop follows: the wallpaper, GNOME's accent, the OpenBar top bar and menus, the dock, workspaces bar, quick settings, Astra Monitor and Jade AI Usage, plus your terminals, launcher, prompt and editor.

**Status: early, GNOME 50 only.** Built and tested on Fedora 44.

![The Jade Shell theme picker: 17 Omarchy themes as wallpaper previews](docs/picker.png)

## Install

```bash
git clone https://github.com/parvezrob/jade-shell.git
cd jade-shell
bash scripts/install.sh
```

Run as your desktop user, without sudo, then log out and back in to load the extension. The installer puts `jade-theme` in `~/.local/bin` and downloads each theme's first wallpaper to make the picker previews (about 15 MB). It does not change your theme; nothing changes until you pick one.

## Use

- **Picker:** click the palette icon in the top bar, or press **Super+Ctrl+Shift+Space**. Arrow keys move, Enter applies. The menu stays open, so you can try several themes in a row.
- **Command line:**

  ```bash
  jade-theme list                 # themes; * marks the current one
  jade-theme plan tokyo-night     # show exactly what would change, change nothing
  jade-theme set tokyo-night      # switch
  jade-theme wallpaper            # next wallpaper of the current theme
  jade-theme undo                 # restore what the last switch changed
  ```

  `--only` and `--skip` limit a switch to some targets, e.g. `jade-theme set nord --skip vscode,kitty`.

Every switch first saves the value of each setting and file it will change, in `~/.local/state/jade-shell/backups/`. `undo` puts those back, and repeated `undo` walks further back, to the look you had before Jade Shell.

## What a switch changes

| Target | How |
|---|---|
| GNOME | dark style, nearest named accent color, wallpaper (desktop and lock screen) |
| OpenBar | bar, menu, highlight and dock colors, then OpenBar regenerates its stylesheet |
| Dash to Dock, App Grid Tuner, Astra Monitor | their color settings (Astra's profile copy too) |
| Shell styles | a generated stylesheet for the workspaces bar, quick settings, the picker and Jade AI Usage, reloaded live by the extension |
| Ptyxis | an Omarchy palette file, selected in every profile |
| Vicinae | an `omarchy-<theme>` theme file, selected in its config |
| Kitty | `jade-theme.conf`, included at the end of `kitty.conf` (your own colors stay, overridden); kitty reloads |
| Starship | a `jade` palette block (Catppuccin color names mapped to the theme) |
| btop | a `jade` theme; btop reloads |
| VS Code | one local extension providing every theme as "Jade · Name"; switching sets `workbench.colorTheme` |

Everything applies live except that newly opened GTK apps pick up the accent as they start. A target that isn't installed is skipped.

## Personal overrides

Pin any color, or reuse wallpapers you already have, in `~/.config/jade-shell/themes/<theme>.toml`. See [examples/osaka-jade.toml](examples/osaka-jade.toml). Besides Omarchy's keys, three GNOME shades can be pinned: `dock_background`, `quick_toggle_hover` and `secondary_text`.

## Development

```bash
python3 -m unittest discover -s tests       # includes a full switch/undo run in a sandbox
bin/jade-theme plan osaka-jade              # dry run against your desktop
```

The sandbox test uses its own HOME, XDG dirs and GSettings keyfile, so it never touches your desktop. If you test the extension in a nested or headless `gnome-shell`, give it its own `XDG_RUNTIME_DIR` too: GNOME keeps a crash marker there, and a test shell that leaves it behind makes your next login disable all extensions.

## License

GPL-3.0-or-later. Omarchy's palettes and templates are MIT; see [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md). Not affiliated with Omarchy or GNOME.
