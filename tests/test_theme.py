"""Unit tests, plus end-to-end runs of `jade` in a throwaway sandbox.

The sandbox gets its own HOME, XDG dirs, a keyfile GSettings backend, no
session bus, and stand-ins for gnome-shell, pkill, systemctl and vicinae on
PATH, so nothing reaches the real desktop.
"""
import configparser
import hashlib
import io
import json
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from jade import __version__, debug, engine, migrations, palette, restore_offer, setup, shelltheme, store, themes, update
from jade.setup import REPLACED, UUID
from jade.targets.apps import VSCode, jsonc, managed_block, restore_theme_names, revert_block, revert_line, set_theme_names
from jade.targets.gnome import Gnome, nearest_accent

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

    def test_fresh_vicinae_config_gets_a_theme_entry(self):
        changed = set_theme_names('// merged with the defaults\n\n{}', 'omarchy-nord')
        self.assertTrue(changed.startswith('// merged with the defaults'))
        self.assertEqual(jsonc(changed)['theme'], {'dark': {'name': 'omarchy-nord'}, 'light': {'name': 'omarchy-nord'}})

    def test_nearest_accent(self):
        self.assertEqual(nearest_accent('#509475'), 'green')
        self.assertEqual(nearest_accent('#7aa2f7'), 'blue')

    def test_no_accent_color_where_gnome_has_none(self):
        class OldGnome:
            def has(self, schema, key=None):
                return key != 'accent-color'
        changes = Gnome().changes(themes.load('nord'), engine.Context(OldGnome()))
        self.assertNotIn('accent-color', [c.key for c in changes])
        self.assertIn('color-scheme', [c.key for c in changes])


class TargetedRevert(unittest.TestCase):
    """Taking only Jade Shell's part out of a config edited after a switch."""

    def test_block_goes_or_gets_its_old_contents_back(self):
        old = 'font_size 11\n'
        edited = managed_block(old, 'include jade-theme.conf') + 'font_family Iosevka\n'
        self.assertEqual(revert_block(edited, old), 'font_size 11\nfont_family Iosevka\n')
        earlier = managed_block(old, 'red = "#111111"')
        edited = managed_block(earlier, 'red = "#222222"').replace('font_size 11', 'font_size 12')
        self.assertEqual(revert_block(edited, earlier), earlier.replace('font_size 11', 'font_size 12'))
        self.assertIsNone(revert_block('no block here\n', old))

    def test_line_goes_back_only_while_it_is_ours(self):
        old = 'color_theme = "nord"\nx = 1\n'
        self.assertEqual(revert_line('color_theme = "jade"\nx = 2\n', old, 'color_theme', 'jade'),
                         'color_theme = "nord"\nx = 2\n')
        self.assertIsNone(revert_line('color_theme = "gruvbox"\n', old, 'color_theme', 'jade'))
        self.assertEqual(revert_line('palette = "jade"\nformat = "$all"\n', 'format = "$all"\n', 'palette', 'jade'),
                         'format = "$all"\n')

    def test_vscode_settings_and_registry(self):
        vscode = VSCode()
        settings = vscode.settings_path()
        old = '{\n    "editor.fontSize": 14\n}\n'
        now = '{\n    "workbench.colorTheme": "Jade · Nord",\n    "editor.fontSize": 16\n}\n'
        self.assertEqual(vscode.revert(settings, now, old), '{\n    "editor.fontSize": 16\n}\n')
        old = '{\n    "workbench.colorTheme": "Dark Modern",\n    "editor.fontSize": 14\n}\n'
        self.assertEqual(vscode.revert(settings, now, old), now.replace('Jade · Nord', 'Dark Modern'))
        self.assertIsNone(vscode.revert(settings, now.replace('Jade · Nord', 'Monokai'), old))
        other = {'identifier': {'id': 'someone.else'}}
        registry = json.dumps([other, {'identifier': {'id': VSCode.ID}}, {'identifier': {'id': 'new.one'}}])
        self.assertEqual(json.loads(vscode.revert(vscode.registry_path(), registry, json.dumps([other]))),
                         [other, {'identifier': {'id': 'new.one'}}])

    def test_vicinae_theme_names(self):
        old = '// vicinae\n{\n  "theme": { "dark": { "name": "a" }, "light": { "name": "a" } },\n  "x": 1\n}'
        now = set_theme_names(old, 'omarchy-nord').replace('"x": 1', '"x": 2')
        self.assertEqual(restore_theme_names(now, old), old.replace('"x": 1', '"x": 2'))
        fresh = '// vicinae\n{}'
        now = set_theme_names(fresh, 'omarchy-nord')
        self.assertNotIn('theme', jsonc(restore_theme_names(now, fresh)))
        self.assertIsNone(restore_theme_names(set_theme_names(old, 'picked-in-vicinae'), old))


class NoSettings:
    def restore_all(self, entries):
        return []

    def write(self, changes):
        pass


class History(unittest.TestCase):
    """Backups on disk, without GSettings: pruning keeps undo exact."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dir = pathlib.Path(self.tmp.name)
        patcher = mock.patch.dict(os.environ, XDG_STATE_HOME=str(self.dir / 'state'))
        patcher.start()
        self.addCleanup(patcher.stop)

    def switch(self, path, content):
        """What engine.apply records for one file, then the write itself."""
        backup = engine.state_dir() / 'backups' / engine.new_backup_name(engine.backups())
        old = store.read_bytes(path)
        saved = None
        if old is not None:
            saved = 'files/0'
            store.write_bytes(backup / saved, old)
        manifest = {'before': {}, 'theme': 'x', 'settings': [], 'targets': [],
                    'files': [{'path': str(path), 'saved': saved, 'written': [store.digest(store.encode(content))]}]}
        store.write_text(backup / 'manifest.json', json.dumps(manifest))
        store.write_text(path, content)

    def test_pruned_history_still_undoes_to_the_original(self):
        conf, extra = self.dir / 'app.conf', self.dir / 'extra.conf'
        conf.write_text('mine\n')
        for n in range(engine.KEEP + 6):
            self.switch(conf, f'theme {n}\n')
            if n == 3:
                self.switch(extra, 'made by jade\n')  # a file only a pruned switch touched
            engine.prune()
        self.assertEqual(len(engine.backups()), engine.KEEP + 1)
        ctx = engine.Context(NoSettings())
        while (undone := engine.undo(ctx)) is not None:
            self.assertEqual(undone['kept'], [])
        self.assertEqual(conf.read_text(), 'mine\n')
        self.assertFalse(extra.exists())

    def test_a_failed_prune_does_not_fail_the_switch(self):
        conf = self.dir / 'app.conf'
        target = mock.Mock()
        target.name = 'fake'
        with mock.patch.object(engine, 'plan', return_value=[(target, store.File(conf, 'new\n'))]), \
             mock.patch.object(engine, 'prune', side_effect=RuntimeError('disk on fire')), \
             mock.patch('sys.stderr') as stderr:
            _changes, backup = engine.apply(mock.Mock(id='x'), engine.Context(NoSettings()))
        self.assertIsNotNone(backup)
        self.assertEqual(conf.read_text(), 'new\n')
        self.assertIn('disk on fire', ''.join(str(c) for c in stderr.write.call_args_list))

    def test_restore_goes_past_a_broken_backup_it_cannot_set_aside(self):
        conf = self.dir / 'app.conf'
        conf.write_text('mine\n')
        self.switch(conf, 'theme\n')
        broken = engine.state_dir() / 'backups' / engine.new_backup_name(engine.backups())
        store.write_text(broken / 'manifest.json', 'not json')
        said = []
        with mock.patch.dict(os.environ, XDG_CONFIG_HOME=str(self.dir / 'config')), \
             mock.patch.object(engine, 'set_aside', side_effect=PermissionError(13, 'Permission denied')), \
             mock.patch.object(setup, 'systemctl'), mock.patch.object(setup, 'say', side_effect=said.append):
            self.assertEqual(setup.restore(engine.Context(NoSettings()), assume_yes=True), 0)
        self.assertEqual(conf.read_text(), 'mine\n')
        self.assertTrue(any('could not set it aside (Permission denied)' in line for line in said), said)
        self.assertTrue(broken.exists())

    def test_names_keep_their_order_after_old_local_time_ones(self):
        folder = engine.state_dir() / 'backups'
        for name in ('20261231-235959-000000', '000002-20260101T000000Z', '000010-20250101T000000Z'):
            store.write_text(folder / name / 'manifest.json', '{}')
        (folder / '.partial-x').mkdir()
        (folder / 'no-manifest').mkdir()
        names = [p.name for p in engine.backups()]
        self.assertEqual(names, ['20261231-235959-000000', '000002-20260101T000000Z', '000010-20250101T000000Z'])
        self.assertTrue(engine.new_backup_name(engine.backups()).startswith('000011-'))


class Migrations(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        patcher = mock.patch.dict(os.environ, XDG_STATE_HOME=tmp.name)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.ran = []

    def migration(self, number, fail=False):
        def run(ctx):
            if fail:
                raise OSError('disk full')
            self.ran.append(number)
        return (number, f'step {number}', run)

    def test_each_runs_once_in_order_and_a_failure_is_retried(self):
        said = []
        with mock.patch.object(migrations, 'MIGRATIONS', [self.migration(1), self.migration(2, fail=True)]):
            self.assertFalse(migrations.run_pending(None, said.append))
            self.assertEqual(self.ran, [1])
            self.assertIn('Update step 2 (step 2) failed: disk full', said)
        with mock.patch.object(migrations, 'MIGRATIONS', [self.migration(1), self.migration(2), self.migration(3)]):
            self.assertTrue(migrations.run_pending(None, said.append))
            self.assertEqual(self.ran, [1, 2, 3])
            self.assertEqual(migrations.pending(), [])

    def test_a_first_setup_starts_with_all_done(self):
        with mock.patch.object(migrations, 'MIGRATIONS', [self.migration(1), self.migration(2)]):
            migrations.mark_all()
            self.assertTrue(migrations.run_pending(None, print))
        self.assertEqual(self.ran, [])


class Update(unittest.TestCase):
    """The release check and download, from a release folder on disk."""

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.dir = pathlib.Path(tmp.name)
        self.release = self.dir / 'release'
        self.release.mkdir()
        (self.release / 'VERSION').write_text('10.2.0\n')
        (self.release / 'jade-shell.rpm').write_bytes(b'package')
        (self.release / 'jade-shell.deb').write_bytes(b'tampered')
        digest = hashlib.sha256(b'package').hexdigest()
        (self.release / 'SHA256SUMS').write_text(f'{digest}  jade-shell.rpm\n{"0" * 64}  jade-shell.deb\n')
        for patcher in (mock.patch.object(update, 'RELEASE', self.release.as_uri()),
                        mock.patch.dict(os.environ, XDG_STATE_HOME=str(self.dir / 'state'))):
            patcher.start()
            self.addCleanup(patcher.stop)

    def test_versions_compare_as_numbers(self):
        self.assertGreater(update.version_key('0.10.0'), update.version_key('0.9.9'))

    def test_check_remembers_when_it_asked(self):
        self.assertEqual(update.check(), '10.2.0')
        cached = json.loads(update.cache_path().read_text())
        self.assertEqual(cached['latest'], '10.2.0')

    def test_a_garbled_or_missing_release_is_a_sentence(self):
        (self.release / 'VERSION').write_text('<html>')
        with self.assertRaisesRegex(update.UpdateError, 'no usable version'):
            update.latest()
        (self.release / 'VERSION').unlink()
        with self.assertRaisesRegex(update.UpdateError, 'Could not reach'):
            update.latest()
        self.assertFalse(update.cache_path().exists())  # the extension asks again later

    def test_only_a_package_matching_the_checksum_is_kept(self):
        path = update.verified_download('rpm', str(self.dir))
        self.assertEqual(pathlib.Path(path).read_bytes(), b'package')
        with self.assertRaisesRegex(update.UpdateError, 'does not match'):
            update.verified_download('deb', str(self.dir))

    def test_check_as_json(self):
        with mock.patch.object(update, 'installed_kind', return_value='deb'), \
                mock.patch('sys.stdout', new_callable=io.StringIO) as out:
            self.assertEqual(update.update(as_json=True), 0)
        self.assertEqual(json.loads(out.getvalue()),
                         {'current': __version__, 'latest': '10.2.0', 'available': True, 'package': 'deb'})


class RestoreKit(unittest.TestCase):
    """What setup leaves behind so a removal through Software can still restore."""

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.dir = pathlib.Path(tmp.name)
        package = self.dir / 'usr/share/jade-shell'
        (package / 'jade/__pycache__').mkdir(parents=True)
        (package / 'jade/setup.py').write_text('# code')
        (package / 'jade/__pycache__/setup.pyc').write_text('bytes')
        (package / 'themes').mkdir()
        home = self.dir / 'home'
        for patcher in (mock.patch.object(restore_offer, 'PACKAGE_ROOT', package),
                        mock.patch.object(restore_offer, 'systemctl'),
                        mock.patch.dict(os.environ, HOME=str(home), XDG_DATA_HOME=str(home / '.local/share'),
                                        XDG_CONFIG_HOME=str(home / '.config'))):
            patcher.start()
            self.addCleanup(patcher.stop)

    def test_only_a_package_keeps_a_kit(self):
        restore_offer.keep_kit()  # this checkout is not under the (patched) package root
        self.assertFalse(restore_offer.kit_path().exists())

    def test_the_kit_copies_the_package_and_goes_when_asked(self):
        with mock.patch.object(restore_offer, 'from_package', return_value=True):
            restore_offer.keep_kit()
            restore_offer.keep_kit()  # every setup refreshes it
        kit = restore_offer.kit_path()
        self.assertEqual((kit / 'jade/setup.py').read_text(), '# code')
        self.assertFalse((kit / 'jade/__pycache__').exists())
        unit = restore_offer.unit_path().read_text()
        self.assertIn(f'Environment=PYTHONPATH={kit}', unit)
        self.assertIn('ConditionPathExists=!/usr/bin/jade', unit)
        restore_offer.systemctl.assert_any_call('enable', restore_offer.UNIT)
        restore_offer.drop_kit()
        self.assertFalse(kit.exists())
        self.assertFalse(restore_offer.unit_path().exists())

    def test_nothing_is_offered_while_jade_is_installed(self):
        with mock.patch.object(restore_offer, 'jade_installed', return_value=True), \
                mock.patch.object(restore_offer, 'Offer') as offer:
            self.assertEqual(restore_offer.main(), 0)
        offer.assert_not_called()


class Leftovers(unittest.TestCase):
    def test_a_home_copy_hiding_the_package_and_old_versions_are_found(self):
        with tempfile.TemporaryDirectory() as tmp:
            home, system = pathlib.Path(tmp) / 'home', pathlib.Path(tmp) / 'usr'
            mine = home / '.local/share/gnome-shell/extensions' / UUID
            old = [home / '.local/lib/jade-shell', home / '.local/share/gnome-shell/extensions/osaka-ai-usage@local']
            for folder in (mine, system / UUID, *old):
                folder.mkdir(parents=True)
            enabled = mock.Mock(stdout='enabled\n')
            with mock.patch.dict(os.environ, HOME=str(home), XDG_DATA_HOME=str(home / '.local/share')), \
                 mock.patch.object(setup, 'SYSTEM_EXTENSIONS', system), \
                 mock.patch.object(setup, 'systemctl', return_value=enabled):
                paths, units = setup.leftovers()
            self.assertEqual(paths, [mine, *old])
            self.assertEqual(setup.leftover_commands(paths, units)[1], 'systemctl --user disable --now osaka-ai-usage.timer')
            (system / UUID).rmdir()  # a development copy alone is not in anyone's way
            with mock.patch.dict(os.environ, HOME=str(home), XDG_DATA_HOME=str(home / '.local/share')), \
                 mock.patch.object(setup, 'SYSTEM_EXTENSIONS', system), \
                 mock.patch.object(setup, 'systemctl', return_value=mock.Mock(stdout='disabled\n')):
                self.assertEqual(setup.leftovers(), (old, []))


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
        for name in ('no_proxy', 'NO_PROXY'):
            self.env.pop(name, None)
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

    def run_jade(self, *args):
        return subprocess.run([sys.executable, '-m', 'jade', *args], env=self.env, capture_output=True, text=True, cwd=ROOT)

    def jade(self, *args):
        result = self.run_jade(*args)
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

    def test_undo_takes_only_jades_part_out_of_an_edited_config(self):
        skip = self.skip_shell_unless_compiler()
        self.jade('theme', 'set', 'tokyo-night', *skip)
        config = self.home / '.config'
        kitty, starship, btop = config / 'kitty/kitty.conf', config / 'starship.toml', config / 'btop/btop.conf'
        kitty.write_text(kitty.read_text() + 'font_family Iosevka\n')
        starship.write_text(starship.read_text() + '\n[character]\nsuccess_symbol = ">"\n')
        # Jade's part can't come out cleanly: a theme picked in btop since, and an edit to Jade's own file.
        btop.write_text(btop.read_text().replace('color_theme = "jade"', 'color_theme = "nord"'))
        theme_conf = config / 'kitty/jade-theme.conf'
        theme_conf.write_text(theme_conf.read_text() + '# mine\n')
        out = self.jade('theme', 'undo')
        self.assertIn(f"Took Jade Shell's part out of {kitty}", out)
        self.assertEqual(kitty.read_text(), self.originals[kitty] + 'font_family Iosevka\n')
        self.assertEqual(starship.read_text(), self.originals[starship] + '\n[character]\nsuccess_symbol = ">"\n')
        self.assertIn(f'Kept {btop}', out)
        self.assertIn('color_theme = "nord"', btop.read_text())
        self.assertIn(f'Kept {theme_conf}', out)
        vscode = config / 'Code/User/settings.json'
        self.assertEqual(vscode.read_text(), self.originals[vscode])

    def test_an_edit_survives_undoing_two_switches(self):
        self.jade('theme', 'set', 'tokyo-night', '--only', 'starship,kitty')
        self.jade('theme', 'set', 'nord', '--only', 'starship,kitty')
        starship = self.home / '.config/starship.toml'
        starship.write_text(starship.read_text().replace('palette = "jade"\n', 'palette = "jade"\nadd_newline = false\n'))
        self.assertIn(f"Took Jade Shell's part out of {starship}", self.jade('theme', 'undo'))
        self.assertIn(themes.load('tokyo-night').colors['red'], starship.read_text())
        self.jade('theme', 'undo')
        self.assertEqual(starship.read_text(), self.originals[starship].replace(
            'palette = "catppuccin_mocha"\n', 'palette = "catppuccin_mocha"\nadd_newline = false\n'))

    def test_an_edit_between_pruned_switches_survives_restore(self):
        self.jade('theme', 'set', 'tokyo-night', '--only', 'starship')
        starship = self.home / '.config/starship.toml'
        starship.write_text(starship.read_text().replace('palette = "jade"\n', 'palette = "jade"\nadd_newline = false\n'))
        self.jade('theme', 'set', 'nord', '--only', 'starship')
        # Pruning folds the second switch into the first, as after 30 more switches.
        fold = 'from jade import engine; h = engine.backups(); engine.fold(h[0], h[1]); import shutil; shutil.rmtree(h[1])'
        subprocess.run([sys.executable, '-c', fold], env=self.env, cwd=ROOT, check=True)
        self.jade('theme', 'undo')
        self.assertEqual(starship.read_text(), self.originals[starship].replace(
            'palette = "catppuccin_mocha"\n', 'palette = "catppuccin_mocha"\nadd_newline = false\n'))

    def test_doctor_reports_old_copies(self):
        old = self.home / '.local/lib/osaka-ai-usage'
        old.mkdir(parents=True)
        result = self.run_jade('doctor')
        self.assertIn('✗ No older or development copies in your home folder', result.stdout)
        self.assertTrue(any(line.strip().startswith('rm -rf ') and str(old) in line
                            for line in result.stdout.splitlines()), result.stdout)
        self.assertTrue(old.exists())

    def test_symlinked_dotfile_stays_a_link(self):
        kitty = self.home / '.config/kitty/kitty.conf'
        dotfiles = self.home / 'dotfiles/kitty.conf'
        dotfiles.parent.mkdir()
        kitty.rename(dotfiles)
        kitty.symlink_to(dotfiles)
        self.jade('theme', 'set', 'nord', '--only', 'kitty')
        self.assertTrue(kitty.is_symlink())
        self.assertIn('include jade-theme.conf', dotfiles.read_text())
        self.jade('theme', 'undo')
        self.assertTrue(kitty.is_symlink())
        self.assertEqual(dotfiles.read_text(), self.originals[kitty])

    def test_offline_switch_keeps_the_current_wallpaper(self):
        # Nothing listens on port 9, so every download fails at once.
        self.env.update(https_proxy='http://127.0.0.1:9', HTTPS_PROXY='http://127.0.0.1:9')
        nord = themes.load('nord')
        (self.home / '.local/share/jade-shell/backgrounds/nord' / nord.backgrounds[0]).unlink()
        out = self.jade('theme', 'set', 'nord', '--only', 'gnome')
        self.assertIn('skipped wallpaper: could not download the Nord wallpaper', out)
        self.assertEqual(self.gsettings('get', 'org.gnome.desktop.interface', 'color-scheme'), "'prefer-dark'")
        self.assertNotIn('nord', self.gsettings('get', 'org.gnome.desktop.background', 'picture-uri'))
        result = self.run_jade('theme', 'wallpaper')
        self.assertEqual(result.returncode, 1)
        self.assertIn('Wallpaper not changed: could not download', result.stderr)
        self.assertNotIn('Traceback', result.stderr)

    def test_mistyped_target_is_refused(self):
        result = self.run_jade('theme', 'plan', 'nord', '--only', 'kity')
        self.assertEqual(result.returncode, 2)
        self.assertIn('unknown target kity; targets are: gnome, dock, shell', result.stderr)

    def test_restore_skips_settings_whose_app_is_gone(self):
        self.jade('theme', 'set', 'tokyo-night', '--only', 'gnome,kitty')
        backup = self.home / '.local/state/jade-shell/backups'
        manifest_path = next(backup.glob('*/manifest.json'))
        manifest = json.loads(manifest_path.read_text())
        manifest['settings'] += [
            {'schema': 'org.example.uninstalled', 'path': None, 'key': 'palette', 'old': "'x'"},
            {'schema': 'org.gnome.desktop.interface', 'path': None, 'key': 'no-such-key', 'old': None},
        ]
        manifest_path.write_text(json.dumps(manifest))
        setup_manifest = {'settings': [{'schema': 'org.gnome.shell.extensions.dash-to-dock', 'path': None,
                                        'key': 'dock-position', 'old': "'LEFT'"}], 'disabled_units': []}
        (self.home / '.local/state/jade-shell/setup.json').write_text(json.dumps(setup_manifest))
        out = self.jade('restore', '--yes')
        self.assertIn('Skipped the settings of org.example.uninstalled: no longer installed.', out)
        self.assertIn('Skipped the settings of org.gnome.shell.extensions.dash-to-dock: no longer installed.', out)
        self.assertIn('Skipped org.gnome.desktop.interface no-such-key (no longer installed)', out)
        kitty = self.home / '.config/kitty/kitty.conf'
        self.assertEqual(kitty.read_text(), self.originals[kitty])
        self.assertNotIn('accent-color', self.keyfile().get('org/gnome/desktop/interface', {}))
        self.assertIn('none', self.jade('theme', 'current'))

    @needs_compiler
    def test_ai_usage_turns_on_once_claude_arrives(self):
        # Neither CLI on PATH (the real ~/.local/bin has them on the developer's machine).
        self.env['PATH'] = f'{self.env["PATH"].split(os.pathsep)[0]}:/usr/bin:/bin'
        self.jade('setup')
        self.assertEqual(self.gsettings('get', 'org.gnome.shell.extensions.jade-shell', 'show-usage'), 'false')
        (self.home / '.claude').mkdir(parents=True)
        self.jade('setup')
        self.assertEqual(self.gsettings('get', 'org.gnome.shell.extensions.jade-shell', 'show-usage'), 'true')

    @needs_compiler
    def test_setup_keeps_the_current_theme_unless_asked(self):
        self.jade('setup')
        self.assertIn('osaka-jade', self.jade('theme', 'current'))
        self.jade('theme', 'set', 'nord')
        self.jade('setup')  # again, as after an update: the chosen theme stays
        self.assertIn('nord', self.jade('theme', 'current'))
        self.jade('setup', '--theme', 'solitude')
        self.assertIn('solitude', self.jade('theme', 'current'))

    @needs_compiler
    def test_an_app_left_alone_gets_its_config_back_and_stays_untouched(self):
        kitty = self.home / '.config/kitty/kitty.conf'
        starship = self.home / '.config/starship.toml'
        out = self.jade('setup')
        self.assertIn('Adding the theme to ~/.config/kitty/kitty.conf', out)
        self.jade('theme', 'set', 'nord')
        # Edited since: the edit stays, Jade Shell's part goes.
        starship.write_text(starship.read_text() + 'command_timeout = 900\n')

        out = self.jade('apps', 'off', 'kitty', 'starship')
        self.assertIn('Jade Shell leaves Kitty alone now: put back ~/.config/kitty/kitty.conf; '
                      'removed ~/.config/kitty/jade-theme.conf.', out)
        self.assertIn("Jade Shell leaves Starship alone now: took Jade Shell's part out of ~/.config/starship.toml", out)
        self.assertEqual(kitty.read_text(), self.originals[kitty])
        self.assertFalse((kitty.parent / 'jade-theme.conf').exists())
        self.assertEqual(starship.read_text(), self.originals[starship] + 'command_timeout = 900\n')
        self.assertIn('left alone', self.jade('apps', 'list'))

        self.jade('theme', 'set', 'tokyo-night')  # the picker runs this too
        out = self.run_jade('theme', 'set', 'nord', '--only', 'kitty').stdout
        self.assertIn('skipped kitty: left alone', out)
        self.jade('theme', 'undo')
        self.jade('setup')
        self.assertEqual(kitty.read_text(), self.originals[kitty])
        self.assertIn('Kitty terminal (left alone: jade apps on kitty)', self.run_jade('doctor').stdout)

        self.assertIn('applied to Kitty', self.jade('apps', 'on', 'kitty'))
        self.assertIn('include jade-theme.conf', kitty.read_text())
        self.jade('restore', '--yes')
        self.assertEqual(kitty.read_text(), self.originals[kitty])
        self.assertEqual(starship.read_text(), self.originals[starship] + 'command_timeout = 900\n')

    def test_debug_report_names_no_one(self):
        import getpass
        import socket
        out = self.jade('debug', '--print')
        self.assertIn('# Jade Shell debug report', out)
        self.assertIn('## jade doctor', out)
        self.assertNotIn(str(self.home), out)
        for secret in (getpass.getuser(), socket.gethostname()):
            self.assertNotIn(secret.lower(), out.lower())
        self.assertLess(len(debug.issue_url(out)), 8000)

    @needs_compiler
    def test_light_dark_light_and_back_leaves_nothing_behind(self):
        before = self.keyfile()
        scheme = ('get', 'org.gnome.desktop.interface', 'color-scheme')
        self.jade('theme', 'set', 'catppuccin-latte')
        self.assertEqual(self.gsettings(*scheme), "'prefer-light'")
        css = (self.home / '.local/state/jade-shell/gnome-shell.css').read_text()
        self.jade('theme', 'set', 'nord')
        self.assertEqual(self.gsettings(*scheme), "'prefer-dark'")
        self.jade('theme', 'set', 'flexoki-light')
        self.assertEqual(self.gsettings(*scheme), "'prefer-light'")
        self.jade('theme', 'set', 'catppuccin-latte')
        self.assertEqual((self.home / '.local/state/jade-shell/gnome-shell.css').read_text(), css)
        for _ in range(4):
            self.jade('theme', 'undo')
        self.assertEqual(self.keyfile(), before)
        for path, text in self.originals.items():
            self.assertEqual(path.read_text(), text, path)

    @needs_compiler
    def test_an_update_leaves_an_extension_turned_back_on(self):
        blur = 'blur-my-shell@aunetx'
        self.gsettings('set', 'org.gnome.shell', 'enabled-extensions', f"['{blur}']")
        self.jade('setup')
        manifest = json.loads((self.home / '.local/state/jade-shell/setup.json').read_text())
        self.assertEqual(manifest['version'], __version__)
        self.assertIn(blur, manifest['replaced'])
        # Its owner turns it back on; an update at login keeps that choice.
        self.gsettings('set', 'org.gnome.shell', 'enabled-extensions', f"['{UUID}', '{blur}']")
        manifest['version'] = '0.1.0'
        (self.home / '.local/state/jade-shell/setup.json').write_text(json.dumps(manifest))
        out = self.jade('setup', '--after-update')
        self.assertIn(f'Jade Shell {__version__} is set up.', out)
        self.assertNotIn('Turned off', out)
        self.assertIn(blur, self.gsettings('get', 'org.gnome.shell', 'enabled-extensions'))
        # Running setup by hand is asking for Jade Shell's layout again.
        self.assertIn('Turned off Blur my Shell', self.jade('setup'))

    @needs_compiler
    def test_setup_then_restore_gives_the_old_desktop_back(self):
        replaced = 'dash-to-panel@jderose9.github.com'  # it would take over the top bar
        self.assertIn(replaced, REPLACED)
        self.gsettings('set', 'org.gnome.shell', 'enabled-extensions', f"['{replaced}', 'keep@me']")
        (self.home / '.claude').mkdir(parents=True)  # so setup starts the usage collector
        old_copy = self.home / '.local/bin/jade-theme'  # from before Jade Shell merged with Jade AI Usage
        old_copy.parent.mkdir(parents=True)
        old_copy.write_text('#!/bin/sh\n')
        before = self.keyfile()

        out = self.jade('setup')
        self.assertIn('Turned off Dash to Panel: Jade Shell does the top bar and the dock', out)
        # Apps that aren't installed are not worth a line; what was themed is.
        self.assertNotIn('skipped', out)
        self.assertIn('Osaka Jade applied to GNOME', out)
        # (With the package installed on this machine, the sandbox's own extension copy is named too.)
        self.assertTrue(any(line.strip().startswith('rm -rf ') and str(old_copy) in line for line in out.splitlines()), out)
        self.assertTrue(old_copy.exists())  # said, never deleted
        enabled = self.gsettings('get', 'org.gnome.shell', 'enabled-extensions')
        self.assertEqual(enabled, f"['keep@me', '{UUID}']")
        self.assertIn('osaka-jade', self.jade('theme', 'current'))
        units = self.home / '.config/systemd/user'
        self.assertIn('ExecStart=/usr/bin/jade usage collect', (units / 'jade-usage.service').read_text())
        self.assertIn('enable --now jade-usage.timer', self.systemctl_log.read_text())
        self.assertEqual(self.gsettings('get', 'org.gnome.shell.extensions.jade-shell', 'show-usage'), 'true')
        # Choices made after setup: a running setup again keeps them, and so does restore.
        self.gsettings('set', 'org.gnome.shell.extensions.jade-shell', 'show-usage', 'false')
        self.gsettings('set', 'org.gnome.shell', 'enabled-extensions', f"['keep@me', '{UUID}', 'later@me']")
        self.systemctl_log.unlink()
        self.jade('setup')  # again: nothing new to record, nothing breaks
        self.assertEqual(self.gsettings('get', 'org.gnome.shell.extensions.jade-shell', 'show-usage'), 'false')
        # AI usage off stays off: the collector is stopped, not started again.
        self.assertIn('disable --now jade-usage.timer', self.systemctl_log.read_text())
        self.assertNotIn('--user enable --now jade-usage.timer', self.systemctl_log.read_text().splitlines())

        self.jade('restore', '--yes')
        before['org/gnome/shell']['enabled-extensions'] = f"['{replaced}', 'keep@me', 'later@me']"
        before['org/gnome/shell/extensions/jade-shell'] = {'show-usage': 'false'}  # setup never changed it
        self.assertEqual(self.keyfile(), before)
        for path, text in self.originals.items():
            self.assertEqual(path.read_text(), text, path)
        self.assertFalse((units / 'jade-usage.timer').exists())
        self.assertIn('none', self.jade('theme', 'current'))


if __name__ == '__main__':
    unittest.main()
