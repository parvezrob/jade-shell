"""Imported first by every test module: the whole test process runs in a
throwaway home. HOME and the XDG folders point into a temporary folder,
GSettings writes a keyfile there, there is no session bus, and systemctl,
pkill and gnome-extensions on PATH do nothing. In-process calls such as
setup.restore() then can't reach the real desktop (the `jade` subprocess
runs in test_theme.py get a sandbox of their own on top of this).

This exists because one didn't: an in-process restore once deleted the
real Tahoe icons and turned off the real restore-offer service.
"""
import atexit
import os
import pathlib
import shutil
import tempfile

ROOT = pathlib.Path(tempfile.mkdtemp(prefix='jade-tests-'))
atexit.register(shutil.rmtree, ROOT, True)

HOME = ROOT / 'home'
BIN = ROOT / 'bin'
for folder in (HOME / '.config', HOME / '.local/share', HOME / '.local/state', HOME / '.cache', ROOT / 'run', BIN):
    folder.mkdir(parents=True, exist_ok=True)
(ROOT / 'run').chmod(0o700)
for tool in ('systemctl', 'pkill', 'gnome-extensions'):
    (BIN / tool).write_text('#!/bin/sh\nexit 0\n')
    (BIN / tool).chmod(0o755)

os.environ.update(
    HOME=str(HOME), XDG_CONFIG_HOME=str(HOME / '.config'), XDG_DATA_HOME=str(HOME / '.local/share'),
    XDG_STATE_HOME=str(HOME / '.local/state'), XDG_CACHE_HOME=str(HOME / '.cache'), XDG_RUNTIME_DIR=str(ROOT / 'run'),
    GSETTINGS_BACKEND='keyfile', DBUS_SESSION_BUS_ADDRESS='unix:path=/nonexistent', PATH=f'{BIN}:{os.environ["PATH"]}',
)
os.environ.pop('WAYLAND_DISPLAY', None)
os.environ.pop('DISPLAY', None)
