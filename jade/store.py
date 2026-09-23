"""The two kinds of change a target can ask for: a GSettings key or a file."""
import os
import pathlib
import tempfile
from dataclasses import dataclass

import gi

gi.require_version('Gio', '2.0')
from gi.repository import Gio, GLib


@dataclass(frozen=True)
class Setting:
    schema: str
    key: str
    value: object
    path: str | None = None  # for relocatable schemas such as Ptyxis profiles


@dataclass(frozen=True)
class File:
    path: pathlib.Path
    content: str


def data_home():
    return pathlib.Path(os.environ.get('XDG_DATA_HOME') or pathlib.Path.home() / '.local/share')


def config_home():
    return pathlib.Path(os.environ.get('XDG_CONFIG_HOME') or pathlib.Path.home() / '.config')


def state_home():
    return pathlib.Path(os.environ.get('XDG_STATE_HOME') or pathlib.Path.home() / '.local/state')


class Settings:
    """GSettings access that also sees schemas shipped inside Shell extensions."""

    def __init__(self):
        source = Gio.SettingsSchemaSource.get_default()
        for base in (pathlib.Path('/usr/share/gnome-shell/extensions'), data_home() / 'gnome-shell/extensions'):
            for schemas in sorted(base.glob('*/schemas')):
                if (schemas / 'gschemas.compiled').exists():
                    source = Gio.SettingsSchemaSource.new_from_directory(str(schemas), source, False)
        self._source = source
        self._open = {}

    def has(self, schema, key=None):
        found = self._source.lookup(schema, True)
        return bool(found) and (key is None or found.has_key(key))

    def get(self, schema, path=None):
        if (schema, path) not in self._open:
            self._open[schema, path] = Gio.Settings.new_full(self._source.lookup(schema, True), None, path)
        return self._open[schema, path]

    def variant(self, change):
        settings = self.get(change.schema, change.path)
        return GLib.Variant(settings.get_value(change.key).get_type_string(), change.value)

    def differs(self, change):
        return not self.get(change.schema, change.path).get_value(change.key).equal(self.variant(change))

    def current(self, change):
        return self.get(change.schema, change.path).get_value(change.key).unpack()

    def user_value(self, change):
        value = self.get(change.schema, change.path).get_user_value(change.key)
        return value.print_(True) if value is not None else None

    def write(self, changes):
        """Write each schema's keys as one batch, so listeners see one update."""
        groups = {}
        for change in changes:
            if self.differs(change):
                groups.setdefault((change.schema, change.path), []).append(change)
        for (schema, path), group in groups.items():
            # A separate object: delay() is permanent on the object it is
            # called on, and would hold back later writes such as reload flips.
            settings = Gio.Settings.new_full(self._source.lookup(schema, True), None, path)
            settings.delay()
            for change in group:
                settings.set_value(change.key, self.variant(change))
            settings.apply()
        Gio.Settings.sync()

    def restore(self, schema, path, key, printed):
        settings = self.get(schema, path)
        if printed is None:
            settings.reset(key)
        else:
            settings.set_value(key, GLib.Variant.parse(None, printed, None, None))

    def flip(self, schema, key):
        settings = self.get(schema)
        settings.set_boolean(key, not settings.get_boolean(key))
        Gio.Settings.sync()


def read_text(path):
    try:
        return path.read_text()
    except FileNotFoundError:
        return None


def write_text(path, content):
    path.parent.mkdir(parents=True, exist_ok=True)
    mode = path.stat().st_mode & 0o777 if path.exists() else 0o644
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=f'.{path.name}.')
    with os.fdopen(fd, 'w') as f:
        f.write(content)
    os.chmod(tmp, mode)
    os.replace(tmp, path)
