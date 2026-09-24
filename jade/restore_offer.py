"""Offer to put the old desktop back after Jade Shell's package is removed.

Removing the package with GNOME Software, dnf or apt skips `jade restore`:
the theme, the dock layout and the extensions setup turned off would stay.
So setup keeps a copy of Jade Shell's code in the home folder (the restore
kit) and a user service that runs this module at login. While Jade Shell is
installed the service does nothing (its unit checks for /usr/bin/jade, and
this checks again). Once it is gone, a notification asks: "Restore My
Desktop" runs the kit's own `jade restore`; "Keep This Look" leaves the
desktop as it is. Either way the kit and the service remove themselves.
Closing the notification without an answer asks again at the next login.
"""
import contextlib
import io
import os
import pathlib
import shutil
import subprocess
import sys

import gi

gi.require_version('Gio', '2.0')
from gi.repository import Gio, GLib

from .store import config_home, data_home, state_home, write_text

UUID = 'jade-shell@parvezrob.github.io'
PACKAGE_ROOT = pathlib.Path('/usr/share/jade-shell')
UNIT = 'jade-restore-offer.service'
UNIT_TEXT = '''[Unit]
Description=Offer to restore the desktop from before Jade Shell once it is removed
# Nothing to do while Jade Shell is installed: no Python starts.
ConditionPathExists=!/usr/bin/jade
ConditionPathExists={manifest}
After=graphical-session.target
PartOf=graphical-session.target

[Service]
Type=simple
Environment={environment}
ExecStart=/usr/bin/python3 -P -m jade.restore_offer

[Install]
WantedBy=graphical-session.target
'''
NOTIFICATIONS = ('org.freedesktop.Notifications', '/org/freedesktop/Notifications', 'org.freedesktop.Notifications')
DISMISSED = 2  # NotificationClosed reason: closed by the user


def kit_path():
    return data_home() / 'jade-shell/restore-kit'


def unit_path():
    return config_home() / 'systemd/user' / UNIT


def systemctl(*args):
    subprocess.run(['systemctl', '--user', *args], capture_output=True)


def from_package():
    """Only a packaged Jade Shell keeps a kit: a development copy (in the home
    folder) is removed by hand, and restored the same way."""
    return pathlib.Path(__file__).resolve().is_relative_to(PACKAGE_ROOT)


def keep_kit():
    """Refresh the kit from the installed package, and the service that uses
    it. Called by every setup, so the kit matches the installed version."""
    if not from_package():
        return
    kit = kit_path()
    fresh = kit.with_name(kit.name + '.new')
    shutil.rmtree(fresh, ignore_errors=True)
    shutil.copytree(PACKAGE_ROOT, fresh, ignore=shutil.ignore_patterns('__pycache__'))
    shutil.rmtree(kit, ignore_errors=True)
    fresh.rename(kit)
    write_text(unit_path(), unit_text(kit))
    systemctl('daemon-reload')
    systemctl('enable', UNIT)


def unit_text(kit):
    """The service, with the folders this setup used (XDG_STATE_HOME moved
    elsewhere included: systemd's own environment may not have it)."""
    def quoted(text):  # one Environment= assignment, as systemd reads it
        return '"' + text.replace('%', '%%').replace('\\', '\\\\').replace('"', '\\"') + '"'
    environment = ' '.join(quoted(f'{name}={value}') for name, value in (
        ('PYTHONPATH', kit), ('XDG_STATE_HOME', state_home()), ('XDG_DATA_HOME', data_home()),
        ('XDG_CONFIG_HOME', config_home())))
    manifest = str(state_home() / 'jade-shell/setup.json').replace('%', '%%')
    return UNIT_TEXT.format(manifest=manifest, environment=environment)


def drop_kit():
    """The kit and its service, gone: after a restore, or once answered."""
    systemctl('disable', UNIT)
    unit_path().unlink(missing_ok=True)
    systemctl('daemon-reload')
    shutil.rmtree(kit_path(), ignore_errors=True)


def forget_jade():
    """After a restore with the package gone: Jade Shell's own files too (the
    downloaded wallpapers, previews, logs, usage caches). Nothing of anyone
    else's lives in these folders."""
    cache = pathlib.Path(os.environ.get('XDG_CACHE_HOME') or pathlib.Path.home() / '.cache')
    for folder in (data_home() / 'jade-shell', state_home() / 'jade-shell', cache / 'jade-shell'):
        shutil.rmtree(folder, ignore_errors=True)


def jade_installed():
    home = pathlib.Path.home()
    return any(path.exists() for path in (
        pathlib.Path('/usr/bin/jade'), pathlib.Path('/usr/share/gnome-shell/extensions') / UUID,
        home / '.local/bin/jade', data_home() / 'gnome-shell/extensions' / UUID))


class Offer:
    def __init__(self):
        self.bus = Gio.bus_get_sync(Gio.BusType.SESSION)
        self.loop = GLib.MainLoop()
        self.handlers = {}
        self.bus.signal_subscribe(NOTIFICATIONS[0], NOTIFICATIONS[2], None, NOTIFICATIONS[1], None,
                                  Gio.DBusSignalFlags.NONE, self.signal)

    def notify(self, title, body, actions, on_answer):
        flat = [part for action in actions for part in action]
        hints = {'resident': GLib.Variant('b', True)}
        params = GLib.Variant('(susssasa{sv}i)', ('Jade Shell', 0, 'preferences-desktop-appearance-symbolic',
                                                  title, body, flat, hints, 0))
        reply = self.bus.call_sync(*NOTIFICATIONS, 'Notify', params, GLib.VariantType('(u)'),
                                   Gio.DBusCallFlags.NONE, -1, None)
        self.handlers[reply.unpack()[0]] = on_answer

    def close(self, notification):
        self.bus.call_sync(*NOTIFICATIONS, 'CloseNotification', GLib.Variant('(u)', (notification,)), None,
                           Gio.DBusCallFlags.NONE, -1, None)

    def signal(self, _bus, _sender, _path, _iface, name, params):
        values = params.unpack()
        handler = self.handlers.get(values[0])
        if handler is None:
            return
        if name == 'ActionInvoked' and values[1] != 'default':
            del self.handlers[values[0]]
            self.close(values[0])
            handler(values[1])
        elif name == 'NotificationClosed':
            del self.handlers[values[0]]
            handler(None if values[1] == DISMISSED else 'expired')

    def wait_for_server(self, seconds=120):
        """The Shell shows notifications; at login it may not be up yet."""
        for _ in range(seconds):
            owner = self.bus.call_sync('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus',
                                       'NameHasOwner', GLib.Variant('(s)', (NOTIFICATIONS[0],)), None,
                                       Gio.DBusCallFlags.NONE, -1, None)
            if owner.unpack()[0]:
                return True
            GLib.usleep(1_000_000)
        return False


def restore():
    """`jade restore --yes` from the kit: its output lines, and whether it worked."""
    from . import engine, setup
    from .store import Settings
    out = io.StringIO()
    try:
        with contextlib.redirect_stdout(out):
            status = setup.restore(engine.Context(Settings()), assume_yes=True)
    except Exception as error:  # shown in the notification; the kit stays for another try
        return [f'{type(error).__name__}: {error}'], False
    return out.getvalue().splitlines(), status == 0


def main():
    if jade_installed() or not (state_home() / 'jade-shell/setup.json').exists():
        return 0
    offer = Offer()
    if not offer.wait_for_server():
        return 1

    def done(_answer=None):
        offer.loop.quit()

    def answered(action):
        if action is None or action == 'expired':
            offer.loop.quit()  # no answer: ask again at the next login
            return
        if action == 'keep':
            drop_kit()
            offer.loop.quit()
            return
        lines, ok = restore()
        if not ok:
            offer.notify('Could not restore your previous desktop', '\n'.join(lines[-3:]), [], done)
            return
        drop_kit()
        forget_jade()
        # What was kept or merged is worth a line; settings of apps removed since are not.
        notes = [line for line in lines if line.startswith(('Kept', 'Took'))]
        offer.notify('Your previous desktop is back', '\n'.join(['Log out and back in to finish.', *notes[:3]]),
                     [('logout', 'Log Out…')], log_out)

    def log_out(action):
        if action == 'logout':
            subprocess.run(['gnome-session-quit', '--logout'])  # GNOME's dialog asks to confirm
        offer.loop.quit()

    offer.notify('Jade Shell was removed',
                 'Its theme and settings are still on this desktop. Put back the desktop you had before it?',
                 [('restore', 'Restore My Desktop'), ('keep', 'Keep This Look')], answered)
    offer.loop.run()
    return 0


if __name__ == '__main__':
    os.umask(0o077)
    sys.exit(main())
