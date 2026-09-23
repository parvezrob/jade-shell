from .apps import Btop, Kitty, Ptyxis, Shell, Starship, Vicinae, VSCode
from .gnome import AppGrid, Astra, Dock, Gnome, OpenBar

# Order matters for GNOME: OpenBar nudges the GNOME accent when its selection
# color changes, so GNOME's own accent is written after it.
ALL = [OpenBar(), Gnome(), Dock(), AppGrid(), Astra(), Shell(), Ptyxis(), Vicinae(), Kitty(), Starship(), Btop(), VSCode()]
