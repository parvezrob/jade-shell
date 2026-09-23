"""The two kinds of change a target can ask for: a GSettings key or a file."""
import hashlib
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

    def restore_all(self, entries):
        """Put recorded keys back, one batch per schema, and flush them to disk.

        Returns a line for each key that could not be put back because its app,
        schema or key is gone (or its type changed), so a removed app never
        blocks undo or restore.
        """
        skipped, groups = [], {}
        for entry in entries:
            schema, path, key, printed = entry['schema'], entry['path'], entry['key'], entry['old']
            found = self._source.lookup(schema, True)
            where = f'{schema}{" " + path if path else ""} {key}'
            if not found or not found.has_key(key):
                skipped.append(f'{where} (no longer installed)')
                continue
            value = None
            if printed is not None:
                schema_key = found.get_key(key)
                try:
                    value = GLib.Variant.parse(schema_key.get_value_type(), printed, None, None)
                except GLib.Error:
                    value = None
                if value is None or not schema_key.range_check(value):
                    skipped.append(f'{where} (its type or allowed values changed)')
                    continue
            groups.setdefault((schema, path), []).append((key, value))
        for (schema, path), group in groups.items():
            settings = Gio.Settings.new_full(self._source.lookup(schema, True), None, path)
            settings.delay()
            for key, value in group:
                if value is None:
                    settings.reset(key)
                else:
                    settings.set_value(key, value)
            settings.apply()
        # Written before the caller deletes the record of the old values.
        Gio.Settings.sync()
        return skipped

    def flip(self, schema, key):
        settings = self.get(schema)
        settings.set_boolean(key, not settings.get_boolean(key))
        Gio.Settings.sync()


def read_bytes(path):
    try:
        return pathlib.Path(path).read_bytes()
    except FileNotFoundError:
        return None


def encode(text):
    # surrogateescape round-trips bytes that are not UTF-8, so an odd comment
    # in someone's config is kept as it was instead of failing the switch.
    return text.encode('utf-8', 'surrogateescape')


def read_text(path):
    data = read_bytes(path)
    return None if data is None else data.decode('utf-8', 'surrogateescape')


def digest(data):
    return None if data is None else hashlib.sha256(data).hexdigest()


def default_mode():
    mask = os.umask(0)
    os.umask(mask)
    return 0o666 & ~mask


def real_path(path):
    """Where a write lands: through a symlinked dotfile to the file it points at."""
    return pathlib.Path(os.path.realpath(path))


def read_only_reason(path):
    """Why a write to `path` would fail, or None (for example a link into /nix/store)."""
    real = real_path(path)
    folder = real.parent
    while not folder.exists():
        folder = folder.parent
    if os.access(folder, os.W_OK) and (not real.exists() or os.access(real, os.W_OK)):
        return None
    link = f' (a link to {real})' if real != pathlib.Path(path) else ''
    return f'{path}{link} is read-only; change it where it is managed'


def write_bytes(path, data, mode=None):
    """Replace a file atomically, writing through a symlink so the link survives.

    An existing file keeps its mode; a new one gets `mode`, or the umask default.
    """
    path = real_path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        mode = path.stat().st_mode & 0o777
    elif mode is None:
        mode = default_mode()
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=f'.{path.name}.')
    try:
        with os.fdopen(fd, 'wb') as f:
            f.write(data)
        os.chmod(tmp, mode)
        os.replace(tmp, path)
    except BaseException:
        pathlib.Path(tmp).unlink(missing_ok=True)
        raise


def write_text(path, content, mode=None):
    write_bytes(path, encode(content), mode)
