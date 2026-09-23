"""One-time changes an update makes to a desktop Jade Shell already set up.

`jade setup` applies everything that can be re-applied at any time (settings
it sets once, the theme). A migration is for what can't: a setting that
changed its meaning, a file that moved. Each runs once per person; a marker
file in state/jade-shell/migrations/ records that it did. A first setup marks
them all done, since it starts from the current shape of things.

Add new ones at the end with the next number; never renumber or remove one.
"""
from . import engine

# (number, what it does, function(ctx)), oldest first.
MIGRATIONS = []


def markers():
    return engine.state_dir() / 'migrations'


def pending():
    done = markers()
    return [m for m in MIGRATIONS if not (done / str(m[0])).exists()]


def mark(number):
    path = markers() / str(number)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.touch()


def mark_all():
    for number, _text, _run in MIGRATIONS:
        mark(number)


def run_pending(ctx, say):
    """Run what hasn't run yet, in order. A failure stops there, unmarked, so
    the next setup tries it again; returns whether all of them ran."""
    for number, text, run in pending():
        try:
            run(ctx)
        except Exception as error:  # reported, then retried by the next setup
            say(f'Update step {number} ({text}) failed: {error}')
            return False
        mark(number)
    return True
