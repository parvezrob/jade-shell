# Third-party code and assets

Jade Shell is GPL-3.0-or-later. It includes, or is adapted from, the work below.

| Part of Jade Shell | Comes from | License |
|---|---|---|
| `themes/*/colors.toml`, `templates/kitty.conf.tpl` (with a marked Jade addition), `templates/btop.theme.tpl`, `templates/vscode-theme.json.tpl`, `templates/ghostty.conf.tpl`, `templates/alacritty.toml.tpl`, `templates/claude.json.tpl` (its name changed to Jade Shell), `templates/obsidian.css.tpl` (its header changed); `jade/palette.py` ports `bin/omarchy-theme-color` | [Omarchy](https://github.com/omacom/omarchy), commit d3cfd53b997f8bdcf776b8db68bf0d735e7a065d | MIT (below) |
| `jade/usage/claude.py`, `jade/usage/codex.py`: `bin/omarchy-agent-usage-claude` and `bin/omarchy-agent-usage-codex`, with small changes marked "Jade:" | Omarchy, same commit | MIT (below) |
| `extension/lib/usage.js`: the menu's layout and formatting logic (window titles and tags, the binding window, durations, day names, model rows), adapted from `shell/plugins/agents/Panel.qml` | Omarchy, same commit | MIT (below) |
| `shell-theme/gnome-50/`: GNOME Shell's theme sources, unmodified (see `SOURCE` there) | [GNOME Shell](https://gitlab.gnome.org/GNOME/gnome-shell) 50.5 | GPL-2.0-or-later (`shell-theme/gnome-50/gnome-shell-sass/COPYING`) |
| `extension/lib/workspaces.js` | [Simple Workspaces Bar](https://gitlab.com/null-git/simple-workspaces-bar) by Francois Thirioux and null-git | GPL-3.0 |
| `extension/lib/clock.js` | [Panel Date Format](https://github.com/KEIII/gnome-shell-panel-date-format) by Ivan Kasenkov | MIT (below) |
| `extension/icons/claude-symbolic.svg`, `openai-symbolic.svg` | [Simple Icons](https://simpleicons.org) | CC0 1.0 |
| `extension/lib/dock/bar.js`: the magnification (the raised-cosine curve, the slot walk anchored at the pointer, the spring that fades it in and out, the smoothed pointer), ported from `magnifier.js` | [dash2dock-motion](https://github.com/Unmade760/dash2dock-motion) by Unmade760, itself based on Dash to Dock | GPL-2.0-or-later |

`extension/lib/desktop.js` follows the approach of [Just Perfection](https://gitlab.gnome.org/jrahmatzadeh/just-perfection) (start on the desktop) and [App Grid Tuner](https://codeberg.org/m-lab/app-grid-tuner) (grid layout), `extension/lib/dock/` that of [Dash to Dock](https://github.com/micheleg/dash-to-dock) (intellihide, the pressure barrier at the screen edge, minimize targets) and `extension/lib/dock/genie.js` the idea of [Compiz-alike magic lamp effect](https://github.com/hermes83/compiz-alike-magic-lamp-effect) (a deform effect on the window, played in place of GNOME's own), and `extension/lib/monitor.js` that of [TopHat](https://github.com/fflewddur/tophat) and [Vitals](https://github.com/corecoding/Vitals); no code is copied from them. The Tahoe icons are not included either: `jade apps on icons` downloads [MacTahoe](https://github.com/vinceliuice/MacTahoe-icon-theme) by Vince Liuice (GPL-3.0), release 2026-09-10, checked against its SHA-256, and builds it into `~/.local/share/icons` the way its `install.sh` does. Omarchy's wallpapers are not included in the package: `jade setup` downloads the first wallpaper of each theme from the Omarchy commit above to make the picker previews, and other wallpapers are downloaded when you use them. They are stored in `~/.local/share/jade-shell/backgrounds` and remain with their authors.

## Omarchy (MIT)


Copyright (c) David Heinemeier Hansson

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
"Software"), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE
LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION
WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

## Panel Date Format (MIT)


Copyright (c) 2018 Ivan Kasenkov

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
