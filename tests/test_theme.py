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
import re
import shutil
import subprocess
import sys
import tempfile
import time
import tomllib
import unittest
from unittest import mock

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tests'))
import sandbox  # noqa: F401  (first: a throwaway home for the whole process)

sys.path.insert(0, str(ROOT))

from jade import __version__, debug, engine, migrations, palette, restore_offer, setup, shelltheme, store, themes, update
from jade.setup import DASH_TO_DOCK, REPLACED, UBUNTU_DOCK, UUID
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


class Flatpak(unittest.TestCase):
    def test_restore_takes_out_only_what_setup_added(self):
        with tempfile.TemporaryDirectory() as tmp, \
                mock.patch.dict(os.environ, XDG_DATA_HOME=tmp), mock.patch('shutil.which', return_value='/usr/bin/flatpak'):
            overrides = setup.flatpak_overrides()
            overrides.parent.mkdir(parents=True)
            overrides.write_text('[Context]\nfilesystems=xdg-config/gtk-3.0:ro;~/Games;\n')

            def fake_flatpak(argv, **_kwargs):  # appends as `flatpak override --user` does
                extra = ''.join(a.split('=', 1)[1] + ';' for a in argv if a.startswith('--filesystem='))
                overrides.write_text(overrides.read_text().rstrip('\n') + extra + '\n')
                return subprocess.CompletedProcess(argv, 0)

            manifest = {}
            with mock.patch('subprocess.run', side_effect=fake_flatpak):
                setup.grant_flatpak(manifest)
            self.assertEqual(manifest['flatpak_added'], ['xdg-config/gtk-4.0:ro'])  # gtk-3.0 was there
            setup.revoke_flatpak(manifest)
            self.assertIn('filesystems=xdg-config/gtk-3.0:ro;~/Games;', overrides.read_text())
            self.assertNotIn('gtk-4.0', overrides.read_text())


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
                        DBUS_SESSION_BUS_ADDRESS='unix:path=/nonexistent', JADE_BIN='/usr/bin/jade',
                        JADE_SYSTEM_EXTENSIONS=str(t / 'system-extensions'))
        self.env.pop('XDG_SESSION_TYPE', None)
        for name in ('no_proxy', 'NO_PROXY'):
            self.env.pop(name, None)
        # Offline: no wallpaper, preview or icon downloads (tests that want one say so).
        self.env.update(https_proxy='http://127.0.0.1:9', HTTPS_PROXY='http://127.0.0.1:9')
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
            config / 'ghostty/config': 'font-size = 12\nbackground = #1e1e2e\n',
            config / 'alacritty/alacritty.toml': '[font]\nsize = 11.0\n',
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
        own = self.home / '.config/gtk-4.0/gtk.css'  # someone's own tweaks stay
        own.parent.mkdir(parents=True)
        own.write_text('window { font-size: 11pt; }\n')
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
        gtk4 = own.read_text()
        self.assertTrue(gtk4.startswith('window { font-size: 11pt; }'))
        self.assertIn('@define-color window_bg_color #eff1f5;', gtk4)
        self.assertIn('--window-bg-color: #eff1f5;', gtk4)
        self.assertIn('@define-color theme_bg_color #eff1f5;', (self.home / '.config/gtk-3.0/gtk.css').read_text())
        for _ in range(4):
            self.jade('theme', 'undo')
        self.assertEqual(own.read_text(), 'window { font-size: 11pt; }\n')
        self.assertFalse((self.home / '.config/gtk-3.0/gtk.css').exists())
        self.assertEqual(self.keyfile(), before)
        for path, text in self.originals.items():
            self.assertEqual(path.read_text(), text, path)

    def test_new_terminals_and_claude_code_follow_and_undo(self):
        (self.home / '.claude').mkdir()
        self.jade('theme', 'set', 'nord', '--only', 'ghostty,alacritty,claude')
        config = self.home / '.config'
        self.assertTrue((config / 'ghostty/config').read_text().endswith('config-file = jade-theme.conf\n# <<< jade-theme\n'))
        self.assertIn('background = #2e3440', (config / 'ghostty/jade-theme.conf').read_text())
        alacritty = (config / 'alacritty/alacritty.toml').read_text()
        self.assertTrue(alacritty.startswith('# >>> jade-theme'), alacritty)
        self.assertTrue(tomllib.loads(alacritty)['general']['import'])
        tomllib.loads((config / 'alacritty/jade-theme.toml').read_text())
        claude = json.loads((self.home / '.claude/themes/jade.json').read_text())
        self.assertEqual(claude['base'], 'dark')
        self.jade('theme', 'undo')
        for path in (config / 'ghostty/config', config / 'alacritty/alacritty.toml'):
            self.assertEqual(path.read_text(), self.originals[path])
        self.assertFalse((self.home / '.claude/themes/jade.json').exists())

    @unittest.skipUnless(shutil.which('tmux'), 'needs tmux')
    def test_tmux_follows_running_servers_and_undo(self):
        conf = self.home / '.tmux.conf'
        conf.write_text('set -g mouse on\nset -g status-style "bg=red"\n')
        tmpdir = pathlib.Path(self.tmp.name) / 'tmux'
        tmpdir.mkdir()
        self.env['TMUX_TMPDIR'] = str(tmpdir)
        server = ['tmux', '-f', str(conf), '-L', 'jadetest']
        subprocess.run([*server, 'new-session', '-d', '-s', 't'], env=self.env, check=True)
        self.addCleanup(subprocess.run, [*server, 'kill-server'], env=self.env, capture_output=True)

        def style():
            return subprocess.run([*server, 'show', '-gv', 'status-style'], env=self.env, capture_output=True,
                                  text=True).stdout.strip()

        self.assertEqual(style(), 'bg=red')
        self.jade('theme', 'set', 'nord', '--only', 'tmux')
        self.assertTrue(conf.read_text().endswith('source-file -q ~/.config/tmux/jade-theme.conf\n# <<< jade-theme\n'))
        foreground = themes.load('nord').colors['foreground'].lower()
        self.assertIn(foreground, style().lower())  # the running server took it
        self.jade('theme', 'undo')
        self.assertEqual(conf.read_text(), 'set -g mouse on\nset -g status-style "bg=red"\n')
        self.assertEqual(style(), 'bg=red')  # and its own again

    @unittest.skipUnless(shutil.which('nvim'), 'needs nvim')
    def test_neovim_colorscheme_follows_running_editors(self):
        runtime = pathlib.Path(self.tmp.name) / 'run'
        runtime.mkdir(mode=0o700)
        self.env['XDG_RUNTIME_DIR'] = str(runtime)
        socket = runtime / 'nvim.4242.0'
        self.jade('theme', 'set', 'nord', '--only', 'neovim')
        colors = self.home / '.config/nvim/colors/jade.lua'
        self.assertIn('generated for the current theme (Nord)', colors.read_text())
        editor = subprocess.Popen(['nvim', '--headless', '--clean', '--listen', str(socket),
                                   '--cmd', f'set rtp^={self.home}/.config/nvim', '-c', 'colorscheme jade'], env=self.env,
                                  stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.addCleanup(editor.wait)
        self.addCleanup(editor.kill)
        for _ in range(50):
            if socket.exists():
                break
            time.sleep(0.1)

        def background():
            expr = 'printf("#%06x", nvim_get_hl(0, {"name": "Normal"}).bg)'
            return subprocess.run(['nvim', '--server', str(socket), '--remote-expr', expr], env=self.env,
                                  capture_output=True, text=True).stdout.strip()

        self.assertEqual(background(), themes.load('nord').colors['background'].lower())
        self.jade('theme', 'set', 'tokyo-night', '--only', 'neovim')  # the running editor follows
        self.assertEqual(background(), themes.load('tokyo-night').colors['background'].lower())
        self.jade('theme', 'undo')
        self.jade('theme', 'undo')
        self.assertFalse(colors.exists())

    def test_obsidian_vaults_get_the_theme_where_none_was_chosen(self):
        mine, chosen = self.home / 'Notes', self.home / 'Work'
        for vault in (mine, chosen):
            (vault / '.obsidian').mkdir(parents=True)
        (chosen / '.obsidian/appearance.json').write_text('{"cssTheme": "Minimal", "baseFontSize": 16}')
        registry = self.home / '.config/obsidian/obsidian.json'
        registry.parent.mkdir(parents=True)
        registry.write_text(json.dumps({'vaults': {'a': {'path': str(mine)}, 'b': {'path': str(chosen)}}}))
        self.jade('theme', 'set', 'nord', '--only', 'obsidian')
        for vault in (mine, chosen):
            css = (vault / '.obsidian/themes/Jade Shell/theme.css').read_text()
            self.assertIn('--background-primary: #2e3440', css)
        self.assertEqual(json.loads((mine / '.obsidian/appearance.json').read_text())['cssTheme'], 'Jade Shell')
        self.assertEqual(json.loads((chosen / '.obsidian/appearance.json').read_text())['cssTheme'], 'Minimal')
        # Obsidian writes its settings as they change; undo gives back only the theme.
        appearance = mine / '.obsidian/appearance.json'
        appearance.write_text(json.dumps({**json.loads(appearance.read_text()), 'baseFontSize': 18}))
        self.jade('theme', 'undo')
        self.assertEqual(json.loads(appearance.read_text()), {'baseFontSize': 18})
        self.assertFalse((mine / '.obsidian/themes/Jade Shell').exists() and
                         any((mine / '.obsidian/themes/Jade Shell').iterdir()))

    def test_your_own_templates_and_hooks(self):
        themed = self.home / '.config/jade-shell/themed'
        hooks = self.home / '.config/jade-shell/hooks/theme-set.d'
        themed.mkdir(parents=True)
        hooks.mkdir(parents=True)
        shutil.copy(ROOT / 'examples/themed/colors.sh.tpl', themed)
        (themed / 'broken.conf.tpl').write_text('color = {{ acent }}\n')
        shutil.copy(ROOT / 'examples/hooks/theme-set.d/10-example', hooks)
        (hooks / '20-fails').write_text('#!/bin/sh\necho "no such app" >&2\nexit 3\n')
        (hooks / '20-fails').chmod(0o755)
        result = self.run_jade('theme', 'set', 'nord', '--only', 'custom')
        self.assertEqual(result.returncode, 0, result.stderr)  # a failing hook doesn't fail the switch
        self.assertIn('hook 20-fails failed (exit 3): no such app', result.stderr)
        self.assertIn('skipped custom: broken.conf.tpl: no placeholder named acent', result.stdout)
        out = (self.home / '.local/state/jade-shell/themed/colors.sh').read_text()
        self.assertIn('export JADE_THEME_NAME="Nord"', out)
        self.assertIn(f'export JADE_ACCENT="{themes.load("nord").colors["accent"]}"', out)
        self.assertNotIn('{{', out)
        self.assertEqual((self.home / '.local/state/jade-shell/hooks.log').read_text(),
                         'Jade Shell switched to Nord (dark)\n')
        self.jade('theme', 'undo')
        self.assertFalse((self.home / '.local/state/jade-shell/themed/colors.sh').exists())

    @unittest.skipUnless('JetBrains Mono' in subprocess.run(['fc-list', ':spacing=100', 'family'], capture_output=True,
                                                             text=True).stdout, 'needs JetBrains Mono installed')
    def test_font_set_reaches_gnome_and_terminals_and_undoes(self):
        interface = ('org.gnome.desktop.interface', 'monospace-font-name')
        self.gsettings('set', *interface, "'Source Code Pro 13'")
        out = self.jade('font', 'set', 'jetbrains', 'mono')
        self.assertIn('JetBrains Mono set for GNOME', out)
        self.assertEqual(self.gsettings('get', *interface), "'JetBrains Mono 13'")  # the size stays
        config = self.home / '.config'
        self.assertIn('include jade-font.conf', (config / 'kitty/kitty.conf').read_text())
        self.assertEqual((config / 'kitty/jade-font.conf').read_text(), 'font_family JetBrains Mono\n')
        self.assertIn('config-file = jade-font.conf', (config / 'ghostty/config').read_text())
        toml = tomllib.loads((config / 'alacritty/jade-theme.toml').read_text())
        self.assertEqual(toml['font']['normal']['family'], 'JetBrains Mono')
        # A theme switch keeps the font.
        self.jade('theme', 'set', 'nord', '--only', 'kitty,font')
        self.assertIn('include jade-font.conf', (config / 'kitty/kitty.conf').read_text())
        self.jade('theme', 'undo')
        self.jade('theme', 'undo')  # the font too
        self.assertEqual(self.gsettings('get', *interface), "'Source Code Pro 13'")
        self.assertFalse((config / 'kitty/jade-font.conf').exists())
        self.assertNotIn('jade-font', (config / 'kitty/kitty.conf').read_text())
        self.assertEqual(self.run_jade('font', 'set', 'No Such Mono').returncode, 1)

    def test_alacritty_keeps_its_own_imports_on_top(self):
        toml = self.home / '.config/alacritty/alacritty.toml'
        toml.write_text('[general]\nimport = ["~/.config/alacritty/mine.toml"]\n')
        self.jade('theme', 'set', 'nord', '--only', 'alacritty')
        imports = tomllib.loads(toml.read_text())['general']['import']
        self.assertEqual(imports, ['~/.config/alacritty/jade-theme.toml', '~/.config/alacritty/mine.toml'])
        toml.write_text(toml.read_text() + '\n[window]\nopacity = 0.9\n')  # edited since
        self.jade('theme', 'undo')
        self.assertEqual(toml.read_text(), '[general]\nimport = ["~/.config/alacritty/mine.toml"]\n\n[window]\nopacity = 0.9\n')

    def test_vscodium_and_flatpak_code_switch_too(self):
        codium = self.home / '.config/VSCodium/User/settings.json'
        flatpak = self.home / '.var/app/com.vscodium.codium/config/VSCodium/User/settings.json'
        for path in (codium, flatpak):
            path.parent.mkdir(parents=True)
            path.write_text('{\n    "editor.fontSize": 13\n}\n')
        (self.home / '.var/app/com.vscodium.codium/data/codium/extensions').mkdir(parents=True)
        self.jade('theme', 'set', 'nord', '--only', 'vscode')
        for path in (codium, flatpak, self.home / '.config/Code/User/settings.json'):
            self.assertIn('"workbench.colorTheme": "Jade · Nord"', path.read_text(), path)
        for base in ('.vscode-oss/extensions', '.var/app/com.vscodium.codium/data/codium/extensions'):
            self.assertTrue((self.home / base / 'jade-shell.jade-themes-1.0.0/package.json').exists(), base)
        self.jade('theme', 'undo')
        for path in (codium, flatpak):
            self.assertEqual(path.read_text(), '{\n    "editor.fontSize": 13\n}\n')

    def test_each_theme_keeps_its_wallpaper(self):
        nord = themes.load('nord')
        second = self.home / '.local/share/jade-shell/backgrounds/nord' / nord.backgrounds[1]
        second.write_bytes(b'image')  # no download in the sandbox
        skip = ['--only', 'gnome']
        self.jade('theme', 'set', 'nord', *skip)
        self.jade('theme', 'wallpaper')
        self.jade('theme', 'set', 'tokyo-night', *skip)
        self.assertNotIn(second.name, self.gsettings('get', 'org.gnome.desktop.background', 'picture-uri'))
        self.jade('theme', 'set', 'nord', *skip)  # back: the wallpaper it had
        self.assertIn(second.name, self.gsettings('get', 'org.gnome.desktop.background', 'picture-uri'))
        self.assertIn('already applied', self.jade('theme', 'plan', 'nord', *skip))

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

    def test_the_omarchy_keymap_goes_back_exactly(self):
        custom = '/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/custom0/'
        self.gsettings('set', 'org.gnome.desktop.wm.keybindings', 'switch-to-workspace-1', "['<Super>Home', '<Super>1']")
        self.gsettings('set', 'org.gnome.settings-daemon.plugins.media-keys', 'custom-keybindings', f"['{custom}']")
        custom_schema = f'org.gnome.settings-daemon.plugins.media-keys.custom-keybinding:{custom}'
        self.gsettings('set', custom_schema, 'binding', '<Super>Return')
        self.gsettings('set', custom_schema, 'command', 'my-terminal')
        before = self.keyfile()

        out = self.jade('keys', 'apply')
        self.assertIn('keymap is on', out)
        changed = int(re.search(r'\((\d+) shortcuts? changed', out)[1])
        self.assertLess(changed, 60)  # the keymap's keys and their clashes, not every media key's ['']
        self.assertEqual(self.gsettings('get', 'org.gnome.shell.extensions.jade-shell', 'toggle-menu'), "['<Super>space']")
        self.assertEqual(self.gsettings('get', 'org.gnome.desktop.wm.keybindings', 'switch-input-source'),
                         "['<Shift><Super>space', 'XF86Keyboard']")  # layouts move off Super+Space
        self.assertEqual(self.gsettings('get', 'org.gnome.desktop.wm.keybindings', 'switch-input-source-backward'),
                         "['<Shift>XF86Keyboard']")
        self.assertEqual(self.gsettings('get', 'org.gnome.desktop.wm.keybindings', 'switch-applications'), "['<Alt>Tab']")
        self.assertEqual(self.gsettings('get', 'org.gnome.desktop.wm.keybindings', 'close'),
                         "['<Super>w', '<Super>q', '<Alt>F4']")
        self.assertEqual(self.gsettings('get', 'org.gnome.shell.keybindings', 'switch-to-application-1'), '@as []')
        self.assertEqual(self.gsettings('get', custom_schema, 'binding'), "''")  # yours moves off Super+Return
        paths = self.gsettings('get', 'org.gnome.settings-daemon.plugins.media-keys', 'custom-keybindings')
        self.assertIn('jade-terminal', paths)
        self.jade('keys', 'apply')  # again: the values kept for revert are still the first ones

        self.assertIn('back as they were', self.jade('keys', 'revert'))
        self.assertEqual(self.keyfile(), before)
        self.assertIn('keymap is off', self.jade('keys'))

        self.jade('keys', 'apply')  # and jade restore takes it back too
        self.jade('restore', '--yes')
        self.assertEqual(self.gsettings('get', 'org.gnome.shell.extensions.jade-shell', 'toggle-menu'),
                         "['<Super><Alt>space']")
        self.assertEqual(self.gsettings('get', custom_schema, 'binding'), "'<Super>Return'")

    def community_repo(self, name, files):
        """A git repo standing in for a community theme; returns its file:// URL."""
        repo = self.home.parent / 'repos' / name
        repo.mkdir(parents=True)
        for path, content in files.items():
            (repo / path).parent.mkdir(parents=True, exist_ok=True)
            (repo / path).write_bytes(content if isinstance(content, bytes) else content.encode())
        git = ['git', '-C', str(repo), '-c', 'user.name=t', '-c', 'user.email=t@t']
        subprocess.run([*git[:3], 'init', '-q'], check=True)
        subprocess.run([*git, 'add', '-A'], check=True)
        subprocess.run([*git, 'commit', '-qm', 'theme'], check=True)
        return repo.as_uri(), repo, git

    def test_a_community_theme_installs_switches_updates_and_goes(self):
        import gi
        gi.require_version('GdkPixbuf', '2.0')
        from gi.repository import GdkPixbuf
        picture = GdkPixbuf.Pixbuf.new(GdkPixbuf.Colorspace.RGB, False, 8, 64, 40)
        picture.fill(0x5f875fff)
        png = bytes(picture.save_to_bufferv('png', [], [])[1])
        palette = ('red = "#b36d43"\ngreen = "#5f875f"\nyellow = "#b8bb26"\n'
                   'blue = "#78824b"\nmagenta = "#bb7744"\ncyan = "#c9a554"\n')
        url, repo, git = self.community_repo('omarchy-harbor-theme', {
            'colors.toml': 'accent = "#78824b"\nbackground = "#222222"\nforeground = "#c2c2b0"\n' + palette,
            'backgrounds/1-forest.png': png, 'preview.png': png,
            'install.sh': '#!/bin/sh\ntouch "$HOME/pwned"\n', 'hyprland.conf': 'exec-once = rm -rf ~\n',
            'backgrounds/notes.txt': 'not a picture',
        })
        out = self.jade('theme', 'install', url)
        self.assertIn('Installed Harbor (1 wallpaper)', out)
        theme = self.home / '.config/jade-shell/themes/harbor'
        self.assertEqual(sorted(str(p.relative_to(theme)) for p in theme.rglob('*')),
                         ['backgrounds', 'backgrounds/1-forest.png', 'colors.toml', 'preview.png', 'source.json'])
        self.assertFalse((self.home / 'pwned').exists())
        listed = json.loads(self.jade('theme', 'list', '--json'))
        harbor = next(row for row in listed if row['id'] == 'harbor')
        self.assertEqual(harbor['colors']['accent'], '#78824b')
        self.assertTrue(harbor['thumbnail'])  # the picker shows its wallpaper

        self.jade('theme', 'set', 'harbor', '--only', 'gnome')
        self.assertIn('harbor/backgrounds/1-forest.png',
                      self.gsettings('get', 'org.gnome.desktop.background', 'picture-uri'))
        self.assertNotEqual(self.run_jade('theme', 'remove', 'harbor').returncode, 0)  # the current one stays

        (repo / 'colors.toml').write_text('accent = "#ff0000"\nbackground = "#222222"\nforeground = "#c2c2b0"\n' + palette)
        subprocess.run([*git, 'commit', '-qam', 'red'], check=True)
        self.assertIn('Apply its new colors with: jade theme set harbor', self.jade('theme', 'update'))
        listed = json.loads(self.jade('theme', 'list', '--json'))
        self.assertEqual(next(row for row in listed if row['id'] == 'harbor')['colors']['accent'], '#ff0000')

        self.jade('theme', 'set', 'osaka-jade', '--only', 'gnome')
        self.assertIn('Removed harbor', self.jade('theme', 'remove', 'harbor'))
        self.assertFalse(theme.exists())
        self.assertNotIn('harbor', [row['id'] for row in json.loads(self.jade('theme', 'list', '--json'))])

    def test_community_themes_are_held_to_their_looks(self):
        # An older theme: colors from its Alacritty theme.
        url, _repo, _git = self.community_repo('omarchy-retro-theme', {
            'alacritty.toml': '[colors.primary]\nbackground = "0x101010"\nforeground = "0xe0e0e0"\n'
                              '[colors.normal]\nblue = "0x3366ff"\nred = "0xcc3333"\n',
        })
        self.jade('theme', 'install', url)
        retro = next(row for row in json.loads(self.jade('theme', 'list', '--json')) if row['id'] == 'retro')
        self.assertEqual(retro['colors']['accent'], '#3366ff')
        # A link out of the repo is never followed, a name Jade has is not taken, a URL must be a git URL.
        url, repo, git = self.community_repo('omarchy-sneaky-theme', {'x': 'x'})
        (repo / 'colors.toml').symlink_to(self.home / '.bashrc')
        subprocess.run([*git, 'add', '-A'], check=True)
        subprocess.run([*git, 'commit', '-qm', 'link'], check=True)
        self.assertIn('is a link', self.run_jade('theme', 'install', url).stderr)
        self.assertIn('already has a theme called nord', self.run_jade('theme', 'install', url, '--name', 'nord').stderr)
        self.assertIn('not a git URL', self.run_jade('theme', 'install', '--', '--upload-pack=touch /tmp/x').stderr)
        self.assertIn('not a git URL', self.run_jade('theme', 'install', 'ext::sh -c touch% /tmp/x').stderr)

    def test_setup_fetches_the_tahoe_icons_once(self):
        out = self.jade('setup')  # offline: said, and setup goes on
        self.assertIn('No Tahoe icons', out)
        manifest = json.loads((self.home / '.local/state/jade-shell/setup.json').read_text())
        self.assertTrue(manifest['icons-offered'])
        self.assertNotIn('No Tahoe icons', self.jade('setup'))  # asked once, not at every update
        # In use but gone from disk (deleted by hand, or by a cleanup tool): fetched again.
        self.gsettings('set', 'org.gnome.desktop.interface', 'icon-theme', 'Jade-MacTahoe-dark')
        self.assertIn('No Tahoe icons', self.jade('setup'))
        self.assertEqual(self.gsettings('get', 'org.gnome.shell.extensions.jade-shell', 'dock-icon-style'), "'color'")

    def test_tahoe_icons_take_the_accent_and_leave_with_restore(self):
        from jade import icons
        icons_home = self.home / '.local/share/icons'
        for name in (icons.NAME, f'{icons.NAME}-dark'):
            (icons_home / name / 'places/scalable').mkdir(parents=True)
            (icons_home / name / 'index.theme').write_text(f'[Icon Theme]\nName={name}\n')
        (icons_home / icons.NAME / '.jade-source').write_text(icons.TAG + '\n')
        (icons_home / icons.NAME / '.jade-folders').mkdir()
        (icons_home / icons.NAME / '.jade-folders/folder.svg').write_text('<svg fill="#006efd"/>')
        self.gsettings('set', 'org.gnome.desktop.interface', 'icon-theme', "'Papirus'")
        self.jade('theme', 'set', 'tokyo-night', '--only', 'icons')
        accent = themes.load('tokyo-night').colors['accent'].lower()
        for name in (icons.NAME, f'{icons.NAME}-dark'):
            self.assertEqual((icons_home / name / 'places/scalable/folder.svg').read_text(), f'<svg fill="{accent}"/>')
        self.assertEqual(self.gsettings('get', 'org.gnome.desktop.interface', 'icon-theme'), f"'{icons.NAME}-dark'")
        self.jade('theme', 'set', 'catppuccin-latte', '--only', 'icons')  # a light theme: the light folder
        self.assertEqual(self.gsettings('get', 'org.gnome.desktop.interface', 'icon-theme'), f"'{icons.NAME}'")
        self.jade('restore', '--yes')
        self.assertEqual(self.gsettings('get', 'org.gnome.desktop.interface', 'icon-theme'), "'Papirus'")
        self.assertFalse((icons_home / icons.NAME).exists())

    @needs_compiler
    def test_the_jade_dock_replaces_other_docks_until_restore(self):
        extensions = self.home / '.local/share/gnome-shell/extensions'
        for uuid in (DASH_TO_DOCK, UBUNTU_DOCK):
            (extensions / uuid).mkdir(parents=True)
            (extensions / uuid / 'metadata.json').write_text('{}')
        self.gsettings('set', 'org.gnome.shell', 'enabled-extensions', f"['{DASH_TO_DOCK}']")
        self.gsettings('set', 'org.gnome.shell', 'disabled-extensions', "['old@me']")
        out = self.jade('setup')
        self.assertIn('Turned off Dash to Dock: Jade Shell does the dock.', out)
        # Ubuntu Dock comes with the session: turned off by the disabled list.
        self.assertIn('Turned off Ubuntu Dock: Jade Shell does the dock.', out)
        self.assertEqual(self.gsettings('get', 'org.gnome.shell', 'enabled-extensions'), f"['{UUID}']")
        self.assertEqual(self.gsettings('get', 'org.gnome.shell', 'disabled-extensions'),
                         f"['old@me', '{DASH_TO_DOCK}', '{UBUNTU_DOCK}']")
        self.assertIn('No extensions doing the same job', self.jade('doctor'))
        self.jade('restore', '--yes')
        self.assertEqual(self.gsettings('get', 'org.gnome.shell', 'enabled-extensions'), f"['{DASH_TO_DOCK}']")
        self.assertEqual(self.gsettings('get', 'org.gnome.shell', 'disabled-extensions'), "['old@me']")

    @needs_compiler
    def test_with_the_jade_dock_off_setup_leaves_other_docks_alone(self):
        extensions = self.home / '.local/share/gnome-shell/extensions'
        (extensions / DASH_TO_DOCK).mkdir(parents=True)
        (extensions / DASH_TO_DOCK / 'metadata.json').write_text('{}')
        self.gsettings('set', 'org.gnome.shell', 'enabled-extensions', f"['{DASH_TO_DOCK}']")
        self.gsettings('set', 'org.gnome.shell.extensions.jade-shell', 'show-dock', 'false')
        self.assertNotIn('Turned off Dash to Dock', self.jade('setup'))
        self.assertIn(DASH_TO_DOCK, self.gsettings('get', 'org.gnome.shell', 'enabled-extensions'))
        self.assertNotIn(DASH_TO_DOCK, self.gsettings('get', 'org.gnome.shell', 'disabled-extensions'))

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
