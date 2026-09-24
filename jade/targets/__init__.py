from .apps import (
                   Alacritty,
                   Btop,
                   ClaudeCode,
                   Ghostty,
                   Gtk,
                   Kitty,
                   Neovim,
                   Obsidian,
                   Ptyxis,
                   Shell,
                   Starship,
                   Tmux,
                   Vicinae,
                   VSCode,
)
from .gnome import Dock, Gnome
from .icons import Icons

ALL = [Gnome(), Dock(), Shell(), Gtk(), Icons(), Ptyxis(), Vicinae(), Kitty(), Ghostty(), Alacritty(), Tmux(), Starship(),
       Btop(), Neovim(), Obsidian(), VSCode(), ClaudeCode()]
