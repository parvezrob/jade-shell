from .apps import Alacritty, Btop, ClaudeCode, Ghostty, Gtk, Kitty, Ptyxis, Shell, Starship, Vicinae, VSCode
from .gnome import Dock, Gnome

ALL = [Gnome(), Dock(), Shell(), Gtk(), Ptyxis(), Vicinae(), Kitty(), Ghostty(), Alacritty(), Starship(), Btop(),
       VSCode(), ClaudeCode()]
