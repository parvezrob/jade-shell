"""Unit tests, plus an end-to-end switch and undo in a throwaway sandbox.

The sandbox gets its own HOME, XDG dirs and a keyfile GSettings backend, and
no-op `pkill`/`systemctl` on PATH, so nothing reaches the real desktop.
"""
import configparser
import os
import pathlib
import subprocess
import sys
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from jade_theme import palette, themes  # noqa: E402
from jade_theme.targets.apps import managed_block  # noqa: E402
from jade_theme.targets.gnome import nearest_accent  # noqa: E402


class Palette(unittest.TestCase):
    def test_osaka_jade_resolves_like_omarchy(self):
        c = palette.load(ROOT / 'themes/osaka-jade/colors.toml')
        self.assertEqual(c['accent'], '#509475')
        self.assertEqual(c['color8'], c['muted'])
        self.assertEqual(c['bg'], c['background'])
        self.assertEqual(c['mode'], 'dark')

    def test_missing_shades_are_derived(self):
        c = palette.resolve({'background': '#000000', 'foreground': '#ffffff', 'red': '#ff0000',
                             'green': '#00ff00', 'yellow': '#ffff00', 'blue': '#0000ff',
                             'magenta': '#ff00ff', 'cyan': '#00ffff'})
        self.assertEqual(c['bright_red'], '#ff3333')
        self.assertEqual(c['accent'], '#0000ff')
        self.assertEqual(c['brown'], '#808000')

    def test_mix(self):
        self.assertEqual(palette.mix('#000000', '#ffffff', '50%'), '#808080')

    def test_every_theme_loads_and_renders_every_template(self):
        for theme_id in themes.ids():
            theme = themes.load(theme_id)
            for name in ('kitty.conf.tpl', 'btop.theme.tpl', 'vscode-theme.json.tpl', 'shell.css.tpl'):
                self.assertNotIn('{{', themes.render(themes.template(name), theme.colors), (theme_id, name))


class Helpers(unittest.TestCase):
    def test_managed_block_replaces_in_place(self):
        once = managed_block('user line\n', 'include a.conf')
        twice = managed_block(once, 'include b.conf')
        self.assertTrue(twice.startswith('user line\n'))
        self.assertEqual(twice.count('include'), 1)
        self.assertIn('include b.conf', twice)

    def test_nearest_accent(self):
        self.assertEqual(nearest_accent('#509475'), 'green')
        self.assertEqual(nearest_accent('#7aa2f7'), 'blue')


class Sandbox(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        t = pathlib.Path(self.tmp.name)
        self.home = t / 'home'
        self.env = dict(os.environ, HOME=str(self.home), XDG_CONFIG_HOME=str(self.home / '.config'),
                        XDG_DATA_HOME=str(self.home / '.local/share'), XDG_STATE_HOME=str(self.home / '.local/state'),
                        GSETTINGS_BACKEND='keyfile', PYTHONPATH=str(ROOT))
        bin_dir = t / 'bin'
        bin_dir.mkdir()
        for tool in ('pkill', 'systemctl', 'vicinae'):
            (bin_dir / tool).write_text('#!/bin/sh\nexit 0\n')
            (bin_dir / tool).chmod(0o755)
        self.env['PATH'] = f'{bin_dir}:{self.env["PATH"]}'
        # Extension schemas (OpenBar, Dock, Astra…) from the real install, read-only.
        real_ext = pathlib.Path.home() / '.local/share/gnome-shell/extensions'
        ext = self.home / '.local/share/gnome-shell/extensions'
        for schemas in real_ext.glob('*/schemas'):
            (ext / schemas.parent.name).mkdir(parents=True, exist_ok=True)
            (ext / schemas.parent.name / 'schemas').symlink_to(schemas)
        config = self.home / '.config'
        self.originals = {
            config / 'kitty/kitty.conf': 'font_size 11\nforeground #cdd6f4\n',
            config / 'starship.toml': 'palette = "catppuccin_mocha"\n\n[palettes.catppuccin_mocha]\nred = "#f38ba8"\n',
            config / 'btop/btop.conf': 'color_theme = "catppuccin_mocha"\ntheme_background = true\n',
            config / 'Code/User/settings.json': '{\n    "workbench.colorTheme": "Dark Modern",\n    "editor.fontSize": 14\n}\n',
        }
        for path, text in self.originals.items():
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text)
        # Pretend the first wallpaper of each theme is already downloaded.
        for theme_id in ('tokyo-night', 'osaka-jade'):
            theme = themes.load(theme_id)
            wallpaper = self.home / '.local/share/jade-shell/backgrounds' / theme_id / theme.backgrounds[0]
            wallpaper.parent.mkdir(parents=True, exist_ok=True)
            wallpaper.write_bytes(b'image')

    def run_cli(self, *args):
        result = subprocess.run([sys.executable, '-m', 'jade_theme', *args], env=self.env,
                                capture_output=True, text=True, cwd=ROOT)
        self.assertEqual(result.returncode, 0, result.stderr)
        return result.stdout

    def accent(self):
        return subprocess.run(['gsettings', 'get', 'org.gnome.desktop.interface', 'accent-color'],
                              env=self.env, capture_output=True, text=True).stdout.strip()

    def keyfile(self):
        parser = configparser.ConfigParser(interpolation=None, strict=False)
        parser.read(self.home / '.config/glib-2.0/settings/keyfile')
        return parser

    def test_switch_twice_then_undo_everything(self):
        self.run_cli('set', 'tokyo-night')
        self.assertIn('already applied', self.run_cli('plan', 'tokyo-night'))
        config = self.home / '.config'
        self.assertIn('#7aa2f7', (config / 'kitty/jade-theme.conf').read_text())
        self.assertIn('include jade-theme.conf', (config / 'kitty/kitty.conf').read_text())
        self.assertIn('"workbench.colorTheme": "Jade · Tokyo Night"', (config / 'Code/User/settings.json').read_text())
        self.assertIn('color_theme = "jade"', (config / 'btop/btop.conf').read_text())
        self.assertEqual(self.accent(), "'blue'")
        self.assertIn('tokyo-night', self.run_cli('current'))

        self.run_cli('set', 'osaka-jade')
        self.assertEqual(self.accent(), "'green'")
        self.run_cli('undo')
        self.assertIn('tokyo-night', self.run_cli('current'))
        self.assertEqual(self.accent(), "'blue'")

        self.run_cli('undo')
        for path, text in self.originals.items():
            self.assertEqual(path.read_text(), text, path)
        self.assertFalse((config / 'kitty/jade-theme.conf').exists())
        keyfile = self.keyfile()
        self.assertFalse(keyfile.has_section('org/gnome/desktop/interface')
                         and keyfile.has_option('org/gnome/desktop/interface', 'accent-color'))
        self.assertIn('none', self.run_cli('current'))


if __name__ == '__main__':
    unittest.main()
