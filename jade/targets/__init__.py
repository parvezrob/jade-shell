from .apps import Alacritty, Btop, ClaudeCode, Ghostty, Gtk, Kitty, Ptyxis, Shell, Starship, Vicinae, VSCode
from .gnome import Dock, Gnome
from .icons import Icons

ALL = [Gnome(), Dock(), Shell(), Gtk(), Icons(), Ptyxis(), Vicinae(), Kitty(), Ghostty(), Alacritty(), Starship(), Btop(),
       VSCode(), ClaudeCode()]
