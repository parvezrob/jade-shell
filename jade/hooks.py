"""Hooks: your own programs, run after Jade Shell does something.

~/.config/jade-shell/hooks/<event>.d/ holds executables, run in name order:
  theme-set.d    after each theme switch, with the theme's id as argument
  post-update.d  after an update is set up, with the new version as argument
They also get JADE_THEME, JADE_THEME_NAME and JADE_MODE (dark or light)
where a theme is known, and JADE_THEMED (where your templates were filled).
A hook that fails or takes longer than 30 seconds is reported; it never
undoes or fails what Jade Shell did.
"""
import os
import subprocess

from .store import config_home, state_home

TIMEOUT = 30


def folder(event):
    return config_home() / 'jade-shell/hooks' / f'{event}.d'


def run(event, *args, theme=None):
    """Run the event's hooks; returns a line for each one that failed."""
    hooks = folder(event)
    if not hooks.is_dir():
        return []
    env = dict(os.environ, JADE_THEMED=str(state_home() / 'jade-shell/themed'))
    if theme is not None:
        env.update(JADE_THEME=theme.id, JADE_THEME_NAME=theme.name, JADE_MODE=theme.colors.get('mode', 'dark'))
    failures = []
    for hook in sorted(hooks.iterdir()):
        if not hook.is_file() or hook.name.startswith('.') or hook.name.endswith(('~', '.sample', '.disabled')):
            continue
        if not os.access(hook, os.X_OK):
            failures.append(f'hook {hook.name} is not executable (chmod +x {hook})')
            continue
        try:
            result = subprocess.run([str(hook), *args], env=env, capture_output=True, text=True, timeout=TIMEOUT)
        except subprocess.TimeoutExpired:
            failures.append(f'hook {hook.name} took longer than {TIMEOUT} s and was stopped')
            continue
        except OSError as error:
            failures.append(f'hook {hook.name} could not run: {error.strerror or error}')
            continue
        if result.returncode != 0:
            said = (result.stderr or result.stdout).strip().splitlines()
            failures.append(f'hook {hook.name} failed (exit {result.returncode})' + (f': {said[-1]}' if said else ''))
    return failures
