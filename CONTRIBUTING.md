# Working on Jade Shell

Thanks for looking. Bug reports are most useful with the output of `jade debug`, which gathers versions, your GPU, extensions and the relevant logs (with your user name, host name and home folder replaced) and opens a pre-filled issue. For a bigger change, open an issue first so we can talk it through.

## Development

```bash
python3 -m unittest discover -s tests   # unit tests, plus full switch/undo and setup/restore runs in a sandbox
bin/jade theme plan osaka-jade          # dry run against your desktop
scripts/dev-install.sh                  # this checkout for your user, then: jade setup
scripts/build-packages.sh               # dist/jade-shell.rpm and .deb (needs nfpm)
scripts/test-packages.sh                # install, set up, restore, remove on fresh Fedora and Ubuntu containers
npm ci && npm run lint                  # ESLint for the extension; Python uses ruff
```

The sandbox tests use their own HOME, XDG dirs and GSettings keyfile, so they never touch your desktop. If you run the extension in a nested or headless `gnome-shell`, give it its own `XDG_RUNTIME_DIR` too: GNOME keeps a crash marker there, and a test shell that leaves it behind makes your next login disable all extensions.

Before a pull request: the tests pass, `npm run lint` and `ruff check .` are clean, and anything that changes a user's desktop can be undone by `jade theme undo` or `jade restore`.
