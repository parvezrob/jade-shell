"""Unit tests, plus end-to-end runs of `jade` in a throwaway sandbox.

The sandbox gets its own HOME, XDG dirs, a keyfile GSettings backend, no
session bus, and stand-ins for gnome-shell, pkill, systemctl and vicinae on
PATH, so nothing reaches the real desktop.
"""
import configparser
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from jade import palette, shelltheme, themes
from jade.setup import REPLACED, UUID
from jade.targets.apps import jsonc, managed_block, set_theme_names
from jade.targets.gnome import nearest_accent

needs_compiler = unittest.skipUnless(shelltheme.compiler_available(), 'sassc (or python libsass) is not installed')


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
            for name in ('kitty.conf.tpl', 'btop.theme.tpl', 'vscode-theme.json.tpl'):
                self.assertNotIn('{{', themes.render(themes.template(name), theme.colors), (theme_id, name))


class Helpers(unittest.TestCase):
    def test_managed_block_replaces_in_place(self):
        once = managed_block('user line\n', 'include a.conf')
        twice = managed_block(once, 'include b.conf')
        self.assertTrue(twice.startswith('user line\n'))
        self.assertEqual(twice.count('include'), 1)
        self.assertIn('include b.conf', twice)

    def test_vicinae_config_keeps_its_comments_and_other_names(self):
        text = ('// written by vicinae\n{\n   "theme": {\n      "light": { "name": "a" },\n'
                '      "dark": { "name": "a" }\n   },\n   "extensions": { "name": "keep" }\n}')
        changed = set_theme_names(text, 'omarchy-nord')
        self.assertTrue(changed.startswith('// written by vicinae'))
        self.assertEqual(jsonc(changed)['theme']['dark']['name'], 'omarchy-nord')
        self.assertEqual(jsonc(changed)['extensions']['name'], 'keep')

    def test_nearest_accent(self):
        self.assertEqual(nearest_accent('#509475'), 'green')
        self.assertEqual(nearest_accent('#7aa2f7'), 'blue')


class ShellTheme(unittest.TestCase):
    def test_a_moved_gnome_variable_fails_loudly(self):
        with self.assertRaises(shelltheme.BuildError):
            shelltheme.point_at_palette('$other: 1;\n', {'bg_color': '$jade-background'}, '_colors.scss')

    def test_accent_text_reads_on_the_accent(self):
        for theme_id in themes.ids():
            colors = themes.load(theme_id).colors
            self.assertGreaterEqual(shelltheme.contrast(colors['accent'], shelltheme.accent_foreground(colors)), 2.5, theme_id)

    @needs_compiler
    def test_every_theme_compiles_for_every_gnome_version(self):
        for version in shelltheme.available_versions():
            for theme_id in themes.ids():
                colors = themes.load(theme_id).colors
                css = shelltheme.build(colors, version)
                self.assertNotIn('-st-accent', css, theme_id)
                self.assertIn(colors['accent'].lower(), css.lower(), theme_id)
                self.assertIn('.popup-menu-content.jade-frame', css, theme_id)


class Sandbox(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        t = pathlib.Path(self.tmp.name)
        self.home = t / 'home'
        pythonpath = os.pathsep.join(filter(None, [str(ROOT), os.environ.get('PYTHONPATH')]))
        self.env = dict(os.environ, HOME=str(self.home), XDG_CONFIG_HOME=str(self.home / '.config'),
                        XDG_DATA_HOME=str(self.home / '.local/share'), XDG_STATE_HOME=str(self.home / '.local/state'),
                        XDG_CACHE_HOME=str(self.home / '.cache'), GSETTINGS_BACKEND='keyfile', PYTHONPATH=pythonpath,
                        DBUS_SESSION_BUS_ADDRESS='unix:path=/nonexistent', JADE_BIN='/usr/bin/jade')
        self.env.pop('XDG_SESSION_TYPE', None)
        bin_dir = t / 'bin'
        bin_dir.mkdir()
        fakes = {'pkill': 'exit 0', 'vicinae': 'exit 0', 'gnome-shell': 'echo "GNOME Shell 50.4"',
                 'systemctl': f'echo "$@" >> {t}/systemctl.log; exit 0'}
        for tool, body in fakes.items():
            (bin_dir / tool).write_text(f'#!/bin/sh\n{body}\n')
            (bin_dir / tool).chmod(0o755)
        self.systemctl_log = t / 'systemctl.log'
        self.env['PATH'] = f'{bin_dir}:{self.env["PATH"]}'

        # Jade Shell's own schema, compiled from this checkout.
        ext = self.home / '.local/share/gnome-shell/extensions'
        schemas = ext / UUID / 'schemas'
        shutil.copytree(ROOT / 'extension/schemas', schemas)
        (ext / UUID / 'metadata.json').write_text('{}')
        subprocess.run(['glib-compile-schemas', str(schemas)], check=True)

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
        # No downloads: pretend each theme's first wallpaper and preview exist.
        for theme_id in themes.ids():
            theme = themes.load(theme_id)
            wallpaper = self.home / '.local/share/jade-shell/backgrounds' / theme_id / theme.backgrounds[0]
            wallpaper.parent.mkdir(parents=True, exist_ok=True)
            wallpaper.write_bytes(b'image')
            thumb = self.home / '.local/state/jade-shell/thumbs' / f'{theme_id}.png'
            thumb.parent.mkdir(parents=True, exist_ok=True)
            thumb.write_bytes(b'png')

    def jade(self, *args):
        result = subprocess.run([sys.executable, '-m', 'jade', *args], env=self.env,
                                capture_output=True, text=True, cwd=ROOT)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        return result.stdout

    def gsettings(self, *args):
        schemadir = self.home / '.local/share/gnome-shell/extensions' / UUID / 'schemas'
        extra = ['--schemadir', str(schemadir)] if 'jade-shell' in args[1] else []
        return subprocess.run(['gsettings', *extra, *args], env=self.env, capture_output=True, text=True).stdout.strip()

    def keyfile(self):
        parser = configparser.ConfigParser(interpolation=None, strict=False)
        parser.optionxform = str
        parser.read(self.home / '.config/glib-2.0/settings/keyfile')
        # A reset key can leave its section behind, empty: no setting, same desktop.
        return {section: dict(parser[section]) for section in parser.sections() if parser[section]}

    def skip_shell_unless_compiler(self):
        return [] if shelltheme.compiler_available() else ['--skip', 'shell']

    def test_switch_twice_then_undo_everything(self):
        skip = self.skip_shell_unless_compiler()
        self.jade('theme', 'set', 'tokyo-night', *skip)
        self.assertIn('already applied', self.jade('theme', 'plan', 'tokyo-night', *skip))
        config = self.home / '.config'
        self.assertIn('#7aa2f7', (config / 'kitty/jade-theme.conf').read_text())
        self.assertIn('include jade-theme.conf', (config / 'kitty/kitty.conf').read_text())
        self.assertIn('"workbench.colorTheme": "Jade · Tokyo Night"', (config / 'Code/User/settings.json').read_text())
        self.assertIn('color_theme = "jade"', (config / 'btop/btop.conf').read_text())
        self.assertEqual(self.gsettings('get', 'org.gnome.desktop.interface', 'accent-color'), "'blue'")
        self.assertIn('tokyo-night', self.jade('theme', 'current'))
        shell_css = self.home / '.local/state/jade-shell/gnome-shell.css'
        if not skip:
            self.assertIn('#7aa2f7', shell_css.read_text())

        self.jade('theme', 'set', 'osaka-jade', *skip)
        self.assertEqual(self.gsettings('get', 'org.gnome.desktop.interface', 'accent-color'), "'green'")
        self.jade('theme', 'undo')
        self.assertIn('tokyo-night', self.jade('theme', 'current'))
        self.assertEqual(self.gsettings('get', 'org.gnome.desktop.interface', 'accent-color'), "'blue'")

        self.jade('theme', 'undo')
        for path, text in self.originals.items():
            self.assertEqual(path.read_text(), text, path)
        self.assertFalse((config / 'kitty/jade-theme.conf').exists())
        self.assertFalse(shell_css.exists())
        self.assertNotIn('accent-color', self.keyfile().get('org/gnome/desktop/interface', {}))
        self.assertIn('none', self.jade('theme', 'current'))

    @needs_compiler
    def test_setup_then_restore_gives_the_old_desktop_back(self):
        replaced = next(iter(REPLACED))
        self.gsettings('set', 'org.gnome.shell', 'enabled-extensions', f"['{replaced}', 'keep@me']")
        before = self.keyfile()

        self.jade('setup')
        enabled = self.gsettings('get', 'org.gnome.shell', 'enabled-extensions')
        self.assertEqual(enabled, f"['keep@me', '{UUID}']")
        self.assertIn('osaka-jade', self.jade('theme', 'current'))
        units = self.home / '.config/systemd/user'
        self.assertIn('ExecStart=/usr/bin/jade usage collect', (units / 'jade-usage.service').read_text())
        self.assertIn('enable --now jade-usage.timer', self.systemctl_log.read_text())
        self.jade('setup')  # again: nothing new to record, nothing breaks

        self.jade('restore', '--yes')
        self.assertEqual(self.keyfile(), before)
        for path, text in self.originals.items():
            self.assertEqual(path.read_text(), text, path)
        self.assertFalse((units / 'jade-usage.timer').exists())
        self.assertIn('none', self.jade('theme', 'current'))


if __name__ == '__main__':
    unittest.main()
