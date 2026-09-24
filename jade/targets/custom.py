"""Your own templates: ~/.config/jade-shell/themed/*.tpl, filled at every
switch into ~/.local/state/jade-shell/themed/ (the name without .tpl), with
the placeholders Jade Shell's own templates use: {{ accent }}, {{ background }},
{{ red_strip }}, {{ blue_rgb }}, {{ mix background accent 20% }}…, and
{{ name }}, {{ id }} and {{ mode }}."""
import re

from .. import themes
from ..store import File, config_home, read_text, state_home
from .base import Absent


class Custom:
    name = 'custom'
    title = 'your templates'
    label = 'Your templates (~/.config/jade-shell/themed)'

    def folder(self):
        return config_home() / 'jade-shell/themed'

    def output(self):
        return state_home() / 'jade-shell/themed'

    def templates(self):
        folder = self.folder()
        return sorted(folder.glob('*.tpl')) if folder.is_dir() else []

    def available(self, ctx):
        return None if self.templates() else Absent('no templates of your own')

    def changes(self, theme, ctx):
        values = {**theme.colors, 'name': theme.name, 'id': theme.id}
        out, problems = [], []
        for template in self.templates():
            try:
                out.append(File(self.output() / template.stem, themes.render(read_text(template), values)))
            except KeyError as error:
                token = re.sub(r"^'|'$", '', str(error))
                problems.append(f'{template.name}: no placeholder named {token}')
            except (ValueError, TypeError) as error:
                problems.append(f'{template.name}: {error}')
        if problems:
            ctx.skipped[self.name] = '; '.join(problems)
        return out

    def reload(self, ctx):
        pass  # your hooks can reload whatever reads these
