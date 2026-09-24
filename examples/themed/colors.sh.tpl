# A sample template for Jade Shell. Copy it to ~/.config/jade-shell/themed/
# and, at every theme switch, Jade Shell fills it in and writes the result to
# ~/.local/state/jade-shell/themed/colors.sh (this name without .tpl).
#
# Placeholders are those of Jade Shell's own templates (see templates/ in the
# source): any palette key such as {{ accent }} or {{ background }}, a key with
# _strip (no #) or _rgb (r,g,b), {{ mix background accent 20% }} for a blend,
# and {{ name }}, {{ id }} and {{ mode }} (dark or light).
#
# Then use the result from your own configs, for example in ~/.bashrc:
#   [ -f ~/.local/state/jade-shell/themed/colors.sh ] && . ~/.local/state/jade-shell/themed/colors.sh

export JADE_THEME_NAME="{{ name }}"
export JADE_ACCENT="{{ accent }}"
export JADE_BACKGROUND="{{ background }}"
export JADE_FOREGROUND="{{ foreground }}"
export JADE_ACCENT_RGB="{{ accent_rgb }}"
export JADE_SOFT_ACCENT="{{ mix background accent 25% }}"
